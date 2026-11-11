import { ROLES } from './agents.ts'
import { CATALOG, defaultMode, MODES, RULE_IDS } from './catalog.ts'
import type { Mode } from './rules/types.ts'

// Same philosophy as claude-gates: every rule is toggled and tuned per project
// (.ai/gates.json), the global store is the fallback, and a value of the wrong type falls
// back to the rule's default instead of breaking the rule.

export type UserRule = {
  id: string
  /** Regex over the tool name; absent means every tool. */
  tools?: string
  /** Regex over the call's text (command, written content, prompt). */
  pattern: string
  mode: 'warn' | 'ask' | 'deny'
  message: string
  reason: string
  addedAt: string
}

export type AgentOverride = { model?: string; effort?: string }

/** One rule's, family's or `all`'s setting: its mode and any of its params. */
export type RuleSetting = { mode?: Mode } & Record<string, unknown>

export type Config = {
  /** Keyed by rule id (`irreversible.publish`), family (`irreversible`) or `all`. */
  rules: Record<string, RuleSetting>
  userRules: UserRule[]
  /** Per-role model/effort for the native agent types, e.g. { builder: { model: 'opus' } }. */
  agents: Record<string, AgentOverride>
}

export const EMPTY_CONFIG: Config = { rules: {}, userRules: [], agents: {} }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRules(raw: Record<string, unknown>): Record<string, RuleSetting> {
  const rules: Record<string, RuleSetting> = {}
  if (isRecord(raw.modes)) {
    for (const [id, mode] of Object.entries(raw.modes)) if (isMode(mode)) rules[id] = { mode }
  }
  if (isRecord(raw.rules)) {
    for (const [id, value] of Object.entries(raw.rules)) {
      if (isMode(value)) rules[id] = { ...rules[id], mode: value }
      else if (isRecord(value)) {
        const { mode, ...params } = value
        rules[id] = { ...rules[id], ...params, ...(isMode(mode) ? { mode } : {}) }
      }
    }
  }
  return rules
}

function parseAgents(value: unknown): Record<string, AgentOverride> {
  if (!isRecord(value)) return {}
  const out: Record<string, AgentOverride> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const override: AgentOverride = {}
    if (typeof raw.model === 'string' && /^[\w.:-]{2,80}$/.test(raw.model)) override.model = raw.model
    if (typeof raw.effort === 'string' && EFFORTS.includes(raw.effort)) override.effort = raw.effort
    out[name] = override
  }
  return out
}

export function compiles(source: string): boolean {
  try {
    new RegExp(source)
    return source.length > 0 && source.length <= 500
  } catch {
    return false
  }
}

function isUserRule(value: unknown): value is UserRule {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.pattern !== 'string' || typeof value.message !== 'string') return false
  if (!['warn', 'ask', 'deny'].includes(String(value.mode))) return false
  return compiles(value.pattern) && (value.tools === undefined || (typeof value.tools === 'string' && compiles(value.tools)))
}

/** Reads one config source defensively: a malformed field is dropped, never fatal. */
export function parseConfig(value: unknown): Config {
  if (!isRecord(value)) return EMPTY_CONFIG
  return {
    rules: parseRules(value),
    userRules: Array.isArray(value.userRules) ? value.userRules.filter(isUserRule) : [],
    agents: parseAgents(value.agents),
  }
}

/** Project overrides global, field by field; user rules from both apply. */
export function mergeConfig(global: Config, project: Config): Config {
  const rules: Record<string, RuleSetting> = { ...global.rules }
  for (const [id, setting] of Object.entries(project.rules)) rules[id] = { ...rules[id], ...setting }
  const agents: Record<string, AgentOverride> = { ...global.agents }
  for (const [name, override] of Object.entries(project.agents)) agents[name] = { ...agents[name], ...override }
  const seen = new Set<string>()
  const userRules = [...project.userRules, ...global.userRules].filter(rule => !seen.has(rule.id) && (seen.add(rule.id), true))
  return { rules, userRules, agents }
}

export function familyOf(id: string): string {
  return id.split('.')[0] ?? id
}

/** The rule's mode: its own setting, else its family's, else `all`, else the catalog default. */
export function modeOf(config: Config, id: string): Mode {
  return config.rules[id]?.mode ?? config.rules[familyOf(id)]?.mode ?? config.rules.all?.mode ?? defaultMode(id)
}

function sameShape(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value) && value.every(item => typeof item === 'string')
  return typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))
}

/** A param of a rule (or of its family), of the default's type; anything else is the default. */
export function paramOf<T>(config: Config, id: string, name: string, fallback: T): T {
  for (const key of [id, familyOf(id)]) {
    const value = config.rules[key]?.[name]
    if (value !== undefined && sameShape(value, fallback)) return value as T
  }
  return fallback
}

/** Every rule with its default mode and params, as `/gates init` writes them for a project. */
export function materialized(): Record<string, RuleSetting> {
  return Object.fromEntries(CATALOG.map(rule => [rule.id, { mode: rule.mode, ...(rule.params ?? {}) }]))
}

const DESCRIPTION = 'descripcion'

/** Read at the top of the project file, refreshed on every write, never parsed as config. */
export const PROJECT_FILE_HELP = [
  'Cada regla de proof-guardrails con el modo y los parámetros que estaban en vigor cuando se escribió este archivo.',
  'Cambia "mode" para activar o desactivar: off (apagada), warn (avisa), ask (pide confirmación), deny (bloquea).',
  'Precedencia: regla > familia (p. ej. "irreversible") > "all" > global (/gates modo … global) > default.',
  'Como cada regla está escrita aquí, una clave de familia o "all" solo alcanza a reglas que no estén listadas.',
  '"agents": modelo (model) y esfuerzo (effort: low, medium, high, xhigh, max) de cada subagente del mod.',
  '"descripcion" se actualiza sola; lo demás que edites se conserva. Reglas y agentes nuevos del mod se agregan al iniciar sesión.',
]

function settingOf(value: unknown): Record<string, unknown> {
  if (isMode(value)) return { mode: value }
  return isRecord(value) ? value : {}
}

/**
 * The project file with every catalog rule and agent role spelled out at the values `effective` puts in force,
 * keeping whatever the file already says. `changed` is false when writing it back would change nothing.
 */
export function withEverySetting(raw: unknown, effective: Config): { file: Record<string, unknown>; added: number; changed: boolean } {
  const base = isRecord(raw) ? raw : {}
  const existing = isRecord(base.rules) ? base.rules : {}
  const catalogRules: Record<string, Record<string, unknown>> = {}
  let added = 0
  for (const rule of CATALOG) {
    if (existing[rule.id] === undefined) added += 1
    const params = Object.fromEntries(Object.entries(rule.params ?? {}).map(([name, fallback]) => [name, paramOf(effective, rule.id, name, fallback)]))
    const { [DESCRIPTION]: _staleRule, ...kept } = settingOf(existing[rule.id])
    catalogRules[rule.id] = { [DESCRIPTION]: rule.summary, mode: modeOf(effective, rule.id), ...params, ...kept }
  }
  const otherRules = Object.fromEntries(Object.entries(existing).filter(([id]) => !RULE_IDS.has(id)))
  const existingAgents = isRecord(base.agents) ? base.agents : {}
  const roleAgents: Record<string, Record<string, unknown>> = {}
  for (const role of ROLES) {
    if (existingAgents[role.name] === undefined) added += 1
    const { [DESCRIPTION]: _staleRole, ...kept } = settingOf(existingAgents[role.name])
    const override = effective.agents[role.name] ?? {}
    roleAgents[role.name] = { [DESCRIPTION]: role.description, model: override.model ?? role.model, effort: override.effort ?? role.effort, ...kept }
  }
  const otherAgents = Object.fromEntries(Object.entries(existingAgents).filter(([name]) => !ROLES.some(role => role.name === name)))
  const { $ayuda: _staleHelp, ...rest } = base
  const file = { $ayuda: PROJECT_FILE_HELP, ...rest, rules: { ...otherRules, ...catalogRules }, agents: { ...otherAgents, ...roleAgents } }
  return { file, added, changed: JSON.stringify(file) !== JSON.stringify(raw) }
}
