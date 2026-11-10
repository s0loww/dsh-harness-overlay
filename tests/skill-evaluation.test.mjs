import test from 'node:test'
import assert from 'node:assert/strict'
import { planEvaluation, runEvaluation, createFixtureIO, fixturePath, LIMITS, renderEvaluationReport } from '../src/skill-evaluation/lib/core.js'
import { createFixtureRunner } from '../src/skill-evaluation/lib/fixture-runner.js'

const current = { name: 'tidy-code', description: 'When asked to tidy comments in a source file.', files: { 'SKILL.md': '# Tidy\nUse only local fixtures.', 'references/guide.md': 'Comment spacing.' } }
const previous = { ...current, files: { 'SKILL.md': '# Previous instruction' } }
const tasks = [
  { id: 'comments', kind: 'positive', prompt: 'Tidy comment spacing in code.bsl.', files: { 'code.bsl': '\uFEFF//+hello\n' }, expectedFiles: { 'code.bsl': '\uFEFF// +hello\n' }, finalIncludes: ['done'] },
  { id: 'near-miss', kind: 'near-miss', prompt: 'Say hello; no source editing needed.', files: {}, finalIncludes: ['hello'] },
]
const plan = options => planEvaluation({ current, previous, tasks, ...options })
const execute = async ({ task, variant, tools }) => {
  if (task.kind === 'near-miss') return { finalText: 'hello' }
  if (variant.name) { tools.readSkill(); tools.readSkill('references/guide.md') }
  tools.write('code.bsl', tools.read('code.bsl').replace('//+', '// +'))
  return { finalText: 'done' }
}

test('planning includes all three variants, exact skill revisions and an unconditional no-skill baseline', () => {
  const result = plan()
  assert.equal(result.sessions, 6)
  assert.deepEqual(result.variants.map(row => row.label), ['current', 'previous', 'no-skill'])
  assert.equal(result.variants[2].skill, null)
  assert.equal(result.planId, plan().planId)
  assert.notEqual(result.variants[0].skill.revision, result.variants[1].skill.revision)
  assert.ok(Object.isFrozen(result.tasks[0].files))
  assert.equal(plan({ previous: null }).sessions, 4)
  assert.notEqual(plan({ modelId: 'deepseek-high' }).planId, result.planId)
})

test('rejects stale revisions, missing skill descriptor and missing near-miss', () => {
  assert.throws(() => plan({ current: { ...current, revision: 'stale' } }), /REVISION_MISMATCH/)
  assert.throws(() => plan({ current: { ...current, description: '' } }), /SKILL_INVALID/)
  assert.throws(() => plan({ tasks: [tasks[0]] }), /TASK_COUNT/)
  assert.throws(() => plan({ tasks: [tasks[0], { ...tasks[0], id: 'second' }] }), /NEAR_MISS_REQUIRED/)
  assert.throws(() => plan({ tasks: [tasks[0], { ...tasks[1], finalIncludes: [] }] }), /ASSERTIONS_REQUIRED/)
  assert.throws(() => plan({ previous: { ...previous, name: 'different' } }), /SKILL_MISMATCH/)
})

test('fixture paths are capability-relative; all Windows and POSIX escape forms rejected', () => {
  for (const value of ['../.env', '/etc/passwd', 'C:/secret', 'dir/../key', 'a\\b', 'file:stream', '', '.', 'a//b', 'a\0b']) assert.throws(() => fixturePath(value), /PATH_REJECTED/)
  assert.equal(fixturePath('src/code.bsl'), 'src/code.bsl')
})

test('each case starts from pristine fixture bytes and traces never contain file bodies', async () => {
  const seen = []
  const result = await runEvaluation({ plan: plan({ previous: null }), runner: createFixtureRunner(args => {
    assert.deepEqual(Object.keys(args).sort(), ['limits', 'signal', 'task', 'tools', 'variant'])
    assert.equal(args.cwd, undefined); assert.equal(args.env, undefined); assert.equal(args.task.expectedFiles, undefined)
    if (args.task.id === 'comments') seen.push(args.tools.read('code.bsl'))
    return execute(args)
  }) })
  assert.equal(result.pass, true)
  assert.deepEqual(seen, ['\uFEFF//+hello\n', '\uFEFF//+hello\n'])
  assert.equal(tasks[0].files['code.bsl'], '\uFEFF//+hello\n')
  assert.equal(result.rows.length, 4)
  assert.equal(result.rows[0].skillRead, true)
  assert.equal(result.rows[1].skillRead, false)
  assert.equal(result.rows[2].skillRead, false)
  assert.ok(!JSON.stringify(result.rows[0].trace).includes('hello'))
  assert.ok(!JSON.stringify(result).includes('reasoning'))
})

test('unlike donor, previous and no-skill both run, and objective file assertions detect regression', async () => {
  const result = await runEvaluation({ plan: plan(), runner: createFixtureRunner(args => {
    if (args.variant.label === 'previous' && args.task.kind === 'positive') return { finalText: 'done' }
    if (args.task.kind === 'positive' && args.variant.name) args.tools.readSkill()
    if (args.task.kind === 'positive') { args.tools.write('code.bsl', '\uFEFF// +hello\n'); return { finalText: 'done' } }
    return { finalText: 'hello' }
  }) })
  assert.equal(result.completedSessions, 6)
  assert.equal(result.pass, false)
  assert.equal(result.rows[0].pass, true)
  assert.equal(result.rows[1].assertions[0].pass, false)
  assert.equal(result.rows[2].pass, true)
  assert.equal(result.rows[1].trigger.pass, false)
})

test('near-miss unnecessary skill loading is reported independently of output correctness', async () => {
  const result = await runEvaluation({ plan: plan({ previous: null }), runner: createFixtureRunner(args => {
    if (args.variant.name) args.tools.readSkill()
    if (args.task.kind === 'near-miss') return { finalText: 'hello' }
    args.tools.write('code.bsl', '\uFEFF// +hello\n'); return { finalText: 'done' }
  }) })
  assert.equal(result.rows[2].pass, true)
  assert.equal(result.rows[2].trigger.pass, false)
  assert.equal(result.pass, false)
})

test('caught tool violations remain failures, so runner cannot hide escape attempts', async () => {
  const result = await runEvaluation({ plan: plan({ previous: null }), runner: createFixtureRunner(async args => {
    try { args.tools.read('../.env') } catch {}
    if (args.task.kind === 'positive') { if (args.variant.name) args.tools.readSkill(); args.tools.write('code.bsl', '\uFEFF// +hello\n') }
    return { finalText: args.task.kind === 'positive' ? 'done' : 'hello' }
  }) })
  assert.equal(result.pass, false)
  assert.ok(result.rows.every(row => row.error === 'SKILL_EVAL_PATH_REJECTED'))
  assert.ok(result.rows.every(row => row.trace[0].ok === false && row.trace[0].path === ''))
})

test('read, write, tool and file budgets are enforced and closed sessions cannot mutate', () => {
  const make = overrides => createFixtureIO(tasks[0], { skill: current }, { ...LIMITS, ...overrides })
  const read = make({ readBytes: 1 }); assert.throws(() => read.tools.read('code.bsl'), /READ_BUDGET/)
  const write = make({ writeBytes: 1 }); assert.throws(() => write.tools.write('a', 'abc'), /WRITE_BUDGET/)
  const calls = make({ calls: 1 }); calls.tools.read('code.bsl'); assert.throws(() => calls.tools.read('code.bsl'), /TOOL_BUDGET/)
  const count = make({ files: 1 }); assert.throws(() => count.tools.write('new', 'a'), /FILE_BUDGET/)
  const closed = make({}); closed.close(); assert.throws(() => closed.tools.write('code.bsl', 'x'), /SESSION_CLOSED/)
  assert.equal(closed.inspect().files['code.bsl'], tasks[0].files['code.bsl'])
})

test('model execution is denied until exact plan and selected model are explicitly authorized', async () => {
  let called = 0
  const runner = { kind: 'model', modelId: 'sol-medium', execute: () => { called++; return {} }, cancel: async () => {} }
  const modelPlan = plan({ modelId: runner.modelId, previous: null })
  for (const authorization of [null, { run: true, planId: 'stale', modelId: runner.modelId }, { run: true, planId: modelPlan.planId, modelId: 'other' }, { run: false, planId: modelPlan.planId, modelId: runner.modelId }]) await assert.rejects(runEvaluation({ plan: modelPlan, runner, authorization }), /EXPLICIT_MODEL_RUN_REQUIRED/)
  assert.equal(called, 0)
  await assert.rejects(runEvaluation({ plan: modelPlan, runner: { ...runner, cancel: undefined }, authorization: { run: true, planId: modelPlan.planId, modelId: runner.modelId } }), /EXPLICIT_MODEL_RUN_REQUIRED/)
})

test('authorized model adapter receives only capability tools and emits no reasoning or arbitrary runner metadata', async () => {
  const modelPlan = plan({ modelId: 'fixture-model', previous: null })
  const result = await runEvaluation({ plan: modelPlan, runner: { kind: 'model', modelId: modelPlan.modelId, cancel: async () => {}, execute: async args => ({ ...await execute(args), reasoning: 'private', environment: 'secret', unrelated: true }) }, authorization: { run: true, planId: modelPlan.planId, modelId: modelPlan.modelId } })
  assert.equal(result.pass, true)
  assert.equal(result.execution, 'model')
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('tampering any variant or planned session count invalidates authorization before execution', async () => {
  for (const change of [p => { p.sessions++ }, p => { p.variants.push({ label: 'rogue', skill: null }) }, p => { p.tasks[0].expectedFiles['code.bsl'] = 'different' }, p => { p.variants[2].skill = p.variants[0].skill }]) {
    const modified = JSON.parse(JSON.stringify(plan())); change(modified)
    await assert.rejects(runEvaluation({ plan: modified, runner: createFixtureRunner(() => { throw new Error('MUST_NOT_EXECUTE') }) }), /PLAN_CHANGED/)
  }
})

test('timeout aborts native adapter, closes its tools and stops the remaining matrix', async () => {
  const modelPlan = plan({ modelId: 'never-call-a-provider', previous: null }); let captured, cancelled = 0
  const result = await runEvaluation({ plan: modelPlan, timeoutMs: 10, runner: { kind: 'model', modelId: modelPlan.modelId, execute: args => { captured = args; return new Promise(() => {}) }, cancel: async () => { cancelled++ } }, authorization: { run: true, planId: modelPlan.planId, modelId: modelPlan.modelId } })
  assert.equal(result.interrupted, 'SKILL_EVAL_TIMEOUT')
  assert.equal(result.completedSessions, 1)
  assert.equal(cancelled, 1)
  assert.equal(captured.signal.aborted, true)
  assert.throws(() => captured.tools.write('late', 'bad'), /SESSION_CLOSED/)
})

test('pre-cancelled run performs no executor call', async () => {
  const controller = new AbortController(); controller.abort()
  const result = await runEvaluation({ plan: plan(), signal: controller.signal, runner: createFixtureRunner(() => { throw new Error('MUST_NOT_EXECUTE') }) })
  assert.equal(result.completedSessions, 0)
  assert.equal(result.interrupted, 'SKILL_EVAL_CANCELLED')
})

test('oversized final text is bounded and report escapes table/control content', async () => {
  const result = await runEvaluation({ plan: plan({ previous: null }), runner: createFixtureRunner(() => ({ finalText: 'a'.repeat(20_000) })) })
  assert.ok(result.rows.every(row => Buffer.byteLength(row.finalText) <= LIMITS.finalBytes))
  const report = renderEvaluationReport({ ...result, name: '<script>|\nhello' })
  assert.ok(!report.includes('<script>'))
  assert.ok(report.includes('near-miss'))
  assert.ok(report.includes('не доказывает'))
})

test('provider exception text and arbitrary metadata are not leaked to the report', async () => {
  const result = await runEvaluation({ plan: plan({ previous: null }), runner: createFixtureRunner(() => { throw new Error('Authorization: bearer private-provider-secret') }) })
  assert.ok(result.rows.every(row => row.error === 'SKILL_EVAL_RUNNER_ERROR'))
  assert.ok(!JSON.stringify(result).includes('private-provider-secret'))
})

test('model metrics without trustworthy evidence are unknown, never zero', async () => {
  const modelPlan = plan({ modelId: 'fixture-model', previous: null })
  const result = await runEvaluation({ plan: modelPlan, runner: { kind: 'model', modelId: modelPlan.modelId, cancel: async () => {}, execute: async () => { throw new Error('provider failed after a paid request') } }, authorization: { run: true, planId: modelPlan.planId, modelId: modelPlan.modelId } })
  assert.equal(result.modelRequests, null)
  assert.ok(result.rows.every(row => row.modelRequests === null))
})
