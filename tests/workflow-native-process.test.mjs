import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createNativeProcessAdapter } from '../src/workflow-integration/lib/native-process.js'
import { validateDescriptor, validateSchema, digest } from '../../project_rules/core/tools/workflow/lib/contracts.mjs'
import { PROCESS_RESULT_SCHEMA } from '../../project_rules/core/tools/workflow/lib/local-process.mjs'

const core = { validateDescriptor, validateSchema, digest, PROCESS_RESULT_SCHEMA }
const inputSchema = { type: 'object', additionalProperties: false, properties: {} }
const helpers = {
  scrubbedParentEnv: () => ({ PATH: 'trusted-native-path', EXAMPLE_TOKEN: 'must-not-forward', DSH_SESSION_ID: 'must-not-forward' }),
  classifyRunnerFailure: (code, text, rules) => code !== 0 && rules.some(rule => rule.fatalSignatures.some(line => text.includes(line))) ? { detail: text } : undefined,
  matchesSignature: (code, text, signatures) => code !== 0 && signatures.some(signature => text.includes(signature)),
}

test('explicit child working directory stays inside the original native session policy root', async t => {
  const f = await fixture(t), nested = join(f.context.cwd, 'isolated-child')
  await mkdir(nested)
  const make = workingDirectory => createNativeProcessAdapter({ ctx: f.ctx, agent: f.agent, callId: 'cwd-call', id: 'child-cwd', core, nativeHelpers: helpers,
    operations: { inspect: { ...f.operations.inspect, workingDirectory } } })
  const success = await make(() => nested).execute('inspect', {}, f.context)
  assert.equal(success.data.exitCode, 0)
  assert.equal(f.calls.spawned.at(-1).cwd, nested)
  assert.equal(f.calls.confined.at(-1).policy.workspaceRoot, f.context.cwd)
  const before = f.calls.spawned.length
  await assert.rejects(make(() => tmpdir()).execute('inspect', {}, f.context), /NATIVE_WORKFLOW_WORKING_DIRECTORY_INVALID/)
  await assert.rejects(make(() => 'relative').execute('inspect', {}, f.context), /NATIVE_WORKFLOW_WORKING_DIRECTORY_INVALID/)
  assert.equal(f.calls.spawned.length, before)
})

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'native-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const session = { id: 'native-session', header: { id: 'native-session', cwd } }, agent = { session }
  let policy = { mode: options.mode ?? 'workspace-write', workspaceRoot: cwd, sessionId: session.id }
  const calls = { resolved: [], confined: [], spawned: [], terminated: 0, approvals: 0 }
  const ctx = {
    approval: { request() { calls.approvals++; throw new Error('Unexpected approval') } },
    sandboxPolicy: { resolve(request) { calls.resolved.push(request); return { ...policy } } },
    sandbox: { async confine(argv, effective, signal) {
      calls.confined.push({ argv, policy: effective, signal })
      if (options.confineError) throw new Error('private-token-must-not-be-shown')
      if (options.changePolicy) policy = { ...policy, mode: 'danger-full-access' }
      return { argv: ['native-sandbox-runner', '--', ...argv], enforcement: 'full',
        denialSignatures: ['access denied'], runnerFailureRules: [{ fatalSignatures: ['runner failed'] }] }
    } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      let resolveDone, rejectDone, resolveExit, exited = false
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
      const exit = new Promise(resolve => { resolveExit = resolve })
      const stdout = new PassThrough(), stderr = new PassThrough()
      const finish = (code = 0, signal = null) => {
        if (exited) return
        exited = true; stdout.end(); stderr.end(); resolveDone({ exitCode: code, signal }); resolveExit(true)
      }
      const handle = { stdout, stderr, done,
        terminate() { calls.terminated++; finish(null, 'SIGTERM') },
        waitForExit(signal) {
          if (options.unconfirmed) return Promise.resolve(false)
          if (!signal) return exit
          if (signal.aborted) return Promise.resolve(false)
          return new Promise(resolve => {
            const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(false) }
            signal.addEventListener('abort', onAbort, { once: true })
            exit.then(value => { signal.removeEventListener('abort', onAbort); resolve(value) })
          })
        },
      }
      queueMicrotask(() => {
        if (options.behavior === 'pending') return
        if (options.behavior === 'error') { rejectDone(new Error('private-token-runtime-error')); return }
        if (options.behavior === 'overflow') { stdout.write(Buffer.alloc(1024 * 1024 + 1, 120)); return }
        stdout.write('private-token-output')
        stderr.write(options.behavior === 'denied' ? 'access denied private-token' : options.behavior === 'runner-failed' ? 'runner failed private-token' : 'private-token-stderr')
        finish(['denied', 'runner-failed'].includes(options.behavior) ? 1 : 0)
      })
      return handle
    } },
  }
  const operations = { inspect: { command: process.execPath, args: () => ['--version'], inputSchema,
    effects: ['readsSource', 'startsProcess'], validator: 'process-exit' } }
  const adapter = createNativeProcessAdapter({ ctx, agent, callId: 'native-call', id: 'native-fixture', operations, core,
    nativeHelpers: helpers, signal: options.signal })
  return { adapter, agent, ctx, calls, operations, context: { cwd, timeoutMs: 1000, runId: 'fixture-run', sourceDigest: 'fixture-source', stepId: 'inspect' } }
}

test('native adapter confines exact fixed argv under the real session policy, without publishing output', async t => {
  const f = await fixture(t)
  const result = await f.adapter.execute('inspect', {}, f.context)
  assert.equal(result.data.exitCode, 0)
  assert.equal(result.data.terminationConfirmed, true)
  assert.equal(result.mutationState, 'not-applied')
  assert.equal(f.calls.confined.length, 1)
  assert.deepEqual(f.calls.confined[0].policy, { mode: 'workspace-write', workspaceRoot: f.context.cwd, sessionId: f.agent.session.id })
  assert.equal(f.calls.resolved[0].session, f.agent.session)
  assert.deepEqual(f.calls.spawned[0].argv, f.calls.confined[0].argv.length ? ['native-sandbox-runner', '--', ...f.calls.confined[0].argv] : [])
  assert.equal(f.calls.spawned[0].cwd, f.context.cwd)
  assert.deepEqual(f.calls.spawned[0].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  assert.equal(f.calls.spawned[0].env.PATH, 'trusted-native-path')
  assert.equal(f.calls.spawned[0].env.EXAMPLE_TOKEN, undefined)
  assert.equal(f.calls.spawned[0].env.DSH_SESSION_ID, undefined)
  assert.equal(f.calls.approvals, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-token|--version|native-sandbox-runner/)
  core.validateSchema(PROCESS_RESULT_SCHEMA, result.data)
})

test('read-only and full access use their standing mode, never requesting escalation', async t => {
  for (const mode of ['read-only', 'danger-full-access']) {
    const f = await fixture(t, { mode })
    const result = await f.adapter.execute('inspect', {}, f.context)
    assert.equal(result.data.exitCode, 0)
    assert.equal(f.calls.confined.length, mode === 'danger-full-access' ? 0 : 1)
    assert.equal(f.calls.approvals, 0)
    if (mode === 'danger-full-access') assert.deepEqual(f.calls.spawned[0].argv.slice(1), ['--version'])
  }
})

test('unavailable sandbox fails closed before spawn and exposes only a safe code', async t => {
  const f = await fixture(t, { confineError: true })
  const result = await f.adapter.execute('inspect', {}, f.context)
  assert.equal(result.data.startError, 'NATIVE_SANDBOX_UNAVAILABLE')
  assert.equal(result.data.terminationConfirmed, true)
  assert.equal(f.calls.spawned.length, 0)
  assert.equal(f.calls.approvals, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-token/)
})

test('sandbox denial and runner failures are classified without leaking stderr or retrying', async t => {
  for (const [behavior, code] of [['denied', 'NATIVE_SANDBOX_DENIED'], ['runner-failed', 'NATIVE_SANDBOX_UNAVAILABLE']]) {
    const f = await fixture(t, { behavior })
    const result = await f.adapter.execute('inspect', {}, f.context)
    assert.equal(result.data.startError, code)
    assert.equal(f.calls.spawned.length, 1)
    assert.equal(f.calls.approvals, 0)
    assert.doesNotMatch(JSON.stringify(result), /private-token/)
  }
})

test('policy changes during preparation cannot widen the pending call', async t => {
  const f = await fixture(t, { changePolicy: true })
  const result = await f.adapter.execute('inspect', {}, f.context)
  assert.equal(result.data.startError, 'NATIVE_POLICY_REJECTED')
  assert.equal(f.calls.spawned.length, 0)
})

test('session and cwd identity are enforced before confinement or execution', async t => {
  const f = await fixture(t)
  const other = join(f.context.cwd, 'other')
  await mkdir(other)
  await assert.rejects(f.adapter.execute('inspect', {}, { ...f.context, cwd: other }), /NATIVE_WORKFLOW_POLICY_MISMATCH/u)
  f.agent.session = { id: 'another', header: { id: 'another', cwd: f.context.cwd } }
  await assert.rejects(f.adapter.execute('inspect', {}, f.context), /NATIVE_WORKFLOW_SESSION_MISMATCH/u)
  assert.equal(f.calls.confined.length, 0)
  assert.equal(f.calls.spawned.length, 0)
})

test('target mutations, unsupported validators and arbitrary arguments cannot be registered or supplied', async t => {
  const f = await fixture(t)
  for (const effects of [['changesMetadata'], ['writesTargetData'], ['externalIO'], ['connectsTarget']]) {
    assert.throws(() => createNativeProcessAdapter({ ctx: f.ctx, agent: f.agent, callId: 'call', id: 'rejected', core, nativeHelpers: helpers,
      operations: { mutate: { ...f.operations.inspect, effects } } }), /NATIVE_WORKFLOW_OPERATION_REJECTED/u)
  }
  await assert.rejects(f.adapter.execute('inspect', { command: 'anything' }, f.context), /NATIVE_WORKFLOW_INPUT_INVALID/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('native timeout terminates only the returned owned handle and waits for quiescence', async t => {
  const f = await fixture(t, { behavior: 'pending' })
  const result = await f.adapter.execute('inspect', {}, { ...f.context, timeoutMs: 100 })
  assert.equal(result.data.timedOut, true)
  assert.equal(result.data.terminationConfirmed, true)
  assert.equal(f.calls.terminated, 1)
  assert.equal(f.calls.spawned.length, 1)
})

test('an unconfirmed managed-range exit never becomes successful process evidence', async t => {
  const f = await fixture(t, { unconfirmed: true })
  const result = await f.adapter.execute('inspect', {}, f.context)
  assert.equal(result.data.exitCode, 0)
  assert.equal(result.data.terminationConfirmed, false)
  assert.equal(result.data.startError, 'NATIVE_PROCESS_FAILED')
  assert.equal(f.calls.terminated, 1)
})

test('cancellation is tied to both native tool signal and core run signal', async t => {
  for (const native of [false, true]) {
    const controller = new AbortController()
    const f = await fixture(t, { behavior: 'pending', ...(native ? { signal: controller.signal } : {}) })
    const timer = setTimeout(() => controller.abort(), 50)
    t.after(() => clearTimeout(timer))
    const result = await f.adapter.execute('inspect', {}, { ...f.context, ...(native ? {} : { signal: controller.signal }) })
    assert.equal(result.data.aborted, true)
    assert.equal(result.data.terminationConfirmed, true)
    assert.equal(f.calls.terminated, 1)
  }
})

test('output overflow stops the owned process and raw provider errors remain sanitized', async t => {
  for (const behavior of ['overflow', 'error']) {
    const f = await fixture(t, { behavior })
    const result = await f.adapter.execute('inspect', {}, f.context)
    assert.equal(result.data.terminationConfirmed, true)
    assert.equal(f.calls.terminated, 1)
    if (behavior === 'overflow') assert.equal(result.data.outputLimitExceeded, true)
    else assert.equal(result.data.startError, 'NATIVE_PROCESS_FAILED')
    assert.doesNotMatch(JSON.stringify(result), /private-token/)
  }
})

test('native adapter fingerprint includes trusted runner files and never returns their content', async t => {
  const f = await fixture(t)
  const runner = join(f.context.cwd, 'runner.js')
  await writeFile(runner, 'initial trusted runner')
  const adapter = createNativeProcessAdapter({ ctx: f.ctx, agent: f.agent, callId: 'call', id: 'fingerprint-fixture', core, nativeHelpers: helpers,
    operations: { inspect: { ...f.operations.inspect, fingerprintPaths: [runner] } } })
  const before = await adapter.fingerprint()
  assert.match(before, /^[a-f0-9]{64}$/u)
  assert.equal(await adapter.fingerprint(), before)
  await writeFile(runner, 'changed trusted runner')
  assert.notEqual(await adapter.fingerprint(), before)
})
