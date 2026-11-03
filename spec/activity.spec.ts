import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { countByEffect, countByRule, outcome, targetOf, toolLabel, type Activity } from '../src/activity.ts'
import type { Verdict } from '../src/evaluate.ts'

const none: Verdict = { deny: [], ask: [], warn: [], allowed: [] }
const judged = (rule: string, mode: 'deny' | 'ask' | 'warn') => ({ rule, message: `msg ${rule}`, mode })

describe('outcome', () => {
  test('a gate deny is "bloqueado" with its rule', () => {
    const result = outcome({ deny: 'x' }, { ...none, deny: [judged('windows.stop-parsing', 'deny')] }, undefined)
    assert.equal(result.effect, 'bloqueado')
    assert.deepEqual(result.rules, ['windows.stop-parsing'])
  })
  test('an ask the person refused is "rechazado"; one that ran is "confirmado"', () => {
    const ask = { ...none, ask: [judged('irreversible.publish', 'ask')] }
    assert.equal(outcome({ deny: 'user said no' }, ask, undefined).effect, 'rechazado')
    assert.equal(outcome({}, ask, undefined).effect, 'confirmado')
  })
  test('a permission refusal arrives as an error result, not as { deny } (seen in the engine)', () => {
    const ran = { isError: true, text: 'Permission to use mcp__x__PowerShell denied by plugin gates: [gates:windows.stop-parsing] …' }
    assert.equal(outcome(ran, { ...none, deny: [judged('windows.stop-parsing', 'deny')] }, undefined).effect, 'bloqueado')
    assert.equal(outcome({ isError: true, text: 'Exit code 1' }, none, undefined).effect, 'error')
  })
  test('a deny no gate made is attributed to the engine', () => {
    assert.deepEqual(outcome({ deny: 'managed policy' }, none, undefined).rules, ['motor'])
  })
  test('rewrite, warning, error and plain ok', () => {
    assert.equal(outcome({}, none, 'attribution.strip').effect, 'reescrito')
    assert.equal(outcome({}, { ...none, warn: [judged('write.timing-change', 'warn')] }, undefined).effect, 'aviso')
    assert.equal(outcome({ isError: true }, none, undefined).effect, 'error')
    assert.equal(outcome({}, none, undefined).effect, 'ok')
  })
})

describe('labels and targets', () => {
  test('MCP tool names read as action · server', () => {
    assert.equal(toolLabel('mcp__remote-devices__Windows-MCP__PowerShell'), 'PowerShell · Windows-MCP')
    assert.equal(toolLabel('Bash'), 'Bash')
  })
  test('target is the first line of the command, the path or the subagent', () => {
    assert.equal(targetOf('Bash', { command: 'git push\necho done' }), 'git push')
    assert.equal(targetOf('Write', { file_path: 'src/a.ts', content: 'x' }), 'src/a.ts')
    assert.equal(targetOf('Agent', { subagent_type: 'proof-guardrails:qa', description: 'atacar login' }), 'proof-guardrails:qa: atacar login')
  })
})

describe('counts', () => {
  const item = (effect: Activity['effect'], rules: string[]): Activity => ({ id: Math.random().toString(), at: 0, tool: 'Bash', target: '', effect, rules, message: '' })
  test('by effect and by rule, most frequent first', () => {
    const list = [item('bloqueado', ['a']), item('bloqueado', ['a', 'b']), item('ok', []), item('aviso', ['b']), item('aviso', ['b'])]
    assert.equal(countByEffect(list).bloqueado, 2)
    assert.deepEqual(countByRule(list), [['b', 3], ['a', 2]])
  })
})
