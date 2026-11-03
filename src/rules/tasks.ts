import type { Ledger, LedgerTask } from '../ledger.ts'
import { isVerificationCommand } from '../ledger.ts'
import { commandWords, gitSubcommand, programName } from '../shell.ts'
import type { Finding, ShellFacts } from './types.ts'

// Port of require-task-split. Native tasks track the parts; unlazy is how the parts are cut
// and proven. Neither stands in for the other: a split is native sub-tasks, and each one
// names the check that proves it (a command, or `gate-check.mjs --reverify` on its ledger).

export type SplitOptions = { readonly exempt: readonly string[]; readonly maxFilesSmall: number }

export const SPLIT_DEFAULTS: SplitOptions = { exempt: ['small', 'trivial'], maxFilesSmall: 3 }

const READ_ONLY_PROGRAMS = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'rg', 'pwd', 'echo', 'printf', 'which', 'where',
  'whoami', 'date', 'env', 'printenv', 'tree', 'stat', 'file', 'du', 'df', 'sort', 'uniq', 'cut', 'jq', 'diff', 'type',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'test-path', 'get-command',
  'gcm', 'get-item', 'gi', 'resolve-path', 'write-output', 'write-host', 'cd', 'set-location',
])
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'remote', 'shortlog', 'reflog', 'grep'])
const PACKAGE_QUERIES = new Set(['view', 'info', 'show', 'ls', 'list', 'outdated', 'why', 'explain', '--version', '-v'])

function isReadOnlySegment(words: readonly string[]): boolean {
  const program = programName(words[0])
  const args = words.slice(1).map(word => word.toLowerCase())
  if (READ_ONLY_PROGRAMS.has(program)) return true
  if (program === 'find') return !args.some(arg => ['-delete', '-exec', '-execdir', '-ok', '-fprint'].includes(arg))
  if (program === 'sed') return !args.some(arg => /^-[a-z]*i/.test(arg) || arg === '--in-place')
  if (program === 'git') {
    const { name, args: rest } = gitSubcommand(words)
    if (name === 'branch') return !rest.some(arg => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(arg))
    if (name === 'tag') return rest.length === 0 || rest.includes('-l') || rest.includes('--list')
    if (name === 'config') return rest.includes('--get') || rest.includes('--list') || rest.includes('-l')
    return READ_ONLY_GIT.has(name)
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'node', 'npx', 'deno', 'python', 'python3'].includes(program)) {
    return args.length > 0 && args.every(arg => PACKAGE_QUERIES.has(arg) || !arg.startsWith('-')) && PACKAGE_QUERIES.has(args[0]!)
  }
  if (program === 'gh') return ['view', 'list', 'status', 'diff', 'checks'].includes(args[1] ?? '')
  return false
}

export function isReadOnlyShell(shell: ShellFacts): boolean {
  if (shell.segments.some(segment => segment.redirects.some(target => !/^\/dev\/null$|^nul$|^\$null$/i.test(target)))) return false
  if (isVerificationCommand(shell.command, shell.dialect)) return true
  return shell.segments.every(segment => isReadOnlySegment(commandWords(segment)))
}

function children(ledger: Ledger, id: string): LedgerTask[] {
  return ledger.tasks.filter(task => task.parent === id)
}

function describe(task: LedgerTask): string {
  return `#${task.id} ${task.subject} (size: ${task.size ?? 'sin declarar'})`
}

const HOW_TO_SPLIT =
  'Antes de partir: si el alcance es vago o no sabes qué archivos toca, pregúntale al usuario; no partas a ciegas.\n' +
  'Cómo partir (Depth Tree de unlazy, skill `proof-guardrails:unlazy`; al escribir su PLAN.md se crean solas las tareas nativas):\n' +
  '  1. Cada subtarea es chica y verificable por separado, en un límite natural (un módulo, una función, un archivo de tests).\n' +
  '  2. Cada subtarea es dueña de archivos propios: dos subtareas no tocan el mismo archivo.\n' +
  '  3. Cada subtarea declara con qué se prueba: un comando, o `gate-check.mjs --reverify <su ledger>` si usas unlazy.\n' +
  'Regístralas con TaskCreate, una por subtarea:\n' +
  '  metadata: { "parent": "<id>", "size": "small", "owns": ["ruta/a.ts"], "verify": "<comando>", "unlazy": "<scope si aplica>" }\n' +
  'La tarea madre también puede llevar "unlazy": "<scope>" para enlazarla a su PLAN.md. Las tareas nativas siguen el trabajo; unlazy lo parte y lo prueba: una no reemplaza a la otra.'

export function splitFindings(ledger: Ledger, options: SplitOptions = SPLIT_DEFAULTS): Finding[] {
  const pending = ledger.tasks.filter(task => task.status !== 'completed' && task.parent === undefined && !options.exempt.includes(task.size ?? ''))
  const unsplit = pending.filter(task => children(ledger, task.id).length === 0)
  const unproven = pending.flatMap(task => children(ledger, task.id).filter(child => child.status !== 'completed' && child.verify === undefined))
  const out: Finding[] = []
  if (unsplit.length > 0) {
    out.push({
      rule: 'tasks.split',
      message: `${unsplit.length} tarea(s) deben partirse antes de implementar:\n${unsplit.map(task => `  - ${describe(task)}`).join('\n')}\n\n${HOW_TO_SPLIT}`,
    })
  }
  if (unproven.length > 0) {
    out.push({
      rule: 'tasks.split',
      message:
        `Subtarea(s) sin verificación declarada:\n${unproven.map(task => `  - ${describe(task)}`).join('\n')}\n` +
        'Actualízalas con TaskUpdate y metadata { "verify": "<comando o gate-check --reverify del ledger>" } antes de implementar.',
    })
  }
  return out
}

export type PlanOptions = { readonly maxFiles: number; readonly via: 'unlazy' | 'any' }

export const PLAN_DEFAULTS: PlanOptions = { maxFiles: 3, via: 'unlazy' }

const NOT_WORK = /(^|\/)\.unlazy\/|(^|\/)\.git\/|\.log$/i

// A path built from a variable or ~ cannot be placed, so it is never counted as project work.
export function relativeTo(cwd: string, path: string): string | undefined {
  if (/^~|\$|`/.test(path)) return undefined
  const target = path.replaceAll('\\', '/')
  const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  if (target.startsWith(`${base}/`)) return target.slice(base.length + 1)
  if (/^([a-z]:)?\//i.test(target)) return undefined
  return target.replace(/^\.\//, '')
}

export function workPaths(cwd: string, paths: readonly string[]): string[] {
  return paths.map(path => relativeTo(cwd, path)).filter((path): path is string => path !== undefined && path !== '' && !NOT_WORK.test(path))
}

const CHANGE_DIR = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir'])

// Targets are resolved against the last `cd`: `cd /otro/repo && cat > a.ts` writes outside this project.
export function shellWriteTargets(shell: ShellFacts): string[] {
  const out: string[] = []
  let base = ''
  const place = (target: string) => {
    if (/^([a-z]:)?[\\/]/i.test(target) || base === '') return target
    return `${base.replace(/[\\/]+$/, '')}/${target.replace(/^\.\//, '')}`
  }
  for (const segment of shell.segments) {
    const words = commandWords(segment)
    const program = programName(words[0])
    if (CHANGE_DIR.has(program)) {
      const dir = positionalDir(words.slice(1))
      base = dir === undefined ? '~' : /^([a-z]:)?[\\/]/i.test(dir) || base === '' ? dir : `${base}/${dir}`
      continue
    }
    const targets = segment.redirects.filter(target => !/^\/dev\/|^nul$|^\$null$|^&/i.test(target))
    if (program === 'tee') targets.push(...words.slice(1).filter(word => !word.startsWith('-')))
    out.push(...targets.map(place))
  }
  return out
}

function positionalDir(args: readonly string[]): string | undefined {
  return args.find(arg => !arg.startsWith('-'))
}

// "small" is the model's own claim, and corrida 4 escaped through it: one small task, then five
// files in one heredoc. Past maxFiles only a plan that was actually split counts. By default that
// plan is unlazy's (its PLAN.md generates the native tasks); `via: "any"` also accepts a hand split.
function isPlanned(ledger: Ledger, task: LedgerTask, via: PlanOptions['via']): boolean {
  if (task.unlazy !== undefined) return true
  return via === 'any' && (task.parent !== undefined || children(ledger, task.id).length > 0)
}

export function planFindings(ledger: Ledger, cwd: string, paths: readonly string[], options: PlanOptions = PLAN_DEFAULTS): Finding[] {
  if (ledger.tasks.some(task => task.status !== 'completed' && isPlanned(ledger, task, options.via))) return []
  const incoming = workPaths(cwd, paths)
  if (incoming.length === 0) return []
  const touched = [...new Set([...workPaths(cwd, ledger.edits.map(edit => edit.path)), ...incoming])]
  if (touched.length <= options.maxFiles) return []
  const shown = touched.slice(0, 8).join(', ') + (touched.length > 8 ? ', …' : '')
  return [{
    rule: 'tasks.plan-required',
    message:
      `Este pedido ya toca ${touched.length} archivos (${shown}), más de ${options.maxFiles}, sin un plan partido. ` +
      'Una tarea "small" suelta no alcanza a este tamaño. Antes de seguir, parte el trabajo con la skill `proof-guardrails:unlazy`: ' +
      'escribe sus gates por hoja y `.unlazy/<scope>/PLAN.md`; al escribir el PLAN.md se crean solas las tareas nativas (madre + una por hoja, con su gate-check como verificación).' +
      (options.via === 'any'
        ? '\n  O a mano: una tarea madre y subtareas con TaskCreate, cada una con metadata { "parent": "<id madre>", "size": "small", "owns": [...], "verify": "<comando>" }.'
        : ''),
  }]
}

export function grewFindings(ledger: Ledger, options: SplitOptions = SPLIT_DEFAULTS): Finding[] {
  const grown = ledger.tasks.filter(
    task =>
      task.status === 'in_progress' &&
      options.exempt.includes(task.size ?? '') &&
      (task.files?.length ?? 0) > options.maxFilesSmall &&
      children(ledger, task.id).length === 0,
  )
  if (grown.length === 0) return []
  return [{
    rule: 'tasks.small-grew',
    message:
      `Declarada chica pero ya toca más de ${options.maxFilesSmall} archivos: ${grown.map(task => `#${task.id} (${task.files?.length} archivos)`).join(', ')}. ` +
      'No sigas escribiendo: pártela en subtareas (TaskCreate con metadata { "parent": "<id>", "size": "small", "owns": [...], "verify": "<comando>" }) ' +
      'o con la skill `proof-guardrails:unlazy`, que crea las tareas nativas al escribir su PLAN.md.',
  }]
}

const RUN_IT =
  'Córrelo solo o encadenado únicamente con `&&` (sin `| tail`, `; echo $?` ni `|| true`): así su exit code es el del comando y cuenta como prueba.'

export function completionFindings(ledger: Ledger, id: string, action: 'completed' | 'deleted' = 'completed'): Finding[] {
  const task = ledger.tasks.find(item => item.id === id)
  if (task === undefined || task.status === 'completed') return []
  const closing = action === 'deleted'
    ? '\nBorrarla no la cierra. Si ya no aplica, quita su `verify` con TaskUpdate (queda a la vista) o pregúntale al usuario.'
    : ''
  const open = children(ledger, id).filter(child => child.status !== 'completed')
  if (open.length > 0) {
    return [{ rule: 'tasks.verify-on-complete', message: `#${id} tiene subtareas abiertas: ${open.map(child => `#${child.id}`).join(', ')}. Ciérralas primero.${closing}` }]
  }
  const owned = (task.files ?? []).length > 0 ? new Set(task.files) : undefined
  const lastEdit = Math.max(0, ...ledger.edits.filter(edit => owned === undefined || owned.has(edit.path)).map(edit => edit.at))
  const since = Math.max(task.startedAt ?? 0, lastEdit)
  const proven = task.verifiedAt !== undefined && task.verifiedAt >= since
  if (task.verify !== undefined && !proven) {
    return [{
      rule: 'tasks.verify-on-complete',
      message: `#${id} declara que se prueba con \`${task.verify}\` y no lo vi pasar después de la última edición. ${RUN_IT}${closing}`,
    }]
  }
  if (task.verify === undefined && (task.files?.length ?? 0) > 0 && !proven) {
    return [{
      rule: 'tasks.verify-on-complete',
      message: `#${id} editó ${task.files?.length} archivo(s) y no vi pasar ninguna verificación (tests, lint, typecheck, build, gate-check) después de la última edición. ${RUN_IT}${closing}`,
    }]
  }
  return []
}
