import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CATALOG } from '../src/catalog.ts'
import { materialized, mergeConfig, modeOf, paramOf, parseConfig } from '../src/config.ts'
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
