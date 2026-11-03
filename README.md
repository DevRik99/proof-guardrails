# proof-guardrails

Guardrails deterministas para Claude (app de chat, desktop y Claude Code), hechos como **mod**:
confirma lo irreversible, no deja dar por terminado sin evidencia, parte el trabajo grande con
[unlazy](https://github.com/Leonxlnx/unlazy) en tareas nativas verificables y te muestra con qué
choca cada acción. Port por intención de [claude-gates](https://github.com/DevRik99/claude-gates)
con los roles del pipeline de [forge](https://github.com/DevRik99/forge-mcp) como agentes nativos.

Criterio: **lo nativo primero**. El mod solo cubre lo que el motor no puede expresar.

## Instalación

En la app (desktop o web): botón **+** junto al prompt → **Plugins** → **Add marketplace** con
`DevRik99/proof-guardrails` → **Add plugin**.

En una terminal de Claude Code:

```
/plugin install proof-guardrails --marketplace DevRik99/proof-guardrails
```

Desde un shell:

```
claude plugin install proof-guardrails --marketplace DevRik99/proof-guardrails
```

## Qué hace

| Intención | Cómo |
|---|---|
| Nada irreversible sin confirmación | Antes de ejecutar, el mod te pide confirmación con el diálogo del motor (y además desde `tool.check`, el punto nativo de permisos, por si el diálogo no corre). Sin nadie que responda, como en `claude -p`, se rechaza. Cubre push, deploys, publicar paquetes, `reset --hard`, borrados recursivos fuera del proyecto, matar procesos por nombre, SQL destructivo, escribir `.env`/lockfiles, `curl \| sh`. Entiende comandos encadenados, `git -C`, rutas absolutas, `bash -c` y shells por MCP (PowerShell remoto incluido). `/gates permisos` escribe además las reglas nativas `permissions.ask` en tu settings |
| Arrancar el pipeline solo | Cuando un pedido ya toca más de `maxFiles` archivos (3 por defecto; cuenta Write/Edit y escrituras por shell: `>`, heredocs, `tee`) sin un plan partido, la siguiente escritura se bloquea hasta partirlo con unlazy, cuyo PLAN.md crea las tareas nativas. Una tarea `small` suelta no alcanza. Con `"via": "any"` en `.ai/gates.json` también vale partirlo a mano en subtareas nativas (`tasks.plan-required`) |
| Partir antes de implementar | Una tarea que no sea `small`/`trivial` bloquea escribir y ejecutar hasta partirla en subtareas nativas, cada una con archivos propios y su verificación. Al escribir un `.unlazy/<scope>/PLAN.md` el mod crea las tareas nativas solo: la madre y una por hoja, cada una con su `gate-check --reverify` como verificación. Las tareas nativas siguen el trabajo; unlazy lo parte y lo prueba |
| Gates antes que código | Con un plan de unlazy, escribir en los archivos que posee una hoja se bloquea hasta que exista su `.unlazy/<scope>/gates/leaf-<id>.md` (`tasks.leaf-gates-first`) |
| Cerrar con evidencia | Marcar `completed` o borrar una tarea se bloquea si el mod no vio pasar su verificación después de su última edición, o si tiene subtareas abiertas. Solo cuenta una verificación cuyo exit code sea el del comando (sin `\| tail`, `;` ni `\|\| true` después) y que haya corrido al menos un test: una salida como `# tests 0` o `No tests found` no prueba nada, aunque la salida se haya redirigido a un archivo. No se puede cerrar el turno con ediciones sin verificación posterior, tareas abiertas o gates de `GATES.md` sin evidencia |
| Ver con qué choca | `/gates actividad` lista cada herramienta usada, a qué apuntó, el veredicto (bloqueado, rechazado, confirmado, aviso, reescrito, retenido) y la regla. `/gates historial` guarda las decisiones entre sesiones con conteo por regla. En superficies que acomodan paneles, `/gates panel` lo muestra en vivo |
| Sin atribución de IA | Reescribe el commit quitando `Co-Authored-By`/`Generated with` en vez de bloquear |
| Shell de Windows | Bloquea `--%` seguido de más comandos en la misma línea; avisa de JSON con comillas pasado a programas nativos desde PowerShell 5.1 |
| Editar con Edit/Write | Bloquea `node -e` que escribe archivos, `sed -i`, `Set-Content` sobre código |
| Calidad al escribir | Juzga solo lo agregado: supresiones de lint, voseo en textos, cambios de timeouts sin evidencia, comentarios que narran el código (clasificador, según el lenguaje del archivo) |
| Delegación | Seis roles nativos con modelo y esfuerzo propios: `proof-guardrails:analyst`, `:architect`, `:builder`, `:verifier`, `:qa`, `:reviewer`. A todo subagente se le inyecta el contexto que no tiene. Se bloquean briefs sin objetivo o sin terminado, los que dependen de la conversación y el tercer reintento idéntico |
| Investigar antes de adivinar | Un paquete nuevo (import o `npm install`) se bloquea si en la sesión no se consultó su documentación |
| No repreguntar | Bloquea una pregunta casi igual a una ya respondida y devuelve la respuesta anterior |
| Reincidencia → regla | La tool `mcp__proof-guardrails__rule_add` convierte un error repetido en una regla de permisos nativa (o regex si no es expresable). Solo agrega restricciones |
| Disciplina | Sección fija en el system prompt, o como contexto del prompt si el system prompt no es modificable |

## Configuración por proyecto

Todo se activa, desactiva y ajusta por proyecto en `.ai/gates.json`; lo global es el fallback
y el proyecto gana. Un valor con tipo equivocado cae al default y nunca rompe la regla.

```json
{
  "rules": {
    "all": { "mode": "warn" },
    "irreversible": { "mode": "ask" },
    "irreversible.destructive": { "regenerable": ["node_modules", "dist", "vendor"] },
    "irreversible.protected-path": { "extraPaths": ["(^|/)infra/prod/"] },
    "research.unknown-package": { "allow": ["zod"] },
    "tasks.split": { "exempt": ["small", "trivial"], "maxFilesSmall": 3 },
    "forge.flow": { "mode": "deny" },
    "completion": { "maxBlocks": 2 }
  },
  "agents": { "builder": { "model": "opus", "effort": "high" } }
}
```

Precedencia del modo: regla > familia > `all` > default. Modos: `off`, `warn`, `ask`, `deny`.

Comandos (los que cambian configuración solo los ejecuta la persona):

- `/gates`: hooks que corrieron en la sesión, ediciones sin verificar, tareas abiertas, últimas decisiones.
- `/gates actividad [gates]` y `/gates historial`: con qué chocó cada acción, en la sesión y entre sesiones.
- `/gates panel`: el panel en vivo; si la superficie no acomoda paneles, dice el motivo y muestra la vista en texto.
- `/gates reglas`: cada regla con su modo efectivo y de dónde sale (proyecto, global, default).
- `/gates modo <regla|familia|all> <off|warn|ask|deny> [proyecto|global]`: proyecto por defecto.
- `/gates init`: escribe en `.ai/gates.json` cada regla con su modo y parámetros por defecto, sin pisar lo existente.
- `/gates permisos <proyecto|usuario>`: escribe las reglas nativas `permissions.ask/deny` y la atribución vacía en `.claude/settings.local.json` o `~/.claude/settings.json`, con respaldo `.gates.bak`.

Excepción justificada en reglas de criterio: `gates-allow: <regla> <motivo>` en el comando o
contenido. No aplica a las reglas irreversibles: esas las confirma la persona.

## Datos

El historial de decisiones se guarda en el almacenamiento local del plugin (últimas 500). La
regla de comentarios narrativos envía los comentarios nuevos a un clasificador del mismo modelo
de la sesión. No hay servidores externos ni telemetría propia.

## Límites conocidos

- Donde un plugin de seguridad integrado se sienta por encima de los mods de usuario, el motor
  puede saltar `settings.read`, `prompt.compose`, `attribution.text` y `classic.*` del mod.
  `/gates` muestra qué hooks corrieron; el mod usa alternativas (`tool.call`/`tool.check` siguen
  bloqueando, la disciplina va como contexto del prompt, el Stop se emula con un turno de
  continuación).
- No todas las superficies acomodan paneles: la app de chat no lo hace; los comandos de texto
  funcionan en todas.
- Las reglas sobre comandos son un análisis léxico, no una frontera de seguridad: para
  aislamiento real de sistema de archivos y red usa el sandbox nativo de Claude Code.
- Contra rodeos (familia `evasion`) el mod no intenta adivinar cada forma de escribir lo mismo:
  frena lo que no puede resolver (eval, base64 a un intérprete, texto canalizado a un shell,
  programa en una variable), mira la capacidad del código (`os.kill`, `rmtree`, `subprocess`…),
  analiza el contenido de los scripts escritos en la sesión antes de ejecutarlos, y tras un
  bloqueo mantiene bloqueado el mismo objetivo por cualquier vía hasta tu próximo mensaje. Un
  modelo aparte revisa los comandos siguientes. Aun así, un rodeo que el mod no reconozca puede
  pasar: el corpus de `spec/corpus.spec.ts` dice qué está cubierto, y cada rodeo nuevo que
  aparezca se agrega ahí.

## Desarrollo

```bash
node --experimental-strip-types --test spec/*.spec.ts   # reglas puras
claude plugin test .                                    # hooks dentro del motor
claude plugin validate .
```

`skills/unlazy` es una copia de unlazy en el commit `16671491f6679ad9378f52604d3bc2415b4120c7`
bajo su propia licencia MIT.
