import { commandWords, gitSubcommand, programName, segmentsOf, type Dialect } from '../shell.ts'

// claude-gates denied the commit and made the agent retry. The intent is only "no AI
// attribution in history", so the trailer is removed and the commit goes through. Work is
// line by line: a trailer line often also carries the closing quote or paren of the message,
// and dropping those breaks the command.

const AI = /(claude|anthropic|noreply@anthropic\.com|\bai\b|gpt|copilot|cursor|codex|gemini)/i
const TRAILER_TEXT = new RegExp(
  `^(co-authored-by:.*${AI.source}.*|claude-session:.*|🤖?\\s*generated with \\[?claude.*|generated (with|by) (claude|ai)\\b.*)$`,
  'i',
)
const SEPARATE_FLAG = /\s+-m\s+(["'])\s*(co-authored-by:[^"'\n]*|claude-session:[^"'\n]*|🤖?\s*generated with[^"'\n]*)\1/gi
const TRAILER_FLAG = /\s+--trailer(?:=|\s+)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/gi

export function isGitCommit(command: string, dialect: Dialect): boolean {
  return segmentsOf(command, dialect).some(segment => {
    const words = commandWords(segment)
    return programName(words[0]) === 'git' && ['commit', 'interpret-trailers'].includes(gitSubcommand(words).name)
  })
}

export function commitMessageFiles(command: string, dialect: Dialect): string[] {
  const out: string[] = []
  for (const segment of segmentsOf(command, dialect)) {
    const words = commandWords(segment)
    if (programName(words[0]) !== 'git' || gitSubcommand(words).name !== 'commit') continue
    const { args } = gitSubcommand(words)
    args.forEach((arg, index) => {
      if ((arg === '-F' || arg === '--file') && args[index + 1] !== undefined && args[index + 1] !== '-') out.push(args[index + 1]!)
      if (arg.startsWith('--file=')) out.push(arg.slice('--file='.length))
    })
  }
  return out
}

export function hasAttributionTrailer(text: string): boolean {
  return text.split('\n').some(line => isTrailer(line))
}

function withoutTrailerFlags(command: string): string {
  return command.replace(TRAILER_FLAG, (whole, double, single, bare) => {
    const value = String(double ?? single ?? bare ?? '').replace(/^([\w-]+)\s*=\s*/, '$1: ')
    return isTrailer(value) ? '' : whole
  })
}

function isTrailer(text: string): boolean {
  const core = text.trim()
  if (/^co-authored-by:/i.test(core) && !AI.test(core)) return false
  return TRAILER_TEXT.test(core)
}

/** The command with AI attribution trailers removed, or undefined when there were none. */
export function stripAttribution(command: string, dialect: Dialect): string | undefined {
  if (!isGitCommit(command, dialect)) return undefined
  const kept: string[] = []
  for (const line of withoutTrailerFlags(command.replace(SEPARATE_FLAG, '')).split('\n')) {
    const cut = line.search(/["'`]/)
    const text = cut === -1 ? line : line.slice(0, cut)
    if (!isTrailer(text)) {
      kept.push(line)
      continue
    }
    const rest = cut === -1 ? '' : line.slice(cut)
    if (rest !== '') {
      while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
      kept[kept.length - 1] = `${kept[kept.length - 1] ?? ''}${rest}`
    }
  }
  const stripped = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n[ \t]*\n([ \t]*(EOF|["'`)]))/g, '\n$1')
  return stripped === command ? undefined : stripped
}

export function promptOrdersAttribution(prompt: string): boolean {
  return /co-authored-by|generated with claude|claude-session/i.test(prompt)
}
