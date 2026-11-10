import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeSessionRunner } from '../src/skill-evaluation/lib/model-runner.js'
import { planEvaluation, runEvaluation } from '../src/skill-evaluation/lib/core.js'

const current = { name: 'fixture-skill', description: 'For the positive case.', files: { 'SKILL.md': 'Fixture instruction' } }
const tasks = [
  { id: 'positive', kind: 'positive', prompt: 'Positive', files: { 'file': 'before' }, expectedFiles: { 'file': 'after' } },
  { id: 'near-miss', kind: 'near-miss', prompt: 'Near miss', files: {}, finalIncludes: ['hello'] },
]
test('native lifecycle adapter creates fresh restricted conversations, guards tools and disposes every case', async () => {
  const selected = 'fixture-native-model', plan = planEvaluation({ current, tasks, modelId: selected })
  let opened = 0, disposed = 0, verified = 0
  const runner = createNativeSessionRunner({ modelId: selected, verifyScope: () => { verified++ }, openSession: async request => {
    opened++
    assert.equal(request.modelId, selected)
    assert.ok(Object.values(request.inherit).every(value => value === false))
    assert.deepEqual(Object.keys(request.tools).sort(), ['read', 'readSkill', 'write'])
    assert.equal(request.env, undefined); assert.equal(request.cwd, undefined); assert.equal(request.history, undefined)
    return { run: async () => {
      if (request.prompt === 'Positive') {
        if (request.skillCatalog.length) request.tools.readSkill()
        request.tools.write('file', 'after')
      }
      return { finalText: 'hello', reasoning: 'must disappear', credentials: 'must disappear' }
    }, cancel: async () => {}, dispose: async () => { disposed++ } }
  } })
  const result = await runEvaluation({ plan, runner, authorization: { run: true, planId: plan.planId, modelId: selected } })
  assert.equal(result.pass, true)
  assert.equal(opened, 4)
  assert.equal(disposed, opened)
  assert.ok(verified > opened * 3)
  assert.ok(!JSON.stringify(result).includes('must disappear'))
})

test('revocation after opening disposes the session and never runs it', async () => {
  let allowed = true, ran = 0, disposed = 0
  const runner = createNativeSessionRunner({ modelId: 'fixture', verifyScope: () => { if (!allowed) throw new Error('SKILL_EVAL_SCOPE_CHANGED') }, openSession: async () => {
    allowed = false
    return { run: async () => { ran++ }, cancel: async () => {}, dispose: async () => { disposed++ } }
  } })
  await assert.rejects(runner.execute({ task: { prompt: 'x' }, variant: {}, tools: {}, limits: {}, signal: new AbortController().signal }), /SCOPE_CHANGED/)
  assert.equal(ran, 0); assert.equal(disposed, 1)
})

test('abort while opening prevents native run and cancels/disposes late session', async () => {
  const controller = new AbortController(); let release, cancelled = 0, disposed = 0, ran = 0
  const runner = createNativeSessionRunner({ modelId: 'fixture', verifyScope: () => {}, openSession: () => new Promise(resolve => { release = resolve }) })
  const running = runner.execute({ task: { prompt: 'x' }, variant: {}, tools: {}, limits: {}, signal: controller.signal })
  controller.abort()
  release({ run: async () => { ran++ }, cancel: async () => { cancelled++ }, dispose: async () => { disposed++ } })
  await assert.rejects(running)
  assert.equal(ran, 0); assert.equal(cancelled, 1); assert.equal(disposed, 1)
})

test('unbound factory is rejected without native or provider activity', () => {
  assert.throws(() => createNativeSessionRunner({ modelId: 'x' }), /NATIVE_FACTORY_REQUIRED/)
})
