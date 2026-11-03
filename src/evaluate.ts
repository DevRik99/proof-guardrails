import { withoutInjected } from './agents.ts'
import { REGENERABLE_DEFAULT } from './catalog.ts'
import { modeOf, paramOf, type Config } from './config.ts'
import type { Ledger } from './ledger.ts'
import { promptOrdersAttribution } from './rules/attribution.ts'
import { briefFindings } from './rules/delegation.ts'
import { inlineDangerFindings, lockedTargetFindings, opaqueFindings } from './rules/evasion.ts'
import { shellIrreversible, writeIrreversible } from './rules/irreversible.ts'
import { forgeFlow, repeatedQuestions, userRuleFindings } from './rules/misc.ts'
import { importedPackages, installedPackages, unknownPackages } from './rules/research.ts'
import { inlineScripts } from './rules/scripts.ts'
import { completionFindings, grewFindings, isReadOnlyShell, PLAN_DEFAULTS, planFindings, shellWriteTargets, splitFindings, SPLIT_DEFAULTS } from './rules/tasks.ts'
import { allowedBy, type Finding, type Mode, type ToolFacts } from './rules/types.ts'
import { windowsShell } from './rules/windows.ts'
import { lintSuppression, neutralSpanish, timingChange } from './rules/writes.ts'

export type Context = {
  readonly config: Config
  readonly ledger: Ledger
  /** Dependencies declared in the project's package.json; undefined when there is none. */
  readonly declared: ReadonlySet<string> | undefined
  readonly now: number
}

export type Judged = Finding & { readonly mode: Exclude<Mode, 'off'> }

export type Verdict = {
  readonly deny: Judged[]
  readonly ask: Judged[]
  readonly warn: Judged[]
  readonly allowed: { rule: string; reason: string }[]
}

const HATCH = new Set([
  'edit.inline-script', 'write.lint-suppression', 'write.narrating-comments', 'write.neutral-spanish',
  'delegation.brief', 'delegation.memory-dependency', 'delegation.circuit-breaker', 'research.unknown-package',
  'questions.no-reconfirm', 'forge.flow', 'tasks.plan-required',
])

export function hatchHint(rule: string): string {
  return HATCH.has(rule) ? `\n(Excepción justificada: incluye \`gates-allow: ${rule} <motivo>\` en el comando o contenido.)` : ''
}

export function findingsFor(facts: ToolFacts, context: Context): (Finding & { mode?: Judged['mode'] })[] {
  const out: (Finding & { mode?: Judged['mode'] })[] = []
  const { shell, write, tool, input } = facts
  const { config } = context
  const extraPaths = paramOf<readonly string[]>(config, 'irreversible.protected-path', 'extraPaths', [])
  const regenerable = paramOf<readonly string[]>(config, 'irreversible.destructive', 'regenerable', REGENERABLE_DEFAULT)
  const allow = paramOf<readonly string[]>(config, 'research.unknown-package', 'allow', [])

  if (shell !== undefined) {
    out.push(...shellIrreversible(shell, facts.cwd, { regenerable, extraPaths }), ...windowsShell(shell), ...inlineScripts(shell))
    out.push(...unknownPackages(installedPackages(shell), context.declared ?? new Set(), context.ledger.research, allow))
    out.push(...opaqueFindings(shell), ...inlineDangerFindings(shell), ...lockedTargetFindings(context.ledger, [shell.command]))
  }
  if (write !== undefined) {
    out.push(...writeIrreversible(write, extraPaths), ...lintSuppression(write), ...neutralSpanish(write), ...timingChange(write))
    if (context.declared !== undefined) {
      out.push(...unknownPackages(importedPackages(write), context.declared, context.ledger.research, allow))
    }
  }
  if (tool === 'Agent' || tool === 'Task') {
    const prompt = withoutInjected(typeof input.prompt === 'string' ? input.prompt : '')
    const kind = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
    out.push(...briefFindings(prompt, context.ledger.delegations, kind, context.now, {
      similarity: paramOf(config, 'delegation.circuit-breaker', 'similarity', 0.85),
      attempts: paramOf(config, 'delegation.circuit-breaker', 'attempts', 2),
      windowSeconds: paramOf(config, 'delegation.sequential', 'windowSeconds', 120),
    }))
    if (promptOrdersAttribution(prompt)) {
      out.push({ rule: 'delegation.attribution', message: 'El brief ordena agregar atribución de IA (Co-Authored-By / Generated with). Quita esa instrucción.' })
    }
  }
  if (tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const asked = (input.questions as { question?: unknown }[])
      .map(item => (typeof item?.question === 'string' ? item.question : ''))
      .filter(Boolean)
    out.push(...repeatedQuestions(asked, context.ledger.questions, paramOf(config, 'questions.no-reconfirm', 'similarity', 0.8)))
  }
  if (write !== undefined || (shell !== undefined && !isReadOnlyShell(shell))) {
    const split = {
      exempt: paramOf<readonly string[]>(config, 'tasks.split', 'exempt', SPLIT_DEFAULTS.exempt),
      maxFilesSmall: paramOf(config, 'tasks.split', 'maxFilesSmall', SPLIT_DEFAULTS.maxFilesSmall),
    }
    out.push(...splitFindings(context.ledger, split), ...grewFindings(context.ledger, split))
  }
  const written = write !== undefined ? [write.path] : shell !== undefined ? shellWriteTargets(shell) : []
  if (written.length > 0) {
    const maxFiles = paramOf(config, 'tasks.plan-required', 'maxFiles', PLAN_DEFAULTS.maxFiles)
    const via = paramOf<string>(config, 'tasks.plan-required', 'via', PLAN_DEFAULTS.via) === 'any' ? 'any' : 'unlazy'
    out.push(...planFindings(context.ledger, facts.cwd, written, { maxFiles, via }))
  }
  if (tool === 'TaskUpdate' && (input.status === 'completed' || input.status === 'deleted') && input.taskId !== undefined) {
    out.push(...completionFindings(context.ledger, String(input.taskId), input.status))
  }
  if ((shell !== undefined || write !== undefined) && modeOf(context.config, 'forge.flow') !== 'off') {
    out.push(...forgeFlow(context.ledger.forgeActive, facts.agentId))
  }
  return out
}

export function judge(
  findings: readonly (Finding & { mode?: Judged['mode'] })[],
  facts: ToolFacts,
  context: Context,
  text: string,
): Verdict {
  const verdict: Verdict = { deny: [], ask: [], warn: [], allowed: [] }
  const all = [...findings, ...userRuleFindings(context.config.userRules, facts.tool, text)]
  for (const finding of all) {
    const mode = finding.mode ?? modeOf(context.config, finding.rule)
    if (mode === 'off') continue
    const reason = HATCH.has(finding.rule) ? allowedBy(text, finding.rule) : undefined
    if (reason !== undefined) {
      verdict.allowed.push({ rule: finding.rule, reason })
      continue
    }
    verdict[mode].push({ ...finding, mode })
  }
  return verdict
}

export function render(items: readonly Judged[]): string {
  return items.map(item => `[gates:${item.rule}] ${item.message}${item.mode === 'deny' ? hatchHint(item.rule) : ''}`).join('\n\n')
}
