import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'
import { createLocalRecoveryProvider } from '../src/workflow-integration/lib/local-recovery.js'

const core = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const identities = ['recoveryId', 'runId', 'targetId', 'planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest']
const helpers = { scrubbedParentEnv: () => ({ PATH: 'native-fixture' }), classifyRunnerFailure: () => undefined, matchesSignature: () => false }

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'local-recovery-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'project'), artifactDir = join(temporary, 'proof'), pwshPath = join(temporary, 'pwsh.exe')
  await mkdir(join(root, 'scripts/lib'), { recursive: true }); await mkdir(artifactDir)
  const files = ['scripts/recover.ps1', 'scripts/lib/recover.psm1', 'recovery.settings.json']
  for (const path of files) await writeFile(join(root, path), path.endsWith('.json') ? '{"fixture":true}' : '# fixture only; never executed')
  await writeFile(pwshPath, 'fixture PowerShell executable bytes; NEVER executed')
  const inventory = await Promise.all([...files].sort().map(async path => ({ path, digest: hash(await readFile(join(root, path))) })))
  const config = { projectId: 'project', id: 'local-recovery', runnerPath: 'scripts/recover.ps1', files,
    reviewedDigest: core.digest({ files: inventory }) }
  const scope = { id: 'session', root, writable: true }
  const session = { id: scope.id, header: { id: scope.id, cwd: root } }
  const controller = new AbortController(), executionController = new AbortController()
  const execution = { agent: { session }, callId: 'native-call', rootCallId: 'root-call', signal: executionController.signal }
  const context = { schemaVersion: 1, recoveryId: randomUUID(), runId: randomUUID(), targetId: 'bound-target',
    planDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64), providerDigest: '',
    originalResult: { projectId: 'project' }, originalTarget: { id: 'bound-target', mutationState: 'unknown' },
    artifactDir, signal: controller.signal, timeoutMs: 1000, deadline: Date.now() + 1000 }
  const calls = { spawned: [], confined: [], terminated: 0 }
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: options.sandboxMode ?? 'workspace-write', workspaceRoot: root, sessionId: session.id }) },
    sandbox: { async confine(argv, policy) {
      calls.confined.push({ argv, policy })
      if (options.denied) throw new Error('private sandbox failure')
      return { argv: ['native-sandbox-fixture', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      const argument = key => spec.argv[spec.argv.indexOf(key) + 1]
      const stdout = new PassThrough(), stderr = new PassThrough()
      let finish, exited = false
      const done = new Promise(resolve => { finish = (exitCode, signal = null) => {
        exited = true; stdout.end(); stderr.end(); resolve({ exitCode, signal })
      } })
      queueMicrotask(async () => {
        if (options.pending) return
        try {
          const path = argument('-WorkflowReportPath')
          if (!options.noReport) {
            await mkdir(dirname(path), { recursive: true })
            const report = { schemaVersion: 1, ...Object.fromEntries(identities.map(key => [key, argument(`-Workflow${key[0].toUpperCase()}${key.slice(1)}`)])),
              executorStopped: true, outcome: 'restored', observedAt: Date.now() }
            await writeFile(path, options.rawReport ?? JSON.stringify(options.reportPatch ? options.reportPatch(report) : report))
          }
          if (options.changeClosure) await writeFile(join(root, 'scripts/lib/recover.psm1'), '# changed during recovery')
          stdout.write('PRIVATE_OUTPUT_MUST_NOT_ESCAPE'); stderr.write('PRIVATE_ERROR_MUST_NOT_ESCAPE')
          finish(options.exitCode ?? 0)
        } catch { finish(99) }
      })
      return { stdout, stderr, done, terminate() { calls.terminated++; if (!exited) finish(null, 'SIGTERM') },
        waitForExit: async () => options.unconfirmed ? false : exited }
    } },
  }
  const active = new Map()
  const make = overrides => createLocalRecoveryProvider({ ctx, scope, config, core, execution, mode: 'enabled', active,
    nativeHelpers: helpers, pwshPath, ...overrides })
  const provider = make()
  context.providerDigest = await provider.fingerprint()
  return { root, artifactDir, pwshPath, config, context, scope, execution, active, calls, controller, executionController, provider, make }
}

async function artifact(context, result) {
  const bytes = await readFile(join(context.artifactDir, result.artifact.path))
  assert.equal(result.artifact.bytes, bytes.length); assert.equal(result.artifact.digest, hash(bytes))
  for (const key of identities) assert.equal(result[key], context[key])
  assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE_OUTPUT|PRIVATE_ERROR/u)
  return bytes
}

test('reviewed local runner executes only through native confinement and returns a bound private proof', async t => {
  const f = await fixture(t), result = await f.provider.reconcile(f.context)
  assert.equal(result.outcome, 'restored'); assert.equal(result.executorStopped, true)
  await artifact(f.context, result)
  assert.equal(f.calls.confined.length, 1); assert.equal(f.calls.spawned.length, 1)
  const call = f.calls.spawned[0]
  assert.equal(call.cwd, f.root)
  assert.ok(call.argv.includes(join(f.root, 'scripts/recover.ps1')))
  for (const key of identities) assert.equal(call.argv[call.argv.indexOf(`-Workflow${key[0].toUpperCase()}${key.slice(1)}`) + 1], f.context[key])
  const path = call.argv[call.argv.indexOf('-WorkflowReportPath') + 1]
  assert.ok(path.startsWith(join(f.root, '.airules/recovery-reports', f.context.recoveryId)))
  assert.equal(call.argv.includes('-Command'), false)
})

test('passive local fingerprint validates the exact sorted closure hash without launching or creating project reports', async t => {
  const f = await fixture(t)
  const passive = f.make({ execution: undefined })
  assert.match(await passive.fingerprint(), /^[a-f0-9]{64}$/u)
  assert.equal(f.calls.spawned.length, 0); assert.equal(f.calls.confined.length, 0)
  await assert.rejects(readFile(join(f.root, '.airules/recovery-reports')), { code: 'ENOENT' })
  await writeFile(join(f.root, 'recovery.settings.json'), '{"changed":true}')
  await assert.rejects(f.provider.fingerprint(), /RECOVERY_LOCAL_REVIEW_REQUIRED/u)
})

test('machine config rejects arbitrary commands, missing closure entries, unsafe paths and unreviewed fields', async t => {
  const f = await fixture(t)
  const invalid = [
    { ...f.config, args: ['-Command', 'arbitrary'] }, { ...f.config, runnerPath: 'scripts/recover.cmd' },
    { ...f.config, runnerPath: '../recover.ps1' }, { ...f.config, files: ['scripts/recover.ps1', 'secrets.env'] },
    { ...f.config, files: ['recovery.settings.json'] }, { ...f.config, files: ['scripts/recover.ps1', 'scripts\\recover.ps1'] },
    { ...f.config, reviewedDigest: 'not-reviewed' },
  ]
  for (const config of invalid) assert.throws(() => f.make({ config }), /RECOVERY_LOCAL_/u)
  await assert.rejects(f.make({ config: { ...f.config, reviewedDigest: 'e'.repeat(64) } }).fingerprint(), /RECOVERY_LOCAL_REVIEW_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('local recovery refuses fixture-only/disabled/unknown modes and missing active writable scope', async t => {
  for (const mode of ['fixture-only', 'disabled', 'unknown']) {
    const f = await fixture(t)
    await assert.rejects(f.make({ mode }).reconcile(f.context), /ACTUAL_DEPLOY_DISABLED/u)
    assert.equal(f.calls.spawned.length, 0)
  }
  const f = await fixture(t)
  for (const overrides of [{ execution: undefined }, { scope: { ...f.scope, writable: false } },
    { execution: { ...f.execution, callId: '' } }, { execution: { ...f.execution, agent: { session: { id: 'other' } } } }]) {
    await assert.rejects(f.make(overrides).reconcile(f.context), /RECOVERY_ACTIVE_AGENT_REQUIRED/u)
  }
  assert.equal(f.calls.spawned.length, 0)
})

test('local recovery blocks active executors, wrong project/target and stale provider fingerprints', async t => {
  const f = await fixture(t)
  f.active.set(f.context.runId, {})
  await assert.rejects(f.provider.reconcile(f.context), /RECOVERY_EXECUTOR_STILL_ACTIVE/u)
  f.active.clear()
  await assert.rejects(f.provider.reconcile({ ...f.context, originalResult: { projectId: 'other' } }), /RECOVERY_PROJECT_MISMATCH/u)
  await assert.rejects(f.provider.reconcile({ ...f.context, targetId: 'other' }), /RECOVERY_LOCAL_CONTEXT_INVALID/u)
  await assert.rejects(f.provider.reconcile({ ...f.context, providerDigest: 'f'.repeat(64) }), /RECOVERY_PROVIDER_CHANGED/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('local recovery rejects missing/stale/foreign/malformed reports and stopped=false even after exit zero', async t => {
  for (const options of [{ noReport: true }, { rawReport: '{malformed' },
    { reportPatch: report => ({ ...report, recoveryId: randomUUID() }) },
    { reportPatch: report => ({ ...report, targetId: 'other' }) },
    { reportPatch: report => ({ ...report, sourceDigest: 'e'.repeat(64) }) },
    { reportPatch: report => ({ ...report, executorStopped: false }) },
    { reportPatch: report => ({ ...report, observedAt: 1 }) },
    { reportPatch: report => ({ ...report, outcome: 'unlocked' }) },
    { reportPatch: report => ({ ...report, extra: 'PRIVATE_DIAGNOSTIC' }) }]) {
    const f = await fixture(t, options)
    await assert.rejects(f.provider.reconcile(f.context))
    assert.deepEqual(await readdir(f.artifactDir), [])
  }
})

test('local recovery fails if the reviewed closure or executable changes before or during execution', async t => {
  const changed = await fixture(t)
  await writeFile(join(changed.root, 'scripts/recover.ps1'), '# edited before run')
  await assert.rejects(changed.provider.reconcile(changed.context), /RECOVERY_LOCAL_REVIEW_REQUIRED/u)
  assert.equal(changed.calls.spawned.length, 0)
  const binary = await fixture(t)
  await writeFile(binary.pwshPath, 'different executable fixture')
  await assert.rejects(binary.provider.reconcile(binary.context), /RECOVERY_PROVIDER_CHANGED/u)
  assert.equal(binary.calls.spawned.length, 0)
  const during = await fixture(t, { changeClosure: true })
  await assert.rejects(during.provider.reconcile(during.context), /RECOVERY_LOCAL_REVIEW_REQUIRED/u)
  assert.equal(during.calls.spawned.length, 1)
  assert.deepEqual(await readdir(during.artifactDir), [])
})

test('local recovery keeps recoveryId stable on retry but uses fresh report and proof paths', async t => {
  const f = await fixture(t)
  const first = await f.provider.reconcile(f.context), original = await artifact(f.context, first)
  const second = await f.provider.reconcile(f.context)
  await artifact(f.context, second)
  assert.notEqual(first.artifact.path, second.artifact.path)
  assert.deepEqual(await readFile(join(f.artifactDir, first.artifact.path)), original)
  const argument = (call, key) => call.argv[call.argv.indexOf(key) + 1]
  assert.equal(argument(f.calls.spawned[0], '-WorkflowRecoveryId'), argument(f.calls.spawned[1], '-WorkflowRecoveryId'))
  assert.notEqual(argument(f.calls.spawned[0], '-WorkflowReportPath'), argument(f.calls.spawned[1], '-WorkflowReportPath'))
})

test('local recovery cancellation and timeout terminate only the owned handle and never emit proof', async t => {
  for (const timeout of [false, true]) {
    const f = await fixture(t, { pending: true })
    if (timeout) f.context.timeoutMs = 100
    const run = f.provider.reconcile(f.context)
    for (let i = 0; i < 100 && !f.calls.spawned.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
    if (!timeout) f.controller.abort()
    await assert.rejects(run)
    assert.equal(f.calls.terminated, 1); assert.deepEqual(await readdir(f.artifactDir), [])
  }
})

test('local recovery refuses failed, unconfirmed or denied native execution without fallback', async t => {
  for (const options of [{ exitCode: 1 }, { unconfirmed: true }, { denied: true }]) {
    const f = await fixture(t, options)
    await assert.rejects(f.provider.reconcile(f.context), /RECOVERY_LOCAL_PROCESS_FAILED/u)
    assert.deepEqual(await readdir(f.artifactDir), [])
    assert.equal(f.calls.spawned.length, options.denied ? 0 : 1)
  }
})

test('local recovery rejects an already aborted caller before process launch', async t => {
  const f = await fixture(t)
  f.executionController.abort()
  await assert.rejects(f.provider.reconcile(f.context))
  assert.equal(f.calls.spawned.length, 0)
})

test('local recovery never writes its trusted proof artifact into the project workspace', async t => {
  const f = await fixture(t), artifactDir = join(f.root, 'project-proof')
  await mkdir(artifactDir)
  await assert.rejects(f.provider.reconcile({ ...f.context, artifactDir }), /RECOVERY_PRIVATE_ARTIFACT_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 0)
  assert.deepEqual(await readdir(artifactDir), [])
})

test('local recovery does not accept project closure aliases or report path redirection', async t => {
  const linked = await fixture(t)
  await link(join(linked.root, 'scripts/recover.ps1'), join(linked.root, 'hardlink.ps1'))
  await assert.rejects(linked.provider.fingerprint(), /RECOVERY_LOCAL_CLOSURE_INVALID/u)
  const redirected = await fixture(t)
  const outside = join(redirected.artifactDir, 'outside'); await mkdir(outside)
  try { await symlink(outside, join(redirected.root, '.airules'), 'junction') }
  catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) return t.skip('reparse fixtures unavailable'); throw error }
  await assert.rejects(redirected.provider.reconcile(redirected.context), /RECOVERY_LOCAL_REPORT_PATH_INVALID/u)
  assert.equal(redirected.calls.spawned.length, 0)
})
