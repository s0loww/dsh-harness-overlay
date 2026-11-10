import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const sdkRoot = resolve('var/host-upgrade/rc022/asar/dsh/node_modules')
const native = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib/index.js')))

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'skill-eval-native-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await cp('src/skill-evaluation', join(base, 'package'), { recursive: true })
  await symlink(sdkRoot, join(base, 'package', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const load = file => import(pathToFileURL(join(base, 'package', 'lib', file)))
  const [{ Context }, { LlmRuntime, LlmAdapter, createUserMessage }, { Session }] = await Promise.all([native('cordis'), native('dsh-llm'), native('dsh-session')])
  const ctx = new Context()
  const service = ctx.plugin({ apply(scope) { new LlmRuntime(scope) } }); await service.await()
  t.after(() => ctx.fiber.dispose())
  return { ctx, LlmAdapter, createUserMessage, Session, load }
}

test('actual SDK022 isolated AgentLoop executes skill/fixture tools through synthetic provider and has no ambient services', { timeout: 15_000 }, async t => {
  const f = await setup(t), observed = []
  class FixtureAdapter extends f.LlmAdapter {
    async *stream(options) {
      observed.push(options)
      assert.equal(options.provider, 'fixture-only'); assert.equal(options.model, 'synthetic')
      const text = JSON.stringify(options.messages)
      assert.ok(!text.includes('HOST_PRIVATE_PROJECT'))
      const names = options.tools.map(tool => tool.name).sort()
      assert.deepEqual(names, ['eval_fixture_read', 'eval_fixture_write', 'eval_skill_read'])
      const positive = text.includes('Fix comment spacing')
      const hasResult = options.messages.some(message => message.role === 'tool')
      if (positive && !hasResult) {
        const calls = []
        if (text.includes('fixture-comment-spacing')) calls.push(['eval_skill_read', { path: 'SKILL.md' }])
        calls.push(['eval_fixture_read', { path: 'code.bsl' }], ['eval_fixture_write', { path: 'code.bsl', text: '\uFEFF// + fixture\n' }])
        for (const [index, [name, args]] of calls.entries()) yield { type: 'tool-call-delta', index, id: `call-${index}`, name, argumentsDelta: JSON.stringify(args) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: positive ? 'done' : 'hello' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const registration = f.ctx.plugin({ inject: ['llm'], apply(scope) { scope.llm.registerAdapter(['fixture-only'], new FixtureAdapter()) } }); await registration.await()
  const [{ createNativeSessionFactory, modelRouteId }, { createNativeSessionRunner }, { planEvaluation, runEvaluation }, { builtinFixtureSpec }] = await Promise.all([f.load('native-factory.js'), f.load('model-runner.js'), f.load('core.js'), f.load('agent.js')])
  const route = { provider: 'fixture-only', model: 'synthetic' }, cases = []
  const openSession = createNativeSessionFactory({ sourceLlm: f.ctx.llm, route, verifyScope: () => {}, onCase: info => {
    cases.push(info)
    for (const service of ['fs', 'subprocess', 'sandbox', 'mcp', 'skills', 'sessionPersistence', 'credentials', 'authorization']) assert.equal(info.context.get(service), undefined, service)
    assert.deepEqual(info.agent.model.current(), route)
  } })
  const plan = planEvaluation({ ...builtinFixtureSpec(), modelId: modelRouteId(route) })
  const errors = []; const wrappedOpen = async request => { try { return await openSession(request) } catch (e) { errors.push(e.stack); throw e } }; const result = await runEvaluation({ plan, runner: createNativeSessionRunner({ modelId: plan.modelId, openSession: wrappedOpen, verifyScope: () => {} }), authorization: { run: true, planId: plan.planId, modelId: plan.modelId } })
  assert.equal(result.pass, true, errors.join("\n") + JSON.stringify(result.rows.map(row => ({ task: row.taskId, error: row.error, assertions: row.assertions, trigger: row.trigger }))))
  assert.equal(cases.length, 6)
  assert.equal(new Set(cases.map(info => info.agent.id)).size, 6)
  assert.equal(observed.length, 9)
  assert.equal(result.modelRequests, 9)
  for (const info of cases) assert.equal(info.context.get('agents'), undefined)
})

async function controllerFixture(t, approval = async () => 'allowed-once') {
  const f = await setup(t), { createEvaluationController } = await f.load('agent.js')
  const id = 'skill-eval-parent', events = []
  const session = f.Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false, cwd: resolve('var/never-written-eval-parent') })
  const append = (type, data, intent) => { const event = session.append(type, data, intent); events.push(event); return event }
  let route = { provider: 'fixture-only', model: 'synthetic' }, approvalCount = 0, factoryCalls = 0
  const agent = { id, session, ctx: {}, model: { current: () => route, select: value => { route = value } } }
  const ctx = {
    agents: { get: value => value === id ? agent : undefined }, agentPresets: { composedPreset: () => '1c-airules' },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', sessionId: id, workspaceRoot: session.header.cwd }) }, llm: f.ctx.llm,
    sessionQuery: { observeSession: async () => ({ events: events.slice(), inheritedEventCount: 0, [Symbol.dispose]() {} }) },
    approval: { request: async input => { approvalCount++; return approval(input, { append, agent, session }) } },
  }
  const user = (text, source = { kind: 'user' }) => append('user/message', f.createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  const nativeFactory = () => { factoryCalls++; return async request => ({ run: async () => {
    if (request.prompt.includes('Fix comment')) { if (request.skillCatalog.length) request.tools.readSkill(); request.tools.write('code.bsl', '\uFEFF// + fixture\n') }
    return { finalText: request.prompt.includes('Fix comment') ? 'done' : 'hello', modelRequests: 1 }
  }, cancel: async () => {}, dispose: async () => {}, metrics: () => ({ modelRequests: 1 }) }) }
  const controller = createEvaluationController(ctx, { nativeFactory })
  const exec = { agent, callId: 'synthetic-model-run', signal: new AbortController().signal }
  return { controller, ctx, exec, user, append, get approvalCount() { return approvalCount }, get factoryCalls() { return factoryCalls } }
}

test('model entry requires original user checkpoint, native approval and one-shot exact plan/model', async t => {
  const f = await controllerFixture(t)
  const plan = await f.controller.act({ action: 'plan' }, f.exec)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
  const review = await f.controller.act({ action: 'review', planId: plan.planId }, f.exec)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
  f.user(review.approvalRequest, { kind: 'runtime-context' })
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
  f.user(review.approvalRequest, { kind: 'user', form: 'recall' })
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
  assert.equal(f.approvalCount, 0); assert.equal(f.factoryCalls, 0)
  f.user(review.approvalRequest)
  const result = await f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec)
  assert.equal(result.result.pass, true)
  assert.equal(result.result.modelRequests, 6)
  assert.equal(f.approvalCount, 1); assert.equal(f.factoryCalls, 1)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
})

test('denial arriving during native approval invalidates prior genuine user nonce before any provider factory', async t => {
  const f = await controllerFixture(t, async (_input, { append }) => { append('user/message', (await native('dsh-llm')).createUserMessage({ content: [{ type: 'text', text: 'Не запускать' }], source: { kind: 'user' } }), { surfaceOp: 'append' }); return 'allowed-once' })
  const plan = await f.controller.act({ action: 'plan' }, f.exec), review = await f.controller.act({ action: 'review', planId: plan.planId }, f.exec)
  f.user(review.approvalRequest)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_CHANGED/)
  assert.equal(f.factoryCalls, 0)
})

test('pinned history snapshot with a newly appended event is rejected immediately', async t => {
  const f = await controllerFixture(t)
  const plan = await f.controller.act({ action: 'plan' }, f.exec)
  const observe = f.ctx.sessionQuery.observeSession
  f.ctx.sessionQuery.observeSession = async () => { const snapshot = await observe(); f.user('New steering'); return snapshot }
  await assert.rejects(f.controller.act({ action: 'review', planId: plan.planId }, f.exec), /USER_CHECKPOINT_CHANGED/)
  assert.equal(f.factoryCalls, 0)
})

test('native approval rejection consumes user checkpoint and prevents model calls', async t => {
  const f = await controllerFixture(t, async () => 'rejected')
  const plan = await f.controller.act({ action: 'plan' }, f.exec), review = await f.controller.act({ action: 'review', planId: plan.planId }, f.exec)
  f.user(review.approvalRequest)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /APPROVAL_REQUIRED/)
  await assert.rejects(f.controller.act({ action: 'run-model', planId: plan.planId }, f.exec), /USER_CHECKPOINT_REQUIRED/)
  assert.equal(f.approvalCount, 1); assert.equal(f.factoryCalls, 0)
})
