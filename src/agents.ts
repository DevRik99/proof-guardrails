// forge's phase roles as native agent types: each one carries its own model, effort and
// tool limits, so the policy lives in the definition instead of in every brief.

export type Role = {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  readonly readOnly: boolean
  readonly contract: string
}

const DELIVERY = [
  'Entrega obligatoria, en este orden:',
  '1. Resultado: qué encontraste o hiciste, concreto.',
  '2. Evidencia: comandos que corriste con su exit code, rutas con número de línea, URLs consultadas.',
  '3. No verificado: lo que no pudiste comprobar y por qué. Nunca lo presentes como hecho.',
].join('\n')

export const ROLES: readonly Role[] = [
  {
    name: 'analyst',
    description: 'Investiga y aclara: lee código y documentación, clasifica el pedido y detecta ambigüedades que cambian el resultado. No modifica archivos.',
    model: 'sonnet',
    effort: 'high',
    readOnly: true,
    contract: 'Eres el analista. Lee antes de concluir. Separa hechos verificados de supuestos. Si una ambigüedad cambia el producto, devuélvela con opciones y consecuencias; no la resuelvas tú.',
  },
  {
    name: 'architect',
    description: 'Diseña y planifica antes de construir: decide enfoque, versiones reales de dependencias y descompone en tareas atómicas con archivos disjuntos. No modifica archivos.',
    model: 'opus',
    effort: 'high',
    readOnly: true,
    contract: 'Eres el arquitecto. Antes de proponer una pieza nueva, busca si ya existe en el proyecto. Versiones de paquetes: verifícalas con `npm view`, nunca de memoria. El plan debe tener tareas con archivos propios y un criterio de terminado comprobable por comando.',
  },
  {
    name: 'builder',
    description: 'Implementa un plan o una tarea acotada: reutiliza lo existente, edita sin reescribir archivos enteros y deja el linter en verde.',
    model: 'sonnet',
    effort: 'medium',
    readOnly: false,
    contract: 'Eres el constructor. Implementa completo, sin placeholders ni "TODO luego". Después de editar, corre el lint/typecheck/tests que correspondan y reporta sus exit codes reales.',
  },
  {
    name: 'verifier',
    description: 'Corre los gates reales del repo (lint, typecheck, build, tests) y reporta exit codes. No corrige nada.',
    model: 'haiku',
    effort: 'low',
    readOnly: true,
    contract: 'Eres el verificador. La verdad es el exit code, no tu opinión. Corre cada comando pedido y reporta comando, exit code y las líneas relevantes del error. No intentes arreglar fallas.',
  },
  {
    name: 'qa',
    description: 'Prueba que lo construido funciona de punta a punta y luego lo ataca: entradas raras, límites, estados imposibles. Reporta qué rompió. No corrige nada.',
    model: 'sonnet',
    effort: 'high',
    readOnly: true,
    contract: 'Eres QA. Primero confirma el camino feliz ejecutándolo. Después ataca: vacíos, nulos, límites, concurrencia, permisos, errores de red. Cada falla con pasos para reproducirla.',
  },
  {
    name: 'reviewer',
    description: 'Revisión independiente y ciega de un cambio terminado: no conoce el veredicto de QA y lo mira con ojos frescos. No modifica archivos.',
    model: 'opus',
    effort: 'high',
    readOnly: true,
    contract: 'Eres el revisor independiente. No asumas que el cambio está bien porque otro lo dijo. Busca errores de lógica, casos borde, regresiones y deuda. Cada hallazgo con ruta:línea y por qué importa.',
  },
]

export function rolePrompt(role: Role): string {
  return `${role.contract}\n\n${DELIVERY}`
}

/** The brief as the model wrote it, without the context this mod injects. */
export function withoutInjected(prompt: string): string {
  return prompt.replace(/<contexto-gates>[\s\S]*?<\/contexto-gates>\s*/g, '')
}

export function spawnContext(cwd: string, activeRules: readonly string[]): string {
  return [
    '<contexto-gates>',
    `Proyecto: ${cwd}`,
    'No tienes la conversación del agente principal. Si te falta información, dilo en tu respuesta en vez de suponer.',
    `Reglas deterministas activas (${activeRules.length}): las acciones irreversibles piden confirmación y otras se bloquean. Si algo se bloquea, no lo intentes por otra vía: repórtalo.`,
    DELIVERY,
    '</contexto-gates>',
  ].join('\n')
}
