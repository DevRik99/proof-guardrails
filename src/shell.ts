// Shell analysis shared by every rule that judges a command. Substring matching on the raw
// command (what claude-gates did) misfires both ways: `echo "git push"` was flagged, and
// `git -C repo push` slipped past a `git push` pattern. Rules here see parsed segments.
//
// This is a best-effort lexer, not a full shell grammar: quotes, escapes, chain operators,
// redirections and heredoc bodies are understood; expansions are left as literal text.

export type Dialect = 'posix' | 'powershell'

const CHAIN = ['&&', '||', ';', '|', '&', '\n'] as const

export type ChainOperator = (typeof CHAIN)[number]

export type Segment = {
  readonly raw: string
  readonly words: readonly string[]
  readonly redirects: readonly string[]
  readonly next?: ChainOperator
}
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nice', 'nohup', 'env', 'doas', '&', '.'])

export function dialectFor(toolName: string, command: string): Dialect {
  if (/powershell|pwsh/i.test(toolName)) return 'powershell'
  if (/^\s*(powershell|pwsh)(\.exe)?\b/i.test(command)) return 'powershell'
  return 'posix'
}

function heredocBodies(command: string): { text: string; bodies: string[] } {
  const bodies: string[] = []
  const lines = command.split('\n')
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    out.push(line)
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (marker === null) continue
    const end = marker[2]!
    const body: string[] = []
    index++
    while (index < lines.length && lines[index]!.trim() !== end) body.push(lines[index++]!)
    bodies.push(body.join('\n'))
  }
  return { text: out.join('\n'), bodies }
}

/** Splits a command into chained segments, each with its words and redirect targets. */
export function segmentsOf(command: string, dialect: Dialect): Segment[] {
  const { text } = heredocBodies(command)
  const escape = dialect === 'powershell' ? '`' : '\\'
  const segments: Segment[] = []
  let raw = ''
  let word = ''
  let hasWord = false
  let words: string[] = []
  let redirects: string[] = []
  let pendingRedirect = false
  let depth = 0

  const endWord = () => {
    if (!hasWord) return
    if (pendingRedirect) {
      redirects.push(word)
      pendingRedirect = false
    } else words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (next?: ChainOperator) => {
    endWord()
    if (raw.trim() !== '' || words.length > 0) {
      segments.push(next === undefined ? { raw: raw.trim(), words, redirects } : { raw: raw.trim(), words, redirects, next })
    } else if (next !== undefined && segments.length > 0 && next !== '\n') {
      const last = segments[segments.length - 1]!
      segments[segments.length - 1] = { ...last, next }
    }
    raw = ''
    words = []
    redirects = []
    pendingRedirect = false
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    const rest = text.slice(index)

    if (char === escape && index + 1 < text.length) {
      raw += char + text[index + 1]
      word += text[index + 1]
      hasWord = true
      index++
      continue
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1)
      const end = close === -1 ? text.length : close
      raw += text.slice(index, end + 1)
      word += text.slice(index + 1, end)
      hasWord = true
      index = end
      continue
    }
    if (char === '"') {
      let end = index + 1
      let value = ''
      while (end < text.length && text[end] !== '"') {
        if (text[end] === escape && end + 1 < text.length) {
          value += text[end + 1]
          end += 2
          continue
        }
        value += text[end]
        end++
      }
      raw += text.slice(index, end + 1)
      word += value
      hasWord = true
      index = end
      continue
    }
    if (char === '(' && text[index - 1] === '$') depth++
    if (char === ')' && depth > 0) depth--

    if (depth === 0) {
      const chain = CHAIN.find(op => rest.startsWith(op))
      const isRedirectAmp = chain === '&' && (text[index - 1] === '>' || text[index + 1] === '>')
      if (chain !== undefined && !isRedirectAmp) {
        endSegment(chain)
        index += chain.length - 1
        continue
      }
      const redirect = /^(\d?>>?|\*>>?)(&\d)?/.exec(rest)
      if (redirect !== null && !hasWord) {
        raw += redirect[0]
        index += redirect[0].length - 1
        if (redirect[2] === undefined) pendingRedirect = true
        continue
      }
      if (/\s/.test(char)) {
        raw += char
        endWord()
        continue
      }
    }
    raw += char
    word += char
    hasWord = true
  }
  endSegment()
  return segments
}

/** The words with leading env assignments and wrapper commands removed. */
export function commandWords(segment: Segment): string[] {
  const words = [...segment.words]
  while (words.length > 0) {
    const first = words[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first.toLowerCase())) {
      words.shift()
      continue
    }
    break
  }
  return words
}

/** `C:\x\git.exe` and `/usr/bin/git` are both `git`. */
export function programName(word: string | undefined): string {
  if (word === undefined) return ''
  const base = word.replaceAll('\\', '/').split('/').pop() ?? word
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/** Flags of a word list, with combined short flags expanded (`-rf` → r, f). */
export function hasFlag(words: readonly string[], long: string[], short: string[]): boolean {
  for (const word of words) {
    if (word === '--') break
    const lower = word.toLowerCase()
    if (long.some(flag => lower === flag || lower.startsWith(flag + '='))) return true
    if (/^-[A-Za-z]+$/.test(word) && short.some(flag => word.slice(1).includes(flag))) return true
  }
  return false
}

/** Positional arguments, skipping flags (and the value of flags listed as taking one). */
export function positionals(words: readonly string[], valued: string[] = []): string[] {
  const out: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (word.startsWith('-') && word.length > 1) {
      if (valued.includes(word.toLowerCase())) index++
      continue
    }
    out.push(word)
  }
  return out
}

/** For `git -C dir -c k=v push`, returns `push` and what follows it. */
export function gitSubcommand(words: readonly string[]): { name: string; args: string[] } {
  let index = 1
  while (index < words.length && words[index]!.startsWith('-')) {
    index += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(words[index]!) ? 2 : 1
  }
  return { name: (words[index] ?? '').toLowerCase(), args: words.slice(index + 1) }
}

export function lines(command: string): string[] {
  return command.split(/\r?\n/)
}
