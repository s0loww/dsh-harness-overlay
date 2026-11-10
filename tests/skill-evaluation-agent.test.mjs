import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadAgent(t, nativePath) {
  const base = mkdtempSync(join(tmpdir(), 'skill-eval-agent-')), pkg = join(base, 'package')
  t.after(() => rmSync(base, { recursive: true, force: true }))
  cpSync(resolve('src/skill-evaluation'), pkg, { recursive: true })
  mkdirSync(join(pkg, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(join(nativePath, '@deepseek-ai/dsh-tools'), join(pkg, 'node_modules', '@deepseek-ai/dsh-tools'), process.platform === 'win32' ? 'junction' : 'dir')
  return import(pathToFileURL(join(pkg, 'lib/agent.js')))
}
function nativeContext() {
  const agents = new Map(), ctx = {
    agents: { get: id => agents.get(id) },
    agentPresets: { composedPreset: agentCtx => agentCtx.preset },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: session.mode ?? 'read-only', sessionId: session.id, workspaceRoot: session.header.cwd }) },
  }
  const makeAgent = id => { const agent = { ctx: { preset: '1c-airules' }, session: { id, header: { id, cwd: resolve('var/fixture-eval-never-written') } } }; agents.set(id, agent); return agent }
  return { ctx, agents, makeAgent }
}
for (const [label, nativePath] of [
  ['rc5', resolve('var/asar-extract-rc5/dsh/node_modules')],
  ['022', resolve('var/host-upgrade/rc022/asar/dsh/node_modules')],
]) {
  test(`native ${label}: scoped tool plans, runs fixture matrix and reports without provider/FS/env access`, async t => {
    const mod = await loadAgent(t, nativePath), host = nativeContext(), agent = host.makeAgent('lead'), foreign = host.makeAgent('foreign')
    const controller = mod.createEvaluationController(host.ctx)
    const before = await controller.act({ action: 'status' }, { agent })
    assert.equal(before.modelExecution, 'unavailable')
    const planned = await controller.act({ action: 'plan' }, { agent })
    assert.equal(planned.sessions, 6)
    assert.equal(planned.execution, 'plan-only')
    await assert.rejects(controller.act({ action: 'fixture', planId: planned.planId }, { agent: foreign }), /PLAN_CHANGED/)
    await assert.rejects(controller.act({ action: 'fixture', planId: 'stale' }, { agent }), /PLAN_CHANGED/)
    const ran = await controller.act({ action: 'fixture', planId: planned.planId }, { agent })
    assert.equal(ran.result.pass, true)
    assert.equal(ran.modelRequests, 0)
    assert.equal(ran.result.rows[0].assertions[0].pass, true)
    const report = await controller.act({ action: 'report', planId: planned.planId }, { agent })
    assert.match(report.report, /near-miss/)
    assert.equal((await controller.act({ action: 'status' }, { agent })).resultAvailable, true)
    await assert.rejects(controller.act({ action: 'plan', specJson: '{bad' }, { agent }), /SPEC_INVALID/)
    await assert.rejects(controller.act({ action: 'status' }, {}), /NATIVE_SCOPE_REQUIRED/)
    await assert.rejects(controller.act({ action: 'run', planId: planned.planId }, { agent }), /ACTION_INVALID/)
    const registered = [], sections = []
    mod.apply({ ...host.ctx, tools: { register: value => registered.push(value) }, systemPrompt: { section: value => sections.push(value) } })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'airules_skill_eval')
    assert.equal(sections.length, 1)
    assert.deepEqual(mod.inject, ['tools', 'systemPrompt', 'agents', 'agentPresets', 'sandboxPolicy', 'llm', 'sessionQuery', 'approval'])
  })
  test(`native ${label}: custom plans support safe declarative operations and reject executable fixture instructions`, async t => {
    const mod = await loadAgent(t, nativePath), host = nativeContext(), agent = host.makeAgent('lead'), controller = mod.createEvaluationController(host.ctx)
    const spec = mod.builtinFixtureSpec()
    spec.tasks[0].fixtureSteps = [{ op: 'shell', path: 'pwsh' }]
    await assert.rejects(controller.act({ action: 'plan', specJson: JSON.stringify(spec) }, { agent }), /FIXTURE_STEPS_INVALID/)
    spec.tasks[0].fixtureSteps = [{ op: 'write', path: '../.env', text: 'bad' }]
    await assert.rejects(controller.act({ action: 'plan', specJson: JSON.stringify(spec) }, { agent }), /PATH_REJECTED/)
    spec.tasks[0].fixtureSteps = []
    const planned = await controller.act({ action: 'plan', specJson: JSON.stringify(spec) }, { agent })
    await assert.rejects(controller.act({ action: 'fixture', planId: planned.planId }, { agent }), /FIXTURE_STEPS_REQUIRED/)
  })
  test(`native ${label}: registry/preset/policy/cancellation guards and post-await revocation reject stale scope`, async t => {
    const mod = await loadAgent(t, nativePath), host = nativeContext(), agent = host.makeAgent('lead'), controller = mod.createEvaluationController(host.ctx)
    const planned = await controller.act({ action: 'plan' }, { agent })
    agent.ctx.preset = 'default'
    await assert.rejects(controller.act({ action: 'status' }, { agent }), /NATIVE_SCOPE_REQUIRED/)
    agent.ctx.preset = '1c-airules'; host.agents.delete('lead')
    await assert.rejects(controller.act({ action: 'status' }, { agent }), /NATIVE_SCOPE_REQUIRED/)
    host.agents.set('lead', agent)
    const resolvePolicy = host.ctx.sandboxPolicy.resolve
    host.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', sessionId: 'other', workspaceRoot: agent.session.header.cwd })
    await assert.rejects(controller.act({ action: 'status' }, { agent }), /NATIVE_POLICY_REQUIRED/)
    host.ctx.sandboxPolicy.resolve = resolvePolicy
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(controller.act({ action: 'fixture', planId: planned.planId }, { agent, signal: cancelled.signal }), /CANCELLED/)
    const revoked = mod.createEvaluationController(host.ctx, { fixtureRunnerFactory: () => ({ kind: 'fixture', execute: async () => { agent.session.mode = 'workspace-write'; return { finalText: 'x' } } }) })
    const revokePlan = await revoked.act({ action: 'plan' }, { agent })
    await assert.rejects(revoked.act({ action: 'fixture', planId: revokePlan.planId }, { agent }), /SCOPE_CHANGED/)
    assert.equal((await revoked.act({ action: 'status' }, { agent })).resultAvailable, false)
  })
}
