import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createDeployProcessAdapter, DEPLOY_RESULT_SCHEMA, validateDeployEvidence } from '../src/workflow-integration/lib/deploy-process.js'
import { validateDescriptor, validateSchema, digest } from '../../project_rules/core/tools/workflow/lib/contracts.mjs'
import { projectPath, safeRead } from '../../project_rules/core/tools/workflow/lib/snapshot.mjs'
import { PROCESS_RESULT_SCHEMA } from '../../project_rules/core/tools/workflow/lib/local-process.mjs'
import { validateDeployReport } from '../../project_rules/overlays/1c/tools/workflow-runners/index.mjs'

const inputSchema = { type: 'object', additionalProperties: false }
const SHA = 'a'.repeat(64), PROFILE = 'b'.repeat(64), SOURCE = 'c'.repeat(64)
const effects = ['readsSource', 'startsProcess', 'writesFilesystem', 'connectsTarget', 'writesTargetData', 'changesMetadata', 'serviceLifecycle']
const helpers = { scrubbedParentEnv: () => ({ PATH: 'native-fixture' }), classifyRunnerFailure: () => undefined, matchesSignature: () => false }

// Normalizer double: strict identity validation happens before exposing any assertion.
function reportValidator(raw, expected) {
  if (!raw || raw.projectId !== expected.projectId || raw.command !== 'deploy' || raw.apply !== true
    || !['runId', 'stepId', 'sourceDigest', 'targetDigest', 'profileDigest'].every(key => raw.workflow?.[key] === expected[key])) throw new Error('DEPLOY_REPORT_PROVENANCE_INVALID')
  return { complete: true, assertions: [{ id: 'deploy.applied', passed: raw.exitCode === 0 && raw.workflow.mutationState === 'applied' }], mutationState: raw.workflow.mutationState }
}
const core = { validateDescriptor, validateSchema, digest, projectPath, safeRead, PROCESS_RESULT_SCHEMA, validateDeployReport: reportValidator }

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-deploy-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context = { cwd: root, runId: randomUUID(), stepId: 'apply', sourceDigest: SOURCE, timeoutMs: 1000 }
  const deployment = { projectId: 'fixture', target: { id: `onec-${SHA}`, environment: 'test', kind: 'file' },
    targetDigest: SHA, profileDigest: PROFILE, resultPath: join(root, 'reports'), targetPath: join(root, 'database-not-opened'), exactBuild: '8.3.27.1989' }
  const reportPath = join(deployment.resultPath, `workflow-${context.runId}`, context.stepId, 'result.json')
  const session = { id: 'session-fixture', header: { id: 'session-fixture', cwd: root } }
  const calls = { spawned: [], confined: [], terminated: 0, validators: [] }
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: options.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session.id }) },
    sandbox: { async confine(argv) {
      calls.confined.push(argv)
      if (options.denied) throw new Error('private runner error')
      return { argv: ['native-fixture', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      const stdout = new PassThrough(), stderr = new PassThrough()
      let resolveDone, exited = false
      const done = new Promise(resolve => { resolveDone = resolve })
      const finish = (exitCode, signal = null) => { exited = true; stdout.end(); stderr.end(); resolveDone({ exitCode, signal }) }
      queueMicrotask(async () => {
        if (options.pending) return
        if (!options.noReport) {
          await mkdir(join(deployment.resultPath, `workflow-${context.runId}`, context.stepId), { recursive: true })
          const workflow = { schemaVersion: 1, runId: context.runId, stepId: context.stepId,
            sourceDigest: options.staleSource ? 'd'.repeat(64) : SOURCE, targetDigest: options.staleTarget ? 'e'.repeat(64) : SHA, profileDigest: options.staleProfile ? 'f'.repeat(64) : PROFILE,
            mutationState: options.mutationState ?? 'applied' }
          await writeFile(reportPath, options.invalidJson ? 'private invalid report {' : JSON.stringify({ schemaVersion: 1, projectId: 'fixture',
            command: 'deploy', apply: true, startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(),
            exitCode: options.exitCode ?? 0, workflow, steps: [{ name: 'deploy.apply', status: 'ok' }], privateMessage: 'NEVER_PUBLISH_REPORT_CONTENT' }))
        }
        stdout.write('NEVER_PUBLISH_STDOUT'); stderr.write('NEVER_PUBLISH_STDERR')
        finish(options.exitCode ?? 0)
      })
      return { stdout, stderr, done,
        terminate() { calls.terminated++; finish(null, 'SIGTERM') },
        waitForExit() { return Promise.resolve(options.unconfirmed ? false : exited) },
      }
    } },
  }
  const operations = { 'deploy-apply': { command: process.execPath, args: (_inputs, context) => ['fixture-only', JSON.stringify(context.deployContext)],
    inputSchema, effects, fingerprintPaths: [] } }
  const adapter = createDeployProcessAdapter({ ctx, agent: { session }, callId: 'call-fixture', id: 'deploy-fixture', core: options.canonicalValidator ? { ...core, validateDeployReport } : core,
    nativeHelpers: helpers, deployment: options.relativeResult ? { ...deployment, resultPath: 'reports' } : deployment, operations })
  return { adapter, calls, context, deployment, reportPath, operations, ctx, session }
}

test('deploy adapter uses native sandbox and bound report, never process-exit alone or raw output', async t => {
  const f = await fixture(t), output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(f.calls.confined.length, 1)
  assert.equal(f.calls.spawned.length, 1)
  assert.equal(output.mutationState, 'applied')
  assert.equal(output.data.complete, true)
  assert.equal(output.data.terminationConfirmed, true)
  assert.deepEqual(validateDeployEvidence(output.data, f.context), { status: 'passed' })
  assert.equal(f.adapter.descriptor.operations['deploy-apply'].resourcesRequired, true)
  assert.equal(f.adapter.descriptor.operations['deploy-apply'].validator, 'deployment-result')
  const invocation = JSON.parse(f.calls.confined[0].at(-1))
  assert.equal(invocation.profileDigest, PROFILE)
  assert.equal(invocation.targetDigest, SHA)
  assert.equal(invocation.targetPath, f.deployment.targetPath)
  assert.equal(invocation.runId, f.context.runId)
  assert.doesNotMatch(JSON.stringify(output), /NEVER_PUBLISH|database-not-opened|native-fixture|targetPath/)
  validateSchema(DEPLOY_RESULT_SCHEMA, output.data)
})

test('successful process without report and stale or malformed report remain unknown', async t => {
  for (const options of [{ noReport: true }, { staleSource: true }, { staleTarget: true }, { staleProfile: true }, { invalidJson: true }]) {
    const f = await fixture(t, options), output = await f.adapter.execute('deploy-apply', {}, f.context)
    assert.equal(output.data.process.exitCode, 0)
    assert.equal(output.data.complete, false)
    assert.equal(output.mutationState, 'unknown')
    assert.equal(validateDeployEvidence(output.data, f.context).status, 'indeterminate')
    assert.doesNotMatch(JSON.stringify(output), /NEVER_PUBLISH|private invalid/)
  }
})

test('canonical report normalizer and relative result path accept only the current invocation', async t => {
  const f = await fixture(t, { canonicalValidator: true, relativeResult: true })
  const output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(output.data.complete, true)
  assert.equal(output.mutationState, 'applied')
  assert.equal(validateDeployEvidence(output.data, f.context).status, 'passed')
  const stale = await fixture(t, { canonicalValidator: true, staleTarget: true })
  assert.equal((await stale.adapter.execute('deploy-apply', {}, stale.context)).mutationState, 'unknown')
})

test('nonzero exit after known apply is failed with applied state; partial apply stays unknown', async t => {
  const f = await fixture(t, { exitCode: 1 }), applied = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(applied.mutationState, 'applied')
  assert.equal(applied.data.complete, true)
  assert.equal(validateDeployEvidence(applied.data, f.context).status, 'failed')
  const partial = await fixture(t, { exitCode: 1, mutationState: 'unknown' })
  assert.equal((await partial.adapter.execute('deploy-apply', {}, partial.context)).mutationState, 'unknown')
})

test('reported pre-apply rejection is not-applied and is never a successful deploy', async t => {
  const f = await fixture(t, { exitCode: 1, mutationState: 'not-applied' }), output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(output.mutationState, 'not-applied')
  assert.equal(validateDeployEvidence(output.data, f.context).status, 'failed')
})

test('preexisting report directory refuses invocation and never reuses stale evidence', async t => {
  const f = await fixture(t)
  await mkdir(join(f.deployment.resultPath, `workflow-${f.context.runId}`, f.context.stepId), { recursive: true })
  const output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(f.calls.spawned.length, 0)
  assert.equal(output.mutationState, 'not-applied')
  assert.equal(output.data.reason, 'DEPLOY_REPORT_PREEXISTING')
})

test('sandbox failure happens without spawn or claiming target changes', async t => {
  const f = await fixture(t, { denied: true }), output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(f.calls.spawned.length, 0)
  assert.equal(output.mutationState, 'not-applied')
  assert.equal(output.data.process.startError, 'NATIVE_SANDBOX_UNAVAILABLE')
})

test('read-only policy refuses deploy before confinement or spawn', async t => {
  const f = await fixture(t, { mode: 'read-only' }), output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(output.mutationState, 'not-applied')
  assert.equal(output.data.reason, 'DEPLOY_WRITE_PERMISSION_REQUIRED')
  assert.equal(f.calls.confined.length, 0)
  assert.equal(f.calls.spawned.length, 0)
})

test('timeout or cancellation terminates only the owned native handle and remains unknown', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t, { pending: true }), controller = new AbortController()
    f.context.timeoutMs = 100
    const pending = f.adapter.execute('deploy-apply', {}, { ...f.context, signal: controller.signal })
    if (cancel) setTimeout(() => controller.abort(), 25)
    const output = await pending
    assert.equal(f.calls.terminated, 1)
    assert.equal(output.mutationState, 'unknown')
    assert.equal(output.data.terminationConfirmed, true)
    assert.equal(validateDeployEvidence(output.data, f.context).status, 'indeterminate')
  }
})

test('unconfirmed process termination remains unknown even with complete report', async t => {
  const f = await fixture(t, { unconfirmed: true }), output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(output.mutationState, 'unknown')
  assert.equal(output.data.terminationConfirmed, false)
  assert.equal(validateDeployEvidence(output.data, f.context).status, 'indeterminate')
})

test('symlink artifact parent is rejected before spawn', async t => {
  const f = await fixture(t), other = await mkdtemp(join(tmpdir(), 'native-deploy-outside-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  try { await symlink(other, f.deployment.resultPath, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation unavailable'); throw error }
  const output = await f.adapter.execute('deploy-apply', {}, f.context)
  assert.equal(f.calls.spawned.length, 0)
  assert.equal(output.mutationState, 'not-applied')
})

test('malformed provenance, wrong operation and production target never launch', async t => {
  const f = await fixture(t)
  await assert.rejects(f.adapter.execute('deploy-apply', {}, { ...f.context, runId: '../outside' }), /DEPLOY_PROVENANCE_REQUIRED/u)
  await assert.rejects(f.adapter.execute('deploy-preview', {}, f.context), /DEPLOY_OPERATION_UNKNOWN/u)
  assert.throws(() => createDeployProcessAdapter({ ctx: f.ctx, agent: { session: f.session }, callId: 'fixture', id: 'test', core,
    nativeHelpers: helpers, operations: f.operations, deployment: { ...f.deployment, target: { ...f.deployment.target, environment: 'production' } } }), /DEPLOY_REGISTRATION_INVALID/u)
  assert.equal(f.calls.spawned.length, 0)
})
