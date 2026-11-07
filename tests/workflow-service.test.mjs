import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'
import { createWorkflowService } from '../src/workflow-integration/lib/service.js'
import { workflowSession } from '../src/workflow-integration/lib/session.js'
import { createHandler } from '../src/workflow-integration/lib/control.js'

const runtime = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const script = "param([ValidateSet('doctor','analyze','deploy','test','unit','serve','stop')] [string]$Command='doctor', [string]$Profile, [switch]$Apply, [switch]$Hidden)\nfunction FixtureOnly {}"
const helpers = { scrubbedParentEnv: () => ({ PATH: 'test-native-path' }), classifyRunnerFailure: () => undefined, matchesSignature: () => false }
const runnerBinding = { schemaVersion: 1, kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1',
  profilePath: 'agent-1c.json', sourceKind: 'extension', extensionName: 'Fixture', exactBuild: '8.3.27.1989' }

async function fixture(t, { reviewed = true, missing = false, mode = 'workspace-write', preset = '1c-airules', pending = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-service-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'project'), stateDir = join(temporary, 'state'), pwsh = join(temporary, 'pwsh.exe')
  await mkdir(join(root, 'tools/agent-1c/lib'), { recursive: true }); await mkdir(join(root, 'src')); await mkdir(join(root, '.airules'))
  await writeFile(pwsh, 'fixture executable bytes; NEVER executed')
  await writeFile(join(root, runnerBinding.runnerPath), script)
  await writeFile(join(root, 'src/input.bsl'), '// source fixture')
  for (const file of ['1c-guard.ps1', 'hidden-desktop.ps1']) await writeFile(join(root, 'tools/agent-1c/lib', file), '# fixture guard only')
  await writeFile(join(root, 'tools/agent-1c/toolchain.lock.json'), '{}')
  const profile = { schemaVersion: 1, projectId: 'fixture', sourceDir: 'src', resultDir: 'reports',
    platform: { engine: 'auto', versionPrefix: '8.3.27' }, extension: { name: 'Fixture' },
    testTarget: { kind: 'file', environment: 'test', envFile: '../UNREAD_PRIVATE_CREDENTIALS.env', envSection: 'TEST' },
    unit: { launchParameter: 'RUN_TESTS' }, vanessa: { settings: 'suite.json', features: 'features' } }
  await writeFile(join(root, 'agent-1c.json'), JSON.stringify(profile))
  const binding = { schemaVersion: 1, projectId: 'fixture', providers: { local: { adapterId: 'project-runner' } },
    runners: { 'project-runner': runnerBinding }, sourcePaths: ['src'], configPaths: ['agent-1c.json'],
    workflows: { inspect: { schemaVersion: 1, id: 'inspect', version: '0.1.0', label: 'Проверить проект',
      steps: [{ id: 'doctor', adapter: 'local', operation: 'doctor' }] } } }
  const bindingPath = join(root, '.airules/workflows.json')
  if (!missing) await writeFile(bindingPath, JSON.stringify(binding))
  const session = { id: 'session-a', header: { id: 'session-a', cwd: root, agentPreset: preset } }
  const sessions = new Map([[session.id, session]])
  const calls = { spawned: [], confined: [], readClosed: 0, closed: 0, terminated: 0 }
  let restoredMode = mode
  const ctx = {
    connection: { requestRejection: () => undefined },
    sessions,
    sessionProjections: { stateOf: (s, name) => name === 'agentPreset' ? s.header.agentPreset : undefined,
      restore: (_seed, _events, _seq, header) => ({ checkpoint: { sandboxMode: { val: restoredMode }, agentPreset: { val: header.agentPreset } } }) },
    sandboxPolicy: { defaultMode: 'read-only', resolve: ({ session: current, mode: override } = {}) => ({ mode: override ?? mode,
      workspaceRoot: current.header.cwd, sessionId: current.id }) },
    sandbox: { async confine(argv, policy) { calls.confined.push({ argv, policy }); return { argv: ['sandbox-fixture', '--', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } } },
    subprocess: { spawn(spec) {
      calls.spawned.push(spec)
      const stdout = new PassThrough(), stderr = new PassThrough()
      let finish
      const done = new Promise(resolve => { finish = () => { stdout.end(); stderr.end(); resolve({ exitCode: pending ? null : 0, signal: pending ? 'SIGTERM' : null }) } })
      if (!pending) queueMicrotask(() => { stdout.write('PRIVATE_OUTPUT_MUST_NOT_ESCAPE'); stderr.write('PRIVATE_ERROR_MUST_NOT_ESCAPE'); finish() })
      return { stdout, stderr, done, terminate() { calls.terminated++; finish() }, waitForExit: async () => true }
    } },
    sessionPersistence: {
      async stat(id) { return { header: { id, cwd: root, agentPreset: preset }, eventCount: 1, sizeBytes: 100 } },
      async open(id) { calls.readClosed++; return { header: { id, cwd: root, agentPreset: preset }, inheritedEventCount: 0,
        read: async () => ({ events: [] }), close: async () => { calls.closed++ } } },
    },
  }
  const inspected = await runtime.inspectRunnerBinding({ root, binding: runnerBinding })
  const config = { powerShellPath: pwsh, trustedRunnerDigests: reviewed ? [inspected.closureDigest] : [] }
  const service = createWorkflowService({ ctx, runtime, stateDir, nativeHelpers: helpers, config })
  const scope = await workflowSession(ctx, session.id)
  return { root, stateDir, binding, bindingPath, ctx, session, sessions, calls, service, scope, config,
    setRestoredMode(value) { restoredMode = value },
    execution: { agent: { session }, callId: 'native-service-call', signal: new AbortController().signal } }
}

async function http(handler, { method = 'GET', query = '', body, csrf, accepted = true } = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(request, { method, url: `/airules/workflows${query}`, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-dsh-csrf': csrf } : {}) } })
  let status, text, headers
  await handler(request, { writeHead(value, metadata) { status = value; headers = metadata }, end(value) { text = value } })
  return { status, headers, body: JSON.parse(text) }
}

async function deployFixture(t, outcome = 'pass', options = {}) {
  const f = await fixture(t, options)
  f.binding.runners = { stub: { schemaVersion: 1, kind: 'deploy-fixture', outcome } }
  f.binding.providers = { deploy: { adapterId: 'stub' } }
  f.binding.workflows = { deploy: { schemaVersion: 1, id: 'deploy', version: '0.1.0',
    steps: [{ id: 'apply', adapter: 'deploy', operation: 'deploy-apply', resources: ['stub'], timeoutMs: 1000 }] } }
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  f.ctx.subprocess.spawn = spec => {
    f.calls.spawned.push(spec)
    const argument = key => spec.argv[spec.argv.indexOf(key) + 1]
    const stdout = new PassThrough(), stderr = new PassThrough()
    let doneResolve, exited = false
    const done = new Promise(resolve => { doneResolve = resolve })
    const finish = (exitCode, signal = null) => { exited = true; stdout.end(); stderr.end(); doneResolve({ exitCode, signal }) }
    queueMicrotask(async () => {
      if (options.pending) return
      if (spec.argv.includes('-Recovery')) {
        const root = join(argument('-ResultRoot'), `recovery-${argument('-RecoveryId')}`)
        await mkdir(root, { recursive: true })
        await rm(join(argument('-ResultRoot'), 'simulated-target.json'), { force: true })
        await writeFile(join(root, 'result.json'), JSON.stringify({ schemaVersion: 1, recoveryId: argument('-RecoveryId'),
          runId: argument('-RunId'), restored: true }))
        finish(0); return
      }
      const reportRoot = join(argument('-ResultRoot'), `workflow-${argument('-RunId')}`, argument('-StepId'))
      await mkdir(reportRoot, { recursive: true })
      if (outcome !== 'fail-before') await writeFile(join(argument('-ResultRoot'), 'simulated-target.json'), JSON.stringify({ runId: argument('-RunId'), state: 'partial' }))
      const exitCode = ['partial', 'fail-before'].includes(outcome) ? 2 : 0
      if (outcome !== 'no-report') await writeFile(join(reportRoot, 'result.json'), JSON.stringify({
        schemaVersion: 1, projectId: argument('-ProjectId'), command: 'deploy', apply: true,
        startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), exitCode,
        steps: [{ name: 'deploy.apply', status: exitCode === 0 ? 'ok' : 'error' }],
        workflow: { schemaVersion: 1, runId: argument('-RunId'), stepId: argument('-StepId'),
          sourceDigest: outcome === 'stale' ? 'a'.repeat(64) : argument('-SourceDigest'),
          targetDigest: argument('-TargetDigest'), profileDigest: argument('-ProfileDigest'),
          mutationState: outcome === 'fail-before' ? 'not-applied' : outcome === 'partial' ? 'unknown' : 'applied' },
      }))
      finish(exitCode)
    })
    return { stdout, stderr, done, terminate() { f.calls.terminated++; if (!exited) finish(null, 'SIGTERM') }, waitForExit: async () => exited }
  }
  return f
}

test('deploy fixture passes through native confinement, bound report, resource lock and durable history', async t => {
  const f = await deployFixture(t)
  const status = await f.service.status(f.scope)
  assert.equal(status.execution.deployImplemented, true)
  assert.equal(status.execution.deployEnabled, false)
  assert.equal(status.execution.fixtureEnabled, true)
  assert.equal(status.workflows[0].steps[0].status, 'configured')
  const plan = await f.service.plan(f.scope, 'deploy')
  const args = { planId: plan.id, planDigest: plan.planDigest, requestId: 'fixture-apply' }
  const result = await f.service.run(f.scope, args, f.execution)
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.mutationState, 'applied')
  assert.equal(result.retainedLocks, false)
  assert.match(result.targets[0].id, /^fixture-[a-f0-9]{64}$/u)
  assert.equal(f.calls.confined.length, 1)
  assert.ok(f.calls.spawned[0].argv.some(value => value.endsWith('deploy-fixture.ps1')))
  assert.ok(!f.calls.spawned[0].argv.some(value => /agent-1c\.ps1|1cv8|ibcmd/iu.test(value)))
  assert.equal((await f.service.run(f.scope, args, f.execution)).runId, result.runId)
  assert.equal(f.calls.spawned.length, 1)
  assert.equal((await f.service.result(f.scope, result.runId)).verdict, 'PASS')
})

test('deploy fixture failures distinguish confirmed refusal, partial work, missing and stale evidence', async t => {
  for (const outcome of ['fail-before', 'partial', 'no-report', 'stale']) {
    const f = await deployFixture(t, outcome), plan = await f.service.plan(f.scope, 'deploy')
    const result = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: `case-${outcome}` }, f.execution)
    assert.equal(result.verdict, outcome === 'fail-before' ? 'FAIL' : 'INDETERMINATE', outcome)
    assert.equal(result.mutationState, outcome === 'fail-before' ? 'not-applied' : 'unknown', outcome)
    assert.equal(result.retainedLocks, outcome !== 'fail-before', outcome)
    assert.equal(f.calls.spawned.length, 1)
    if (outcome !== 'fail-before') {
      const retryPlan = await f.service.plan(f.scope, 'deploy')
      const retry = await f.service.run(f.scope, { planId: retryPlan.id, planDigest: retryPlan.planDigest, requestId: 'retry' }, f.execution)
      assert.notEqual(retry.verdict, 'PASS')
      assert.equal(f.calls.spawned.length, 1)
    }
  }
})

test('deploy fixture cannot run with stale sources, wrong resource or disabled machine mode', async t => {
  const f = await deployFixture(t), plan = await f.service.plan(f.scope, 'deploy')
  await writeFile(join(f.root, 'src/input.bsl'), '// changed source')
  const result = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'stale-fixture' }, f.execution)
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(f.calls.spawned.length, 0)
  f.binding.workflows.deploy.steps[0].resources = []
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  await assert.rejects(f.service.plan(f.scope, 'deploy'), /DEPLOY_RESOURCE_REQUIRED/u)
  const disabled = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers,
    config: { ...f.config, deployMode: 'disabled' } })
  assert.equal((await disabled.status(f.scope)).execution.fixtureEnabled, false)
})

test('cancelling deploy fixture terminates only the owned handle and retains uncertain target lock', async t => {
  const f = await deployFixture(t, 'pass', { pending: true }), plan = await f.service.plan(f.scope, 'deploy')
  const run = f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'cancel-deploy' }, f.execution)
  for (let i = 0; i < 100 && !f.calls.spawned.length; i++) await delay(10)
  const [record] = await f.service.runs(f.scope)
  await f.service.cancel(f.scope, record.runId)
  const result = await run
  assert.equal(result.verdict, 'INTERRUPTED')
  assert.equal(result.mutationState, 'unknown')
  assert.equal(result.retainedLocks, true)
  assert.equal(f.calls.terminated, 1)
})

test('real runner adapter is implemented, blocked by default, and executable through a mocked native transport only when enabled', async t => {
  const f = await fixture(t)
  const flags = ['RunId', 'StepId', 'SourceDigest', 'TargetDigest', 'ProfileDigest', 'ExactBuild', 'TargetPath']
    .map(key => `[string]$Workflow${key}`).join(', ')
  await writeFile(join(f.root, runnerBinding.runnerPath), script.replace('[switch]$Hidden)', `[switch]$Hidden, ${flags})`))
  const profilePath = join(f.root, 'agent-1c.json'), profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.testTarget.path = join(f.root, 'stub-database-never-opened')
  await writeFile(profilePath, JSON.stringify(profile))
  f.binding.workflows.inspect.steps = [{ id: 'apply', adapter: 'local', operation: 'deploy-apply', resources: ['project-runner'] }]
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  const inspected = await runtime.inspectRunnerBinding({ root: f.root, binding: runnerBinding })
  const config = { ...f.config, trustedRunnerDigests: [inspected.closureDigest] }
  const blocked = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers, config })
  const blockedStatus = await blocked.status(f.scope)
  assert.equal(blockedStatus.workflows[0].steps[0].reason, 'ACTUAL_DEPLOY_DISABLED')
  const blockedPlan = await blocked.plan(f.scope, 'inspect')
  await assert.rejects(blocked.run(f.scope, { planId: blockedPlan.id, planDigest: blockedPlan.planDigest, requestId: 'not-enabled' }, f.execution), /ACTUAL_DEPLOY_DISABLED/u)
  assert.equal(f.calls.spawned.length, 0)
  f.ctx.subprocess.spawn = spec => {
    f.calls.spawned.push(spec)
    const argument = key => spec.argv[spec.argv.indexOf(key) + 1]
    const stdout = new PassThrough(), stderr = new PassThrough()
    let finish
    const done = new Promise(resolve => { finish = resolve })
    queueMicrotask(async () => {
      const runRoot = join(f.root, 'reports', `workflow-${argument('-WorkflowRunId')}`, argument('-WorkflowStepId'))
      await mkdir(runRoot, { recursive: true })
      await writeFile(join(runRoot, 'result.json'), JSON.stringify({ schemaVersion: 1, projectId: 'fixture', command: 'deploy', apply: true,
        startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), exitCode: 0,
        steps: [{ name: 'deploy.apply', status: 'ok' }], workflow: { schemaVersion: 1,
          runId: argument('-WorkflowRunId'), stepId: argument('-WorkflowStepId'), sourceDigest: argument('-WorkflowSourceDigest'),
          targetDigest: argument('-WorkflowTargetDigest'), profileDigest: argument('-WorkflowProfileDigest'), mutationState: 'applied' } }))
      stdout.end(); stderr.end(); finish({ exitCode: 0, signal: null })
    })
    return { stdout, stderr, done, terminate() {}, waitForExit: async () => true }
  }
  const enabled = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers, config: { ...config, deployMode: 'enabled' } })
  const status = await enabled.status(f.scope)
  assert.equal(status.execution.deployEnabled, true)
  assert.equal(status.workflows[0].steps[0].status, 'configured')
  const plan = await enabled.plan(f.scope, 'inspect')
  const result = await enabled.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'transport-mock-only' }, f.execution)
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.mutationState, 'applied')
  assert.equal(f.calls.spawned.length, 1)
  assert.ok(f.calls.spawned[0].argv.includes('-Apply'))
  assert.equal(result.targets[0].id, status.runnerBindings[0].target.id)
})

test('fixture recovery uses stop receipts and native restore, releases only its lock and survives a broken project binding', async t => {
  const f = await deployFixture(t, 'partial'), plan = await f.service.plan(f.scope, 'deploy')
  const original = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'partial-recovery' }, f.execution)
  const originalBytes = await readFile(join(f.stateDir, 'runs', original.runId, 'result.json'), 'utf8')
  assert.equal(original.retainedLocks, true)
  await writeFile(f.bindingPath, '{broken configuration')
  const view = await f.service.result(f.scope, original.runId)
  assert.equal(view.recoveryOptions[0].id, 'fixture-stub')
  const args = { runId: original.runId, targetId: original.targets[0].id, providerId: 'fixture-stub', requestId: 'recover-once' }
  const receipt = await f.service.recover(f.scope, args, f.execution)
  assert.equal(receipt.phase, 'completed')
  assert.equal(receipt.evidence.outcome, 'restored')
  assert.equal(f.calls.spawned.length, 2)
  assert.ok(f.calls.spawned[1].argv.includes('-Recovery'))
  const recovered = await f.service.result(f.scope, original.runId)
  assert.equal(recovered.verdict, 'INDETERMINATE')
  assert.equal(recovered.mutationState, 'unknown')
  assert.equal(recovered.recoveryState, 'completed')
  assert.equal(recovered.retainedLocks, false)
  assert.equal(await readFile(join(f.stateDir, 'runs', original.runId, 'result.json'), 'utf8'), originalBytes)
  assert.equal((await f.service.recover(f.scope, args, f.execution)).receiptDigest, receipt.receiptDigest)
  assert.equal(f.calls.spawned.length, 2)
  assert.equal((await f.service.runs(f.scope))[0].recoveryState, 'completed')
})

test('fixture recovery refuses foreign sessions and unconfirmed executor termination without invoking restore', async t => {
  const f = await deployFixture(t, 'partial'), plan = await f.service.plan(f.scope, 'deploy')
  const result = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'unsafe-recovery' }, f.execution)
  const args = { runId: result.runId, targetId: result.targets[0].id, providerId: 'fixture-stub', requestId: 'unsafe' }
  await assert.rejects(f.service.recover({ ...f.scope, id: 'other' }, args, f.execution))
  const path = join(f.stateDir, 'execution-receipts', result.runId, 'apply.json')
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...receipt, stopped: false }))
  await assert.rejects(f.service.recover(f.scope, args, f.execution), /RECOVERY_EXECUTOR_STOP_UNCONFIRMED/u)
  assert.equal(f.calls.spawned.length, 1)
  assert.equal((await f.service.result(f.scope, result.runId)).retainedLocks, true)
})

test('server pipeline compiles the bound preview/apply and refuses apply when its required analysis fails', async t => {
  const f = await fixture(t)
  const fields = ['RunId', 'StepId', 'SourceDigest', 'TargetDigest', 'ProfileDigest', 'ExactBuild', 'TargetPath', 'TargetKind', 'TargetServer', 'TargetRef']
    .map(key => `[string]$Workflow${key}`).join(', ')
  await writeFile(join(f.root, runnerBinding.runnerPath), script.replace('[switch]$Hidden)', `[switch]$Hidden, ${fields})`))
  const profilePath = join(f.root, 'agent-1c.json'), profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.testTarget = { kind: 'server', environment: 'test', server: 'fixture-host:1541', ref: 'fixture-base' }
  profile.platform.engine = 'designer'
  await writeFile(profilePath, JSON.stringify(profile))
  f.binding.workflows.inspect.steps = [
    { id: 'doctor', adapter: 'local', operation: 'doctor' },
    { id: 'analyze', adapter: 'local', operation: 'analyze', dependsOn: ['doctor'] },
    { id: 'preview', adapter: 'local', operation: 'deploy-preview', dependsOn: ['analyze'], resources: ['project-runner'] },
    { id: 'apply', adapter: 'local', operation: 'deploy-apply', dependsOn: ['preview'], resources: ['project-runner'] },
  ]
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  const inspected = await runtime.inspectRunnerBinding({ root: f.root, binding: runnerBinding })
  const service = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers,
    config: { ...f.config, trustedRunnerDigests: [inspected.closureDigest], deployMode: 'enabled' } })
  let failAnalysis = true
  f.ctx.subprocess.spawn = spec => {
    f.calls.spawned.push(spec)
    const scriptIndex = spec.argv.findIndex(value => value.endsWith('agent-1c.ps1')), command = spec.argv[scriptIndex + 1]
    const argument = key => spec.argv[spec.argv.indexOf(key) + 1]
    const stdout = new PassThrough(), stderr = new PassThrough()
    let finish
    const done = new Promise(resolve => { finish = resolve })
    queueMicrotask(async () => {
      if (command === 'deploy') {
        assert.equal(argument('-WorkflowTargetKind'), 'server')
        assert.equal(argument('-WorkflowTargetServer'), 'fixture-host:1541')
        const directory = join(f.root, 'reports', `workflow-${argument('-WorkflowRunId')}`, argument('-WorkflowStepId'))
        await mkdir(directory, { recursive: true })
        const apply = spec.argv.includes('-Apply')
        await writeFile(join(directory, 'result.json'), JSON.stringify({ schemaVersion: 1, projectId: 'fixture', command: 'deploy', apply,
          startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), exitCode: 0,
          steps: [{ name: 'deploy.apply', status: apply ? 'ok' : 'dry-run' }], workflow: { schemaVersion: 1,
            runId: argument('-WorkflowRunId'), stepId: argument('-WorkflowStepId'), sourceDigest: argument('-WorkflowSourceDigest'),
            targetDigest: argument('-WorkflowTargetDigest'), profileDigest: argument('-WorkflowProfileDigest'), mutationState: apply ? 'applied' : 'not-applied' } }))
      }
      stdout.end(); stderr.end(); finish({ exitCode: command === 'analyze' && failAnalysis ? 2 : 0, signal: null })
    })
    return { stdout, stderr, done, terminate() {}, waitForExit: async () => true }
  }
  const blockedPlan = await service.plan(f.scope, 'inspect')
  const blocked = await service.run(f.scope, { planId: blockedPlan.id, planDigest: blockedPlan.planDigest, requestId: 'analysis-failed' }, f.execution)
  assert.equal(blocked.verdict, 'FAIL')
  assert.equal(f.calls.spawned.length, 2)
  assert.equal(blocked.steps.find(step => step.id === 'apply').status, 'blocked')
  failAnalysis = false
  const plan = await service.plan(f.scope, 'inspect')
  const applied = await service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'server-mock-pipeline' }, f.execution)
  assert.equal(applied.verdict, 'PASS')
  assert.equal(applied.mutationState, 'applied')
  assert.equal(f.calls.spawned.length, 6)
})

test('status and durable plan inspect reviewed runner bindings without invoking native subprocess or credentials', async t => {
  const f = await fixture(t)
  const status = await f.service.status(f.scope)
  assert.equal(status.configured, true)
  assert.equal(status.execution.deployEnabled, false)
  assert.equal(status.runnerBindings[0].status, 'configured')
  assert.ok(status.runnerBindings[0].operations.find(op => op.id === 'doctor').enabled)
  assert.ok(status.runnerBindings[0].operations.find(op => op.id === 'analyze').enabled)
  const plan = await f.service.plan(f.scope, 'inspect')
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/u)
  assert.equal(f.calls.spawned.length, 0)
  assert.equal(f.calls.confined.length, 0)
  assert.doesNotMatch(JSON.stringify({ status, plan }), /UNREAD_PRIVATE_CREDENTIALS|envSection|PRIVATE_OUTPUT/)
})

test('missing project bindings return an empty status without guessing targets or installing files', async t => {
  const f = await fixture(t, { missing: true })
  const status = await f.service.status(f.scope)
  assert.equal(status.configured, false)
  assert.deepEqual(status.workflows, [])
  assert.deepEqual(status.runnerBindings, [])
  await assert.rejects(f.service.plan(f.scope, 'inspect'), /WORKFLOW_NOT_CONFIGURED/u)
  await assert.rejects(readFile(f.bindingPath), { code: 'ENOENT' })
  assert.equal(f.calls.spawned.length, 0)
})

test('HTTP status is native-gated, plan requires CSRF and write permission, and no HTTP run action exists', async t => {
  const f = await fixture(t), handler = createHandler(f.ctx, f.service)
  const status = await http(handler, { query: '?sessionId=session-a' })
  assert.equal(status.status, 200)
  assert.equal(status.headers['cache-control'], 'no-store')
  const body = { action: 'plan', sessionId: 'session-a', workflowId: 'inspect' }
  assert.equal((await http(handler, { method: 'POST', body })).status, 403)
  const planned = await http(handler, { method: 'POST', body, csrf: status.body.csrfToken })
  assert.equal(planned.status, 200)
  assert.match(planned.body.plan.planDigest, /^[a-f0-9]{64}$/u)
  for (const action of ['run', 'cancel', 'deploy', 'apply']) {
    assert.equal((await http(handler, { method: 'POST', body: { action, sessionId: 'session-a' }, csrf: status.body.csrfToken })).status, 405)
    assert.equal((await http(handler, { query: `?sessionId=session-a&action=${action}` })).status, 405)
  }
  f.ctx.connection.requestRejection = () => 'rejected'
  assert.equal((await http(handler, { query: '?sessionId=session-a' })).status, 403)
  assert.equal(f.calls.spawned.length, 0)
})

test('read-only project scope can inspect but cannot persist or run a plan', async t => {
  const f = await fixture(t, { mode: 'read-only' }), handler = createHandler(f.ctx, f.service)
  const status = await http(handler, { query: '?sessionId=session-a' })
  assert.equal(status.status, 200)
  assert.equal(status.body.writable, false)
  const planned = await http(handler, { method: 'POST', body: { action: 'plan', sessionId: 'session-a', workflowId: 'inspect' }, csrf: status.body.csrfToken })
  assert.equal(planned.status, 400)
  assert.equal(planned.body.error, 'WORKSPACE_WRITE_REQUIRED')
  await assert.rejects(f.service.run(f.scope, {}, f.execution), /ACTIVE_AGENT_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('setup discovery and preview stay read-only, CSRF-gated and available when existing bindings are broken', async t => {
  const f = await fixture(t, { mode: 'read-only' }), handler = createHandler(f.ctx, f.service)
  await writeFile(f.bindingPath, '{broken existing configuration')
  assert.equal((await http(handler, { query: '?sessionId=session-a' })).status, 400)
  const discovered = await http(handler, { query: '?sessionId=session-a&action=setup' })
  assert.equal(discovered.status, 200)
  assert.equal(discovered.body.existingBinding, true)
  assert.equal(discovered.body.candidates[0].id, 'agent-1c')
  const body = { action: 'previewSetup', sessionId: 'session-a', setup: { candidateId: 'agent-1c', exactBuild: '8.3.27.1989' } }
  assert.equal((await http(handler, { method: 'POST', body })).status, 403)
  const preview = await http(handler, { method: 'POST', body, csrf: discovered.body.csrfToken })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.configuration.workflows['static-checks'].steps[0].operation, 'doctor')
  assert.equal(await readFile(f.bindingPath, 'utf8'), '{broken existing configuration')
  assert.equal(f.calls.spawned.length, 0)
  f.ctx.connection.requestRejection = () => 'rejected'
  assert.equal((await http(handler, { query: '?sessionId=session-a&action=setup' })).status, 403)
})

test('settings HTTP saves a ready fixture scenario and enables planning without executing a process', async t => {
  const f = await fixture(t, { missing: true }), handler = createHandler(f.ctx, f.service)
  const discovered = await http(handler, { query: '?action=setup&sessionId=session-a' })
  const body = { action: 'previewSetup', sessionId: 'session-a', setup: { candidateId: 'deploy-fixture' } }
  const preview = await http(handler, { method: 'POST', body, csrf: discovered.body.csrfToken })
  assert.equal(preview.body.revision, null)
  const saving = { ...body, action: 'saveSetup', revision: preview.body.revision }
  assert.equal((await http(handler, { method: 'POST', body: saving })).status, 403)
  const saved = await http(handler, { method: 'POST', body: saving, csrf: discovered.body.csrfToken })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.workflowId, 'deploy-fixture')
  const status = await f.service.status(f.scope)
  assert.equal(status.workflows[0].id, 'deploy-fixture')
  const plan = await f.service.plan(f.scope, saved.body.workflowId)
  assert.equal(plan.steps[0].operation, 'deploy-apply')
  assert.equal(f.calls.spawned.length, 0)
  assert.equal((await http(handler, { method: 'POST', body: saving, csrf: discovered.body.csrfToken })).body.error, 'STALE_BINDING')
})

test('executor mode is explicit, native-persisted and CSRF/write gated without running anything', async t => {
  const f = await fixture(t), persisted = []
  const service = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers, config: f.config,
    onModeChange: async mode => { persisted.push(mode) } })
  const handler = createHandler(f.ctx, service), status = await http(handler, { query: '?sessionId=session-a' })
  const body = { action: 'setMode', sessionId: 'session-a', mode: 'enabled' }
  assert.equal((await http(handler, { method: 'POST', body })).status, 403)
  const saved = await http(handler, { method: 'POST', body, csrf: status.body.csrfToken })
  assert.equal(saved.status, 200)
  assert.deepEqual(persisted, ['enabled'])
  assert.equal((await service.status(f.scope)).execution.deployMode, 'enabled')
  await assert.rejects(service.setMode({ ...f.scope, writable: false }, 'fixture-only'), /WORKSPACE_WRITE_REQUIRED/u)
  await assert.rejects(service.setMode(f.scope, 'arbitrary'), /DEPLOY_MODE_INVALID/u)
  await assert.rejects(f.service.setMode(f.scope, 'enabled'), /MODE_CONFIGURATION_UNAVAILABLE/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('executor mode cannot change while a native run is active', async t => {
  const f = await fixture(t, { pending: true })
  const service = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers,
    config: f.config, onModeChange: async () => assert.fail('must not persist mode during execution') })
  const plan = await service.plan(f.scope, 'inspect')
  const run = service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'mode-busy' }, f.execution)
  for (let i = 0; i < 100 && !f.calls.spawned.length; i++) await delay(10)
  await assert.rejects(service.setMode(f.scope, 'enabled'), /MODE_CHANGE_BUSY/u)
  const [record] = await service.runs(f.scope)
  await service.cancel(f.scope, record.runId)
  await run
})

test('reviewed runner executes only as the owning active agent through native sandbox and never returns raw output', async t => {
  const f = await fixture(t), plan = await f.service.plan(f.scope, 'inspect')
  const result = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'run-once' }, f.execution)
  assert.equal(result.verdict, 'PASS')
  assert.equal(f.calls.spawned.length, 1)
  assert.equal(f.calls.confined.length, 1)
  assert.equal(f.calls.confined[0].policy.sessionId, f.session.id)
  assert.ok(f.calls.confined[0].argv.includes('-File'))
  assert.ok(f.calls.confined[0].argv.includes('doctor'))
  assert.equal(f.calls.confined[0].argv.includes('-Apply'), false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTPUT_MUST_NOT_ESCAPE|PRIVATE_ERROR_MUST_NOT_ESCAPE/)
  assert.equal((await f.service.runs(f.scope)).length, 1)
  assert.equal((await f.service.result(f.scope, result.runId)).verdict, 'PASS')
})

test('unreviewed code closure can be inspected and planned but is refused before native invocation', async t => {
  const f = await fixture(t, { reviewed: false })
  const status = await f.service.status(f.scope)
  assert.equal(status.runnerBindings[0].status, 'needs-review')
  assert.equal(status.runnerBindings[0].operations.find(op => op.id === 'doctor').enabled, false)
  assert.equal(status.workflows[0].steps[0].operation, 'doctor')
  assert.equal(status.workflows[0].steps[0].adapterId, 'project-runner')
  assert.equal(status.workflows[0].steps[0].status, 'needs-review')
  assert.equal(status.workflows[0].steps[0].reason, 'RUNNER_REVIEW_REQUIRED')
  const plan = await f.service.plan(f.scope, 'inspect')
  await assert.rejects(f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'unreviewed' }, f.execution), /RUNNER_REVIEW_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 0)
})

test('runner closure change invalidates an existing plan before invoking any native process', async t => {
  const f = await fixture(t), plan = await f.service.plan(f.scope, 'inspect')
  await writeFile(join(f.root, 'tools/agent-1c/lib/1c-guard.ps1'), '# changed after planning')
  await assert.rejects(f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'unreviewed-change' }, f.execution), /RUNNER_REVIEW_REQUIRED/u)
  const current = await runtime.inspectRunnerBinding({ root: f.root, binding: runnerBinding })
  const reviewed = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers,
    config: { ...f.config, trustedRunnerDigests: [current.closureDigest] } })
  const result = await reviewed.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'stale' }, f.execution)
  assert.equal(result.verdict, 'BLOCKED')
  assert.equal(result.reason, 'STALE_PLAN')
  assert.equal(f.calls.spawned.length, 0)
})

test('test, lifecycle and deploy runners stay disabled even when the profile declares those capabilities', async t => {
  const f = await fixture(t)
  const status = await f.service.status(f.scope), operations = status.runnerBindings[0].operations
  for (const name of ['unit', 'test', 'test-hidden', 'serve', 'stop', 'deploy-preview', 'deploy-apply']) {
    const operation = operations.find(operation => operation.id === name)
    assert.ok(operation)
    assert.equal(operation.enabled, false)
  }
  f.binding.workflows.inspect.steps[0].operation = 'unit'
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  const disabled = await f.service.status(f.scope)
  assert.equal(disabled.workflows[0].steps[0].status, 'disabled')
  assert.equal(disabled.workflows[0].steps[0].reason, 'EXECUTION_NOT_IMPLEMENTED')
  await assert.rejects(f.service.plan(f.scope, 'inspect'))
  assert.equal(f.calls.spawned.length, 0)
})

test('missing PowerShell is reported as an actionable unavailable capability, not configured', async t => {
  const f = await fixture(t)
  const service = createWorkflowService({ ctx: f.ctx, runtime, stateDir: f.stateDir, nativeHelpers: helpers,
    config: { ...f.config, powerShellPath: join(f.root, 'missing-pwsh.exe') } })
  const status = await service.status(f.scope)
  assert.equal(status.runnerBindings[0].status, 'unavailable')
  assert.match(status.runnerBindings[0].message, /PowerShell/u)
  assert.equal(status.workflows[0].steps[0].status, 'unavailable')
  assert.equal(status.workflows[0].steps[0].reason, 'POWERSHELL_NOT_FOUND')
  assert.equal(status.execution.deployImplemented, true)
  assert.equal(status.execution.deployMode, 'fixture-only')
  assert.equal(f.calls.spawned.length, 0)
})

test('history and result ownership are scoped to the originating session even for the same project', async t => {
  const f = await fixture(t), plan = await f.service.plan(f.scope, 'inspect')
  const result = await f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'owned-run' }, f.execution)
  const otherSession = { id: 'session-b', header: { ...f.session.header, id: 'session-b' } }
  f.sessions.set(otherSession.id, otherSession)
  const otherScope = await workflowSession(f.ctx, otherSession.id)
  assert.deepEqual(await f.service.runs(otherScope), [])
  await assert.rejects(f.service.result(otherScope, result.runId))
  await assert.rejects(f.service.run(otherScope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'foreign-run' }, f.execution), /ACTIVE_AGENT_REQUIRED/u)
  assert.equal(f.calls.spawned.length, 1)
})

test('active cancellation is owned by the originating session and terminates only its native handle', async t => {
  const f = await fixture(t, { pending: true }), plan = await f.service.plan(f.scope, 'inspect')
  const run = f.service.run(f.scope, { planId: plan.id, planDigest: plan.planDigest, requestId: 'cancel-owned' }, f.execution)
  for (let i = 0; i < 100 && !f.calls.spawned.length; i++) await delay(10)
  assert.equal(f.calls.spawned.length, 1)
  const runs = await f.service.runs(f.scope)
  assert.equal(runs.length, 1)
  const runId = runs[0].runId
  await assert.rejects(f.service.cancel({ ...f.scope, id: 'foreign-session' }, runId), /RUN_NOT_OWNED_OR_NOT_ACTIVE/u)
  assert.equal(f.calls.terminated, 0)
  assert.equal((await f.service.cancel(f.scope, runId)).cancellationRequested, true)
  const result = await run
  assert.equal(result.verdict, 'INTERRUPTED')
  assert.equal(f.calls.terminated, 1)
})

test('TestEnv unit runner remains metadata-only and cannot be promoted to a check execution', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'scripts'))
  await writeFile(join(f.root, 'scripts/RunUnitTests.ps1'), 'param()\n. "$PSScriptRoot/TestEnv.ps1"')
  await writeFile(join(f.root, 'scripts/TestEnv.ps1'), '# fixture only')
  f.binding.runners = { 'test-env-runner': { schemaVersion: 1, kind: 'test-env', runnerPath: 'scripts/RunUnitTests.ps1' } }
  f.binding.providers.local.adapterId = 'test-env-runner'
  f.binding.workflows.inspect.steps[0].operation = 'unit'
  await writeFile(f.bindingPath, JSON.stringify(f.binding))
  const status = await f.service.status(f.scope)
  assert.equal(status.runnerBindings[0].kind, 'test-env')
  assert.equal(status.runnerBindings[0].operations.find(operation => operation.id === 'unit').enabled, false)
  await assert.rejects(f.service.plan(f.scope, 'inspect'))
  assert.equal(f.calls.spawned.length, 0)
})

test('all three shipped domain presets accept native and closed projected sessions; Standard is rejected', async t => {
  for (const preset of ['1c-airules', 'python-airules', 'sysadmin-airules']) {
    const f = await fixture(t, { preset })
    assert.equal((await workflowSession(f.ctx, f.session.id)).preset, preset)
    f.sessions.delete(f.session.id)
    assert.equal((await workflowSession(f.ctx, f.session.id)).preset, preset)
    assert.equal(f.calls.readClosed, 1)
    assert.equal(f.calls.closed, 1)
    f.setRestoredMode('not-a-mode')
    await assert.rejects(workflowSession(f.ctx, f.session.id), /SANDBOX_PROJECTION_REQUIRED/u)
    assert.equal(f.calls.closed, 2)
    assert.equal(f.calls.spawned.length, 0)
  }
  await assert.rejects(fixture(t, { preset: 'standard' }), /WORKFLOW_SESSION_REQUIRED/u)
})
