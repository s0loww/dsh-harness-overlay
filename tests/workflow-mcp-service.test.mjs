import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'
import { createWorkflowService } from '../src/workflow-integration/lib/service.js'

const runtime = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const tools = ['mcp__syntax_project__verify', 'mcp__quality_project__check']
const proof = name => ({ isError: false, value: { content: [], structuredContent: {
  complete: true, assertions: [{ id: name === tools[0] ? 'syntax' : 'quality', passed: true }],
} } })

async function fixture(t, { approved = true, missing = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-mcp-service-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'project'), stateDir = join(temporary, 'state')
  await mkdir(join(root, '.airules'), { recursive: true }); await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/input.txt'), 'local source fixture')
  const provider = tool => ({ schemaVersion: 1, tool, revision: 'fixture-v1', operation: 'check',
    inputSchema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string' } } },
    format: 'assertions-json', effects: ['readsSource'] })
  const binding = { schemaVersion: 1, projectId: 'direct-mcp-project', sourcePaths: ['src'], configPaths: [], runners: {},
    mcpProviders: { 'syntax-native': provider(tools[0]), 'quality-native': provider(tools[1]) },
    providers: { syntax: { adapterId: 'syntax-native' }, quality: { adapterId: 'quality-native' } },
    workflows: { check: { schemaVersion: 1, id: 'check', version: '0.1.0', steps: [
      { id: 'syntax', adapter: 'syntax', operation: 'check', inputs: { scope: 'src' } },
      { id: 'quality', adapter: 'quality', operation: 'check', dependsOn: ['syntax'], inputs: { scope: 'src' } },
    ] } } }
  await writeFile(join(root, '.airules/workflows.json'), JSON.stringify(binding))
  const calls = [], lookups = [], definitions = new Map(tools.map(name => [name, { name }]))
  const results = new Map()
  if (missing) definitions.clear()
  const session = { id: 'mcp-session', header: { id: 'mcp-session', cwd: root, agentPreset: '1c-airules' } }
  const execution = { agent: { session }, callId: 'workflow-parent', rootCallId: 'workflow-root', token: Symbol('dsh.tool.execution'), signal: new AbortController().signal }
  const ctx = { tools: {
    get(name, agent) { lookups.push({ name, agent }); return definitions.get(name) },
    async execute(input) { calls.push(input); return results.get(input.name) ?? proof(input.name) },
  }, subprocess: { spawn() { throw new Error('Local process execution is forbidden in this fixture') } },
  sandbox: { confine() { throw new Error('No process sandbox should be requested for existing native MCP') } } }
  const scope = { id: session.id, root, mode: 'workspace-write', writable: true, preset: '1c-airules' }
  const config = { readOnlyMcpTools: approved ? [...tools] : [] }
  const service = createWorkflowService({ ctx, runtime, stateDir, config })
  let sequence = 0
  return { root, service, ctx, scope, execution, calls, lookups, definitions, results, config,
    plan: () => service.plan(scope, 'check', execution),
    run: plan => service.run(scope, { planId: plan.id, planDigest: plan.planDigest, requestId: `mcp-request-${++sequence}` }, execution) }
}

test('two direct project MCP providers plan and execute without any facade or local runner', async t => {
  const f = await fixture(t)
  const status = await f.service.status(f.scope)
  assert.equal(status.configured, true)
  assert.equal(status.runnerBindings.length, 2)
  assert.ok(status.runnerBindings.every(row => row.kind === 'mcp' && row.status === 'configured'))
  assert.equal(f.calls.length, 0)
  const plan = await f.plan()
  assert.equal(f.calls.length, 0)
  const result = await f.run(plan)
  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(f.calls.map(call => call.name), tools)
  assert.equal(result.steps.length, 2)
  assert.ok(result.steps.every(step => step.status === 'passed'))
  for (const call of f.calls) {
    assert.equal(call.agent, f.execution.agent)
    assert.equal(call.parent, f.execution.token)
    assert.equal(call.rootCallId, f.execution.rootCallId)
    assert.match(call.callId, /^workflow-parent:workflow:(syntax|quality)$/u)
    assert.ok(call.signal instanceof AbortSignal)
    assert.deepEqual(call.arguments, { scope: 'src' })
  }
})

test('HTTP-style planning uses only existing tool metadata and does not require an execution token', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan(f.scope, 'check')
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/u)
  assert.equal(f.calls.length, 0)
  assert.ok(f.lookups.some(lookup => lookup.agent === undefined))
  assert.equal((await f.run(plan)).verdict, 'PASS')
})

test('a project readsSource declaration cannot bypass the machine read-only MCP allowlist', async t => {
  const f = await fixture(t, { approved: false })
  const status = await f.service.status(f.scope)
  assert.ok(status.runnerBindings.every(row => row.status === 'needs-review'))
  const plan = await f.plan()
  await assert.rejects(f.run(plan), /RUNNER_REVIEW_REQUIRED/u)
  assert.equal(f.calls.length, 0)
})

test('native MCP tool registration replacement makes the old plan stale', async t => {
  const f = await fixture(t), plan = await f.plan()
  f.definitions.set(tools[0], { name: tools[0], replacementRegistration: true })
  const result = await f.run(plan)
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(result.reason, 'STALE_PLAN')
  assert.equal(f.calls.length, 0)
})

test('missing native tool cannot pass and does not dispatch any fallback provider', async t => {
  const f = await fixture(t, { missing: true }), plan = await f.plan()
  const result = await f.run(plan)
  assert.notEqual(result.verdict, 'PASS')
  assert.equal(f.calls.length, 0)
  assert.equal(result.steps[1].status, 'blocked')
})

test('native policy denial cannot be mapped into PASS and private error text is not returned', async t => {
  const f = await fixture(t)
  f.results.set(tools[0], { isError: true, content: [{ type: 'text', text: 'PRIVATE_NATIVE_DENIAL_TOKEN' }], value: proof(tools[0]).value })
  const result = await f.run(await f.plan())
  assert.notEqual(result.verdict, 'PASS')
  assert.equal(f.calls.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NATIVE_DENIAL_TOKEN/)
})

test('malformed MCP proof fails only after preserving successful prior step evidence', async t => {
  const f = await fixture(t)
  f.results.set(tools[1], { isError: false, value: { content: [{ type: 'text', text: 'PRIVATE_MALFORMED_JSON' }] } })
  const result = await f.run(await f.plan())
  assert.notEqual(result.verdict, 'PASS')
  assert.equal(result.steps[0].status, 'passed')
  assert.equal(result.steps[1].status, 'indeterminate')
  assert.equal(f.calls.length, 2)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MALFORMED_JSON/)
})

test('machine MCP approval changes cannot retroactively authorize or preserve a saved plan', async t => {
  const denied = await fixture(t, { approved: false }), old = await denied.plan()
  denied.config.readOnlyMcpTools = [...tools]
  const stale = await denied.run(old)
  assert.equal(stale.verdict, 'BLOCKED')
  assert.equal(stale.reason, 'STALE_PLAN')
  assert.equal(denied.calls.length, 0)
  assert.equal((await denied.run(await denied.plan())).verdict, 'PASS')
  const approved = await fixture(t), plan = await approved.plan()
  approved.config.readOnlyMcpTools = []
  await assert.rejects(approved.run(plan), /RUNNER_REVIEW_REQUIRED/u)
  assert.equal(approved.calls.length, 0)
})
