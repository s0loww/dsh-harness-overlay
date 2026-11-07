import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'
import { createDeployProcessAdapter, validateDeployEvidence, DEPLOY_RESULT_SCHEMA } from '../src/workflow-integration/lib/deploy-process.js'

const core = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const SOURCE = 'a'.repeat(64), PROFILE = 'b'.repeat(64)
const helpers = { scrubbedParentEnv: () => ({ PATH: 'native-transport-fixture' }), classifyRunnerFailure: () => undefined, matchesSignature: () => false }
const inputSchema = { type: 'object', additionalProperties: false }

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-server-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runnerPath = 'tools/agent-1c/agent-1c.ps1', executable = join(root, 'pwsh.exe')
  await mkdir(join(root, 'tools/agent-1c'), { recursive: true })
  await writeFile(executable, 'mock transport only; never executed')
  await writeFile(join(root, runnerPath), '# mock transport fixture; never executed')
  const identity = core.normalizeDeployServerTarget('CLUSTER.EXAMPLE.', 'Демо')
  const targetDigest = core.digest({ kind: 'server', ...identity })
  const deployment = { projectId: 'server-fixture', sourcePath: 'src', resultPath: 'reports',
    exactBuild: '8.3.27.1989', profileDigest: PROFILE, targetPath: null,
    targetServer: options.noncanonical ? 'CLUSTER.EXAMPLE.' : identity.server, targetRef: identity.ref,
    targetDigest, target: { id: `onec-${targetDigest}`, kind: 'server', environment: 'test' } }
  const operation = options.operation ?? 'deploy-preview'
  const context = { cwd: root, runId: randomUUID(), stepId: operation === 'deploy-preview' ? 'preview' : 'apply', sourceDigest: SOURCE, timeoutMs: 1000 }
  const calls = { confined: [], spawned: [], contexts: [] }
  const session = { id: 'server-session', header: { id: 'server-session', cwd: root } }
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) },
    sandbox: { async confine(argv) {
      calls.confined.push(argv)
      return { argv: ['mock-native-sandbox', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      const stdout = new PassThrough(), stderr = new PassThrough()
      let resolveDone
      const done = new Promise(resolve => { resolveDone = resolve })
      queueMicrotask(async () => {
        const preview = operation === 'deploy-preview'
        const reportPreview = options.wrongApply ? !preview : preview
        const directory = join(root, 'reports', `workflow-${context.runId}`, context.stepId)
        await mkdir(directory, { recursive: true })
        const report = { schemaVersion: 1, projectId: 'server-fixture', command: 'deploy', apply: !reportPreview,
          startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), exitCode: options.exitCode ?? 0,
          steps: [{ name: 'deploy.apply', status: reportPreview ? 'dry-run' : 'ok', message: 'DO_NOT_EXPOSE_SERVER_REPORT' }],
          workflow: { schemaVersion: 1, runId: options.wrongNonce ? randomUUID() : context.runId, stepId: context.stepId,
            sourceDigest: SOURCE, targetDigest: options.wrongTarget ? 'f'.repeat(64) : targetDigest, profileDigest: PROFILE,
            mutationState: reportPreview ? 'not-applied' : 'applied' } }
        await writeFile(join(directory, 'result.json'), JSON.stringify(report))
        stdout.write('DO_NOT_EXPOSE_STDOUT'); stderr.write('DO_NOT_EXPOSE_STDERR')
        stdout.end(); stderr.end(); resolveDone({ exitCode: options.exitCode ?? 0, signal: null })
      })
      return { stdout, stderr, done, terminate() {}, waitForExit: async () => true }
    } },
  }
  const operations = Object.fromEntries(['deploy-preview', 'deploy-apply'].map(name => [name, {
    command: executable, inputSchema, fingerprintPaths: [join(root, runnerPath)],
    effects: name === 'deploy-preview' ? ['readsSource', 'startsProcess', 'writesFilesystem', 'externalIO']
      : ['readsSource', 'startsProcess', 'writesFilesystem', 'connectsTarget', 'writesTargetData', 'changesMetadata'],
    args(_inputs, nativeContext) {
      calls.contexts.push(structuredClone(nativeContext.deployContext))
      return core.compileRunnerCommand({ runnerKind: 'agent-1c', operation: name, root, runnerPath,
        profilePath: 'agent-1c.json', pwshPath: executable, deployContext: nativeContext.deployContext }).args
    },
  }]))
  const adapter = createDeployProcessAdapter({ ctx, agent: { session }, callId: 'server-fixture-call', id: 'server-runner',
    core, nativeHelpers: helpers, deployment, operations })
  return { adapter, context, deployment, operation, calls, ctx, session, operations }
}

test('server preview uses canonical typed context with no file path or Apply and passes as not-applied', async t => {
  const f = await fixture(t), output = await f.adapter.execute(f.operation, {}, f.context)
  assert.equal(output.data.operation, 'deploy-preview')
  assert.equal(output.data.complete, true)
  assert.equal(output.mutationState, 'not-applied')
  assert.equal(validateDeployEvidence(output.data, f.context).status, 'passed')
  assert.ok(output.data.assertions.some(row => row.id === 'deploy-preview' && row.passed))
  assert.equal(f.calls.confined.length, 1)
  assert.equal(f.calls.spawned.length, 1)
  assert.equal(f.calls.contexts[0].targetKind, 'server')
  assert.equal(f.calls.contexts[0].targetServer, 'cluster.example:1541')
  assert.equal(f.calls.contexts[0].targetRef, 'демо')
  assert.equal(Object.hasOwn(f.calls.contexts[0], 'targetPath'), false)
  assert.ok(f.calls.spawned[0].argv.includes('-WorkflowTargetServer'))
  assert.equal(f.calls.spawned[0].argv.includes('-WorkflowTargetPath'), false)
  assert.equal(f.calls.spawned[0].argv.includes('-Apply'), false)
  assert.equal(f.adapter.descriptor.operations['deploy-preview'].effects.includes('changesMetadata'), false)
  assert.equal(f.adapter.descriptor.operations['deploy-preview'].resourcesRequired, true)
  assert.doesNotMatch(JSON.stringify(output), /DO_NOT_EXPOSE|cluster\.example|демо|targetPath/u)
  core.validateSchema(DEPLOY_RESULT_SCHEMA, output.data)
})

test('server apply uses the same bound target and requires actual application evidence', async t => {
  const f = await fixture(t, { operation: 'deploy-apply' }), output = await f.adapter.execute(f.operation, {}, f.context)
  assert.equal(output.mutationState, 'applied')
  assert.equal(validateDeployEvidence(output.data, f.context).status, 'passed')
  assert.ok(f.calls.spawned[0].argv.includes('-Apply'))
  assert.equal(output.data.targetId, f.deployment.target.id)
  assert.equal(f.calls.contexts[0].targetDigest, f.deployment.targetDigest)
})

test('apply and preview reports cannot substitute for each other even after process exit zero', async t => {
  for (const operation of ['deploy-preview', 'deploy-apply']) {
    const f = await fixture(t, { operation, wrongApply: true }), output = await f.adapter.execute(operation, {}, f.context)
    assert.equal(output.data.process.exitCode, 0)
    assert.equal(output.data.complete, false)
    assert.equal(output.mutationState, 'unknown')
    assert.notEqual(validateDeployEvidence(output.data, f.context).status, 'passed')
    assert.equal(output.data.reason, 'DEPLOY_REPORT_INVALID')
  }
})

test('wrong nonce or target in a fresh preview report remains unconfirmed', async t => {
  for (const patch of [{ wrongNonce: true }, { wrongTarget: true }]) {
    const f = await fixture(t, patch), output = await f.adapter.execute('deploy-preview', {}, f.context)
    assert.equal(output.data.complete, false)
    assert.notEqual(validateDeployEvidence(output.data, f.context).status, 'passed')
    assert.equal(output.data.reason, 'DEPLOY_REPORT_IDENTITY_MISMATCH')
  }
})

test('nonnormalized server context never reaches native spawn or produces PASS', async t => {
  let f
  try { f = await fixture(t, { noncanonical: true }) }
  catch (error) { assert.match(error.code ?? error.message, /DEPLOY_(?:REGISTRATION_INVALID|SERVER_TARGET_INVALID)/u); return }
  const output = await f.adapter.execute('deploy-preview', {}, f.context)
  assert.equal(f.calls.spawned.length, 0)
  assert.notEqual(validateDeployEvidence(output.data, f.context).status, 'passed')
})

test('preview cannot register mutation effects as a supposedly harmless operation', async t => {
  const f = await fixture(t)
  assert.throws(() => createDeployProcessAdapter({ ctx: f.ctx, agent: { session: f.session }, callId: 'bad-preview', id: 'bad-preview', core,
    nativeHelpers: helpers, deployment: f.deployment,
    operations: { 'deploy-preview': { ...f.operations['deploy-preview'], effects: ['readsSource', 'writesTargetData', 'changesMetadata'] } } }), /DEPLOY_EFFECTS_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('server resource cannot substitute a file target, forged digest or another lock identifier', async t => {
  const f = await fixture(t)
  for (const patch of [
    { targetPath: join(f.context.cwd, 'ambiguous-file-target') },
    { targetDigest: 'f'.repeat(64), target: { ...f.deployment.target, id: `onec-${'f'.repeat(64)}` } },
    { target: { ...f.deployment.target, id: 'another-target-lock' } },
  ]) {
    assert.throws(() => createDeployProcessAdapter({ ctx: f.ctx, agent: { session: f.session }, callId: 'forged-resource', id: 'forged-resource', core,
      nativeHelpers: helpers, deployment: { ...f.deployment, ...patch }, operations: f.operations }), /DEPLOY_SERVER_TARGET_INVALID/u)
  }
  assert.equal(f.calls.spawned.length, 0)
})
