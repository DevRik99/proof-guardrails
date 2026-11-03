// Rules that judge the shape of a command can be walked around by changing the shape:
// the same kill or delete through an interpreter, a decoded string, a variable or a script
// written a step earlier. These rules work on what cannot be resolved (opacity), on the
// capability the code reaches for, and on the target a blocked action pointed at, so a
// rewording does not reopen what was blocked. None of them needs a sandbox.

import type { BlockedTarget, Ledger } from '../../types/index.d.ts'
import { commandWords, expandAssignments, positionals, programName, segmentsOf, type Dialect, type Segment } from '../shell.ts'
import type { Finding, ShellFacts } from './types.ts'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])
const INLINE_FLAGS: Record<string, readonly string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
}
const INTERPRETERS = new Set(Object.keys(INLINE_FLAGS))
const SCRIPT_FILE = /\.(sh|bash|zsh|ps1|psm1|js|mjs|cjs|ts|mts|py|rb|pl|php)$/i

export const KILL_API =
  /\b(os\.kill|os\.killpg|[Pp]rocess\.kill|signal\.SIG[A-Z]+|psutil\b[^\n]*\.(kill|terminate)|\.terminate\(\)|TerminateProcess|Stop-Process|spps\b|taskkill|pkill|killall|fuser\s+-k|xargs\s+(-\S+\s+)*kill)\b|\bkill\s+(-\S+\s+)*(-1|\$\(|`|%)/
export const DELETE_API =
  /\b(shutil\.rmtree|rmtree|os\.remove|os\.unlink|os\.rmdir|unlinkSync|rmSync|rmdirSync|fs\.rm|fs\.unlink|fs\.promises\.(rm|unlink)|\.unlink\(|FileUtils\.rm\w*|Remove-Item|rm\s+-[A-Za-z]*[rRf])\b/
export const SPAWN_API =
  /\b(child_process|execSync|execFileSync|spawnSync|subprocess|os\.system|os\.popen|os\.exec[lv]p?e?|Deno\.Command|Bun\.spawn|Runtime\.getRuntime|IO\.popen|system\s*\(|Kernel\.exec)\b/

const KILL_WORDS = new Set(['kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'spps', 'fuser', 'killall5'])
const DELETE_WORDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'trash'])

function finding(rule: string, message: string): Finding {
  return { rule, message }
}

function resolved(shell: ShellFacts): Segment[] {
  return expandAssignments(shell.segments)
}

function inlineCode(words: readonly string[]): string | undefined {
  const flags = INLINE_FLAGS[programName(words[0])]
  if (flags === undefined) return undefined
  const index = words.findIndex(word => flags.includes(word))
  return index === -1 ? undefined : words.slice(index + 1).join(' ')
}

export function opaqueFindings(shell: ShellFacts): Finding[] {
  const out: Finding[] = []
  const opaque = (why: string) =>
    out.push(finding('evasion.opaque', `${why} No se puede saber de antemano qué se ejecuta, así que necesita la aprobación del usuario.`))
  const segments = resolved(shell)
  segments.forEach((segment, index) => {
    const words = commandWords(segment)
    const program = programName(words[0])
    const first = words[0] ?? ''
    if (['eval', 'iex', 'invoke-expression'].includes(program)) opaque(`\`${program}\` ejecuta texto armado en tiempo de ejecución.`)
    if ((program === 'pwsh' || program === 'powershell') && words.some(word => /^-e(nc(odedcommand)?)?$/i.test(word))) {
      opaque('PowerShell con `-EncodedCommand` ejecuta un comando codificado.')
    }
    if (/\[scriptblock\]::create|frombase64string/i.test(segment.raw)) opaque('Construye y ejecuta código desde un texto (`[scriptblock]::Create`/base64).')
    if (/[$`]/.test(first) || first.startsWith('(')) opaque(`El programa a ejecutar (\`${first}\`) sale de una variable o sustitución que no se puede resolver.`)
    if (/(^|\s)(source|\.|bash|sh|zsh)\s+<\(/.test(segment.raw)) opaque('Ejecuta la salida de otro comando como script (`<(…)`).')
    const previous = segments[index - 1]
    const fromPipe = previous?.next === '|'
    const runsStdin = (SHELLS.has(program) || INTERPRETERS.has(program)) && inlineCode(words) === undefined &&
      !positionals(words.slice(1)).some(arg => SCRIPT_FILE.test(arg) || arg === '-c')
    if (fromPipe && runsStdin) opaque(`Canaliza texto a \`${program}\` para que lo ejecute.`)
  })
  if (/\b(base64\s+(-d|--decode|-D)\b|openssl\s+(enc\s+)?base64\s+-d|xxd\s+-r)/.test(shell.command) &&
    /\b(sh|bash|zsh|node|python3?|perl|ruby|eval|iex)\b/.test(shell.command)) {
    opaque('Decodifica un texto (base64/hex) y lo pasa a un intérprete.')
  }
  return dedupe(out)
}

function capabilities(code: string): string[] {
  const out: string[] = []
  if (KILL_API.test(code)) out.push('mata procesos')
  if (DELETE_API.test(code)) out.push('borra archivos')
  if (SPAWN_API.test(code)) out.push('lanza otros comandos, que así no son visibles')
  return out
}

export function inlineDangerFindings(shell: ShellFacts): Finding[] {
  const out: Finding[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const code = inlineCode(words)
    if (code === undefined) continue
    const found = capabilities(code)
    // Inline code is a single line written for this call: a bare `kill` in it (perl's `kill 9, $pid`)
    // is the call itself, not a word in a comment, so it counts without the API spelling.
    if (!found.includes('mata procesos') && /\bkill\b/i.test(code)) found.unshift('mata procesos')
    if (found.length > 0) {
      out.push(finding('evasion.inline-dangerous', `Código inline de \`${programName(words[0])}\` que ${found.join(', ')}. Usa el comando directo para que los gates lo vean, o pide aprobación.`))
    }
  }
  return dedupe(out)
}

export function codeFileFindings(path: string, content: string): Finding[] {
  const found = capabilities(content)
  return found.length === 0 ? [] : [finding('evasion.inline-dangerous', `El script \`${path}\`, escrito en esta sesión, ${found.join(', ')}.`)]
}

export function scriptRuns(shell: ShellFacts): string[] {
  const out: string[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const program = programName(words[0])
    const first = words[0] ?? ''
    const args = words.slice(1)
    if (/[\\/]/.test(first) && SCRIPT_FILE.test(first)) out.push(first)
    if (['source', '.'].includes(program) && args[0] !== undefined) out.push(args[0])
    if (program === '&' && args[0] !== undefined) out.push(args[0])
    if (SHELLS.has(program) && !args.includes('-c')) {
      const fileFlag = args.findIndex(arg => /^-file$/i.test(arg))
      if (fileFlag !== -1 && args[fileFlag + 1] !== undefined) out.push(args[fileFlag + 1]!)
      else {
        const script = positionals(args).find(arg => SCRIPT_FILE.test(arg) || !arg.startsWith('-'))
        if (script !== undefined) out.push(script)
      }
    }
    if (INTERPRETERS.has(program) && inlineCode(words) === undefined) {
      const script = positionals(args).find(arg => SCRIPT_FILE.test(arg))
      if (script !== undefined) out.push(script)
    }
    if (['npx', 'bunx', 'pnpx'].includes(program) && ['tsx', 'ts-node', 'zx'].includes(args[0] ?? '')) {
      const script = positionals(args.slice(1)).find(arg => SCRIPT_FILE.test(arg))
      if (script !== undefined) out.push(script)
    }
    if (['deno', 'bun'].includes(program) && args[0] === 'run') {
      const script = positionals(args.slice(1)).find(arg => SCRIPT_FILE.test(arg))
      if (script !== undefined) out.push(script)
    }
  }
  return [...new Set(out.map(path => path.replace(/^\.\//, '')))]
}

export function packageScriptsRun(shell: ShellFacts): string[] {
  const out: string[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const program = programName(words[0])
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(program)) continue
    const verb = (words[1] ?? '').toLowerCase()
    if (['run', 'run-script'].includes(verb) && words[2] !== undefined) out.push(words[2])
    else if (['test', 't', 'start', 'stop', 'restart'].includes(verb)) out.push(verb === 't' ? 'test' : verb)
    else if (program !== 'npm' && verb !== '' && !verb.startsWith('-') && !['install', 'i', 'add', 'remove', 'exec', 'dlx', 'x'].includes(verb)) out.push(verb)
  }
  return out
}

export function shellOfText(text: string, path: string): ShellFacts {
  const dialect: Dialect = /\.ps1$|\.psm1$/i.test(path) ? 'powershell' : 'posix'
  return { command: text, dialect, segments: segmentsOf(text, dialect) }
}

function clean(target: string): string {
  return target.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function killTargets(shell: ShellFacts): string[] {
  const out: string[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const program = programName(words[0])
    const lower = words.map(word => word.toLowerCase())
    if (['pkill', 'killall', 'pgrep', 'pidof'].includes(program)) out.push(...positionals(words.slice(1), ['-u', '-g', '-signal', '-s', '-o']))
    if (program === 'taskkill') {
      const at = lower.indexOf('/im')
      if (at !== -1 && words[at + 1] !== undefined) out.push(words[at + 1]!)
    }
    if (['stop-process', 'spps', 'kill'].includes(program)) {
      const at = lower.findIndex(word => word === '-name' || word === '-processname')
      if (at !== -1 && words[at + 1] !== undefined) out.push(words[at + 1]!)
    }
    if (program === 'kill') out.push(...positionals(words.slice(1)).filter(arg => /^\d{2,}$/.test(arg)))
    if (program === 'fuser') out.push(...positionals(words.slice(1)))
  }
  for (const match of shell.command.matchAll(/\b(pgrep|pidof)\s+(?:-\S+\s+)*["']?([\w.@:-]+)/g)) out.push(match[2]!)
  return [...new Set(out.map(clean).filter(target => target.length >= 2 && target !== '-1'))]
}

export function deleteTargets(shell: ShellFacts): string[] {
  const out: string[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const program = programName(words[0])
    if (!DELETE_WORDS.has(program)) continue
    out.push(...positionals(words.slice(1), ['-path', '-literalpath', '-include', '-exclude', '-filter']).filter(arg => !/^\/[sq]$/i.test(arg)))
    const lower = words.map(word => word.toLowerCase())
    const at = lower.findIndex(word => word === '-path' || word === '-literalpath')
    if (at !== -1 && words[at + 1] !== undefined) out.push(words[at + 1]!)
  }
  return [...new Set(out.map(clean).filter(target => target.length >= 2 && !['.', '..', '*'].includes(target)))]
}

export function blockedTargetsOf(shell: ShellFacts, rules: readonly string[], now: number): BlockedTarget[] {
  const rule = rules[0] ?? 'irreversible.destructive'
  const kills = KILL_API.test(shell.command) || resolved(shell).some(segment => KILL_WORDS.has(programName(commandWords(segment)[0])))
  const deletes = DELETE_API.test(shell.command) || resolved(shell).some(segment => DELETE_WORDS.has(programName(commandWords(segment)[0])))
  return [
    ...(kills ? killTargets(shell).map(target => ({ kind: 'kill' as const, target, rule, at: now })) : []),
    ...(deletes ? deleteTargets(shell).map(target => ({ kind: 'delete' as const, target, rule, at: now })) : []),
  ]
}

// comment-ok: decisión de diseño. Un PID que salió de buscar por nombre cuenta como matar por
// nombre (rodeo visto en la sesión atacante: pgrep, luego kill 2413); cualquier otro PID, como el
// de un servidor que lanzó la sesión, sigue permitido para no pedir confirmación al detenerlo.
const PID_LOOKUP = /\b(pgrep|pidof|lsof\s+(?:-\S+\s+)*-t\b|ps\b|get-process|gps|tasklist)/i

export type LookedUpPid = { pid: string; name: string }

export function lookedUpPids(shell: ShellFacts, output: string): LookedUpPid[] {
  if (!PID_LOOKUP.test(shell.command)) return []
  const names = [
    ...killTargets(shell),
    ...[...shell.command.matchAll(/\bgrep\s+(?:-\S+\s+)*["']?([\w.@:-]{2,})/g)].map(match => match[1]!),
    ...[...shell.command.matchAll(/\b(?:get-process|gps)\s+(?:-name\s+)?["']?([\w.@-]{2,})/gi)].map(match => match[1]!),
    ...[...shell.command.matchAll(/imagename\s+eq\s+([\w.@-]{2,})/gi)].map(match => match[1]!),
  ].filter(name => !/^\d+$/.test(name))
  const name = names[0] ?? 'un proceso buscado por nombre'
  const command = shell.command
  const isPid = (token: string | undefined): token is string => token !== undefined && /^\d{2,7}$/.test(token)
  const pick = (tokens: string[]): string[] => {
    if (/\bpgrep\b/.test(command)) return isPid(tokens[0]) ? [tokens[0]] : []
    if (/\b(pidof|lsof\s+(?:-\S+\s+)*-t\b)/.test(command)) return tokens.filter(isPid)
    if (/\b(get-process|gps)\b/i.test(command)) return isPid(tokens[tokens.length - 3]) ? [tokens[tokens.length - 3]!] : []
    if (/\btasklist\b/i.test(command)) return isPid(tokens[1]) ? [tokens[1]] : []
    return isPid(tokens[0]) ? [tokens[0]] : isPid(tokens[1]) ? [tokens[1]] : []
  }
  const pids = new Set<string>()
  for (const line of output.split('\n')) {
    const tokens = line.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const ownList = /\b(pgrep|pidof|lsof\s+(?:-\S+\s+)*-t\b)/.test(command)
    const named = ownList || names.length === 0 || names.some(item => line.toLowerCase().includes(item.toLowerCase()))
    if (named) for (const pid of pick(tokens)) pids.add(pid)
  }
  return [...pids].map(pid => ({ pid, name }))
}

function killedPids(shell: ShellFacts): string[] {
  const out: string[] = []
  for (const segment of resolved(shell)) {
    const words = commandWords(segment)
    const program = programName(words[0])
    const lower = words.map(word => word.toLowerCase())
    if (program === 'kill' && !lower.some(word => word === '-name' || word === '-processname')) {
      out.push(...positionals(words.slice(1)).filter(arg => /^\d{2,7}$/.test(arg)))
    }
    if (['stop-process', 'spps', 'kill'].includes(program)) {
      lower.forEach((word, index) => {
        if (word === '-id' && words[index + 1] !== undefined) out.push(...words[index + 1]!.split(','))
      })
    }
    if (program === 'taskkill') {
      lower.forEach((word, index) => {
        if (word === '/pid' && words[index + 1] !== undefined) out.push(words[index + 1]!)
      })
    }
  }
  return out.map(pid => pid.trim()).filter(pid => /^\d{2,7}$/.test(pid))
}

export function pidKillFindings(shell: ShellFacts, looked: readonly LookedUpPid[]): Finding[] {
  const byPid = new Map(looked.map(item => [item.pid, item.name]))
  const hits = killedPids(shell).filter(pid => byPid.has(pid))
  if (hits.length === 0) return []
  return [finding(
    'irreversible.destructive',
    `Matar ${hits.map(pid => `el PID ${pid} («${byPid.get(pid)}»)`).join(', ')}, que salió de buscar el proceso por nombre, es matar por nombre en dos pasos: puede cerrar programas ajenos a la tarea.`,
  )]
}

export function sameCommandCommitFile(
  shell: ShellFacts,
  hasTrailer: (text: string) => boolean,
  messageFiles: readonly string[],
  written: readonly string[],
): Finding[] {
  const plain = (path: string) => path.replace(/^\.\//, '')
  const fresh = messageFiles.filter(file => written.map(plain).includes(plain(file)))
  if (fresh.length === 0 || !hasTrailer(shell.command.replace(/\\n/g, '\n'))) return []
  return [finding('attribution.strip', `El mensaje del commit se escribe en \`${fresh[0]}\` en este mismo comando y trae coautoría de IA. Quítala del texto.`)]
}

function mentions(text: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w-])`, 'i').test(text.replace(/\\/g, '/'))
}

function reaches(kind: BlockedTarget['kind'], text: string): boolean {
  if (kind === 'kill') return KILL_API.test(text) || /(^|[\s;&|(])(kill|pkill|killall|taskkill|stop-process|spps|fuser)\b/i.test(text)
  if (kind === 'delete') return DELETE_API.test(text) || /(^|[\s;&|(])(rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred|trash)\b/i.test(text) || /-delete\b/.test(text)
  return false
}

export function lockedTargetFindings(ledger: Ledger, texts: readonly string[]): Finding[] {
  const out: Finding[] = []
  for (const blocked of ledger.blockedTargets ?? []) {
    const hit = texts.some(text => reaches(blocked.kind, text) && mentions(text, blocked.target))
    if (!hit) continue
    const verb = blocked.kind === 'kill' ? 'matar' : blocked.kind === 'delete' ? 'borrar' : 'publicar'
    out.push(finding(
      'evasion.blocked-target',
      `Vuelve a intentar ${verb} «${blocked.target}», que se bloqueó antes por [${blocked.rule}]. ` +
        'Cualquier vía para lograrlo (otro comando, un intérprete, un script) queda bloqueada hasta que el usuario lo apruebe en su próximo mensaje. Pregúntale.',
    ))
  }
  return dedupe(out)
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter(item => {
    const key = `${item.rule}\u0000${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
