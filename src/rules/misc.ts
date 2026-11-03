import type { UserRule } from '../config.ts'
import { similarity } from '../text.ts'
import type { Finding } from './types.ts'

export function userRuleFindings(rules: readonly UserRule[], tool: string, text: string): (Finding & { mode: UserRule['mode'] })[] {
  return rules
    .filter(rule => rule.tools === undefined || new RegExp(rule.tools, 'i').test(tool))
    .filter(rule => new RegExp(rule.pattern, 'im').test(text))
    .map(rule => ({ rule: `user.${rule.id}`, message: rule.message, mode: rule.mode }))
}

export function repeatedQuestions(
  asked: readonly string[],
  answered: readonly { question: string; answer: string }[],
  threshold = 0.8,
): Finding[] {
  const out: Finding[] = []
  for (const question of asked) {
    const prior = answered.find(item => similarity(item.question, question) >= threshold)
    if (prior !== undefined) {
      out.push({
        rule: 'questions.no-reconfirm',
        message: `Ya preguntaste esto ("${prior.question}") y la respuesta fue: "${prior.answer}". Úsala en vez de volver a preguntar.`,
      })
    }
  }
  return out
}

export function forgeFlow(active: boolean, agentId: string | undefined): Finding[] {
  if (!active) {
    return [{
      rule: 'forge.flow',
      message: 'Este proyecto usa forge y no hay un run activo. Arranca con `forge_start` y sigue sus fases antes de editar o ejecutar.',
    }]
  }
  if (agentId === undefined) {
    return [{
      rule: 'forge.flow',
      message: 'Hay un run de forge activo: las fases las ejecuta un subagente con el brief de `forge_next`, no el agente principal.',
    }]
  }
  return []
}
