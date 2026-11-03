import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Overrides = {
  check?: { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }
  call?: (e: Record<string, unknown>) => unknown
  submit?: (e: { text: string; context?: readonly string[] }) => void
  files?: Record<string, string>
  stored?: Record<string, unknown>
  placed?: { isPlaced: true } | { isPlaced: false; reason: string }
}

// Nothing sits beneath the plugin in a test: each hook here stands for the engine.
function engine(on: On, overrides: Overrides = {}) {
  const files = overrides.files ?? {}
  on('fs.read', ($, e) => {
    const path = String((e as { path?: unknown }).path ?? '').replaceAll('\\', '/')
    const key = Object.keys(files).find(name => path === name || path.endsWith(`/${name}`))
    const text = key === undefined ? undefined : files[key]
    if (text !== undefined) return { value: text }
    throw new Error(`ENOENT: no such file ${path}`)
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  const stored = overrides.stored ?? {}
  on('store.get', ($, e) => ({ value: stored[String((e as { key?: unknown }).key)] }))
  on('store.set', ($, e) => {
    const { key, value } = e as { key?: unknown; value?: unknown }
    stored[String(key)] = value
    return { value: undefined }
  })
  on('ui.open', () => ({ value: overrides.placed ?? { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'gates' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__proof-guardrails__rule_add' } }))
  on('agent.register', () => ({ value: { agent: 'proof-guardrails:x' } }))
  on('tool.check', () => overrides.check ?? { decision: 'allow' })
  on('tool.call', ($, e) => (overrides.call?.(e as never) ?? { result: {} }) as never)
  on('classic.Stop', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    overrides.submit?.(e)
    return { text: e.text, context: e.context }
  })
  on('attribution.text', () => ({ text: 'Co-Authored-By: Claude' }))
}

const START = { cwd: '/repo', surface: 'desktop', isInteractive: true } as const
const TURN = { answer: 'listo', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('tool.check covers what native rules cannot see', () => {
  test('git -C . push asks when the engine would allow it', async ($, on) => {
    engine(on)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git -C . push origin main' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toMatch(/irreversible\.publish/)
  })
  test('an engine ask becomes the plugin ask, so the auto-mode classifier cannot settle it', async ($, on) => {
    engine(on, { check: { decision: 'ask', reason: 'auto mode' } })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'cd /tmp/r && git push origin master' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toMatch(/irreversible\.publish/)
    expect(verdict.reason).toMatch(/auto mode/)
  })
  test('an engine ask with nothing to add is handed up unchanged', async ($, on) => {
    engine(on, { check: { decision: 'ask', reason: 'rule', rule: 'Bash(ls *)' } })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(verdict.rule).toBe('Bash(ls *)')
  })
  test('an engine deny is final', async ($, on) => {
    engine(on, { check: { decision: 'deny', reason: 'managed' } })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(verdict.reason).toBe('managed')
  })
  test('PowerShell over MCP: --% swallowing the next command is denied', async ($, on) => {
    engine(on)
    const verdict = await $.tool.check({
      tool: 'mcp__remote-devices__Windows-MCP__PowerShell',
      input: { command: '& $exe --% mcp add forge -- cmd /c npx pkg 2>&1; & $exe mcp get forge' },
    })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toMatch(/windows\.stop-parsing/)
  })
  test('tool.call asks the person itself, so a skipped tool.check cannot let a push through', async ($, on) => {
    const ran: string[] = []
    engine(on, {
      call: e => {
        if (e.tool === 'AskUserQuestion') {
          const questions = (e as { questions: { question: string }[] }).questions
          return { result: { questions, answers: { [questions[0]!.question]: 'No' } } }
        }
        ran.push(String(e.command))
        return { result: {} }
      },
    })
    const refused = await $.tool.call({ tool: 'Bash', command: 'cd /tmp/r && git push origin master' } as never)
    expect(String((refused as { deny?: string }).deny)).toMatch(/irreversible\.publish[\s\S]*no lo confirmó/)
    expect(ran).toEqual([])
  })
  test('a confirmed push runs once, without a second ask from tool.check', async ($, on) => {
    const ran: string[] = []
    let asks = 0
    engine(on, {
      call: e => {
        if (e.tool === 'AskUserQuestion') {
          asks += 1
          const questions = (e as { questions: { question: string }[] }).questions
          return { result: { questions, answers: { [questions[0]!.question]: 'Sí, ejecutar' } } }
        }
        ran.push(String(e.command))
        return { result: {} }
      },
    })
    const done = await $.tool.call({ tool: 'Bash', command: 'git push origin master' } as never)
    expect((done as { deny?: string }).deny).toBeUndefined()
    expect(ran).toEqual(['git push origin master'])
    expect(asks).toBe(1)
    const activity = await $.command.run({ command: 'gates', args: 'actividad' } as never)
    expect(activity.text).toMatch(/respuesta del diálogo: «Sí, ejecutar»/)
  })
  test('a request that writes a fourth file with no plan is stopped, and shell writes count as edits', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.prompt.submit({ text: 'haz textkit' } as never)
    const first = await $.tool.call({ tool: 'Bash', command: "cat > src/a.ts <<'EOF'\nx\nEOF\ncat > src/b.ts <<'EOF'\ny\nEOF" } as never)
    expect((first as { deny?: string }).deny).toBeUndefined()
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/c.ts', content: 'export const c = 1\n' } as never)
    const fourth = await $.tool.call({ tool: 'Write', file_path: '/repo/src/index.ts', content: 'export {}\n' } as never)
    expect(String((fourth as { deny?: string }).deny)).toMatch(/tasks\.plan-required[\s\S]*4 archivos[\s\S]*proof-guardrails:unlazy/)
    const plan = await $.tool.call({ tool: 'Write', file_path: '/repo/.unlazy/textkit/notes.md', content: 'plan\n' } as never)
    expect((plan as { deny?: string }).deny).toBeUndefined()
  })
  test('the corrida-3 loop: a piped check does not prove a task, a decisive one does, and deleting it unproven is refused', async ($, on) => {
    engine(on, { call: e => (e.tool === 'TaskCreate' ? { result: { task: { id: '1' } }, text: 'Task #1 created' } : { result: {} }) })
    await $.session.start(START)
    await $.prompt.submit({ text: 'haz textkit' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'textkit', description: 'x', metadata: { size: 'small', verify: 'npm test' } } as never)
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/slugify.ts', content: 'export const s = 1\n' } as never)
    const piped = await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -30' } as never)
    expect(((piped as { context?: string[] }).context ?? []).join('\n')).toMatch(/no cuenta como prueba/)
    const early = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
    expect(String((early as { deny?: string }).deny)).toMatch(/tasks\.verify-on-complete[\s\S]*solo o encadenado/)
    const dodge = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' } as never)
    expect(String((dodge as { deny?: string }).deny)).toMatch(/Borrarla no la cierra/)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    const done = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
    expect((done as { deny?: string }).deny).toBeUndefined()
  })
  test('a lone small task stops at the fourth file of the request until the work is split (corrida 4)', async ($, on) => {
    let next = 0
    engine(on, { call: e => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++next) } } } : { result: {} }) })
    await $.session.start(START)
    await $.prompt.submit({ text: 'haz textkit' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'chica', description: 'x', metadata: { size: 'small', verify: 'npm test' } } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
    for (const name of ['a', 'b', 'c']) await $.tool.call({ tool: 'Write', file_path: `/repo/src/${name}.ts`, content: 'export {}\n' } as never)
    const blocked = await $.tool.call({ tool: 'Write', file_path: '/repo/src/d.ts', content: 'export {}\n' } as never)
    expect(String((blocked as { deny?: string }).deny)).toMatch(/tasks\.plan-required[\s\S]*suelta no alcanza[\s\S]*proof-guardrails:unlazy/)
    await $.tool.call({ tool: 'TaskCreate', subject: 'parte d', description: 'x', metadata: { parent: '1', size: 'small', owns: ['src/d.ts'], verify: 'npm test' } } as never)
    const handSplit = await $.tool.call({ tool: 'Write', file_path: '/repo/src/d.ts', content: 'export {}\n' } as never)
    expect(String((handSplit as { deny?: string }).deny)).toMatch(/tasks\.plan-required/)
  })
  test('with via "any" in the project config, a hand split into native sub-tasks is enough', async ($, on) => {
    let next = 0
    const files = { '.ai/gates.json': JSON.stringify({ rules: { 'tasks.plan-required': { mode: 'deny', via: 'any' } } }) }
    engine(on, { files, call: e => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++next) } } } : { result: {} }) })
    await $.session.start(START)
    await $.prompt.submit({ text: 'haz textkit' } as never)
    for (const name of ['a', 'b', 'c']) await $.tool.call({ tool: 'Write', file_path: `/repo/src/${name}.ts`, content: 'export {}\n' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'madre', description: 'x', metadata: { size: 'large' } } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'parte d', description: 'x', metadata: { parent: '1', size: 'small', owns: ['src/d.ts'], verify: 'npm test' } } as never)
    const after = await $.tool.call({ tool: 'Write', file_path: '/repo/src/d.ts', content: 'export {}\n' } as never)
    expect((after as { deny?: string }).deny).toBeUndefined()
  })
  test('installing an unknown package is denied even where there is no package.json yet', async ($, on) => {
    engine(on)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'cd /tmp/r && npm i paquete-que-no-existe-xyz' } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toMatch(/research\.unknown-package/)
  })
  test('plain safe command passes', async ($, on) => {
    engine(on)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
    expect(verdict.decision).toBe('allow')
  })
  test('a lint suppression in a Write is denied, with the existing file read as the baseline', async ($, on) => {
    engine(on, { files: { 'src/a.ts': 'export const a = 1\n' } })
    const verdict = await $.tool.check({ tool: 'Write', input: { file_path: 'src/a.ts', content: 'export const a = 1\n// @ts-ignore\nexport const b: number = "x"\n' } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toMatch(/write\.lint-suppression/)
  })
})

describe('warnings reach the model through the tool result', () => {
  test('a timing change gets context, the call still runs', async ($, on) => {
    let ran = false
    engine(on, { call: () => ((ran = true), undefined) })
    const result = await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'const timeout = 3000', new_string: 'const timeout = 10000' })
    expect(ran).toBe(true)
    expect((result.context ?? []).join('\n')).toMatch(/write\.timing-change/)
  })
})

describe('completion', () => {
  test('classic.Stop holds after an edit with no later verification, releases after one', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: 'export const a = 1\n' })
    const held = await $.classic.Stop({ stop_hook_active: false })
    expect(held.block).toMatch(/completion\.verify-after-edit/)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const released = await $.classic.Stop({ stop_hook_active: true })
    expect(released.block).toBeUndefined()
  })
  test('open native tasks hold the turn', async ($, on) => {
    engine(on, { call: e => (e.tool === 'TaskCreate' ? { result: { task: { id: '7', subject: 'port gates' } } } : undefined) })
    await $.session.start(START)
    await $.tool.call({ tool: 'TaskCreate', subject: 'port gates', description: 'd' })
    const held = await $.classic.Stop({ stop_hook_active: false })
    expect(held.block).toMatch(/#7 port gates/)
  })
  test('where Stop is passed on, turn.complete queues a continuation, bounded', async ($, on) => {
    const submitted: string[] = []
    engine(on, { submit: e => submitted.push(e.text) })
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: 'export const a = 1\n' })
    for (let turn = 0; turn < 5; turn++) await $.turn.complete(TURN as never)
    expect(submitted.length).toBe(3)
    expect(submitted[0]).toMatch(/completion\.verify-after-edit/)
  })
  test('a verified turn ends quietly', async ($, on) => {
    const submitted: string[] = []
    engine(on, { submit: e => submitted.push(e.text) })
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: 'export const a = 1\n' })
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    const done = await $.turn.complete(TURN as never)
    expect(submitted.length).toBe(0)
    expect(done.text).toBe('listo')
  })
})

describe('attribution, delegation and discipline', () => {
  test('attribution text is emptied at the source where the hook runs', async ($, on) => {
    engine(on)
    const answer = await $.attribution.text({ kind: 'commit' } as never)
    expect(answer.text).toBe('')
  })
  test('a commit with an AI trailer is rewritten, not blocked', async ($, on) => {
    let seen = ''
    engine(on, { call: e => ((seen = String(e.command ?? '')), undefined) })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' })
    expect(seen).toMatch(/feat: x/)
    expect(seen).not.toMatch(/Co-Authored-By/)
  })
  test('subagents get the injected context through the Agent call', async ($, on) => {
    let prompt = ''
    engine(on, { call: e => ((prompt = String(e.prompt ?? '')), undefined) })
    await $.tool.call({
      tool: 'Agent',
      subagent_type: 'proof-guardrails:analyst',
      description: 'r',
      prompt: 'Objetivo: revisa src/a.ts y encuentra por qué falla el build. No edites nada. Devuelve la causa con ruta y línea.',
    } as never)
    expect(prompt).toMatch(/<contexto-gates>/)
    expect(prompt).toMatch(/Objetivo: revisa src\/a\.ts/)
  })
  test('a thin brief is refused even with the injected context around it', async ($, on) => {
    engine(on)
    const verdict = await $.tool.check({ tool: 'Agent', input: { prompt: '<contexto-gates>\nEntrega obligatoria: Resultado, Evidencia\n</contexto-gates>\n\nfix it', subagent_type: 'general-purpose' } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toMatch(/delegation\.brief/)
  })
  test('without prompt.compose, the first prompt carries the discipline as context', async ($, on) => {
    const contexts: string[] = []
    engine(on, { submit: e => contexts.push((e.context ?? []).join('\n')) })
    await $.session.start(START)
    await $.prompt.submit({ text: 'hola' } as never)
    expect(contexts.some(text => /Disciplina de trabajo/.test(text))).toBe(true)
  })
})

describe('/gates', () => {
  test('writing native permissions is refused unless the person typed it', async ($, on) => {
    engine(on)
    const answer = await $.command.run({ command: 'gates', args: 'permisos usuario' } as never)
    expect(answer.text).toMatch(/Solo el usuario/)
  })
  test('status reports which hooks actually ran', async ($, on) => {
    engine(on)
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    const answer = await $.command.run({ command: 'gates', args: '' } as never)
    expect(answer.text).toMatch(/tool\.check sí/)
  })
  test('open tasks come back after a process restart resumes the session (seen live)', async ($, on) => {
    const stored: Record<string, unknown> = {
      'tasks-by-session': { 's-1': { at: 1, tasks: [{ id: '12', subject: 'mini proyecto', status: 'in_progress', size: 'small' }] } },
    }
    engine(on, { stored })
    await $.session.start(START)
    const answer = await $.command.run({ command: 'gates', args: '' } as never)
    expect(answer.text).toMatch(/Tareas abiertas: #12 mini proyecto/)
  })
  test('task changes are saved under the session id', async ($, on) => {
    const stored: Record<string, unknown> = {}
    engine(on, { stored, call: e => (e.tool === 'TaskCreate' ? { result: { task: { id: '3' } } } : { result: {} }) })
    await $.session.start(START)
    await $.tool.call({ tool: 'TaskCreate', subject: 'algo', description: 'x', metadata: { size: 'small' } } as never)
    expect(JSON.stringify(stored['tasks-by-session'])).toMatch(/"s-1".*"id":"3"/)
  })
})

const PANE = {
  plugin: 'proof-guardrails',
  component: 'Pane',
  requestId: 'guardrails',
  props: { title: 'Guardrails', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('panel', () => {
  test('the session tab shows what was hit, with the rule, on every surface', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'mcp__remote-devices__Windows-MCP__PowerShell', command: '& $exe --% mcp add x 2>&1; & $exe mcp get x' } as never)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /bloqueado/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /PowerShell · Windows-MCP/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /windows\.stop-parsing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 llamadas/ })).toBeDefined()
      await ui.unmount()
    }
  })
  test('gated decisions persist to the store and show in the history tab', async ($, on) => {
    const stored: Record<string, unknown> = {}
    engine(on, { stored })
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__x__PowerShell', command: 'a --% b; c' } as never)
    expect(Array.isArray(stored.history)).toBe(true)
    expect((stored.history as unknown[]).length).toBe(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab-historial' })
    expect(await ui.find({ type: 'Text', text: /Reglas que más actuaron/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /repo/ })).toBeDefined()
    await ui.unmount()
  })
  test('history from earlier sessions is loaded at start; plain ok calls are not persisted', async ($, on) => {
    const stored: Record<string, unknown> = {
      history: [{ id: 'old', at: 0, tool: 'Bash', target: 'git push', effect: 'rechazado', rules: ['irreversible.publish'], message: 'm', project: 'otro' }],
    }
    engine(on, { stored })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect((stored.history as unknown[]).length).toBe(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab-historial' })
    expect(await ui.find({ type: 'Text', text: /irreversible\.publish/ })).toBeDefined()
    await ui.unmount()
  })
})

const PLAN_TEXT = [
  '# Plan: pagos', '', '## Tree', '',
  '- 1 pagos .......... GATES.md',
  '  - 1.1.1 checkout . gates/leaf-1.1.1.md',
  '  - 1.1.2 webhooks . gates/leaf-1.1.2.md', '',
  '## Leaf dispatch table', '',
  '| Leaf | Owns | Needs | Tier | Planned wave | State |',
  '|---|---|---|---|---|---|',
  '| 1.1.1 | src/checkout/** | - | judgment | 1 | READY |',
  '| 1.1.2 | src/webhooks/** | 1.1.1 | mechanical | 2 | WAITING |', '',
].join('\n')

function taskEngine(on: On, created: Record<string, unknown>[], files: Record<string, string> = {}) {
  let next = 1
  engine(on, {
    files,
    call: e => {
      if (e.tool !== 'TaskCreate') return undefined
      created.push(e)
      return { result: { task: { id: String(next++), subject: String(e.subject) } } }
    },
  })
}

describe('surfaces that place no pane, and reloads', () => {
  test('/gates panel says why and falls back to the text view', async ($, on) => {
    engine(on, { placed: { isPlaced: false, reason: 'the attached surfaces place no panes' } })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const answer = await $.command.run({ command: 'gates', args: 'panel' } as never)
    expect(answer.text).toMatch(/the attached surfaces place no panes/)
    expect(answer.text).toMatch(/Sesión: 1 llamadas/)
  })
  test('/gates actividad and historial work without a pane', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__x__PowerShell', command: 'a --% b; c' } as never)
    expect((await $.command.run({ command: 'gates', args: 'actividad' } as never)).text).toMatch(/BLOQUEADO/)
    expect((await $.command.run({ command: 'gates', args: 'historial' } as never)).text).toMatch(/windows\.stop-parsing/)
  })
  test('a reload (session.start again) keeps the ledger', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: 'export const a = 1\n' })
    await $.session.start(START)
    const held = await $.classic.Stop({ stop_hook_active: false })
    expect(held.block).toMatch(/completion\.verify-after-edit/)
  })
})

describe('split with native tasks generated by unlazy', () => {
  test('a large native task blocks writes until it is split', async ($, on) => {
    const created: Record<string, unknown>[] = []
    taskEngine(on, created)
    await $.session.start(START)
    await $.tool.call({ tool: 'TaskCreate', subject: 'refactor pagos', description: 'd', metadata: { size: 'large' } } as never)
    const verdict = await $.tool.check({ tool: 'Write', input: { file_path: 'src/a.ts', content: 'x' } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toMatch(/tasks\.split/)
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git status' } })).decision).toBe('allow')
  })
  test('writing .unlazy/<scope>/PLAN.md creates the root and one native sub-task per leaf, with its gate-check', async ($, on) => {
    const created: Record<string, unknown>[] = []
    taskEngine(on, created, { '.unlazy/pagos/PLAN.md': PLAN_TEXT })
    await $.session.start(START)
    const result = await $.tool.call({ tool: 'Write', file_path: '.unlazy/pagos/PLAN.md', content: PLAN_TEXT })
    expect(created.length).toBe(3)
    expect(String(created[1]?.subject)).toMatch(/1\.1\.1 checkout/)
    expect(JSON.stringify(created[1]?.metadata)).toMatch(/gate-check\.mjs --root \. --cwd \. --reverify \.unlazy\/pagos\/gates\/leaf-1\.1\.1\.md/)
    expect((result.context ?? []).join('\n')).toMatch(/tareas nativas creadas/)
    await $.tool.call({ tool: 'Write', file_path: '.unlazy/pagos/PLAN.md', content: PLAN_TEXT })
    expect(created.length).toBe(3)
    expect((await $.tool.check({ tool: 'Write', input: { file_path: 'src/checkout/a.ts', content: 'x' } })).decision).toBe('allow')
  })
  test('a leaf cannot be marked completed until its gate-check passed after it started', async ($, on) => {
    const created: Record<string, unknown>[] = []
    taskEngine(on, created, { '.unlazy/pagos/PLAN.md': PLAN_TEXT })
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', file_path: '.unlazy/pagos/PLAN.md', content: PLAN_TEXT })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)
    const refused = await $.tool.check({ tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' } })
    expect(refused.decision).toBe('deny')
    expect(refused.reason).toMatch(/tasks\.verify-on-complete/)
    await $.tool.call({ tool: 'Bash', command: 'node skills/unlazy/scripts/gate-check.mjs --reverify .unlazy/pagos/gates/leaf-1.1.1.md' })
    expect((await $.tool.check({ tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' } })).decision).toBe('allow')
  })
})
