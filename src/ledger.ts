import type { BlockedTarget, Ledger, LedgerTask } from '../types/index.d.ts'
import { commandWords, expandAssignments, programName, segmentsOf, type Dialect, type Segment } from './shell.ts'

// What the session actually did, as the mod observed it from real tool calls and results.
// Completion rules read this instead of trusting what the model writes about its own work.

export type { Ledger, LedgerTask }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

type TaskMeta = Pick<LedgerTask, 'size' | 'parent' | 'owns' | 'verify' | 'unlazy' | 'leaf' | 'key'>

export function taskMeta(metadata: unknown): TaskMeta {
  const raw = metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const owns = Array.isArray(raw.owns) ? raw.owns.filter((item): item is string => typeof item === 'string') : text(raw.owns)?.split(/\s*,\s*/)
  const meta: TaskMeta = {}
  const leaf = text(raw.leaf)
  if (leaf !== undefined) meta.leaf = leaf
  const key = text(raw.key)
  if (key !== undefined) meta.key = key
  const size = text(raw.size)?.toLowerCase()
  if (size !== undefined) meta.size = size
  const parent = text(raw.parent) ?? (typeof raw.parent === 'number' ? String(raw.parent) : undefined)
  if (parent !== undefined) meta.parent = parent.replace(/^#/, '')
  if (owns !== undefined && owns.length > 0) meta.owns = owns
  const verify = text(raw.verify)
  if (verify !== undefined) meta.verify = verify
  const unlazy = text(raw.unlazy)
  if (unlazy !== undefined) meta.unlazy = unlazy
  return meta
}

export function recordTaskCreated(ledger: Ledger, id: string, subject: string, metadata?: unknown): Ledger {
  const task: LedgerTask = { id, subject, status: 'pending', ...taskMeta(metadata) }
  return { ...ledger, tasks: cap([...ledger.tasks.filter(item => item.id !== id), task], 200) }
}

export function recordTaskUpdated(
  ledger: Ledger,
  id: string,
  status: string | undefined,
  subject: string | undefined,
  now = 0,
  metadata?: unknown,
): Ledger {
  if (status === 'deleted') return { ...ledger, tasks: ledger.tasks.filter(task => task.id !== id) }
  return {
    ...ledger,
    tasks: ledger.tasks.map(task => {
      if (task.id !== id) return task
      const next: LedgerTask = { ...task, ...taskMeta(metadata), subject: subject ?? task.subject }
      if (status === 'pending' || status === 'in_progress' || status === 'completed') next.status = status
      if (status === 'in_progress' && task.status !== 'in_progress') next.startedAt = now
      return next
    }),
  }
}

export function creditTasks(ledger: Ledger, edit: { path: string } | undefined, check: { command: string; at: number } | undefined): Ledger {
  if (edit === undefined && check === undefined) return ledger
  return {
    ...ledger,
    tasks: ledger.tasks.map(task => {
      if (task.status === 'completed') return task
      const next = { ...task }
      const active = task.status === 'in_progress'
      if (active && edit !== undefined && !(task.files ?? []).includes(edit.path)) next.files = [...(task.files ?? []), edit.path].slice(-100)
      const matches = task.verify === undefined ? active : sameCheck(task.verify, check?.command ?? '')
      if (check !== undefined && matches) next.verifiedAt = check.at
      return next
    }),
  }
}

function squash(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

// Every ledger a gate-check --reverify run names, wherever the flags sit: textstats ran
// `--reverify --jobs 1 leaf-1.1.md leaf-1.2.md …` and none of its leaves was credited.
export function reverifiedLedgers(command: string): string[] {
  const out: string[] = []
  for (const match of squash(command).matchAll(/gate-check\.mjs\b([^&|;]*)/g)) {
    const args = match[1] ?? ''
    if (!/(^|\s)--reverify(\s|$)/.test(args)) continue
    out.push(...[...args.matchAll(/(?:^|\s)([^\s-][^\s]*\.md)(?=\s|$)/g)].map(item => item[1]!.replaceAll('\\', '/')))
  }
  return out
}

export function sameCheck(declared: string, ran: string): boolean {
  const want = squash(declared)
  if (want === '') return false
  if (squash(ran).includes(want)) return true
  const wanted = reverifiedLedgers(want)
  if (wanted.length === 0) return false
  const ranLedgers = reverifiedLedgers(ran)
  return wanted.every(ledger => ranLedgers.some(target => target.endsWith(ledger) || ledger.endsWith(target)))
}

export function openTasks(ledger: Ledger): Ledger['tasks'] {
  return ledger.tasks.filter(task => task.status !== 'completed')
}

export function emptyLedger(now: number): Ledger {
  return {
    windowStart: now,
    edits: [],
    verifications: [],
    research: [],
    questions: [],
    delegations: [],
    forgeActive: false,
    stopBlocks: 0,
    decisions: [],
    tasks: [],
    blockedTargets: [],
  }
}

function cap<T>(list: T[], size: number): T[] {
  return list.slice(-size)
}

export function startWindow(ledger: Ledger, now: number): Ledger {
  return { ...ledger, windowStart: now, edits: [], verifications: [], stopBlocks: 0, blockedTargets: [] }
}

export function recordBlockedTargets(ledger: Ledger, targets: readonly BlockedTarget[]): Ledger {
  if (targets.length === 0) return ledger
  const known = new Set((ledger.blockedTargets ?? []).map(item => `${item.kind}:${item.target}`))
  const fresh = targets.filter(item => !known.has(`${item.kind}:${item.target}`))
  return { ...ledger, blockedTargets: cap([...(ledger.blockedTargets ?? []), ...fresh], 50) }
}

export function recordEdit(ledger: Ledger, path: string, now: number): Ledger {
  return { ...ledger, edits: cap([...ledger.edits, { path, at: now }], 200) }
}

export function recordVerification(ledger: Ledger, command: string, now: number): Ledger {
  return { ...ledger, verifications: cap([...ledger.verifications, { command, at: now }], 100) }
}

export function recordResearch(ledger: Ledger, text: string): Ledger {
  return { ...ledger, research: cap([...ledger.research, text.toLowerCase().slice(0, 2000)], 300) }
}

export function recordDecision(ledger: Ledger, rule: string, effect: string, message: string, now: number): Ledger {
  return { ...ledger, decisions: cap([...ledger.decisions, { rule, effect, message: message.slice(0, 300), at: now }], 50) }
}

const CHECKERS = new Set([
  'tsc', 'vue-tsc', 'svelte-check', 'vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress', 'pytest',
  'eslint', 'biome', 'oxlint', 'ruff', 'mypy', 'stylelint', 'prettier', 'make', 'gradle', 'gradlew', 'phpunit',
])
const SUBCOMMAND_CHECKERS: Record<string, readonly string[]> = {
  go: ['test', 'vet', 'build'],
  cargo: ['test', 'check', 'build', 'clippy'],
  dotnet: ['test', 'build'],
  deno: ['test', 'check', 'lint'],
  flutter: ['test', 'analyze'],
  dart: ['test', 'analyze'],
}
const SCRIPT = /(test|lint|check|build|type|verify|e2e|ci|validate)/i

function isCheckSegment(words: readonly string[]): boolean {
  const program = programName(words[0])
  const args = words.slice(1)
  const verb = (args[0] ?? '').toLowerCase()
  if (CHECKERS.has(program)) return !(program === 'prettier' && !args.includes('--check'))
  if (SUBCOMMAND_CHECKERS[program]?.includes(verb)) return true
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (['test', 't', 'tst'].includes(verb)) return true
    if (verb === 'run' && SCRIPT.test(args[1] ?? '')) return true
    if (['dlx', 'exec', 'x'].includes(verb)) return isCheckSegment(args.slice(1))
    return program !== 'npm' && SCRIPT.test(verb)
  }
  if (['npx', 'pnpx', 'bunx'].includes(program)) return isCheckSegment(args.filter(arg => !arg.startsWith('-')))
  if (program === 'node' || program === 'deno' || program === 'bun') {
    return args.includes('--test') || args.some(arg => /(gate-check|test|verify|check)[\w.-]*\.(m?[jt]s)$/i.test(arg))
  }
  if (program === 'claude' && verb === 'plugin') return ['validate', 'test'].includes((args[1] ?? '').toLowerCase())
  return false
}

function expandedSegments(command: string, dialect: Dialect): Segment[] {
  return expandAssignments(segmentsOf(command, dialect))
}

export function isVerificationCommand(command: string, dialect: Dialect): boolean {
  return expandedSegments(command, dialect).some(segment => isCheckSegment(commandWords(segment)))
}

// A check proves something only when its exit code is the command's: `npm test | tail`
// and `npm test; echo` exit 0 with failing tests. Only a check followed by nothing but
// `&&` decides the result.
export function decisiveChecks(command: string, dialect: Dialect): string[] {
  const segments = expandedSegments(command, dialect)
  return segments
    .filter((segment, index) => isCheckSegment(commandWords(segment)) && segments.slice(index).every(item => item.next === undefined || item.next === '&&'))
    .map(segment => segment.raw)
}

// A runner that found nothing to run still exits 0 (seen in validation: `npm test` with
// "# tests 0" closed a task). These are the runners' own "nothing ran" lines.
const NO_TESTS = [
  /^#\s*tests\s+0\s*$/m,
  /^ℹ\s*tests\s+0\s*$/m,
  /^\s*0 passing\b/m,
  /\bNo tests? found\b/i,
  /\bNo test files found\b/i,
  /\bcollected 0 items\b/,
  /\[no test files\]/,
]

export function ranNoTests(output: string): boolean {
  return NO_TESTS.some(pattern => pattern.test(output))
}

export function checkRedirects(command: string, dialect: Dialect): string[] {
  const segments = segmentsOf(command, dialect)
  return segments
    .filter(segment => isCheckSegment(commandWords(segment)))
    .flatMap(segment => segment.redirects.filter(target => !/^\/dev\/|^nul$|^\$null$|^&/i.test(target)))
}

/** Paths edited after the last successful verification of this window. */
export function unverifiedEdits(ledger: Ledger): string[] {
  const lastCheck = Math.max(0, ...ledger.verifications.map(item => item.at))
  return [...new Set(ledger.edits.filter(edit => edit.at > lastCheck).map(edit => edit.path))]
}

export type LedgerGate = { file: string; id: string; title: string }

/** Unmet and abandoned gates of unlazy GATES.md ledgers, read without executing anything. */
export function unlazyGates(file: string, text: string): { unmet: LedgerGate[]; abandoned: LedgerGate[] } {
  const unmet: LedgerGate[] = []
  const abandoned: LedgerGate[] = []
  const abandonedIds = new Set([...text.matchAll(/^ABANDON:\s*(\S+)\s+\S/gm)].map(match => match[1]!))
  const withoutFences = text.replace(/```[\s\S]*?```/g, '')
  const blocks = withoutFences.split(/\n(?=- \[[ xX]\] )/)
  for (const block of blocks) {
    const head = /^- \[([ xX])\] ([A-Za-z0-9_.-]+):\s*(.*)/.exec(block.trimStart())
    if (head === null) continue
    const gate = { file, id: head[2]!, title: head[3]!.trim() }
    if (abandonedIds.has(gate.id)) {
      abandoned.push(gate)
      continue
    }
    const evidence = /^\s+EVIDENCE:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? ''
    const checked = head[1] !== ' '
    if (!checked || evidence === '' || /^pending\b/i.test(evidence)) unmet.push(gate)
  }
  return { unmet, abandoned }
}
