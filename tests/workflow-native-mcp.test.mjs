import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeMcpProvider } from '../src/workflow-integration/lib/native-mcp.js'
import { createMcpAdapter } from '../../project_rules/core/tools/workflow/lib/mcp-adapter.mjs'
import { canonical, digest, validateSchema } from '../../project_rules/core/tools/workflow/lib/contracts.mjs'
import { validateEvidence } from '../../project_rules/core/tools/workflow/lib/validators.mjs'

const core = { createMcpAdapter, canonical, digest, validateSchema }
const assertions = { complete: true, assertions: [{ id: 'source-clean', passed: true }] }
const success = data => ({ isError: false, value: { content: [], structuredContent: data } })
const context = () => ({ runId: 'run-current', sourceDigest: 'source-current', stepId: 'check', signal: new AbortController().signal })
const binding = (tool = 'mcp__direct_project__verify') => ({ schemaVersion: 1, tool, revision: 'fixture-config-v1', operation: 'check',
  format: 'assertions-json', inputSchema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string' } } }, effects: ['readsSource'] })
function fixture(options = {}) {
  const calls = [], lookups = [], started = []
  let definition = { name: options.tool ?? 'mcp__direct_project__verify' }
  let nativeResult = options.result ?? success(assertions)
  const execution = options.planning ? undefined : { agent: { session: { id: 'native-session' } }, callId: 'parent-call', rootCallId: 'root-call', token: Symbol('dsh.tool.execution'), signal: new AbortController().signal }
  const ctx = { tools: { get(name, agent) { lookups.push({ name, agent }); return options.missing ? undefined : definition },
    async execute(input) { calls.push(input); return typeof nativeResult === 'function' ? nativeResult(input) : nativeResult } } }
  const settings = { ...binding(options.tool), ...options.binding }
  const adapter = createNativeMcpProvider({ ctx, execution, id: 'mcp-fixture', binding: settings, core, onRunStart: runId => started.push(runId),
    allowedTools: options.unapproved ? [] : [settings.tool] })
  return { adapter, calls, lookups, started, execution, ctx, settings,
    replaceDefinition() { definition = { name: settings.tool } }, setResult(value) { nativeResult = value } }
}

test('existing direct MCP and facade tools use the same native execution pipeline and parent token', async () => {
  for (const tool of ['mcp__direct_project__verify', 'mcp__1c-facade__check']) {
    const f = fixture({ tool }), run = context()
    const result = await f.adapter.execute('check', { scope: 'src' }, run)
    assert.equal(f.calls.length, 1)
    const child = f.calls[0]
    assert.equal(child.name, tool)
    assert.equal(child.agent, f.execution.agent)
    assert.equal(child.parent, f.execution.token)
    assert.equal(child.callId, 'parent-call:workflow:check')
    assert.equal(child.rootCallId, 'root-call')
    assert.deepEqual(child.arguments, { scope: 'src' })
    assert.ok(child.signal instanceof AbortSignal)
    assert.deepEqual(f.started, [run.runId])
    assert.deepEqual(result, { data: assertions, mutationState: 'not-applied' })
    assert.equal(validateEvidence('assertions', result.data).status, 'passed')
    assert.equal(f.lookups.at(-1).agent, f.execution.agent)
  }
})

test('planning and fingerprints inspect registration metadata without executing any MCP tool', async () => {
  const f = fixture({ planning: true })
  const before = await f.adapter.fingerprint()
  assert.match(before, /^[a-f0-9]{64}$/u)
  assert.equal(await f.adapter.fingerprint(), before)
  assert.equal(f.calls.length, 0)
  assert.equal(f.started.length, 0)
  assert.equal(f.lookups.at(-1).agent, undefined)
  await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  assert.equal(f.calls.length, 0)
})

test('replacing an existing native tool definition invalidates the adapter fingerprint', async () => {
  const f = fixture()
  const before = await f.adapter.fingerprint()
  f.replaceDefinition()
  assert.notEqual(await f.adapter.fingerprint(), before)
  assert.equal(f.calls.length, 0)
  assert.notEqual(await fixture({ binding: { revision: 'changed-config-revision' } }).adapter.fingerprint(), before)
})

test('missing tools and absent native execution identity fail before dispatch', async () => {
  const missing = fixture({ missing: true })
  await assert.rejects(missing.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  assert.equal(missing.calls.length, 0)
  const f = fixture()
  delete f.execution.token
  await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  assert.equal(f.calls.length, 0)
  assert.equal(f.started.length, 0)
})

test('project readsSource declaration alone never approves a remote tool for execution', async () => {
  const f = fixture({ unapproved: true })
  assert.equal(f.adapter.readOnlyApproved, false)
  await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  assert.equal(f.calls.length, 0)
  assert.equal(f.started.length, 0)
  const approved = createNativeMcpProvider({ ctx: f.ctx, execution: f.execution, id: 'mcp-fixture', binding: f.settings, core, allowedTools: [f.settings.tool] })
  assert.equal(approved.readOnlyApproved, true)
  assert.notEqual(await approved.fingerprint(), await f.adapter.fingerprint())
  const deniedByDefault = createNativeMcpProvider({ ctx: f.ctx, execution: f.execution, id: 'mcp-fixture', binding: f.settings, core })
  assert.equal(deniedByDefault.readOnlyApproved, false)
  await assert.rejects(deniedByDefault.execute('check', {}, context()), /MCP_CALL_FAILED/u)
})

test('native denied/error results cannot be converted into successful evidence or leak their text', async () => {
  for (const result of [{ isError: true, value: success(assertions).value, content: [{ type: 'text', text: 'PRIVATE_NATIVE_DENIAL' }] },
    { isError: false, value: { ...success(assertions).value, isError: true } }]) {
    const f = fixture({ result })
    await assert.rejects(f.adapter.execute('check', {}, context()), error => {
      assert.equal(error.message, 'MCP_CALL_FAILED')
      assert.doesNotMatch(error.message, /PRIVATE_NATIVE_DENIAL/)
      return true
    })
  }
})

test('only one exact JSON text block is accepted when structured evidence is absent', async () => {
  const f = fixture({ result: { isError: false, value: { content: [{ type: 'text', text: JSON.stringify(assertions) }] } } })
  assert.deepEqual((await f.adapter.execute('check', {}, context())).data, assertions)
  for (const content of [[], [{ type: 'image', data: 'untrusted' }], [{ type: 'text', text: 'PRIVATE_BAD_JSON' }],
    [{ type: 'text', text: JSON.stringify(assertions) }, { type: 'text', text: '{}' }], [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }]]) {
    f.setResult({ isError: false, value: { content } })
    await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  }
})

test('structured evidence must match the strict normalized schema and bounded JSON protocol', async () => {
  const f = fixture()
  const cyclic = {}; cyclic.self = cyclic
  for (const data of [null, 'json string is not structured evidence', { ...assertions, privateMessage: 'PRIVATE_EXTRA_FIELD' },
    { complete: true, assertions: [{ id: 'one', passed: 'true' }] }, cyclic,
    { complete: true, assertions: [{ id: 'x'.repeat(1024 * 1024 + 1), passed: true }] }]) {
    f.setResult(success(data))
    await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
  }
  f.setResult({ isError: false, content: [{ type: 'text', text: JSON.stringify(assertions) }] })
  await assert.rejects(f.adapter.execute('check', {}, context()), /MCP_CALL_FAILED/u)
})

test('test summary preserves current provenance and never synthesizes missing or stale identities', async () => {
  const run = context()
  const summary = { complete: true, runId: run.runId, sourceDigest: run.sourceDigest, tests: 2, failures: 0, errors: 0, skipped: 0 }
  const f = fixture({ binding: { format: 'test-summary-json' }, result: success(summary) })
  const result = await f.adapter.execute('check', {}, run)
  assert.deepEqual(result.data, summary)
  assert.equal(validateEvidence('test-summary', result.data, run).status, 'passed')
  for (const data of [{ ...summary, runId: 'old-run' }, { ...summary, sourceDigest: 'old-source' },
    { complete: true, tests: 1, failures: 0, errors: 0, skipped: 0 }]) {
    f.setResult(success(data))
    await assert.rejects(f.adapter.execute('check', {}, run), /MCP_CALL_FAILED/u)
  }
  f.setResult(success({ ...summary, tests: 0 }))
  const empty = await f.adapter.execute('check', {}, run)
  assert.equal(validateEvidence('test-summary', empty.data, run).status, 'failed')
})

test('native and core cancellation signals are forwarded and aborted results are rejected', async () => {
  for (const native of [false, true]) {
    const f = fixture(), run = context(), controller = new AbortController()
    if (native) f.execution.signal = controller.signal
    else run.signal = controller.signal
    f.setResult(async input => { controller.abort(); assert.equal(input.signal.aborted, true); return success(assertions) })
    await assert.rejects(f.adapter.execute('check', {}, run), /MCP_CALL_FAILED/u)
  }
  const f = fixture(), run = context()
  run.signal = AbortSignal.abort()
  await assert.rejects(f.adapter.execute('check', {}, run), /MCP_CALL_FAILED/u)
  assert.equal(f.calls.length, 0)
})

test('endpoint configuration, arbitrary tools, target effects and unsupported bindings are rejected', () => {
  for (const patch of [{ endpoint: 'https://untrusted.invalid' }, { tool: 'airules_workflow_run' }, { tool: 'check' },
    { tool: 'mcp__server' }, { effects: ['changesMetadata'] }, { effects: [] }, { effects: ['readsSource', 'externalIO'] },
    { format: 'raw-text' }, { operation: 'deploy' }, { schemaVersion: 2 }]) {
    assert.throws(() => fixture({ binding: patch }), /NATIVE_MCP_BINDING_INVALID/u)
  }
})
