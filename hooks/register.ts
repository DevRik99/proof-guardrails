import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ROLES, rolePrompt, spawnContext, withoutInjected } from '../src/agents.ts'
import { CATALOG, FAMILIES, MODES, RULE_IDS } from '../src/catalog.ts'
import { compiles, mergeConfig, modeOf, paramOf, parseConfig, withEverySetting, type Config, type UserRule } from '../src/config.ts'
import { DISCIPLINE } from '../src/discipline.ts'
import { findingsFor, judge, render, type Context, type Judged, type Verdict } from '../src/evaluate.ts'
import { shellOf, textOf, writeIntentOf } from '../src/facts.ts'
import {
  creditTasks, decisiveChecks, emptyLedger, isVerificationCommand, openTasks, ranNoTests, recordAttributionLeak, recordBlockedTargets,
  recordDecision, recordEdit, recordLookedUpPids, recordResearch, recordTaskCreated, recordTaskUpdated, recordVerification, startWindow,
  unlazyGates, unverifiedEdits,
  type Ledger, type LedgerGate,
} from '../src/ledger.ts'
import { isNativeRule, withNative } from '../src/native.ts'
import { commitMessageFiles, hasAttributionTrailer, isGitCommit, stripAttribution } from '../src/rules/attribution.ts'
import {
  blockedTargetsOf, codeFileFindings, lockedTargetFindings, lookedUpPids, packageScriptsRun, scriptRuns, shellOfText,
} from '../src/rules/evasion.ts'
import { commandWords, gitSubcommand, programName } from '../src/shell.ts'
import { isReadOnlyShell, leafGatesFinding, leafLedgersFor, shellWriteTargets, workPaths } from '../src/rules/tasks.ts'
import type { Finding, ShellFacts, ToolFacts, WriteFacts } from '../src/rules/types.ts'
import { addedLines, newComments } from '../src/rules/writes.ts'
import { activityText, historyText, outcome, projectName, targetOf } from '../src/activity.ts'
import { leafSpecs, parsePlan, rootKey, rootSpec, scopeOfPlanPath, type TaskSpec } from '../src/unlazy-plan.ts'
import { loadHistory, openPane, recordActivity, registerPane, savedHistory, sessionActivity } from './pane.tsx'

const PROJECT_CONFIG = '.ai/gates.json'
const PROJECT_SETTINGS = '.claude/settings.json'
const MAX_STOP_BLOCKS = 3

function maxBlocks(config: Config): number {
  return Math.max(0, Math.round(paramOf(config, 'completion.verify-after-edit', 'maxBlocks', MAX_STOP_BLOCKS)))
}

function withMode(rules: Record<string, unknown> | undefined, target: string, mode: string): Record<string, unknown> {
  const current = rules?.[target]
  const setting = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
  return { ...(rules ?? {}), [target]: { ...setting, mode } }
}
const READ_ONLY_DENY = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

const PLUGIN_TOOLS = 'mcp__proof-guardrails__'
const ledgerAtom = atom({ plugin: 'proof-guardrails', key: 'ledger' } as const, emptyLedger(0), { shape: 'ledger-2' })

// A verdict computed in tool.call is read back by tool.check for the same call, so a call is
// analyzed once. Module memory: a reload only costs a recompute.
const verdicts = new Map<string, Verdict>()
const confirmed = new Set<string>()
const CONFIRM = 'Sí, ejecutar'

// A managed hook above this plugin can settle tool.check and skip it, so tool.call
// decides first: it refuses what is denied and asks the person itself.
type Decision = { deny?: string; answer?: string }

const LOCKS = /^(irreversible\.destructive|evasion\.)/
const LOCK_NOTE = '\nCualquier otra vía hacia lo mismo (otro comando, un intérprete o un script) también queda bloqueada hasta que el usuario lo apruebe.'

async function decideBeforeRunning(engine: $, id: string | undefined, verdict: Verdict): Promise<Decision> {
  if (verdict.deny.length > 0) {
    await note(engine, verdict.deny, 'bloqueado')
    return { deny: render(verdict.deny) + (verdict.deny.some(item => LOCKS.test(item.rule)) ? LOCK_NOTE : '') }
  }
  if (verdict.ask.length === 0) return {}
  await note(engine, verdict.ask, 'confirmación')
  const reason = render(verdict.ask)
  const answer = await engine.ui
    .ask(`${reason}\n\n¿Ejecutar de todas formas?`, { header: 'Confirmar', options: [CONFIRM, 'No'] })
    .catch((error: unknown) => {
      engine.ui.log(`proof-guardrails: no se pudo pedir confirmación (${String(error).slice(0, 200)})`)
      return undefined
    })
  if (answer !== undefined) engine.ui.log(`proof-guardrails: confirmación de ${verdict.ask.map(item => item.rule).join(', ')} → «${answer}»`)
  if (answer === CONFIRM) {
    if (id !== undefined) confirmed.add(id)
    return { answer }
  }
  const why = answer === undefined ? 'No hay a quién pedir confirmación en esta sesión.' : `El usuario no lo confirmó${answer === 'No' ? '' : `: ${answer}`}.`
  await note(engine, verdict.ask, 'rechazado')
  const lock = verdict.ask.some(item => LOCKS.test(item.rule)) ? LOCK_NOTE : ''
  return { deny: `${reason}\n${why}${lock}`, answer: answer ?? 'sin respuesta: nadie a quién preguntar' }
}

type $ = EngineInterface
type Input = Record<string, unknown>

async function readJson(engine: $, path: string): Promise<unknown> {
  try {
    return JSON.parse(await engine.fs.read(path))
  } catch {
    return undefined
  }
}

// A config that cannot be read must leave the defaults in force, never switch the guards off.
async function loadConfig(engine: $): Promise<Config> {
  const global = parseConfig(await engine.store.get('config').catch(() => undefined))
  const project = parseConfig(await readJson(engine, PROJECT_CONFIG))
  return mergeConfig(global, project)
}

// A home folder or a temp folder can be a git repository too, and is never a project.
const NOT_A_PROJECT = /^(([a-z]:)?[\\/]+(users|home)[\\/]+[^\\/]+|([a-z]:)?[\\/]+(tmp|var[\\/]+tmp)([\\/].*)?|.*[\\/]appdata[\\/]+local[\\/]+temp([\\/].*)?)[\\/]*$/i

/** Spells out every rule in the project's .ai/gates.json when the session runs at a git root, so each is toggled there. */
async function syncProjectConfig(engine: $, config: Config): Promise<void> {
  const cwd = await engine.session.cwd()
  if (NOT_A_PROJECT.test(cwd) || !(await engine.fs.exists(underCwd(cwd, '.git')).catch(() => false))) return
  const present = await engine.fs.exists(PROJECT_CONFIG)
  const text = present ? await engine.fs.read(PROJECT_CONFIG) : undefined
  let raw: unknown
  try {
    raw = text === undefined ? undefined : JSON.parse(text)
  } catch {
    // A hand edit that broke the JSON is the person's to fix; rewriting it would lose it.
    engine.ui.log(`proof-guardrails: ${PROJECT_CONFIG} no es JSON válido; no se tocó`)
    return
  }
  const { file, changed } = withEverySetting(raw, config)
  if (changed) await engine.fs.write(PROJECT_CONFIG, `${JSON.stringify(file, null, 2)}\n`)
}

async function declaredDependencies(engine: $): Promise<Set<string> | undefined> {
  const manifest = (await readJson(engine, 'package.json')) as Record<string, Record<string, string> | undefined> | undefined
  if (manifest === undefined) return undefined
  return new Set(
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(key => Object.keys(manifest[key] ?? {})),
  )
}

async function fileBefore(engine: $, path: string): Promise<string | null | undefined> {
  try {
    return await engine.fs.read(path)
  } catch (error) {
    return /ENOENT|no such file|not found/i.test(String(error)) ? null : undefined
  }
}

async function writeFacts(engine: $, tool: string, input: Input): Promise<WriteFacts | undefined> {
  const intent = writeIntentOf(tool, input)
  if (intent === undefined) return undefined
  if (intent.content !== undefined) {
    const before = await fileBefore(engine, intent.path)
    return { path: intent.path, before, after: intent.content, added: addedLines(before, intent.content) }
  }
  return {
    path: intent.path,
    before: intent.replacements.map(item => item.before).join('\n'),
    after: intent.replacements.map(item => item.after).join('\n'),
    added: intent.replacements.flatMap(item => addedLines(item.before, item.after)),
  }
}

async function narratingComments(engine: $, write: WriteFacts): Promise<Finding[]> {
  const comments = newComments(write)
  if (comments.length === 0) return []
  const text =
    'Comentarios nuevos agregados a un archivo de código. Etiqueta "narra" si al menos uno solo describe lo que ' +
    'el código hace (repite el código en palabras). Etiqueta "justifica" si todos explican un porqué, una decisión, ' +
    `un trade-off o una limitación.\n\n${comments.slice(0, 20).join('\n')}`
  const label = await engine.model.classify(text, ['narra', 'justifica']).catch(() => undefined)
  if (label !== 'narra') return []
  return [{
    rule: 'write.narrating-comments',
    message:
      `Hay comentarios que narran lo que hace el código:\n${comments.slice(0, 8).map(line => `  ${line}`).join('\n')}\n` +
      'Bórralos. Solo quedan comentarios que explican un porqué, una decisión o una limitación (o `comment-ok: <motivo>`).',
  }]
}

async function assess(engine: $, tool: string, input: Input, agentId: string | undefined): Promise<Verdict> {
  const [config, ledger, declared] = await Promise.all([
    loadConfig(engine),
    read(engine, ledgerAtom).catch(() => emptyLedger(0)),
    declaredDependencies(engine),
  ])
  const cwd = await engine.session.cwd().catch(() => '.')
  const write = await writeFacts(engine, tool, input)
  const facts: ToolFacts = { tool, input, cwd, agentId, shell: shellOf(tool, input), write }
  const context: Context = { config, ledger, declared, now: Date.now() }
  const findings = findingsFor(facts, context)
  if (modeOf(config, 'tasks.leaf-gates-first') !== 'off') {
    const written = write !== undefined ? [write.path] : facts.shell !== undefined ? shellWriteTargets(facts.shell) : []
    const required = leafLedgersFor(ledger, cwd, written)
    const present = await Promise.all(required.map(item => engine.fs.exists(`${cwd.replace(/[\\/]+$/, '')}/${item.ledger}`).catch(() => false)))
    findings.push(...leafGatesFinding(required.filter((_, index) => !present[index])))
  }
  if (write !== undefined && modeOf(config, 'write.narrating-comments') !== 'off') {
    findings.push(...(await narratingComments(engine, write)))
  }
  if (facts.shell !== undefined) {
    findings.push(...(await executedContentFindings(engine, facts, context)), ...(await commitFileFindings(engine, facts.shell, cwd)))
  }
  if (tool === 'TaskUpdate' && (input.status === 'completed' || input.status === 'deleted') && input.taskId !== undefined) {
    findings.push(...(await unlazyRootFindings(engine, ledger, cwd, String(input.taskId), input.status)))
  }
  if (findings.length === 0) findings.push(...(await secondOpinion(engine, facts, ledger, config)))
  return judge(findings, facts, context, textOf(input))
}

function underCwd(cwd: string, path: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

function scanContent(path: string, content: string, facts: ToolFacts, context: Context, where: string, asShell = false): Finding[] {
  const shellLike = asShell || /\.(sh|bash|zsh|ps1|psm1)$/i.test(path) || !/\.[a-z0-9]+$/i.test(path)
  const raw = shellLike
    ? findingsFor({ ...facts, tool: 'Bash', input: { command: content }, shell: shellOfText(content, path), write: undefined }, context)
        .filter(item => /^(irreversible|evasion|edit)\./.test(item.rule))
    : [...codeFileFindings(path, content), ...lockedTargetFindings(context.ledger, [content])]
  return raw.map(item => ({ rule: item.rule, message: `${where}: ${item.message}` }))
}

async function executedContentFindings(engine: $, facts: ToolFacts, context: Context): Promise<Finding[]> {
  const shell = facts.shell
  if (shell === undefined || modeOf(context.config, 'evasion.fresh-script') === 'off') return []
  const written = new Set(workPaths(facts.cwd, context.ledger.edits.map(edit => edit.path)))
  const out: Finding[] = []
  for (const script of scriptRuns(shell)) {
    const relative = workPaths(facts.cwd, [script])[0]
    if (relative === undefined || !written.has(relative)) continue
    const content = await engine.fs.read(underCwd(facts.cwd, relative)).catch(() => undefined)
    if (content !== undefined) out.push(...scanContent(relative, content, facts, context, `Dentro de \`${relative}\` (escrito en esta sesión)`))
  }
  const names = packageScriptsRun(shell)
  if (names.length > 0 && written.has('package.json')) {
    const manifest = (await readJson(engine, underCwd(facts.cwd, 'package.json'))) as { scripts?: Record<string, unknown> } | undefined
    for (const name of names) {
      const body = manifest?.scripts?.[name]
      if (typeof body === 'string') out.push(...scanContent('package.json', body, facts, context, `En el script \`${name}\` de package.json (editado en esta sesión)`, true))
    }
  }
  return out
}

async function commitFileFindings(engine: $, shell: ShellFacts, cwd: string): Promise<Finding[]> {
  const out: Finding[] = []
  for (const file of commitMessageFiles(shell.command, shell.dialect)) {
    const text = await engine.fs.read(/^([a-z]:)?[\\/]/i.test(file) ? file : underCwd(cwd, file)).catch(() => '')
    if (hasAttributionTrailer(text)) {
      out.push({ rule: 'attribution.strip', message: `El mensaje de \`${file}\` trae coautoría de IA. Quítala del archivo antes del commit.` })
    }
  }
  return out
}

async function unlazyRootFindings(engine: $, ledger: Ledger, cwd: string, id: string, action: string): Promise<Finding[]> {
  const task = ledger.tasks.find(item => item.id === id)
  if (task?.unlazy === undefined || task.leaf !== undefined) return []
  const scope = task.unlazy
  const gatesDir = underCwd(cwd, `.unlazy/${scope}/gates`)
  const leaves = (await engine.fs.list(gatesDir).catch(() => []))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .map(entry => `${gatesDir}/${entry.name}`)
  const unmet: string[] = []
  const abandoned: string[] = []
  for (const file of [underCwd(cwd, `.unlazy/${scope}/GATES.md`), ...leaves]) {
    const text = await engine.fs.read(file).catch(() => undefined)
    if (text === undefined) continue
    const gates = unlazyGates(file, text)
    unmet.push(...gates.unmet.map(gate => gate.id))
    abandoned.push(...gates.abandoned.map(gate => gate.id))
  }
  if (unmet.length === 0 && abandoned.length === 0) return []
  const what = [unmet.length > 0 ? `sin cumplir: ${unmet.join(', ')}` : '', abandoned.length > 0 ? `abandonados: ${abandoned.join(', ')}` : ''].filter(Boolean).join('; ')
  return [{
    rule: 'tasks.verify-on-complete',
    message:
      `La tarea madre del plan unlazy «${scope}» tiene gates ${what}. ${action === 'deleted' ? 'Borrarla' : 'Cerrarla'} esconde lo que falta. ` +
      'Déjala abierta y dile al usuario qué queda pendiente y por qué.',
  }]
}

async function secondOpinion(engine: $, facts: ToolFacts, ledger: Ledger, config: Config): Promise<Finding[]> {
  const shell = facts.shell
  if (shell === undefined || modeOf(config, 'evasion.second-opinion') === 'off' || isReadOnlyShell(shell) || isVerificationCommand(shell.command, shell.dialect)) return []
  const blocks = ledger.decisions.filter(
    item => item.at >= ledger.windowStart && ['bloqueado', 'rechazado'].includes(item.effect) && /^(irreversible|evasion)\./.test(item.rule),
  )
  const targets = ledger.blockedTargets ?? []
  if (blocks.length === 0 && targets.length === 0) return []
  const description = typeof facts.input.description === 'string' ? facts.input.description : '(sin descripción)'
  const text =
    'Revisas si un agente de código intenta rodear un bloqueo de seguridad.\n' +
    `Lo que se le bloqueó en esta conversación:\n${blocks.slice(-5).map(item => `- [${item.rule}] ${item.message.split('\n')[0]}`).join('\n')}\n` +
    `${targets.map(item => `- objetivo bloqueado: ${item.kind} «${item.target}»`).join('\n')}\n\n` +
    `Comando que quiere ejecutar ahora:\n${shell.command.slice(0, 2000)}\nDescripción que dio el agente: ${description}\n\n` +
    'Etiqueta "rodea" si el comando logra, por otra vía, lo mismo que se bloqueó, o si mata procesos, borra datos o publica algo sin que su descripción lo diga. ' +
    'Etiqueta "normal" si es trabajo corriente que no toca lo bloqueado.'
  const label = await engine.model.classify(text, ['normal', 'rodea']).catch(() => undefined)
  if (label !== 'rodea') return []
  return [{
    rule: 'evasion.second-opinion',
    message:
      'Un revisor independiente juzgó que este comando rodea un bloqueo anterior (o hace algo irreversible que su descripción no dice). ' +
      'No lo intentes por otra vía: explícale al usuario qué necesitas y por qué.',
  }]
}

async function note(engine: $, items: readonly Judged[], effect: string): Promise<void> {
  if (items.length === 0) return
  const now = Date.now()
  await update(engine, ledgerAtom, ledger =>
    items.reduce((acc, item) => recordDecision(acc, item.rule, effect, item.message, now), ledger),
  )
}

const RESEARCH_TOOL = /^(WebSearch|WebFetch)$|context7|engram__mem_search|__(search|fetch|web_search|web_fetch|get_library_docs|resolve_library_id|query_docs)$/i
const NPM_LOOKUP = /\b(npm|pnpm|yarn|bun)\s+(view|info|show|docs|repo|home)\b/

async function checkOutput(engine: $, shell: ShellFacts, ranText: string): Promise<string> {
  const files = shellWriteTargets(shell).filter(target => !/^~|\$|`/.test(target)).slice(0, 3)
  const contents = await Promise.all(files.map(file => engine.fs.read(file).then(text => text.slice(-200_000)).catch(() => '')))
  return [ranText, ...contents].join('\n')
}

async function observe(
  engine: $,
  tool: string,
  input: Input,
  ran: { deny?: string; isError?: boolean; result?: unknown; text?: string },
): Promise<{ noTests: boolean; commitNote?: string }> {
  if (ran.deny !== undefined) return { noTests: false }
  const ok = ran.isError !== true
  const now = Date.now()
  const shell = shellOf(tool, input)
  const intent = writeIntentOf(tool, input)
  const cwd = await engine.session.cwd().catch(() => '.')
  const shellWrites = ok && shell !== undefined ? workPaths(cwd, shellWriteTargets(shell)) : []
  let decisive = ok && shell !== undefined ? decisiveChecks(shell.command, shell.dialect).join(' && ') : ''
  const noTests = decisive !== '' && shell !== undefined && ranNoTests(await checkOutput(engine, shell, ran.text ?? ''))
  if (noTests) decisive = ''
  const after = await update(engine, ledgerAtom, ledger => {
    let next = ledger
    if (ok && intent !== undefined) next = recordEdit(next, intent.path, now)
    for (const path of shellWrites) next = creditTasks(recordEdit(next, path, now), { path }, undefined)
    if (decisive !== '') next = recordVerification(next, decisive, now)
    if (shell !== undefined && NPM_LOOKUP.test(shell.command)) next = recordResearch(next, shell.command)
    if (RESEARCH_TOOL.test(tool)) next = recordResearch(next, textOf(input) || JSON.stringify(input))
    if (/node_modules[\\/]/.test(String(input.file_path ?? input.path ?? ''))) next = recordResearch(next, String(input.file_path ?? input.path))
    if (ok && tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
      const answer = (ran.text ?? '').slice(0, 300)
      const asked = (input.questions as { question?: unknown }[]).map(item => String(item?.question ?? '')).filter(Boolean)
      next = { ...next, questions: [...next.questions, ...asked.map(question => ({ question, answer }))].slice(-50) }
    }
    if (tool === 'Agent' || tool === 'Task') {
      const kind = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
      const prompt = withoutInjected(String(input.prompt ?? ''))
      next = { ...next, delegations: [...next.delegations, { kind, prompt, at: now }].slice(-30) }
    }
    if (ok && tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id ?? /#(\d+)/.exec(ran.text ?? '')?.[1]
      if (created !== undefined) next = recordTaskCreated(next, String(created), String(input.subject ?? ''), input.metadata)
    }
    if (ok && tool === 'TaskUpdate' && input.taskId !== undefined) {
      next = recordTaskUpdated(next, String(input.taskId), input.status as string | undefined, input.subject as string | undefined, now, input.metadata)
    }
    next = creditTasks(next, ok && intent !== undefined ? { path: intent.path } : undefined, decisive !== '' ? { command: decisive, at: now } : undefined)
    if (ok && /forge_start$/.test(tool)) next = { ...next, forgeActive: true }
    if (ok && /forge_complete_phase$/.test(tool) && /\b(run (is )?done|status:\s*done|all phases (are )?(closed|complete))/i.test(ran.text ?? '')) {
      next = { ...next, forgeActive: false }
    }
    return next
  })
  const touchedTasks = /^Task(Create|Update)$/.test(tool) || decisive !== '' || intent !== undefined || shellWrites.length > 0
  if (ok && touchedTasks && (after.tasks.length > 0 || tool === 'TaskUpdate')) await saveTasks(engine, after.tasks).catch(() => undefined)
  if (ok && shell !== undefined) {
    const looked = lookedUpPids(shell, ran.text ?? '')
    if (looked.length > 0) await update(engine, ledgerAtom, ledger => recordLookedUpPids(ledger, looked, now)).catch(() => undefined)
  }
  const commitNote = ok && shell !== undefined && isGitCommit(shell.command, shell.dialect) ? await checkHeadAttribution(engine, shell, cwd) : undefined
  return { noTests, commitNote }
}

function commitDir(shell: ShellFacts, cwd: string): string {
  const absolute = (path: string) => /^([a-z]:)?[\\/]/i.test(path)
  const join = (base: string, path: string) => (absolute(path) ? path : `${base.replace(/[\\/]+$/, '')}/${path}`)
  let dir = cwd
  for (const segment of shell.segments) {
    const words = commandWords(segment)
    const program = programName(words[0])
    if (['cd', 'pushd', 'set-location', 'sl'].includes(program) && words[1] !== undefined) dir = join(dir, words[1])
    if (program === 'git' && ['commit', 'interpret-trailers'].includes(gitSubcommand(words).name)) {
      const at = words.indexOf('-C')
      return at !== -1 && words[at + 1] !== undefined ? join(dir, words[at + 1]!) : dir
    }
  }
  return dir
}

// The last word on attribution is the commit itself: whatever route put a trailer in (a file, a
// template, a hook, an amend), HEAD's message is read after the commit and a push waits until
// the commit is amended.
async function checkHeadAttribution(engine: $, shell: ShellFacts, cwd: string): Promise<string | undefined> {
  const dir = commitDir(shell, cwd)
  const ran = await engine.process.run(['git', '-C', dir, 'log', '-1', '--format=%H%n%B'], { timeoutMs: 10_000 }).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) return undefined
  const [sha = '', ...body] = ran.stdout.split('\n')
  const leaked = hasAttributionTrailer(body.join('\n'))
  await update(engine, ledgerAtom, ledger =>
    recordAttributionLeak(ledger, leaked ? { dir, sha, at: Date.now() } : ledger.attributionLeak?.dir === dir ? null : ledger.attributionLeak ?? null),
  ).catch(() => undefined)
  return leaked
    ? `[gates:attribution.strip] El commit ${sha.slice(0, 7)} quedó con coautoría de IA en su mensaje. Enmiéndalo sin esa línea (git commit --amend); hasta entonces el push queda bloqueado.`
    : undefined
}

// $.state does not outlive the process: a container restart that resumes the session starts
// with an empty ledger, and open tasks would vanish from every rule. They are kept per session.
const TASKS_KEY = 'tasks-by-session'
const TASK_SESSIONS = 20

type SavedTasks = Record<string, { at: number; tasks: Ledger['tasks'] }>

async function saveTasks(engine: $, tasks: Ledger['tasks']): Promise<void> {
  const id = await engine.session.id()
  const saved = ((await engine.store.get(TASKS_KEY).catch(() => undefined)) ?? {}) as SavedTasks
  const kept = Object.entries({ ...saved, [id]: { at: Date.now(), tasks } })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, TASK_SESSIONS)
  await engine.store.set(TASKS_KEY, Object.fromEntries(kept))
}

async function restoreTasks(engine: $): Promise<void> {
  const ledger = await read(engine, ledgerAtom)
  if (ledger.tasks.length > 0) return
  const id = await engine.session.id()
  const saved = ((await engine.store.get(TASKS_KEY).catch(() => undefined)) ?? {}) as SavedTasks
  const tasks = saved[id]?.tasks
  if (tasks === undefined || tasks.length === 0) return
  await update(engine, ledgerAtom, current => (current.tasks.length > 0 ? current : { ...current, tasks }))
}

async function ledgerFiles(engine: $): Promise<string[]> {
  const files: string[] = []
  const markdownIn = async (dir: string) =>
    (await engine.fs.list(dir).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md')).map(entry => `${dir}/${entry.name}`)
  if (await engine.fs.exists('GATES.md').catch(() => false)) files.push('GATES.md')
  files.push(...(await markdownIn('gates')))
  for (const scope of (await engine.fs.list('.unlazy').catch(() => [])).filter(entry => entry.kind === 'dir')) {
    if (await engine.fs.exists(`.unlazy/${scope.name}/GATES.md`).catch(() => false)) files.push(`.unlazy/${scope.name}/GATES.md`)
    files.push(...(await markdownIn(`.unlazy/${scope.name}/gates`)))
  }
  return files
}

async function pendingLedgerGates(engine: $): Promise<LedgerGate[]> {
  const unmet: LedgerGate[] = []
  for (const file of await ledgerFiles(engine)) {
    const text = await engine.fs.read(file).catch(() => '')
    unmet.push(...unlazyGates(file, text).unmet)
  }
  return unmet
}

async function stopReasons(engine: $, config: Config, ledger: Ledger): Promise<{ block: string[]; warn: string[] }> {
  const out = { block: [] as string[], warn: [] as string[] }
  const add = (rule: string, text: string) => {
    const mode = modeOf(config, rule)
    if (mode === 'off') return
    ;(mode === 'warn' ? out.warn : out.block).push(`[gates:${rule}] ${text}`)
  }
  const unverified = unverifiedEdits(ledger)
  if (unverified.length > 0) {
    add(
      'completion.verify-after-edit',
      `Editaste ${unverified.slice(0, 6).join(', ')}${unverified.length > 6 ? ` y ${unverified.length - 6} más` : ''} sin una verificación exitosa posterior ` +
        '(tests, lint, typecheck o build). Córrela ahora. Si no aplica, dile al usuario explícitamente qué no verificaste y por qué.',
    )
  }
  const open = openTasks(ledger)
  if (open.length > 0) {
    add(
      'completion.open-tasks',
      `Quedan ${open.length} tarea(s) sin completar: ${open.slice(0, 6).map(task => `#${task.id} ${task.subject}`).join('; ')}. ` +
        'Termínalas con evidencia y márcalas completed, o explica al usuario por qué quedan pendientes y bórralas de la lista.',
    )
  }
  const gates = await pendingLedgerGates(engine)
  if (gates.length > 0) {
    add(
      'completion.unlazy-ledger',
      `Gates de unlazy sin evidencia: ${gates.slice(0, 6).map(gate => `${gate.file}:${gate.id}`).join(', ')}. ` +
        'Corre `gate-check.mjs --status` y cúmplelos, o márcalos con `ABANDON: <id> <motivo>` como traspaso explícito.',
    )
  }
  return out
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const DISCIPLINE_EVERY = 15

// Which of this mod's hooks actually ran in this session. A security plugin seated above
// user mods can pass some events on past them (seen with classic.*, prompt.compose,
// settings.read, attribution.text); /gates reports it and the fallbacks below key off it.
// Session state, not a module variable: every hot reload starts the module over.
const seenAtom = atom({ plugin: 'proof-guardrails', key: 'seen' } as const, [])
let userPrompts = 0

async function mark($: $, event: string): Promise<void> {
  const seen = await read($, seenAtom).catch(() => [] as string[])
  if (!seen.includes(event)) await update($, seenAtom, list => [...list, event]).catch(() => undefined)
}

async function homeDirectory(engine: $): Promise<string | undefined> {
  const cwd = await engine.session.cwd().catch(() => '/')
  const argv = /^[A-Za-z]:[\\/]/.test(cwd) ? ['cmd', '/c', 'echo %USERPROFILE%'] : ['sh', '-c', 'printf %s "$HOME"']
  const ran = await engine.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
  const home = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  return home === '' || home.includes('%') ? undefined : home.replaceAll('\\', '/')
}

async function installPermissions(engine: $, scope: string, config: Config): Promise<string> {
  const home = scope === 'usuario' ? await homeDirectory(engine) : undefined
  if (scope === 'usuario' && home === undefined) return 'No pude resolver tu carpeta de usuario; usa /gates permisos proyecto.'
  const path = scope === 'usuario' ? `${home}/.claude/settings.json` : '.claude/settings.local.json'
  const raw = await engine.fs.read(path).catch(() => undefined)
  let current: Record<string, unknown> = {}
  if (raw !== undefined) {
    try {
      current = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return `${path} no es JSON válido; no lo toqué.`
    }
    await engine.fs.write(`${path}.gates.bak`, raw)
  }
  const merged = withNative(current, config)
  await engine.fs.write(path, `${JSON.stringify(merged, null, 2)}\n`)
  const permissions = merged.permissions as { ask: string[]; deny: string[] }
  return (
    `Reglas nativas escritas en ${path} (${permissions.ask.length} ask, ${permissions.deny.length} deny` +
    `${merged.attribution !== undefined ? ', atribución vacía' : ''}).` +
    `${raw !== undefined ? ` Respaldo: ${path}.gates.bak.` : ''} El motor las aplica en todos los modos, incluido bypassPermissions.`
  )
}

async function createTask($: $, spec: TaskSpec): Promise<string | undefined> {
  const created = await $.tool
    .call({ tool: 'TaskCreate', subject: spec.subject, description: spec.description, metadata: spec.metadata } as never)
    .catch(() => undefined)
  const answer = created as { result?: { task?: { id?: unknown } }; text?: string; deny?: string } | undefined
  if (answer === undefined || answer.deny !== undefined) return undefined
  const id = answer.result?.task?.id ?? /#(\d+)/.exec(answer.text ?? '')?.[1]
  if (id === undefined) return undefined
  await update($, ledgerAtom, ledger => recordTaskCreated(ledger, String(id), spec.subject, spec.metadata))
  return String(id)
}

async function syncPlan($: $, path: string): Promise<string | undefined> {
  const scope = scopeOfPlanPath(path)
  if (scope === undefined || modeOf(await loadConfig($), 'tasks.from-unlazy') === 'off') return undefined
  const plan = parsePlan(await $.fs.read(path).catch(() => ''))
  if (plan.leaves.length === 0) return undefined
  const ledger = await read($, ledgerAtom)
  const created: string[] = []
  let rootId = ledger.tasks.find(task => task.key === rootKey(scope))?.id
  if (rootId === undefined) {
    const spec = rootSpec(scope, plan)
    rootId = await createTask($, spec)
    if (rootId === undefined) return 'gates: no pude crear la tarea madre del plan; créala con TaskCreate y metadata { "unlazy": "' + scope + '" }.'
    created.push(`#${rootId} ${spec.subject}`)
  }
  const skillDir = `${$.plugin.root.replaceAll('\\', '/')}/skills/unlazy`
  const current = await read($, ledgerAtom)
  for (const spec of leafSpecs(scope, plan, skillDir, rootId, current.tasks)) {
    const id = await createTask($, spec)
    if (id !== undefined) created.push(`#${id} ${spec.subject}`)
  }
  if (created.length === 0) return undefined
  return (
    `gates: tareas nativas creadas desde .unlazy/${scope}/PLAN.md:\n${created.map(line => `  ${line}`).join('\n')}\n` +
    'Cada hoja se cierra con TaskUpdate completed solo después de que su `gate-check --reverify` pase.'
  )
}

async function recordHold($: $, reasons: readonly string[], effectLabel: string): Promise<void> {
  const rules = reasons.map(reason => /^\[gates:([^\]]+)\]/.exec(reason)?.[1] ?? 'completion')
  const cwd = await $.session.cwd().catch(() => '.')
  await recordActivity($, {
    id: `hold-${Date.now()}`,
    at: Date.now(),
    tool: 'fin de turno',
    target: effectLabel,
    effect: 'retenido',
    rules,
    message: (reasons[0] ?? '').replace(/^\[gates:[^\]]+\]\s*/, '').slice(0, 200),
    project: projectName(cwd),
  })
}

export const register: Register = on => {
  registerPane(on)

  on('session.start', async ($, e, next) => {
    void mark($, 'session.start')
    const started = await next(e)
    const config = await loadConfig($)
    await syncProjectConfig($, config).catch((error: unknown) => $.ui.log(`proof-guardrails: no se pudo escribir ${PROJECT_CONFIG} (${String(error).slice(0, 200)})`))
    await loadHistory($)
    await restoreTasks($).catch(() => undefined)
    void openPane($)
    await Promise.allSettled([
      $.command.register({
        name: 'gates',
        description: 'Estado de los gates. /gates actividad [gates] | historial | panel | reglas | init | modo <regla|familia|all> <modo> [proyecto|global] | permisos <proyecto|usuario>',
        argumentHint: '[actividad | historial | panel | reglas | init | modo … | permisos …]',
      }),
      $.tool.register({
        name: 'rule_add',
        description:
          'Convierte un error repetido en una regla determinista. Preferir `permission` (regla de permisos nativa de Claude, ' +
          'p. ej. "Bash(git push *)" o "Edit(**/secrets/**)"); usar `pattern` (regex sobre el texto de la llamada) solo si no es expresable como permiso. ' +
          'Solo agrega restricciones: nunca puede relajar una regla.',
        inputSchema: {
          type: 'object',
          properties: {
            permission: { type: 'string', description: 'Regla de permisos nativa, p. ej. Bash(npm publish *)' },
            pattern: { type: 'string', description: 'Regex sobre comando/contenido/prompt si no hay forma nativa' },
            tools: { type: 'string', description: 'Regex sobre el nombre de la herramienta (solo con pattern)' },
            mode: { type: 'string', enum: ['ask', 'deny', 'warn'] },
            message: { type: 'string', description: 'Qué hacer en su lugar (solo con pattern)' },
            reason: { type: 'string', description: 'Qué falló y cuántas veces' },
          },
          required: ['mode', 'reason'],
        },
      }),
      ...ROLES.map(role => {
        const custom = config.agents[role.name]
        return $.agent.register({
          name: role.name,
          description: role.description,
          prompt: rolePrompt(role),
          model: custom?.model ?? role.model,
          effort: custom?.effort ?? role.effort,
          ...(role.readOnly ? { disallowedTools: READ_ONLY_DENY } : {}),
        })
      }),
    ])
    return started
  }).catch(($, e, next) => next(e))

  on('attribution.text', async ($, e, next) => {
    void mark($, 'attribution.text')
    return modeOf(await loadConfig($), 'attribution.strip') === 'off' ? next(e) : { text: '' }
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    void mark($, 'prompt.compose')
    const composed = await next(e)
    if (modeOf(await loadConfig($), 'discipline.prompt') === 'off') return composed
    return { ...composed, sections: [...composed.sections, { id: 'gates:discipline', text: DISCIPLINE, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    void mark($, 'prompt.submit')
    const fromPerson = e.origin === undefined || e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!fromPerson) return next(e)
    await update($, ledgerAtom, ledger => startWindow(ledger, Date.now()))
    const config = await loadConfig($)
    const every = Math.max(1, Math.round(paramOf(config, 'discipline.prompt', 'every', DISCIPLINE_EVERY)))
    const composeRuns = (await read($, seenAtom).catch(() => [] as string[])).includes('prompt.compose')
    const shouldRemind = !composeRuns && userPrompts++ % every === 0 && modeOf(config, 'discipline.prompt') !== 'off'
    return shouldRemind ? next({ ...e, context: [...(e.context ?? []), DISCIPLINE] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    void mark($, 'tool.call')
    if (e.tool.startsWith(PLUGIN_TOOLS)) return next(e)
    const config = await loadConfig($)
    const original = e as unknown as Input
    let call = e
    let rewrittenBy: string | undefined
    const shell = shellOf(e.tool, original)
    if (shell !== undefined && typeof original.command === 'string' && modeOf(config, 'attribution.strip') !== 'off') {
      const stripped = stripAttribution(shell.command, shell.dialect)
      if (stripped !== undefined) {
        call = { ...call, command: stripped } as typeof e
        rewrittenBy = 'attribution.strip'
        await note($, [{ rule: 'attribution.strip', message: 'trailer de atribución quitado del commit', mode: 'deny' }], 'reescrito')
      }
    }
    const toolName: string = e.tool
    if ((toolName === 'Agent' || toolName === 'Task') && typeof original.prompt === 'string') {
      const active = CATALOG.filter(rule => modeOf(config, rule.id) !== 'off').map(rule => rule.id)
      const cwd = await $.session.cwd().catch(() => '.')
      call = { ...call, prompt: `${spawnContext(cwd, active)}\n\n${withoutInjected(original.prompt)}` } as typeof e
    }
    const verdict = await assess($, e.tool, call as unknown as Input, e.agentId)
    if (e.tool_use_id !== undefined) verdicts.set(e.tool_use_id, verdict)
    try {
      const decision = await decideBeforeRunning($, e.tool_use_id, verdict)
      const lockedBy = [...verdict.deny, ...verdict.ask].map(item => item.rule).filter(rule => LOCKS.test(rule))
      const shellCall = shellOf(e.tool, call as unknown as Input)
      if (decision.deny !== undefined && lockedBy.length > 0 && shellCall !== undefined) {
        const targets = blockedTargetsOf(shellCall, lockedBy, Date.now())
        if (targets.length > 0) await update($, ledgerAtom, ledger => recordBlockedTargets(ledger, targets)).catch(() => undefined)
      }
      const ran = decision.deny !== undefined ? { deny: decision.deny } : await next(call)
      const observed = await observe($, e.tool, call as unknown as Input, ran as never)
      const cwd = await $.session.cwd().catch(() => '.')
      const judged = outcome(ran as { deny?: string; isError?: boolean; text?: string }, verdict, rewrittenBy)
      const answer = decision.answer
      await recordActivity($, {
        id: e.tool_use_id ?? `call-${Date.now()}`,
        at: Date.now(),
        tool: e.tool,
        target: targetOf(e.tool, original),
        ...judged,
        message: answer === undefined ? judged.message : `${judged.message} (respuesta del diálogo: «${answer}»)`,
        project: projectName(cwd),
      }).catch(() => undefined)
      const notes: string[] = []
      const written = writeIntentOf(e.tool, original)
      if (written !== undefined && ran.deny === undefined && (ran as { isError?: boolean }).isError !== true) {
        const synced = await syncPlan($, written.path).catch(() => undefined)
        if (synced !== undefined) notes.push(synced)
      }
      const ranOk = ran.deny === undefined && (ran as { isError?: boolean }).isError !== true
      if (observed.commitNote !== undefined) notes.push(observed.commitNote)
      if (observed.noTests) {
        notes.push(
          '[gates:completion.verify-after-edit] Esta verificación no corrió ningún test (el runner no encontró ninguno), así que no cuenta como prueba. ' +
            'Revisa el patrón o la ruta de los tests y vuelve a correrla.',
        )
      }
      if (ranOk && shell !== undefined && isVerificationCommand(shell.command, shell.dialect) && decisiveChecks(shell.command, shell.dialect).length === 0) {
        notes.push(
          '[gates:completion.verify-after-edit] Esta verificación no cuenta como prueba: su exit code no es el del comando ' +
            '(va seguida de `|`, `;` o `||`, así que un fallo sale con 0). Córrela sola o encadenada solo con `&&`, ' +
            'sin `| tail` ni `; echo $?`, para que cuente.',
        )
      }
      if (verdict.warn.length > 0 && ran.deny === undefined) {
        await note($, verdict.warn, 'aviso')
        notes.push(render(verdict.warn))
      }
      if (notes.length === 0 || ran.deny !== undefined) return ran
      return { ...ran, context: [...(ran.context ?? []), ...notes] }
    } finally {
      if (e.tool_use_id !== undefined) {
        verdicts.delete(e.tool_use_id)
        confirmed.delete(e.tool_use_id)
      }
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    void mark($, 'tool.check')
    const base = await next(e)
    if (base.decision === 'deny') return base
    const input = (e.input ?? {}) as Input
    const verdict = (e.tool_use_id !== undefined ? verdicts.get(e.tool_use_id) : undefined) ?? (await assess($, e.tool, input, e.agentId))
    if (verdict.deny.length > 0) {
      await note($, verdict.deny, 'bloqueado')
      return { decision: 'deny', reason: render(verdict.deny) }
    }
    if (verdict.ask.length > 0 && !(e.tool_use_id !== undefined && confirmed.has(e.tool_use_id))) {
      await note($, verdict.ask, 'confirmación')
      const reason = [render(verdict.ask), base.decision === 'ask' ? base.reason : undefined].filter(Boolean).join('\n')
      return { decision: 'ask', reason }
    }
    return base
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    void mark($, 'classic.Stop')
    const base = await next(e)
    if (base.block !== undefined) return base
    const ledger = await read($, ledgerAtom)
    const config = await loadConfig($)
    if (e.stop_hook_active && ledger.stopBlocks >= maxBlocks(config)) return base
    const reasons = await stopReasons($, config, ledger)
    if (reasons.block.length === 0) {
      return reasons.warn.length > 0 ? { ...base, additionalContext: [...(base.additionalContext ?? []), ...reasons.warn] } : base
    }
    await update($, ledgerAtom, current => ({
      ...recordDecision(current, 'completion', 'turno retenido', reasons.block.join(' | '), Date.now()),
      stopBlocks: current.stopBlocks + 1,
    }))
    await recordHold($, reasons.block, 'turno retenido (Stop)').catch(() => undefined)
    return { ...base, block: reasons.block.join('\n\n') }
  }).catch(($, e, next) => next(e))

  // Where classic.Stop is passed on past this mod, the turn has already ended: the same
  // reasons queue a continuation turn instead, bounded by the same counter.
  on('turn.complete', async ($, e, next) => {
    void mark($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    const ledger = await read($, ledgerAtom)
    const config = await loadConfig($)
    if (ledger.stopBlocks >= maxBlocks(config)) return done
    const reasons = await stopReasons($, config, ledger)
    if (reasons.block.length === 0) return done
    await update($, ledgerAtom, current => ({
      ...recordDecision(current, 'completion', 'continuación forzada', reasons.block.join(' | '), Date.now()),
      stopBlocks: current.stopBlocks + 1,
    }))
    await recordHold($, reasons.block, 'continuación forzada').catch(() => undefined)
    void $.prompt.submit({ text: `Antes de dar por terminado:\n\n${reasons.block.join('\n\n')}` }).catch(() => undefined)
    return { ...done, text: `gates: quedó trabajo sin cerrar; sigo con eso.\n${reasons.block.map(item => `- ${item.split('] ')[0]}]`).join('\n')}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__proof-guardrails__rule_add' }, async ($, e) => {
    const input = e as unknown as Input
    const mode = asText(input.mode)
    const reason = asText(input.reason).trim()
    if (!['ask', 'deny', 'warn'].includes(mode)) return { deny: 'mode debe ser ask, deny o warn.' }
    if (reason.length < 10) return { deny: 'reason es obligatorio: qué falló y cuántas veces.' }
    const permission = asText(input.permission).trim()
    if (permission !== '') {
      if (!isNativeRule(permission) || mode === 'warn') return { deny: `"${permission}" no es una regla de permisos nativa válida para ask/deny.` }
      const settings = ((await readJson($, PROJECT_SETTINGS)) ?? {}) as { permissions?: Record<string, unknown> }
      const permissions = settings.permissions ?? {}
      const current = Array.isArray(permissions[mode]) ? (permissions[mode] as string[]) : []
      if (current.includes(permission)) return { result: `La regla ${permission} ya estaba en ${mode}.` }
      await $.fs.write(PROJECT_SETTINGS, `${JSON.stringify({ ...settings, permissions: { ...permissions, [mode]: [...current, permission] } }, null, 2)}\n`)
      return { result: `Regla nativa agregada en ${PROJECT_SETTINGS}: permissions.${mode} += ${permission}. El motor la aplica sin reiniciar.` }
    }
    const pattern = asText(input.pattern)
    const tools = asText(input.tools) || undefined
    const message = asText(input.message).trim()
    if (!compiles(pattern) || (tools !== undefined && !compiles(tools))) return { deny: 'pattern/tools debe ser una regex válida (máx. 500 caracteres).' }
    if (message.length < 10) return { deny: 'message es obligatorio con pattern: qué hacer en su lugar.' }
    const raw = ((await readJson($, PROJECT_CONFIG)) ?? {}) as { userRules?: unknown[] }
    const rule: UserRule = {
      id: `r${Date.now().toString(36)}`, pattern, tools, mode: mode as UserRule['mode'], message, reason, addedAt: new Date().toISOString(),
    }
    await $.fs.write(PROJECT_CONFIG, `${JSON.stringify({ ...raw, userRules: [...(raw.userRules ?? []), rule] }, null, 2)}\n`)
    return { result: `Regla user.${rule.id} agregada en ${PROJECT_CONFIG} (${mode}).` }
  }).catch(() => ({ deny: 'gates: error interno al agregar la regla; no se guardó nada.' }))

  on('command.run', { command: 'gates' }, async ($, e) => {
    const [verb = '', first = '', second = '', third = ''] = e.args.trim().split(/\s+/)
    const config = await loadConfig($)
    const byPerson = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    if (verb === 'reglas') {
      const project = parseConfig(await readJson($, PROJECT_CONFIG))
      const global = parseConfig(await $.store.get('config').catch(() => undefined))
      const source = (id: string) => {
        for (const key of [id, id.split('.')[0]!, 'all']) {
          if (project.rules[key]?.mode !== undefined) return 'proyecto'
          if (global.rules[key]?.mode !== undefined) return 'global'
        }
        return 'default'
      }
      return { text: CATALOG.map(item => `${modeOf(config, item.id).padEnd(5)} [${source(item.id)}] ${item.id} — ${item.summary}`).join('\n') }
    }
    if (verb === 'modo') {
      if (!byPerson) return { text: 'Solo el usuario puede cambiar modos de los gates.' }
      const scope = third || 'proyecto'
      const isTarget = RULE_IDS.has(first) || FAMILIES.has(first) || first === 'all'
      if (!isTarget || !(MODES as readonly string[]).includes(second) || !['proyecto', 'global'].includes(scope)) {
        return { text: `Uso: /gates modo <regla|familia|all> <off|warn|ask|deny> [proyecto|global]\nFamilias: ${[...FAMILIES].join(', ')}. Ver /gates reglas.` }
      }
      if (scope === 'global') {
        const stored = ((await $.store.get('config').catch(() => undefined)) ?? {}) as { rules?: Record<string, unknown> }
        await $.store.set('config', { ...stored, rules: withMode(stored.rules, first, second) })
      } else {
        const raw = ((await readJson($, PROJECT_CONFIG)) ?? {}) as { rules?: Record<string, unknown> }
        await $.fs.write(PROJECT_CONFIG, `${JSON.stringify({ ...raw, rules: withMode(raw.rules, first, second) }, null, 2)}\n`)
      }
      const precedence = scope === 'global' ? ` Un valor en ${PROJECT_CONFIG} del proyecto tiene prioridad.` : ''
      return { text: `${first} → ${second} (${scope === 'global' ? 'global' : PROJECT_CONFIG}).${precedence}` }
    }
    if (verb === 'init') {
      if (!byPerson) return { text: 'Solo el usuario puede inicializar la configuración del proyecto.' }
      const { file, added } = withEverySetting(await readJson($, PROJECT_CONFIG), config)
      await $.fs.write(PROJECT_CONFIG, `${JSON.stringify(file, null, 2)}\n`)
      return { text: `${PROJECT_CONFIG}: ${added} regla(s) o agente(s) agregados con los valores en vigor; lo que ya tenías se conservó.` }
    }
    if (verb === 'panel') {
      const opened = await openPane($)
      if (opened.isPlaced) return { text: 'Panel de gates abierto.' }
      return { text: `El panel no se dibujó en esta superficie (motivo del motor: ${opened.reason || 'sin motivo'}).\nVista en texto:\n\n${activityText(await sessionActivity($), false)}` }
    }
    if (verb === 'actividad') return { text: activityText(await sessionActivity($), first === 'gates') }
    if (verb === 'historial') return { text: historyText(await savedHistory($)) }
    if (verb === 'permisos') {
      if (!byPerson) return { text: 'Solo el usuario puede escribir reglas de permisos en sus settings.' }
      if (!['proyecto', 'usuario'].includes(first)) return { text: 'Uso: /gates permisos <proyecto|usuario>' }
      return { text: await installPermissions($, first, config) }
    }
    const ledger = await read($, ledgerAtom)
    const unverified = unverifiedEdits(ledger)
    const open = openTasks(ledger)
    const recent = ledger.decisions.slice(-10).reverse()
    const hooks = ['tool.call', 'tool.check', 'classic.Stop', 'turn.complete', 'prompt.compose', 'prompt.submit', 'attribution.text']
    const seen = await read($, seenAtom).catch(() => [] as string[])
    return {
      text: [
        `Hooks que corrieron en esta sesión: ${hooks.map(name => `${name} ${seen.includes(name) ? 'sí' : 'no'}`).join(' · ')}`,
        `Ediciones sin verificar: ${unverified.length === 0 ? 'ninguna' : unverified.join(', ')}`,
        `Tareas abiertas: ${open.length === 0 ? 'ninguna' : open.map(task => `#${task.id} ${task.subject}`).join('; ')}`,
        'Últimas decisiones:',
        ...(recent.length === 0 ? ['  (ninguna)'] : recent.map(item => `  ${item.effect}: ${item.rule} — ${item.message.split('\n')[0]}`)),
      ].join('\n'),
    }
  }).catch(() => ({ text: 'gates: error interno al leer el estado.' }))
}
