import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'
import { createFixtureRecoveryProvider, createToolRecoveryProvider, recordExecution } from '../src/workflow-integration/lib/recovery-providers.js'

const core = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const helpers = { scrubbedParentEnv: () => ({ PATH: 'fixture-path' }), classifyRunnerFailure: () => undefined, matchesSignature: () => false }
const identities = ['recoveryId', 'runId', 'targetId', 'planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest']

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'recovery-provider-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'project'), stateDir = join(temporary, 'state'), artifactDir = join(temporary, 'proof')
  await mkdir(root); await mkdir(stateDir); await mkdir(artifactDir)
  const targetId = `fixture-${core.digest({ fixture: true, root: await realpath(root) })}`
  const scope = { id: 'own-session', root, writable: true }
  const session = { id: scope.id, header: { id: scope.id, cwd: root } }
  const execution = { agent: { session }, token: Symbol('parent'), callId: 'native-call', rootCallId: 'root-call', signal: new AbortController().signal }
  const controller = new AbortController()
  const context = { schemaVersion: 1, recoveryId: randomUUID(), runId: randomUUID(), targetId,
    planDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64), providerDigest: 'd'.repeat(64),
    originalTarget: { id: targetId, stages: [{ stepId: 'apply' }], mutationState: 'unknown' },
    originalResult: { projectId: 'project' }, artifactDir, signal: controller.signal, timeoutMs: 1000, deadline: Date.now() + 1000 }
  const calls = { spawned: [], confined: [], tool: [], definitions: [], terminated: 0, definition: {} }
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: options.sandboxMode ?? 'workspace-write', workspaceRoot: root, sessionId: session.id }) },
    sandbox: { async confine(argv, policy) { calls.confined.push({ argv, policy }); return { argv: ['sandbox-fixture', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      const argument = key => spec.argv[spec.argv.indexOf(key) + 1]
      const stdout = new PassThrough(), stderr = new PassThrough()
      let resolveDone, exited = false
      const done = new Promise(resolve => { resolveDone = resolve })
      const finish = (exitCode, signal = null) => { exited = true; stdout.end(); stderr.end(); resolveDone({ exitCode, signal }) }
      queueMicrotask(async () => {
        if (options.pending) return
        try {
          if (!options.noReport) {
            const directory = join(argument('-ResultRoot'), `recovery-${argument('-RecoveryId')}`)
            await mkdir(directory, { recursive: true })
            const raw = { schemaVersion: 1, recoveryId: argument('-RecoveryId'), runId: argument('-RunId'), restored: true }
            await writeFile(join(directory, 'result.json'), JSON.stringify(options.restorePatch ? options.restorePatch(raw) : raw))
          }
          finish(options.exitCode ?? 0)
        } catch { finish(99) }
      })
      return { stdout, stderr, done, terminate() { calls.terminated++; if (!exited) finish(null, 'SIGTERM') },
        waitForExit: async () => options.unconfirmed ? false : exited }
    } },
    tools: {
      get(name, agent) { calls.definitions.push({ name, agent }); return calls.definition },
      async execute(args) {
        calls.tool.push(args)
        const report = { schemaVersion: 1, ...Object.fromEntries(identities.map(key => [key, args.arguments[key]])),
          executorStopped: true, outcome: 'restored', observedAt: Date.now() }
        const value = options.reportPatch ? options.reportPatch(report) : report
        if (options.rawResponse) return options.rawResponse(value)
        return { value: { structuredContent: value } }
      },
    },
  }
  const active = new Map(), pwshPath = join(temporary, 'pwsh.exe')
  await writeFile(pwshPath, 'mock executable bytes; never executed')
  const makeTool = extra => createToolRecoveryProvider({ ctx, scope, config: { projectId: 'project', id: 'restore', tool: 'mcp__qa__restore' },
    core, execution, mode: 'enabled', active, ...extra })
  const makeFixture = extra => createFixtureRecoveryProvider({ ctx, scope, stateDir, bindingId: 'stub', targetId, core,
    nativeHelpers: helpers, pwshPath, execution, active, ...extra })
  const privateReceipt = { schemaVersion: 1, runId: context.runId, stepId: 'apply', targetId, kind: 'deploy-fixture',
    rootDigest: core.digest({ root: await realpath(root) }), stopped: true, mutationState: 'unknown', finishedAt: Date.now() }
  await recordExecution(stateDir, privateReceipt, { ...context, stepId: 'apply' }, { data: { terminationConfirmed: true }, mutationState: 'unknown' })
  await mkdir(join(stateDir, 'execution-receipts', context.runId), { recursive: true })
  const receiptPath = join(stateDir, 'execution-receipts', context.runId, 'apply.json')
  await writeFile(receiptPath, JSON.stringify(privateReceipt))
  return { root, stateDir, artifactDir, context, scope, execution, ctx, calls, active, controller, targetId,
    receiptPath, privateReceipt, makeTool, makeFixture }
}

async function verifyArtifact(context, result) {
  assert.equal(result.executorStopped, true)
  for (const key of identities) assert.equal(result[key], context[key], key)
  const bytes = await readFile(join(context.artifactDir, result.artifact.path))
  assert.equal(result.artifact.digest, sha(bytes)); assert.equal(result.artifact.bytes, bytes.length)
  const value = JSON.parse(bytes)
  assert.equal(value.runId, context.runId); assert.equal(value.targetId, context.targetId)
  return value
}

test('native recovery tool preserves parent execution identity, scope and proof artifact', async t => {
  const f = await fixture(t), provider = f.makeTool()
  f.context.providerDigest = await provider.fingerprint()
  const result = await provider.reconcile(f.context)
  await verifyArtifact(f.context, result)
  assert.equal(f.calls.tool.length, 1)
  const call = f.calls.tool[0]
  assert.equal(call.name, 'mcp__qa__restore'); assert.equal(call.agent, f.execution.agent)
  assert.equal(call.parent, f.execution.token); assert.equal(call.rootCallId, 'root-call')
  assert.equal(call.callId, `native-call:recovery:${f.context.recoveryId}`)
  assert.equal(call.arguments.projectId, 'project'); assert.ok(call.signal instanceof AbortSignal)
  f.controller.abort(); assert.equal(call.signal.aborted, true)
  assert.equal(f.calls.spawned.length, 0)
})

test('native recovery accepts the standard text MCP envelope and strips unrelated report content', async t => {
  const f = await fixture(t, { reportPatch: report => ({ ...report, privateDiagnostic: 'DO_NOT_EXPOSE' }),
    rawResponse: report => ({ value: { content: [{ type: 'text', text: JSON.stringify(report) }] } }) })
  const result = await f.makeTool().reconcile(f.context)
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/u)
  assert.doesNotMatch(await readFile(join(f.artifactDir, result.artifact.path), 'utf8'), /DO_NOT_EXPOSE/u)
})

test('native recovery rejects errors, unbound identities, stopped=false and stale stamps without proof', async t => {
  const variants = [
    { rawResponse: report => ({ isError: true, value: { structuredContent: report } }) },
    { rawResponse: report => ({ value: { isError: true, structuredContent: report } }) },
    { rawResponse: report => ({ value: report }) },
    { reportPatch: report => ({ ...report, runId: randomUUID() }) },
    { reportPatch: report => ({ ...report, targetId: 'wrong-target' }) },
    { reportPatch: report => ({ ...report, sourceDigest: 'e'.repeat(64) }) },
    { reportPatch: report => ({ ...report, executorStopped: false }) },
    { reportPatch: report => ({ ...report, outcome: 'unlocked' }) },
    { reportPatch: report => ({ ...report, observedAt: 1 }) },
    { reportPatch: report => ({ ...report, observedAt: Date.now() + 60000 }) },
  ]
  for (const options of variants) {
    const f = await fixture(t, options)
    await assert.rejects(f.makeTool().reconcile(f.context))
    assert.deepEqual(await readdir(f.artifactDir), [])
    assert.equal(f.calls.tool.length, 1)
  }
})

test('native recovery refuses disabled/unknown modes and missing active native ownership before dispatch', async t => {
  for (const mode of ['fixture-only', 'disabled', 'unknown']) {
    const f = await fixture(t)
    await assert.rejects(f.makeTool({ mode }).reconcile(f.context), /ACTUAL_DEPLOY_DISABLED/u)
    assert.equal(f.calls.tool.length, 0)
  }
  for (const change of [f => ({ execution: undefined }), f => ({ execution: { ...f.execution, token: 'not-native' } }),
    f => ({ scope: { ...f.scope, writable: false } }), f => ({ execution: { ...f.execution, agent: { session: { id: 'other' } } } })]) {
    const f = await fixture(t)
    await assert.rejects(f.makeTool(change(f)).reconcile(f.context), /RECOVERY_NATIVE_TOOL_REQUIRED/u)
    assert.equal(f.calls.tool.length, 0)
  }
})

test('native recovery checks active executor and registered project ownership before dispatch', async t => {
  const f = await fixture(t)
  f.active.set(f.context.runId, {})
  await assert.rejects(f.makeTool().reconcile(f.context), /RECOVERY_EXECUTOR_STILL_ACTIVE/u)
  f.active.clear(); f.context.originalResult.projectId = 'other-project'
  await assert.rejects(f.makeTool().reconcile(f.context), /RECOVERY_PROJECT_MISMATCH/u)
  assert.equal(f.calls.tool.length, 0)
})

test('native recovery registration is fixed-tool only and its fingerprint binds registration generation', async t => {
  const f = await fixture(t), provider = f.makeTool()
  for (const config of [{ projectId: 'project', id: 'restore', tool: 'shell' },
    { projectId: 'project', id: 'restore', tool: 'mcp__qa__restore', args: ['arbitrary'] }]) {
    assert.throws(() => f.makeTool({ config }), /RECOVERY_TOOL_CONFIG_INVALID/u)
  }
  const before = await provider.fingerprint()
  assert.equal(await provider.fingerprint(), before)
  f.calls.definition = {}
  assert.notEqual(await provider.fingerprint(), before)
  f.calls.definition = null
  await assert.rejects(provider.reconcile(f.context), /RECOVERY_NATIVE_TOOL_REQUIRED/u)
  assert.equal(f.calls.tool.length, 0)
})

test('native recovery never dispatches after either caller or recovery cancellation', async t => {
  for (const cancelCaller of [false, true]) {
    const f = await fixture(t)
    if (cancelCaller) {
      const cancellation = new AbortController(); cancellation.abort()
      f.execution.signal = cancellation.signal
    } else f.controller.abort()
    await assert.rejects(f.makeTool().reconcile(f.context))
    assert.equal(f.calls.tool.length, 0)
    assert.deepEqual(await readdir(f.artifactDir), [])
  }
})

test('native recovery validates execution IDs before transport and combines turn cancellation', async t => {
  for (const change of [{ callId: '' }, { callId: undefined }, { rootCallId: 'bad\nidentity' }, { signal: {} }]) {
    const f = await fixture(t)
    await assert.rejects(f.makeTool({ execution: { ...f.execution, ...change } }).reconcile(f.context), /RECOVERY_NATIVE_TOOL_REQUIRED/u)
    assert.equal(f.calls.tool.length, 0)
  }
  const f = await fixture(t)
  const cancellation = new AbortController(); f.execution.signal = cancellation.signal
  let observed
  f.ctx.tools.execute = async args => {
    observed = args.signal
    cancellation.abort()
    return { value: { structuredContent: { schemaVersion: 1, ...args.arguments, executorStopped: true, outcome: 'restored', observedAt: Date.now() } } }
  }
  await assert.rejects(f.makeTool().reconcile(f.context))
  assert.equal(observed.aborted, true)
  assert.deepEqual(await readdir(f.artifactDir), [])
})

test('recovery retry keeps the same recovery identity and stores a new proof artifact instead of overwriting old evidence', async t => {
  for (const fixtureProvider of [true, false]) {
    const f = await fixture(t), provider = fixtureProvider ? f.makeFixture() : f.makeTool()
    const first = await provider.reconcile(f.context)
    const before = await readFile(join(f.artifactDir, first.artifact.path))
    const second = await provider.reconcile(f.context)
    await verifyArtifact(f.context, second)
    assert.notEqual(first.artifact.path, second.artifact.path)
    assert.deepEqual(await readFile(join(f.artifactDir, first.artifact.path)), before)
    if (!fixtureProvider) {
      assert.equal(f.calls.tool[0].arguments.recoveryId, f.calls.tool[1].arguments.recoveryId)
      assert.equal(f.calls.tool[0].arguments.runId, f.calls.tool[1].arguments.runId)
    }
  }
})

test('fixture recovery reads every private stop receipt before native restore and records a bound proof', async t => {
  const f = await fixture(t), provider = f.makeFixture()
  const result = await provider.reconcile(f.context)
  assert.equal(result.outcome, 'restored'); await verifyArtifact(f.context, result)
  assert.equal(f.calls.confined.length, 1); assert.equal(f.calls.spawned.length, 1)
  const argv = f.calls.spawned[0].argv
  assert.ok(argv.some(value => value.endsWith('deploy-fixture.ps1')))
  assert.ok(argv.includes('-Recovery')); assert.ok(argv.includes(f.context.recoveryId))
  assert.ok(!argv.some(value => /agent-1c\.ps1|1cv8|ibcmd/iu.test(value)))
  assert.equal(f.calls.tool.length, 0)
})

test('fixture recovery refuses missing stop, wrong root, foreign target and invalid receipt schemas before spawn', async t => {
  const changes = [{ stopped: false }, { stopped: 'yes' }, { rootDigest: 'f'.repeat(64) },
    { targetId: 'another' }, { kind: 'agent-1c' }, { schemaVersion: 2 }, { finishedAt: Date.now() + 60000 }]
  for (const change of changes) {
    const f = await fixture(t)
    await writeFile(f.receiptPath, JSON.stringify({ ...f.privateReceipt, ...change }))
    await assert.rejects(f.makeFixture().reconcile(f.context), /RECOVERY_EXECUTOR_STOP_UNCONFIRMED/u)
    assert.equal(f.calls.spawned.length, 0)
  }
  const absent = await fixture(t)
  await rm(absent.receiptPath)
  await assert.rejects(absent.makeFixture().reconcile(absent.context))
  assert.equal(absent.calls.spawned.length, 0)
})

test('fixture recovery requires stop evidence for every original mutation stage before restoring the earliest backup', async t => {
  const f = await fixture(t)
  f.context.originalTarget.stages.push({ stepId: 'second-apply' })
  await assert.rejects(f.makeFixture().reconcile(f.context))
  assert.equal(f.calls.spawned.length, 0)
  await recordExecution(f.stateDir, { kind: 'deploy-fixture', targetId: f.targetId, rootDigest: f.privateReceipt.rootDigest },
    { runId: f.context.runId, stepId: 'second-apply' }, { data: { terminationConfirmed: true }, mutationState: 'applied' })
  const result = await f.makeFixture().reconcile(f.context)
  assert.equal(result.outcome, 'restored')
  const args = f.calls.spawned[0].argv
  assert.equal(args[args.indexOf('-StepId') + 1], 'apply')
})

test('fixture recovery rejects active execution, foreign context target and unwritable scope before spawn', async t => {
  const f = await fixture(t)
  f.active.set(f.context.runId, {})
  await assert.rejects(f.makeFixture().reconcile(f.context), /RECOVERY_EXECUTOR_STILL_ACTIVE/u)
  f.active.clear()
  await assert.rejects(f.makeFixture({ scope: { ...f.scope, writable: false } }).reconcile(f.context), /RECOVERY_ACTIVE_AGENT_REQUIRED/u)
  await assert.rejects(f.makeFixture().reconcile({ ...f.context, targetId: 'other' }), /RECOVERY_TARGET_MISMATCH/u)
  await assert.rejects(f.makeFixture().reconcile({ ...f.context, originalTarget: { ...f.context.originalTarget, id: 'other' } }), /RECOVERY_TARGET_MISMATCH/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('fixture recovery does not infer restore from zero exit without an exact report', async t => {
  for (const options of [{ noReport: true }, { exitCode: 1 }, { unconfirmed: true },
    { restorePatch: raw => ({ ...raw, restored: false }) }, { restorePatch: raw => ({ ...raw, runId: randomUUID() }) }]) {
    const f = await fixture(t, options)
    await assert.rejects(f.makeFixture().reconcile(f.context))
    assert.deepEqual(await readdir(f.artifactDir), [])
  }
})

test('fixture restore cancellation terminates its owned native handle and emits no completion proof', async t => {
  const f = await fixture(t, { pending: true }), running = f.makeFixture().reconcile(f.context)
  for (let i = 0; i < 100 && !f.calls.spawned.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
  f.controller.abort()
  await assert.rejects(running, /RECOVERY_RESTORE_NOT_CONFIRMED/u)
  assert.equal(f.calls.terminated, 1); assert.deepEqual(await readdir(f.artifactDir), [])
})

test('fixture restore deadline terminates its owned handle rather than reporting successful recovery', async t => {
  const f = await fixture(t, { pending: true }); f.context.timeoutMs = 100
  await assert.rejects(f.makeFixture().reconcile(f.context), /RECOVERY_RESTORE_NOT_CONFIRMED/u)
  assert.equal(f.calls.terminated, 1); assert.deepEqual(await readdir(f.artifactDir), [])
})

test('execution stop receipt stores only bound metadata and distinguishes unconfirmed termination', async t => {
  const f = await fixture(t), stepId = 'different-stage'
  await recordExecution(f.stateDir, { kind: 'deploy-fixture', targetId: f.targetId, rootDigest: 'a'.repeat(64) },
    { runId: f.context.runId, stepId }, { data: { terminationConfirmed: false, rawOutput: 'PRIVATE_OUTPUT' }, mutationState: 'unknown' })
  const text = await readFile(join(f.stateDir, 'execution-receipts', f.context.runId, `${stepId}.json`), 'utf8')
  const value = JSON.parse(text)
  assert.equal(value.stopped, false); assert.equal(value.mutationState, 'unknown')
  assert.doesNotMatch(text, /PRIVATE_OUTPUT/u)
  await assert.rejects(recordExecution(f.stateDir, { kind: 'deploy-fixture', targetId: f.targetId },
    { runId: f.context.runId, stepId }, { data: { terminationConfirmed: true } }), { code: 'EEXIST' })
})
