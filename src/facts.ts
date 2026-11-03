import { dialectFor, expandAssignments, segmentsOf } from './shell.ts'
import type { ShellFacts } from './rules/types.ts'

type Input = Readonly<Record<string, unknown>>

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const READ_ONLY = /(^|_)(read|get|list|search|find|grep|glob|stat|info|view|show|query|fetch|describe|status)(_|$)/i
const WRITE_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit)$|write|edit|create_file|save_file|filesystem|patch|replace/i

export function shellOf(tool: string, input: Input): ShellFacts | undefined {
  const command = str(input.command) ?? str(input.cmd) ?? str(input.script)
  if (command === undefined || command.trim() === '') return undefined
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep|Agent|Task)$/.test(tool)) return undefined
  const dialect = dialectFor(tool, command)
  return { command, dialect, segments: expandAssignments(segmentsOf(command, dialect)) }
}

export type WriteIntent = {
  path: string
  /** Full new content (Write-like), or undefined for a replacement edit. */
  content?: string
  replacements: { before: string; after: string }[]
}

export function writeIntentOf(tool: string, input: Input): WriteIntent | undefined {
  if (!WRITE_TOOL.test(tool)) return undefined
  const action = (tool.split('__').pop() ?? tool)
  if (READ_ONLY.test(action) && !/write|edit/i.test(action)) return undefined
  const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? str(input.notebook_path)
  if (path === undefined) return undefined
  const mode = str(input.mode)?.toLowerCase()
  if (mode !== undefined && ['read', 'list', 'info', 'search', 'copy', 'move', 'delete'].includes(mode)) return undefined

  const replacements: WriteIntent['replacements'] = []
  const old = str(input.old_string) ?? str(input.oldText) ?? str(input.old_str)
  const neu = str(input.new_string) ?? str(input.newText) ?? str(input.new_str)
  if (old !== undefined && neu !== undefined) replacements.push({ before: old, after: neu })
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits as unknown[]) {
      const item = (edit ?? {}) as Input
      const before = str(item.old_string) ?? str(item.oldText)
      const after = str(item.new_string) ?? str(item.newText)
      if (before !== undefined && after !== undefined) replacements.push({ before, after })
    }
  }
  const content = str(input.content) ?? str(input.new_source) ?? str(input.text)
  if (content === undefined && replacements.length === 0) return undefined
  return { path, content, replacements }
}

/** What a call's text is for user rules and escape markers: command, content, or prompt. */
export function textOf(input: Input): string {
  return ['command', 'cmd', 'script', 'content', 'new_string', 'new_source', 'prompt', 'description', 'query', 'url']
    .map(key => str(input[key]))
    .filter((value): value is string => value !== undefined)
    .join('\n')
}
