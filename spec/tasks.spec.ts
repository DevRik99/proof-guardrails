import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { activityText, historyText } from '../src/activity.ts'
import { shellOf } from '../src/facts.ts'
import { creditTasks, emptyLedger, recordTaskCreated, recordTaskUpdated, sameCheck } from '../src/ledger.ts'
import { completionFindings, grewFindings, isReadOnlyShell, leafLedgersFor, ownsMatch, planFindings, shellWriteTargets, splitFindings, workPaths } from '../src/rules/tasks.ts'
import { checkRedirects, decisiveChecks, ranNoTests, recordEdit } from '../src/ledger.ts'
import { addedLines, newComments } from '../src/rules/writes.ts'
import { leafSpecs, parsePlan, reverifyCommand, rootSpec, scopeOfPlanPath } from '../src/unlazy-plan.ts'

const PLAN = readFileSync(new URL('./fixtures/PLAN.md', import.meta.url), 'utf8')

describe('leaf gates before leaf work (csvkit wrote code before its gates)', () => {
  test('owns globs: **, *, plain files', () => {
    assert.ok(ownsMatch('src/checkout/**', 'src/checkout/a/b.ts'))
    assert.ok(ownsMatch('src/**/x.ts', 'src/x.ts'))
    assert.ok(ownsMatch('src/**/x.ts', 'src/a/b/x.ts'))
    assert.ok(!ownsMatch('src/**/x.ts', 'src/ax.ts'))
    assert.ok(ownsMatch('src/*.ts', 'src/parse.ts'))
    assert.ok(!ownsMatch('src/*.ts', 'src/a/parse.ts'))
    assert.ok(ownsMatch('src/parse.ts', './src/parse.ts'))
    assert.ok(!ownsMatch('src/parse.ts', 'src/parseXts'))
  })
  test('a write to a file an open unlazy leaf owns needs that leaf ledger', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '2', '1.1 parse', { parent: '1', size: 'small', unlazy: 'csvkit', leaf: '1.1', owns: ['src/parse.ts', 'src/parse.test.ts'] })
    ledger = recordTaskCreated(ledger, '3', '1.2 serialize', { parent: '1', size: 'small', unlazy: 'csvkit', leaf: '1.2', owns: ['src/serialize.ts'] })
    assert.deepEqual(leafLedgersFor(ledger, '/repo', ['/repo/src/parse.ts']).map(item => item.ledger), ['.unlazy/csvkit/gates/leaf-1.1.md'])
    assert.deepEqual(leafLedgersFor(ledger, '/repo', ['src/index.ts']), [])
    assert.deepEqual(leafLedgersFor(ledger, '/repo', ['.unlazy/csvkit/gates/leaf-1.1.md']), [])
    assert.deepEqual(leafLedgersFor(recordTaskUpdated(ledger, '2', 'completed', undefined), '/repo', ['src/parse.ts']), [])
  })
})

describe('a check counts only when its exit code is the command exit code', () => {
  test('alone, redirected or followed only by && it decides the result', () => {
    assert.deepEqual(decisiveChecks('npm test', 'posix'), ['npm test'])
    assert.deepEqual(decisiveChecks('npm test 2>&1', 'posix'), ['npm test 2>&1'])
    assert.deepEqual(decisiveChecks('cd repo && npm test && npm run lint', 'posix'), ['npm test', 'npm run lint'])
  })
  test('a pipe, ; or || after it hides a failure, so it does not count', () => {
    for (const command of ['npm test 2>&1 | tail -30', 'npm test >/dev/null 2>&1; echo "exit=$?"', 'npm test || true', 'npm test && echo ok | tee out.txt']) {
      assert.deepEqual(decisiveChecks(command, 'posix'), [], command)
    }
  })
  test('a run that found no tests is not proof (seen in validation: "# tests 0")', () => {
    const live = '> g@1.0.0 test\n> node --test\n\nTAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n'
    assert.ok(ranNoTests(live))
    for (const output of ['ℹ tests 0\nℹ pass 0', '  0 passing (2ms)', 'No tests found, exiting with code 0', 'No test files found, exiting with code 1', '===== collected 0 items =====', 'ok  \tpkg/x\t[no test files]']) {
      assert.ok(ranNoTests(output), output)
    }
    for (const output of ['# tests 21\n# pass 21\n# fail 0', 'ℹ tests 10', '  10 passing (5ms)', 'collected 12 items', 'tsc: no errors']) {
      assert.ok(!ranNoTests(output), output)
    }
  })
  test('the files a check writes its output to can be read back', () => {
    assert.deepEqual(checkRedirects('cd x && npm test > out.txt 2>&1', 'posix'), ['out.txt'])
    assert.deepEqual(checkRedirects('npm test 2>/dev/null', 'posix'), [])
  })
  test('a pending task that declares the check is credited when it passes, without being in_progress', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '1', 'textkit', { size: 'small', verify: 'npm test' })
    ledger = creditTasks(ledger, undefined, { command: 'npm test', at: 5 })
    assert.equal(ledger.tasks[0]?.verifiedAt, 5)
    ledger = creditTasks(ledger, { path: 'src/a.ts' }, undefined)
    assert.equal(ledger.tasks[0]?.files, undefined)
  })
})

describe('plan-required: the pipeline starts on its own once a request outgrows maxFiles', () => {
  const heredoc = "mkdir -p src && cat > src/a.ts <<'EOF'\nx\nEOF\ncat > src/b.ts <<'EOF'\ny\nEOF\nprintf z | tee src/c.ts > /dev/null && echo ok > run.log"
  test('shell writes are read from redirections, heredocs and tee; logs and /dev are not work', () => {
    const shell = shellOf('Bash', { command: heredoc })!
    assert.deepEqual(shellWriteTargets(shell).sort(), ['run.log', 'src/a.ts', 'src/b.ts', 'src/c.ts'])
    assert.deepEqual(workPaths('/repo', shellWriteTargets(shell)).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })
  test('one command writing four files with no plan and no task is denied', () => {
    const shell = shellOf('Bash', { command: `${heredoc} && cat > src/index.ts <<'EOF'\nw\nEOF` })!
    const found = planFindings(emptyLedger(0), '/repo', shellWriteTargets(shell))
    assert.equal(found[0]?.rule, 'tasks.plan-required')
    assert.match(found[0]!.message, /4 archivos/)
  })
  test('earlier edits in the same request count, absolute and relative paths are one file', () => {
    let ledger = emptyLedger(0)
    for (const path of ['/repo/src/a.ts', '/repo/src/b.ts', 'src/c.ts']) ledger = recordEdit(ledger, path, 1)
    assert.equal(planFindings(ledger, '/repo', ['src/a.ts']).length, 0)
    assert.equal(planFindings(ledger, '/repo', ['/repo/src/d.ts'])[0]?.rule, 'tasks.plan-required')
  })
  test('a lone small task does not exempt it past maxFiles (escape seen in corrida 4); a split plan does', () => {
    let ledger = emptyLedger(0)
    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) ledger = recordEdit(ledger, path, 1)
    const lone = recordTaskCreated(ledger, '1', 'chica', { size: 'small' })
    assert.equal(planFindings(lone, '/repo', ['src/d.ts'])[0]?.rule, 'tasks.plan-required')
    const split = recordTaskCreated(lone, '2', 'parte', { parent: '1', size: 'small', verify: 'npm test' })
    assert.equal(planFindings(split, '/repo', ['src/d.ts'])[0]?.rule, 'tasks.plan-required', 'by default a hand split is not unlazy')
    assert.equal(planFindings(split, '/repo', ['src/d.ts'], { maxFiles: 3, via: 'any' }).length, 0)
    assert.equal(planFindings(recordTaskCreated(ledger, '5', 'unlazy root', { size: 'large', unlazy: 'textkit' }), '/repo', ['src/d.ts']).length, 0)
  })
  test('the plan itself or files outside the project do not trigger it', () => {
    let ledger = emptyLedger(0)
    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) ledger = recordEdit(ledger, path, 1)
    assert.equal(planFindings(ledger, '/repo', ['.unlazy/textkit/PLAN.md', '/repo/.unlazy/textkit/gates/leaf-1.1.1.md']).length, 0)
    assert.equal(planFindings(ledger, '/repo', ['/tmp/salida.ts']).length, 0)
  })
  test('writes after cd into another repo, or into $VAR and ~ paths, are not this project (false positive seen live)', () => {
    const live = "R=$S/install/textkit; rm -rf $R && mkdir -p $R && cd $R && printf x > package.json && printf y > .gitignore && claude -p hola > $S/install/run4.jsonl 2>$S/install/run4.err"
    assert.deepEqual(workPaths('/home/claude', shellWriteTargets(shellOf('Bash', { command: live })!)), [])
    const other = 'cd /tmp/otro && cat > a.ts <<EOF\nx\nEOF'
    assert.deepEqual(workPaths('/home/claude', shellWriteTargets(shellOf('Bash', { command: other })!)), [])
    assert.deepEqual(workPaths('/repo', shellWriteTargets(shellOf('Bash', { command: 'cd /repo/pkg && echo x > b.ts' })!)), ['pkg/b.ts'])
    assert.deepEqual(workPaths('/repo', shellWriteTargets(shellOf('Bash', { command: 'cd src && echo x > c.ts' })!)), ['src/c.ts'])
  })
  test('maxFiles is the threshold', () => {
    let ledger = emptyLedger(0)
    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) ledger = recordEdit(ledger, path, 1)
    assert.equal(planFindings(ledger, '/repo', ['src/d.ts'], { maxFiles: 5, via: 'unlazy' }).length, 0)
  })
})

describe('split (require-task-split, native tasks + unlazy)', () => {
  test('a large task without sub-tasks blocks; unspecified size counts as not small', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '1', 'refactor pagos', { size: 'large' })
    assert.equal(splitFindings(ledger)[0]?.rule, 'tasks.split')
    ledger = recordTaskCreated(emptyLedger(0), '1', 'algo')
    assert.equal(splitFindings(ledger).length, 1)
    assert.equal(splitFindings(recordTaskCreated(emptyLedger(0), '1', 'typo', { size: 'small' })).length, 0)
  })
  test('sub-tasks without a declared check still block; with one they pass', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '1', 'refactor', { size: 'large' })
    ledger = recordTaskCreated(ledger, '2', 'parte a', { parent: '1', size: 'small' })
    assert.match(splitFindings(ledger)[0]?.message ?? '', /sin verificación declarada/)
    ledger = recordTaskUpdated(ledger, '2', undefined, undefined, 0, { verify: 'npm test' })
    assert.deepEqual(splitFindings(ledger), [])
  })
  test('an unlazy scope alone does not stand in for native sub-tasks', () => {
    const ledger = recordTaskCreated(emptyLedger(0), '1', 'pagos', { size: 'large', unlazy: 'pagos' })
    assert.equal(splitFindings(ledger).length, 1)
  })
  test('read-only and verification commands stay allowed while unsplit', () => {
    for (const command of ['git status', 'ls src', 'cat a.ts | grep x', 'npm test', 'git log --oneline', 'npm view zod version']) {
      assert.ok(isReadOnlyShell(shellOf('Bash', { command })!), command)
    }
    for (const command of ['npm install zod', 'echo x > a.ts', 'git commit -m x', 'rm a.ts', 'git branch -D x']) {
      assert.ok(!isReadOnlyShell(shellOf('Bash', { command })!), command)
    }
  })
  test('a small task that grows past maxFilesSmall is flagged until it has sub-tasks', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '1', 'x', { size: 'small' })
    ledger = recordTaskUpdated(ledger, '1', 'in_progress', undefined, 1)
    for (const path of ['a', 'b', 'c', 'd']) ledger = creditTasks(ledger, { path }, undefined)
    assert.equal(grewFindings(ledger)[0]?.rule, 'tasks.small-grew')
  })
})

describe('closing with evidence', () => {
  const started = () => recordTaskUpdated(recordTaskCreated(emptyLedger(0), '2', 'leaf', { verify: 'npm test -- auth' }), '2', 'in_progress', undefined, 100)
  test('completed is refused until the declared check is seen passing after the start', () => {
    assert.equal(completionFindings(started(), '2')[0]?.rule, 'tasks.verify-on-complete')
    const early = creditTasks(started(), undefined, { command: 'npm test -- auth', at: 50 })
    assert.equal(completionFindings(early, '2').length, 1)
    const proven = creditTasks(started(), undefined, { command: 'npm test -- auth', at: 150 })
    assert.deepEqual(completionFindings(proven, '2'), [])
  })
  test('a parent with open sub-tasks cannot be completed', () => {
    let ledger = recordTaskCreated(emptyLedger(0), '1', 'madre', { size: 'large' })
    ledger = recordTaskCreated(ledger, '2', 'hija', { parent: '1', verify: 'x' })
    assert.match(completionFindings(ledger, '1')[0]?.message ?? '', /subtareas abiertas/)
  })
  test('without a declared check, edits need some passing verification', () => {
    let ledger = recordTaskUpdated(recordTaskCreated(emptyLedger(0), '3', 't'), '3', 'in_progress', undefined, 10)
    ledger = creditTasks(ledger, { path: 'a.ts' }, undefined)
    assert.equal(completionFindings(ledger, '3').length, 1)
    ledger = creditTasks(ledger, undefined, { command: 'npx tsc', at: 20 })
    assert.deepEqual(completionFindings(ledger, '3'), [])
  })
  test('gate-check matches by its ledger path whatever path the script is called by', () => {
    const declared = reverifyCommand('/abs/plugin/skills/unlazy', 'pagos', '1.1.1')
    assert.ok(sameCheck(declared, 'node skills/unlazy/scripts/gate-check.mjs --reverify .unlazy/pagos/gates/leaf-1.1.1.md'))
    assert.ok(!sameCheck(declared, 'node x/gate-check.mjs --reverify .unlazy/pagos/gates/leaf-1.1.2.md'))
  })
})

describe('unlazy PLAN.md generates the native tasks', () => {
  test('parses the dispatch table and the tree names, ignoring fenced examples', () => {
    const plan = parsePlan(PLAN)
    assert.equal(plan.title, 'pagos')
    assert.deepEqual(plan.leaves.map(leaf => [leaf.id, leaf.name, leaf.state]), [['1.1.1', 'checkout', 'READY'], ['1.1.2', 'webhooks', 'WAITING']])
    assert.deepEqual(plan.leaves[0]?.owns, ['src/checkout/**', 'tests/checkout/**'])
    assert.deepEqual(plan.leaves[1]?.needs, ['1.1.1'])
  })
  test('one root plus one sub-task per leaf, each with its gate-check as verify; rewriting adds only new leaves', () => {
    const plan = parsePlan(PLAN)
    assert.equal(rootSpec('pagos', plan).metadata.size, 'large')
    const specs = leafSpecs('pagos', plan, '/p/skills/unlazy', '7', [])
    assert.equal(specs.length, 2)
    assert.equal(specs[0]?.metadata.parent, '7')
    assert.equal(specs[0]?.metadata.verify, 'node /p/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify .unlazy/pagos/gates/leaf-1.1.1.md')
    let ledger = recordTaskCreated(emptyLedger(0), '7', 'root', rootSpec('pagos', plan).metadata)
    for (const [index, spec] of specs.entries()) ledger = recordTaskCreated(ledger, String(8 + index), spec.subject, spec.metadata)
    assert.equal(leafSpecs('pagos', plan, '/p/skills/unlazy', '7', ledger.tasks).length, 0)
    assert.deepEqual(splitFindings(ledger), [])
  })
  test('plan paths', () => {
    assert.equal(scopeOfPlanPath('/repo/.unlazy/pagos/PLAN.md'), 'pagos')
    assert.equal(scopeOfPlanPath('C:\\repo\\.unlazy\\pagos\\PLAN.md'), 'pagos')
    assert.equal(scopeOfPlanPath('/repo/PLAN.md'), undefined)
  })
})

describe('comments are judged per language (false positive seen live)', () => {
  const write = (path: string, after: string) => ({ path, before: null, after, added: addedLines(null, after) })
  test('a markdown heading inside a TS template literal is not a comment', () => {
    assert.deepEqual(newComments(write('/r/a.spec.ts', 'const PLAN = `\n# Plan: x\n## Tree\n`')), [])
  })
  test('# is a comment in Python and shell, // in TS', () => {
    assert.equal(newComments(write('/r/a.py', '# incrementa el contador\nx += 1')).length, 1)
    assert.equal(newComments(write('/r/a.sh', '# borra el build\nrm -rf dist')).length, 1)
    assert.equal(newComments(write('/r/a.ts', '// incrementa el contador\nx++')).length, 1)
  })
})

describe('text views (for surfaces that place no pane)', () => {
  const entry = { id: '1', at: 0, tool: 'mcp__a__PowerShell', target: 'x --% y; z', effect: 'bloqueado' as const, rules: ['windows.stop-parsing'], message: 'msg', project: 'repo' }
  test('activity and history read as plain text', () => {
    assert.match(activityText([entry], false), /1 llamadas · 1 bloqueadas/)
    assert.match(activityText([entry], false), /BLOQUEADO\s+PowerShell · a/)
    assert.match(historyText([entry]), /1\s+windows\.stop-parsing/)
    assert.match(activityText([], true), /Ningún gate/)
  })
})
