import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CATALOG } from '../src/catalog.ts'
import { materialized, mergeConfig, modeOf, paramOf, parseConfig, withEverySetting } from '../src/config.ts'
import { ROLES } from '../src/agents.ts'
import { findingsFor, type Context } from '../src/evaluate.ts'
import { shellOf } from '../src/facts.ts'
import { emptyLedger } from '../src/ledger.ts'
import type { ToolFacts } from '../src/rules/types.ts'
import { addedLines } from '../src/rules/writes.ts'

const ctx = (raw: unknown): Context => ({ config: parseConfig(raw), ledger: emptyLedger(0), declared: new Set(['vue']), now: 0 })

function shellRules(command: string, raw: unknown): string[] {
  const facts: ToolFacts = { tool: 'Bash', input: { command }, cwd: '/repo', shell: shellOf('Bash', { command }) }
  return findingsFor(facts, ctx(raw)).map(finding => finding.rule)
}

describe('toggling like claude-gates: rule, family, all; project over global', () => {
  test('rule beats family beats all beats default', () => {
    const config = parseConfig({ rules: { all: 'off', irreversible: { mode: 'warn' }, 'irreversible.publish': { mode: 'deny' } } })
    assert.equal(modeOf(config, 'irreversible.publish'), 'deny')
    assert.equal(modeOf(config, 'irreversible.destructive'), 'warn')
    assert.equal(modeOf(config, 'write.lint-suppression'), 'off')
  })
  test('legacy `modes` still reads', () => {
    assert.equal(modeOf(parseConfig({ modes: { 'forge.flow': 'deny' } }), 'forge.flow'), 'deny')
  })
  test('project overrides global field by field, keeping the global params it does not set', () => {
    const merged = mergeConfig(
      parseConfig({ rules: { 'delegation.circuit-breaker': { mode: 'warn', similarity: 0.9 } } }),
      parseConfig({ rules: { 'delegation.circuit-breaker': { mode: 'deny' } } }),
    )
    assert.equal(modeOf(merged, 'delegation.circuit-breaker'), 'deny')
    assert.equal(paramOf(merged, 'delegation.circuit-breaker', 'similarity', 0.85), 0.9)
  })
})

describe('params', () => {
  test('a param of the wrong type falls back to the default, never breaks the rule', () => {
    const config = parseConfig({ rules: { 'irreversible.destructive': { regenerable: 'node_modules' }, 'discipline.prompt': { every: 'x' } } })
    assert.deepEqual(paramOf(config, 'irreversible.destructive', 'regenerable', ['dist']), ['dist'])
    assert.equal(paramOf(config, 'discipline.prompt', 'every', 15), 15)
  })
  test('family-level params apply to the family', () => {
    assert.equal(paramOf(parseConfig({ rules: { completion: { maxBlocks: 1 } } }), 'completion.verify-after-edit', 'maxBlocks', 3), 1)
  })
  test('a project can mark more folders as regenerable', () => {
    assert.ok(shellRules('rm -rf generated', {}).length === 0)
    assert.ok(shellRules('rm -rf ../x', {}).includes('irreversible.destructive'))
    assert.deepEqual(shellRules('rm -rf vendor/*', {}).filter(r => r.startsWith('irreversible')), ['irreversible.destructive'])
    assert.deepEqual(shellRules('rm -rf vendor/*', { rules: { 'irreversible.destructive': { regenerable: ['vendor'] } } }), [])
  })
  test('a project can protect more paths', () => {
    const raw = { rules: { 'irreversible.protected-path': { extraPaths: ['(^|/)infra/prod/'] } } }
    assert.ok(shellRules('echo x > infra/prod/main.tf', raw).includes('irreversible.protected-path'))
    assert.deepEqual(shellRules('echo x > infra/dev/main.tf', raw), [])
  })
  test('a project can pre-approve packages', () => {
    const facts: ToolFacts = {
      tool: 'Write', input: {}, cwd: '/repo',
      write: { path: '/repo/a.ts', before: null, after: "import z from 'zod'", added: addedLines(null, "import z from 'zod'") },
    }
    assert.ok(findingsFor(facts, ctx({})).some(f => f.rule === 'research.unknown-package'))
    assert.deepEqual(findingsFor(facts, ctx({ rules: { 'research.unknown-package': { allow: ['zod'] } } })), [])
  })
})

describe('/gates init materializes every knob', () => {
  test('every catalog rule with its mode and params', () => {
    const all = materialized()
    assert.equal(Object.keys(all).length, CATALOG.length)
    assert.equal(all['discipline.prompt']?.every, 15)
    assert.equal(all['irreversible.publish']?.mode, 'ask')
    assert.ok(Array.isArray(all['irreversible.destructive']?.regenerable))
  })
})

describe('the project file spells out every setting', () => {
  const rulesOf = (file: Record<string, unknown>) => file.rules as Record<string, Record<string, unknown>>
  const agentsOf = (file: Record<string, unknown>) => file.agents as Record<string, Record<string, unknown>>

  test('a missing file gets every rule and agent with its description and the values in force', () => {
    const effective = mergeConfig(parseConfig({ rules: { irreversible: 'deny' }, agents: { builder: { model: 'opus' } } }), parseConfig(undefined))
    const { file, added, changed } = withEverySetting(undefined, effective)
    assert.equal(added, CATALOG.length + ROLES.length)
    assert.ok(changed)
    for (const rule of CATALOG) assert.equal(rulesOf(file)[rule.id]?.descripcion, rule.summary)
    assert.equal(rulesOf(file)['irreversible.publish']?.mode, 'deny')
    assert.equal(rulesOf(file)['forge.flow']?.mode, 'off')
    assert.equal(agentsOf(file).builder?.model, 'opus')
    assert.ok(typeof agentsOf(file).analyst?.descripcion === 'string')
  })

  test('what the person wrote survives; a stale description is refreshed', () => {
    const raw = {
      custom: 1,
      rules: { 'edit.inline-script': { mode: 'off', descripcion: 'vieja' }, 'tasks.split': 'warn', irreversible: { mode: 'ask' } },
      agents: { builder: { effort: 'low' } },
      userRules: [],
    }
    const { file } = withEverySetting(raw, parseConfig(raw))
    assert.equal(file.custom, 1)
    assert.equal(rulesOf(file)['edit.inline-script']?.mode, 'off')
    assert.equal(rulesOf(file)['edit.inline-script']?.descripcion, CATALOG.find(rule => rule.id === 'edit.inline-script')?.summary)
    assert.equal(rulesOf(file)['tasks.split']?.mode, 'warn')
    assert.deepEqual(rulesOf(file).irreversible, { mode: 'ask' })
    assert.equal(agentsOf(file).builder?.effort, 'low')
    assert.deepEqual(file.userRules, [])
  })

  test('the written file reads back to the same modes, and rewriting it changes nothing', () => {
    const first = withEverySetting(undefined, parseConfig(undefined)).file
    const again = withEverySetting(JSON.parse(JSON.stringify(first)), parseConfig(first))
    assert.equal(again.changed, false)
    assert.equal(again.added, 0)
    for (const rule of CATALOG) assert.equal(modeOf(parseConfig(first), rule.id), rule.mode)
  })
})

describe('every option in the project file says what it does', () => {
  test('each param of each rule has its help, and no help names a param that does not exist', () => {
    for (const rule of CATALOG) {
      assert.deepEqual(Object.keys(rule.paramHelp ?? {}).sort(), Object.keys(rule.params ?? {}).sort(), rule.id)
    }
  })
  test('each rule lists what every mode does for it', () => {
    const rules = withEverySetting(undefined, parseConfig(undefined)).file.rules as Record<string, { opciones: { mode: Record<string, string> } }>
    for (const rule of CATALOG) assert.deepEqual(Object.keys(rules[rule.id]!.opciones.mode), ['off', 'warn', 'ask', 'deny'], rule.id)
    assert.match(rules['completion.open-tasks']!.opciones.mode.ask, /deny/)
    assert.match(rules['attribution.strip']!.opciones.mode.warn, /Encendida/)
  })
})
