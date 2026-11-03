import { REGENERABLE_DEFAULT } from '../catalog.ts'
import {
  commandWords,
  gitSubcommand,
  hasFlag,
  positionals,
  programName,
  type Segment,
} from '../shell.ts'
import type { Finding, ShellFacts, WriteFacts } from './types.ts'

export type IrreversibleOptions = {
  readonly regenerable: readonly string[]
  /** Extra protected paths, as regex sources over the forward-slashed path. */
  readonly extraPaths: readonly string[]
}

export const DEFAULT_OPTIONS: IrreversibleOptions = { regenerable: REGENERABLE_DEFAULT, extraPaths: [] }

const PROTECTED: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i, label: 'archivo de secretos .env' },
  { pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock)$/i, label: 'lockfile (se regenera con el gestor de paquetes)' },
  { pattern: /(^|\/)\.git\/(?!info\/exclude$)/, label: 'interno de .git' },
  { pattern: /(^|\/)\.claude\/settings(\.local)?\.json$/i, label: 'configuración de Claude' },
  { pattern: /(^|\/)\.ssh\//, label: 'credenciales SSH' },
  { pattern: /(^|\/)\.ai\/gates\.json$/, label: 'configuración de estos gates' },
]

export function protectedLabel(path: string, extraPaths: readonly string[] = []): string | undefined {
  const normalized = path.replaceAll('\\', '/')
  const builtin = PROTECTED.find(entry => entry.pattern.test(normalized))?.label
  if (builtin !== undefined) return builtin
  const extra = extraPaths.find(source => {
    try {
      return new RegExp(source).test(normalized)
    } catch {
      return false
    }
  })
  return extra === undefined ? undefined : `ruta protegida por la configuración del proyecto (${extra})`
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '')
}

function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:\/|\/|~)/.test(normalize(path))
}

/** Why deleting `target` recursively deserves a confirmation, or undefined when it does not. */
export function riskyDeleteTarget(target: string, cwd: string, regenerable: readonly string[] = REGENERABLE_DEFAULT): string | undefined {
  const path = normalize(target)
  if (/^(\/|~|\$home|\$env:userprofile|[a-z]:)?\/?\*?$/i.test(path) || path === '.' || path === '..' || path === '*') {
    return `"${target}" es la raíz, el home o todo el directorio actual`
  }
  if (path.includes('..')) return `"${target}" sale del directorio del proyecto`
  if (isAbsolute(path)) {
    const root = normalize(cwd)
    const inside = path.toLowerCase().startsWith(root.toLowerCase() + '/')
    if (!inside) return `"${target}" está fuera del proyecto (${cwd})`
  }
  const relative = isAbsolute(path) ? path.slice(normalize(cwd).length + 1) : path.replace(/^\.\//, '')
  const top = relative.split('/')[0] ?? ''
  if (regenerable.includes(top)) return undefined
  if (/[*?]/.test(relative)) return `"${target}" es un comodín que puede abarcar más de lo previsto`
  return undefined
}

function finding(rule: string, message: string): Finding {
  return { rule, message }
}

function gitFindings(words: string[]): Finding[] {
  const { name, args } = gitSubcommand(words)
  const out: Finding[] = []
  const destructive = (message: string) => out.push(finding('irreversible.destructive', message))
  const publish = (message: string) => out.push(finding('irreversible.publish', message))

  if (name === 'reset' && hasFlag(args, ['--hard', '--merge', '--keep'], [])) {
    destructive('`git reset --hard` descarta cambios sin commit de forma irrecuperable.')
  }
  if (name === 'clean' && hasFlag(args, ['--force'], ['f'])) {
    destructive('`git clean -f` borra archivos no versionados sin pasar por la papelera.')
  }
  if (name === 'checkout' && (args.includes('--') || args.includes('.'))) {
    destructive('`git checkout -- <ruta>` descarta cambios locales de esos archivos.')
  }
  if (name === 'restore' && !hasFlag(args, ['--staged'], ['S'])) {
    destructive('`git restore` descarta cambios locales del árbol de trabajo.')
  }
  if (name === 'branch' && hasFlag(args, ['--delete'], ['D'])) {
    destructive('Borrado de rama: puede perder commits que no estén en otra rama.')
  }
  if (name === 'stash' && ['drop', 'clear'].includes((args[0] ?? '').toLowerCase())) {
    destructive('`git stash drop/clear` elimina cambios guardados.')
  }
  if (name === 'commit' && hasFlag(args, ['--no-verify'], ['n'])) {
    destructive('`--no-verify` se salta los hooks de commit del proyecto.')
  }
  if (name === 'push') {
    const forced = hasFlag(args, ['--force', '--force-with-lease', '--mirror'], ['f']) ||
      positionals(args).some(arg => arg.startsWith('+'))
    const deleting = hasFlag(args, ['--delete'], ['d']) || positionals(args).some(arg => arg.startsWith(':'))
    publish(
      forced
        ? '`git push` forzado reescribe historia remota que otros pueden tener.'
        : deleting
          ? '`git push --delete` borra una rama o tag remoto.'
          : '`git push` publica commits en el remoto.',
    )
  }
  return out
}

function segmentFindings(segment: Segment, cwd: string, dialect: ShellFacts['dialect'], options: IrreversibleOptions): Finding[] {
  const words = commandWords(segment)
  const program = programName(words[0])
  const args = words.slice(1)
  const lowerArgs = args.map(arg => arg.toLowerCase())
  const out: Finding[] = []
  const destructive = (message: string) => out.push(finding('irreversible.destructive', message))
  const publish = (message: string) => out.push(finding('irreversible.publish', message))

  if (program === 'git') out.push(...gitFindings(words))

  if (program === 'gh') {
    const action = lowerArgs.slice(0, 2).join(' ')
    if (['pr merge', 'release create', 'release delete', 'repo delete', 'repo create', 'gist create'].includes(action)) {
      publish(`\`gh ${action}\` actúa sobre GitHub de forma visible para otros.`)
    }
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && ['publish', 'unpublish', 'deprecate'].includes(lowerArgs[0] ?? '')) {
    publish(`\`${program} ${lowerArgs[0]}\` publica en el registro de paquetes.`)
  }
  if (
    (program === 'vercel' && hasFlag(args, ['--prod'], [])) ||
    (program === 'firebase' && lowerArgs[0] === 'deploy') ||
    (program === 'fly' && lowerArgs[0] === 'deploy') ||
    (program === 'eas' && lowerArgs[0] === 'submit') ||
    (program === 'supabase' && lowerArgs.slice(0, 2).join(' ') === 'db push') ||
    (program === 'wrangler' && ['deploy', 'publish'].includes(lowerArgs[0] ?? ''))
  ) {
    publish(`\`${words.slice(0, 2).join(' ')}\` despliega a un entorno real.`)
  }

  const isPosixDelete = program === 'rm' && hasFlag(args, ['--recursive'], ['r', 'R'])
  const isPsDelete = ['remove-item', 'ri', 'rd', 'rmdir', 'del', 'erase', 'rm'].includes(program) &&
    dialect === 'powershell' && lowerArgs.some(arg => /^-r(ecurse)?$/.test(arg))
  const isCmdDelete = ['rmdir', 'rd'].includes(program) && lowerArgs.includes('/s')
  if (isPosixDelete || isPsDelete || isCmdDelete) {
    const targets = positionals(args, ['-path', '-literalpath', '-include', '-exclude', '-filter'])
      .filter(arg => !(isCmdDelete && /^\/[sq]$/i.test(arg)))
    const valued = args.flatMap((arg, index) =>
      /^-(literal)?path$/i.test(arg) && args[index + 1] !== undefined ? [args[index + 1]!] : [],
    )
    for (const target of [...targets, ...valued]) {
      const why = riskyDeleteTarget(target, cwd, options.regenerable)
      if (why !== undefined) destructive(`Borrado recursivo: ${why}.`)
    }
  }

  if (
    ['pkill', 'killall'].includes(program) ||
    (program === 'taskkill' && lowerArgs.includes('/im')) ||
    (['stop-process', 'spps', 'kill'].includes(program) && lowerArgs.some(arg => arg === '-name' || arg === '-processname'))
  ) {
    destructive('Matar procesos por nombre puede cerrar programas ajenos a la tarea (incluido el propio Claude).')
  }

  if (['mkfs', 'diskpart', 'format', 'format-volume', 'clear-disk'].includes(program) ||
    (program === 'dd' && args.some(arg => arg.startsWith('of=/dev/')))) {
    destructive(`\`${program}\` puede destruir un disco completo.`)
  }
  if (program === 'docker' && (/(system|volume|image|builder) prune/.test(lowerArgs.join(' ')) || lowerArgs.slice(0, 2).join(' ') === 'volume rm')) {
    destructive('Docker prune / volume rm elimina datos persistentes.')
  }
  if (program === 'chmod' && hasFlag(args, ['--recursive'], ['R']) && args.includes('777')) {
    destructive('`chmod -R 777` abre permisos de forma insegura.')
  }
  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(segment.raw) ||
    /\bdelete\s+from\s+\S+\s*(;|$|["'])/i.test(segment.raw)) {
    destructive('SQL destructivo (DROP/TRUNCATE o DELETE sin WHERE).')
  }

  for (const target of segment.redirects) {
    const label = protectedLabel(target, options.extraPaths)
    if (label !== undefined) out.push(finding('irreversible.protected-path', `Escritura por redirección a ${target}: ${label}.`))
  }
  if (['set-content', 'add-content', 'out-file', 'sc', 'ac', 'tee', 'tee-object', 'cp', 'copy', 'copy-item', 'mv', 'move', 'move-item'].includes(program)) {
    const targets = positionals(args, ['-encoding', '-value'])
    const destination = ['cp', 'copy', 'copy-item', 'mv', 'move', 'move-item'].includes(program) ? targets.slice(-1) : targets
    for (const target of destination) {
      const label = protectedLabel(target, options.extraPaths)
      if (label !== undefined) out.push(finding('irreversible.protected-path', `\`${program}\` escribe en ${target}: ${label}.`))
    }
  }
  return out
}

// Killing by name rarely says "by name": the PIDs come from pgrep/pidof/Get-Process through a
// pipe or $(…), and -1 means every process the user owns. These need the whole command.
const KILL_BY_LOOKUP = [
  /\bkill\b[^|;&\n]*(\$\(|`)\s*(pgrep|pidof|lsof\s+-t)\b/,
  /\b(pgrep|pidof|lsof\s+-t)\b[^\n;&]*\|\s*(sudo\s+)?xargs\s+(-\S+\s+)*(sudo\s+)?kill\b/,
  /\b(get-process|gps|ps)\b[^\n;&]*\|\s*(stop-process|spps|kill)\b/i,
  /\bkill\s+(-\S+\s+)*(--\s+)?-1\b/,
  /\bfuser\s+(-\S+\s+)*-[a-z]*k/,
  /\bkillall5\b/,
]

export function shellIrreversible(shell: ShellFacts, cwd: string, options: IrreversibleOptions = DEFAULT_OPTIONS): Finding[] {
  const out = shell.segments.flatMap(segment => segmentFindings(segment, cwd, shell.dialect, options))
  if (!out.some(item => item.message.startsWith('Matar procesos')) && KILL_BY_LOOKUP.some(pattern => pattern.test(shell.command))) {
    out.push(finding('irreversible.destructive', 'Matar procesos por nombre puede cerrar programas ajenos a la tarea (incluido el propio Claude).'))
  }
  if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression)\b/i.test(shell.command)) {
    out.push(finding('irreversible.remote-script', 'Ejecuta un script descargado de internet sin revisarlo.'))
  }
  return out
}

export function writeIrreversible(write: WriteFacts, extraPaths: readonly string[] = []): Finding[] {
  const label = protectedLabel(write.path, extraPaths)
  return label === undefined ? [] : [finding('irreversible.protected-path', `Escritura en ${write.path}: ${label}.`)]
}
