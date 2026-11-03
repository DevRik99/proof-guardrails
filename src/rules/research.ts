import { commandWords, positionals, programName } from '../shell.ts'
import type { Finding, ShellFacts, WriteFacts } from './types.ts'

const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro)$/i
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2',
  'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'test', 'module', 'inspector',
])

export function packageName(specifier: string): string | undefined {
  if (/^(\.|\/|~|#|node:|bun:|virtual:|data:|https?:)/.test(specifier)) return undefined
  if (/^[@$]?[A-Za-z]:/.test(specifier)) return undefined
  if (/^(@\/|~\/|@@\/)/.test(specifier)) return undefined
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  if (NODE_BUILTINS.has(name)) return undefined
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : undefined
}

export function importedPackages(write: WriteFacts): string[] {
  if (!JS_FILE.test(write.path)) return []
  const found = new Set<string>()
  const pattern = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
  for (const line of write.added) {
    for (const match of line.matchAll(pattern)) {
      const name = packageName(match[1]!)
      if (name !== undefined) found.add(name)
    }
  }
  return [...found]
}

export function installedPackages(shell: ShellFacts): string[] {
  const found: string[] = []
  for (const segment of shell.segments) {
    const words = commandWords(segment)
    const program = programName(words[0])
    const verb = (words[1] ?? '').toLowerCase()
    const adds =
      (program === 'npm' && ['install', 'i', 'add'].includes(verb) && words.length > 2) ||
      (['pnpm', 'yarn', 'bun'].includes(program) && verb === 'add')
    if (!adds) continue
    for (const word of positionals(words.slice(2))) {
      const name = packageName(word.replace(/(?<=.)@[^/]*$/, ''))
      if (name !== undefined) found.push(name)
    }
  }
  return found
}

/** Packages that are new to the project and were not researched in this session. */
export function unknownPackages(
  candidates: readonly string[],
  declared: ReadonlySet<string>,
  researched: readonly string[],
  allow: readonly string[] = [],
): Finding[] {
  const unknown = candidates.filter(name => !declared.has(name) && !allow.includes(name) && !researched.some(text => text.includes(name.toLowerCase())))
  if (unknown.length === 0) return []
  return [{
    rule: 'research.unknown-package',
    message:
      `${unknown.join(', ')} no está en las dependencias del proyecto y no se consultó en esta sesión. ` +
      'No adivines su API desde memoria: busca su documentación actual (WebSearch/WebFetch/context7 con el nombre) ' +
      'y verifica la versión vigente (`npm view <paquete> version`) antes de usarlo.',
  }]
}
