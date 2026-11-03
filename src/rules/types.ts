import type { Dialect, Segment } from '../shell.ts'

export type Mode = 'off' | 'warn' | 'ask' | 'deny'

export type Finding = {
  readonly rule: string
  readonly message: string
}

export type ShellFacts = {
  readonly command: string
  readonly dialect: Dialect
  readonly segments: readonly Segment[]
}

export type WriteFacts = {
  readonly path: string
  /** File text before the write; null for a new file, undefined when unknown. */
  readonly before: string | null | undefined
  readonly after: string
  /** Lines present after the write that were not present before it. */
  readonly added: readonly string[]
}

export type ToolFacts = {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
  readonly agentId?: string
  readonly shell?: ShellFacts
  readonly write?: WriteFacts
}

/** `gates-allow: <rule> <reason>`: one uniform, auditable escape hatch for every rule. */
export function allowedBy(text: string, rule: string): string | undefined {
  const pattern = new RegExp(`gates-allow:\\s*${rule.replaceAll('.', '\\.')}\\b[\\s:—-]*([^\\n]{10,})`)
  const match = pattern.exec(text)
  return match?.[1]?.trim()
}
