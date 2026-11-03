import { similarity } from '../text.ts'
import type { Finding } from './types.ts'

export type PastDelegation = { readonly kind: string; readonly prompt: string; readonly at: number }

// A subagent starts with no conversation: a brief that leans on it, or that names no goal
// or finish line, produces work that comes back half-done. These checks are structural.

const GOAL = /(objetivo|meta|goal|tarea|task|qu[eé] (hacer|necesito)|debes|tienes que|you (must|need|should)|implementa|investiga|revisa|encuentra|find|implement|review|research|audit)/i
const DONE = /(listo cuando|terminad[oa] cuando|criterio|entregable|devuelve|reporta|responde con|done when|deliverable|return|report|output|acceptance|definition of done|al final)/i
const MEMORY = /(como (dijimos|hablamos|vimos|acordamos|te dije)|lo (anterior|de antes|que hablamos)|el archivo que (vimos|mencion)|ya sabes|as (we )?discussed|as mentioned( above| earlier)?|the (above|earlier|previous) (file|plan|approach|conversation)|you already know|like before)/i

export type DelegationOptions = { readonly similarity: number; readonly attempts: number; readonly windowSeconds: number }

export const DELEGATION_DEFAULTS: DelegationOptions = { similarity: 0.85, attempts: 2, windowSeconds: 120 }

export function briefFindings(
  prompt: string,
  past: readonly PastDelegation[],
  kind: string,
  now: number,
  options: DelegationOptions = DELEGATION_DEFAULTS,
): Finding[] {
  const out: Finding[] = []
  const text = prompt.trim()
  if (text.length < 80 || !GOAL.test(text) || !DONE.test(text)) {
    out.push({
      rule: 'delegation.brief',
      message:
        'El brief para el subagente es insuficiente. Debe ser autosuficiente e incluir: objetivo concreto, ' +
        'contexto necesario (rutas, decisiones tomadas), qué SÍ y qué NO hacer, y criterio de terminado / qué devolver.',
    })
  }
  const leaning = MEMORY.exec(text)
  if (leaning !== null && !/memory-not-needed/.test(text)) {
    out.push({
      rule: 'delegation.memory-dependency',
      message:
        `El brief depende de la memoria de esta conversación ("${leaning[0]}"), que el subagente no tiene. ` +
        'Escribe explícitamente lo que necesita saber.',
    })
  }
  const similar = past.filter(item => item.kind === kind && similarity(item.prompt, text) >= options.similarity)
  if (similar.length >= options.attempts) {
    out.push({
      rule: 'delegation.circuit-breaker',
      message:
        `Es el intento ${similar.length + 1} de una delegación casi idéntica. Repetir lo mismo no cambia el resultado: ` +
        'diagnostica por qué falló (lee lo que devolvió), cambia el enfoque o resuélvelo tú.',
    })
  }
  const last = past[past.length - 1]
  if (last !== undefined && now - last.at < options.windowSeconds * 1000 && similarity(last.prompt, text) < 0.5 && !/SEQUENTIAL-JUSTIFIED/.test(text)) {
    out.push({
      rule: 'delegation.sequential',
      message:
        'Lanzaste delegaciones una tras otra. Si son independientes, lánzalas juntas en un mismo mensaje para que ' +
        'corran en paralelo. Si esta depende de la anterior, ignora este aviso.',
    })
  }
  return out
}
