import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ROLES, spawnContext, withoutInjected } from '../src/agents.ts'
import { findingsFor } from '../src/evaluate.ts'
import { EMPTY_CONFIG, mergeConfig, parseConfig } from '../src/config.ts'
import { emptyLedger, openTasks, recordTaskCreated, recordTaskUpdated } from '../src/ledger.ts'
import { isNativeRule, nativePermissions, withNative } from '../src/native.ts'

describe('native permission rules', () => {
  test('defaults go to ask and cover both Bash and PowerShell', () => {
    const { ask, deny } = nativePermissions(EMPTY_CONFIG)
    assert.equal(deny.length, 0)
    assert.ok(ask.includes('Bash(git push *)'))
    assert.ok(ask.includes('PowerShell(git push *)'))
    assert.ok(ask.includes('Edit(**/.env)'))
  })
  test('a rule set to deny moves its entries; off removes them', () => {
    const config = parseConfig({ modes: { 'irreversible.publish': 'deny', 'irreversible.protected-path': 'off' } })
    const { ask, deny } = nativePermissions(config)
    assert.ok(deny.includes('Bash(git push *)'))
    assert.ok(!ask.includes('Bash(git push *)'))
    assert.ok(!ask.includes('Edit(**/.env)'))
  })
  test('merging keeps the user settings and adds without duplicates', () => {
    const settings = { model: 'opus', permissions: { ask: ['Bash(git push *)'], deny: ['Read(.env)'], defaultMode: 'bypassPermissions' } }
    const merged = withNative(settings, EMPTY_CONFIG)
    const permissions = merged.permissions as { ask: string[]; deny: string[]; defaultMode: string }
    assert.equal(merged.model, 'opus')
    assert.equal(permissions.defaultMode, 'bypassPermissions')
    assert.deepEqual(permissions.deny, ['Read(.env)'])
    assert.equal(permissions.ask.filter(rule => rule === 'Bash(git push *)').length, 1)
    assert.deepEqual(merged.attribution, { commit: '', pr: '' })
  })
  test('attribution policy follows its rule mode', () => {
    const merged = withNative({}, parseConfig({ modes: { 'attribution.strip': 'off' } }))
    assert.equal(merged.attribution, undefined)
  })
  test('rule_add accepts only native-expressible rules', () => {
    assert.ok(isNativeRule('Bash(npm publish *)'))
    assert.ok(isNativeRule('Edit(**/secrets/**)'))
    assert.ok(isNativeRule('mcp__forge__forge_start'))
    assert.ok(!isNativeRule('mcp__x__y(param:1)'))
    assert.ok(!isNativeRule('rm -rf'))
  })
})

describe('config', () => {
  test('malformed fields are dropped, never fatal', () => {
    const config = parseConfig({ modes: { a: 'nope', 'write.neutral-spanish': 'off' }, userRules: [{ id: 'x', pattern: '(', mode: 'deny', message: 'm' }], agents: { builder: { model: 'opus', effort: 'turbo' } } })
    assert.deepEqual(config.rules, { 'write.neutral-spanish': { mode: 'off' } })
    assert.equal(config.userRules.length, 0)
    assert.deepEqual(config.agents, { builder: { model: 'opus' } })
  })
  test('project overrides global per field', () => {
    const merged = mergeConfig(
      parseConfig({ modes: { 'forge.flow': 'deny' }, agents: { builder: { model: 'opus', effort: 'high' } } }),
      parseConfig({ modes: { 'forge.flow': 'off' }, agents: { builder: { effort: 'low' } } }),
    )
    assert.equal(merged.rules['forge.flow']?.mode, 'off')
    assert.deepEqual(merged.agents.builder, { model: 'opus', effort: 'low' })
  })
})

describe('native tasks in the ledger', () => {
  test('created, progressed, completed and deleted', () => {
    let ledger = emptyLedger(0)
    ledger = recordTaskCreated(ledger, '1', 'port gates')
    ledger = recordTaskCreated(ledger, '2', 'tests')
    ledger = recordTaskUpdated(ledger, '1', 'in_progress', undefined)
    assert.deepEqual(openTasks(ledger).map(task => task.id), ['1', '2'])
    ledger = recordTaskUpdated(ledger, '1', 'completed', undefined)
    ledger = recordTaskUpdated(ledger, '2', 'deleted', undefined)
    assert.deepEqual(openTasks(ledger), [])
  })
})

describe('roles', () => {
  test('every role has a model, effort and delivery contract; reviewers cannot write', () => {
    for (const role of ROLES) {
      assert.match(role.model, /^(haiku|sonnet|opus)$/)
      assert.ok(['low', 'medium', 'high'].includes(role.effort))
    }
    assert.equal(ROLES.find(role => role.name === 'builder')?.readOnly, false)
    assert.ok(ROLES.filter(role => role.name !== 'builder').every(role => role.readOnly))
  })
  test('the injected context never makes a thin brief pass', () => {
    const injected = `${spawnContext('/repo', ['delegation.brief'])}\n\nfix it`
    assert.equal(withoutInjected(injected), 'fix it')
    const facts = { tool: 'Agent', input: { prompt: injected, subagent_type: 'general-purpose' }, cwd: '/repo' }
    const context = { config: EMPTY_CONFIG, ledger: emptyLedger(0), declared: undefined, now: 0 }
    assert.ok(findingsFor(facts, context).some(finding => finding.rule === 'delegation.brief'))
  })
  test('spawn context tells the subagent what it lacks and what to return', () => {
    const text = spawnContext('/repo', ['irreversible.publish'])
    assert.match(text, /\/repo/)
    assert.match(text, /No tienes la conversación/)
    assert.match(text, /Evidencia/)
  })
})
