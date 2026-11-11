import type { Mode } from './rules/types.ts'

export type RuleInfo = {
  readonly id: string
  readonly mode: Mode
  readonly summary: string
  /** Tunable params and their defaults; a project overrides any of them in .ai/gates.json. */
  readonly params?: Readonly<Record<string, string | number | boolean | readonly string[]>>
  /** What each param does and the values it takes; one entry per key of `params`. */
  readonly paramHelp?: Readonly<Record<string, string>>
  /**
   * How the mode acts. `action` (default): judged on each tool call. `turn`: judged when the turn ends,
   * where nothing can be confirmed, so ask blocks like deny. `switch`: only on or off.
   */
  readonly kind?: 'action' | 'turn' | 'switch'
}

export const REGENERABLE_DEFAULT = [
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit',
  'coverage', '.cache', '.turbo', '.parcel-cache', 'target', 'tmp', '.tmp', '__pycache__',
]

/** Every rule, its default mode, and what it protects. The one source the config and /gates read. */
export const CATALOG: readonly RuleInfo[] = [
  { id: 'irreversible.destructive', mode: 'ask', summary: 'Borrados recursivos fuera del proyecto, reset --hard, clean -f, matar procesos por nombre, SQL destructivo', params: { regenerable: REGENERABLE_DEFAULT }, paramHelp: { regenerable: 'Lista de carpetas regenerables (nombre de primer nivel) que se pueden borrar sin confirmar' } },
  { id: 'irreversible.publish', mode: 'ask', summary: 'git push, merge de PR, releases, publicar paquetes, deploys' },
  { id: 'irreversible.protected-path', mode: 'ask', summary: 'Escribir .env, lockfiles, .git interno, settings de Claude, ~/.ssh, la config de estos gates', params: { extraPaths: [] }, paramHelp: { extraPaths: 'Lista de regex sobre la ruta (con /) que se protegen además de las incluidas, p. ej. "(^|/)infra/prod/"' } },
  { id: 'irreversible.remote-script', mode: 'ask', summary: 'Ejecutar scripts descargados (curl | sh, irm | iex)' },
  { id: 'evasion.opaque', mode: 'ask', summary: 'Comandos cuyo efecto no se puede ver antes de ejecutarlos: eval/iex, -EncodedCommand, base64 → intérprete, texto canalizado a un shell, programa en una variable sin resolver' },
  { id: 'evasion.inline-dangerous', mode: 'ask', summary: 'Intérpretes inline (python -c, node -e, perl -e…) o scripts nuevos que matan procesos, borran o lanzan otros comandos' },
  { id: 'evasion.blocked-target', mode: 'ask', summary: 'Volver a apuntar, por cualquier vía, a un proceso o ruta cuyo kill/borrado se bloqueó; vale hasta el próximo mensaje del usuario' },
  { id: 'evasion.fresh-script', mode: 'ask', summary: 'Al ejecutar un script escrito en la sesión (o un npm run tras editar package.json) se analiza su contenido con las mismas reglas' },
  { id: 'evasion.second-opinion', mode: 'ask', summary: 'Tras un bloqueo de algo irreversible, un modelo aparte revisa cada comando no trivial y frena si rodea el bloqueo' },
  { id: 'attribution.strip', mode: 'deny', summary: 'Quita trailers de atribución de IA de los commits (los reescribe, no bloquea)', kind: 'switch' },
  { id: 'windows.stop-parsing', mode: 'deny', summary: '`--%` seguido de otros comandos en la misma línea de PowerShell' },
  { id: 'windows.native-quotes', mode: 'warn', summary: 'JSON o comillas dobles en argumentos a programas nativos desde PowerShell 5.1' },
  { id: 'edit.inline-script', mode: 'deny', summary: 'Editar archivos con node -e, sed -i, Set-Content, etc. en vez de Edit/Write' },
  { id: 'write.lint-suppression', mode: 'deny', summary: 'Silenciar el linter o type-checker en vez de corregir' },
  { id: 'write.narrating-comments', mode: 'deny', summary: 'Comentarios que narran qué hace el código (juzgado por un clasificador)' },
  { id: 'write.neutral-spanish', mode: 'deny', summary: 'Voseo o léxico regional en textos en español' },
  { id: 'write.timing-change', mode: 'warn', summary: 'Cambiar timeouts/reintentos sin evidencia del origen' },
  { id: 'delegation.brief', mode: 'deny', summary: 'Brief de subagente sin objetivo, contexto y criterio de terminado' },
  { id: 'delegation.memory-dependency', mode: 'deny', summary: 'Brief que depende de que el subagente recuerde la conversación' },
  { id: 'delegation.circuit-breaker', mode: 'deny', summary: 'Tercer intento de la misma delegación sin cambios', params: { similarity: 0.85, attempts: 2 }, paramHelp: { similarity: 'Número de 0 a 1: desde qué parecido un brief cuenta como el mismo intento', attempts: 'Número: intentos parecidos permitidos; el siguiente se bloquea' } },
  { id: 'delegation.sequential', mode: 'warn', summary: 'Delegaciones independientes lanzadas en serie', params: { windowSeconds: 120 }, paramHelp: { windowSeconds: 'Segundos: dos delegaciones distintas dentro de esta ventana cuentan como lanzadas en serie' } },
  { id: 'delegation.attribution', mode: 'deny', summary: 'Brief que ordena agregar atribución de IA' },
  { id: 'research.unknown-package', mode: 'deny', summary: 'Usar o instalar un paquete nuevo sin consultar su documentación en la sesión', params: { allow: [] }, paramHelp: { allow: 'Lista de paquetes que se pueden usar sin consultar su documentación en la sesión' } },
  { id: 'questions.no-reconfirm', mode: 'deny', summary: 'Volver a preguntar algo que ya respondiste', params: { similarity: 0.8 }, paramHelp: { similarity: 'Número de 0 a 1: desde qué parecido una pregunta cuenta como ya respondida' } },
  { id: 'forge.flow', mode: 'off', summary: 'Sin run activo de forge no se edita; con run, edita un subagente' },
  { id: 'tasks.split', mode: 'deny', summary: 'Tarea no chica sin subtareas nativas, o subtareas sin verificación declarada (split con el método de unlazy)', params: { exempt: ['small', 'trivial'], maxFilesSmall: 3 }, paramHelp: { exempt: 'Lista de tamaños de tarea que no hace falta partir', maxFilesSmall: 'Número: archivos que puede tocar una tarea chica antes de exigir partirla (lo usa también tasks.small-grew)' } },
  { id: 'tasks.plan-required', mode: 'deny', summary: 'Un pedido que ya toca más de maxFiles archivos sin plan partido: partirlo con unlazy (via "unlazy") o también a mano con subtareas nativas (via "any")', params: { maxFiles: 3, via: 'unlazy' }, paramHelp: { maxFiles: 'Número: archivos que puede tocar un pedido sin plan partido', via: '"unlazy": solo vale un PLAN.md de unlazy; "any": también vale partirlo a mano en subtareas nativas' } },
  { id: 'tasks.leaf-gates-first', mode: 'deny', summary: 'Escribir en archivos de una hoja de unlazy antes de que exista su .unlazy/<scope>/gates/leaf-<id>.md' },
  { id: 'tasks.from-unlazy', mode: 'warn', summary: 'Crea las tareas nativas (madre + una por hoja, con su gate-check como verify) al escribir un .unlazy/<scope>/PLAN.md', kind: 'switch' },
  { id: 'tasks.small-grew', mode: 'deny', summary: 'Tarea declarada chica que ya toca más archivos que maxFilesSmall (parámetro en tasks.split): partirla antes de seguir' },
  { id: 'tasks.verify-on-complete', mode: 'deny', summary: 'Cerrar (completed) o borrar una tarea sin que su verificación haya pasado después de su última edición, o con subtareas abiertas' },
  { id: 'completion.verify-after-edit', mode: 'deny', summary: 'Terminar el turno con ediciones sin verificación posterior (maxBlocks vale para toda la familia completion)', params: { maxBlocks: 3 }, paramHelp: { maxBlocks: 'Número: veces que se retiene el fin de turno antes de dejarlo terminar (vale para toda la familia completion)' }, kind: 'turn' },
  { id: 'completion.open-tasks', mode: 'deny', summary: 'Terminar el turno con tareas abiertas', kind: 'turn' },
  { id: 'completion.unlazy-ledger', mode: 'deny', summary: 'Terminar el turno con gates de GATES.md (unlazy) sin evidencia', kind: 'turn' },
  { id: 'discipline.prompt', mode: 'warn', summary: 'Reglas de autocuestionamiento en el system prompt (every: cada cuántos prompts se recuerda si el system prompt no es modificable)', params: { every: 15 }, paramHelp: { every: 'Número: cada cuántos prompts se recuerdan las reglas cuando el system prompt no es modificable' }, kind: 'switch' },
]

/** What each mode does, by how the rule acts. Written next to every rule in the project file. */
export const MODE_HELP: Readonly<Record<NonNullable<RuleInfo['kind']>, Readonly<Record<Mode, string>>>> = {
  action: {
    off: 'Apagada: no revisa nada',
    warn: 'Avisa al modelo y deja seguir',
    ask: 'Te pide confirmación antes de ejecutar; sin nadie a quién preguntar, se rechaza',
    deny: 'Bloquea la acción',
  },
  turn: {
    off: 'Apagada: deja terminar el turno',
    warn: 'Avisa al terminar el turno y deja terminar',
    ask: 'Igual que deny: al terminar el turno no hay qué confirmar, así que retiene el turno',
    deny: 'Retiene el turno hasta resolverlo (máximo maxBlocks veces)',
  },
  switch: {
    off: 'Apagada',
    warn: 'Encendida (warn, ask y deny hacen lo mismo)',
    ask: 'Encendida (warn, ask y deny hacen lo mismo)',
    deny: 'Encendida (warn, ask y deny hacen lo mismo)',
  },
}

export const RULE_IDS = new Set(CATALOG.map(rule => rule.id))
export const FAMILIES = new Set(CATALOG.map(rule => rule.id.split('.')[0]!))
export const MODES: readonly Mode[] = ['off', 'warn', 'ask', 'deny']

export function defaultMode(id: string): Mode {
  return CATALOG.find(rule => rule.id === id)?.mode ?? 'deny'
}
