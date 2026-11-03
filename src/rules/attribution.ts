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

export function isGitCommit(command: string, dialect: Dialect): boolean {
  return segmentsOf(command, dialect).some(segment => {
    const words = commandWords(segment)
    return programName(words[0]) === 'git' && gitSubcommand(words).name === 'commit'
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
  for (const line of command.replace(SEPARATE_FLAG, '').split('\n')) {
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
