import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpecializedService, classifyChange } from '../src/onec-specialized/lib/core.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const DRIVER = `import{readFile,writeFile}from'node:fs/promises';import{dirname,join}from'node:path';
const a=process.argv.slice(2),p=a[a.indexOf('--request')+1],o=a[a.indexOf('--result')+1],r=JSON.parse(await readFile(p,'utf8'));
if(r.operation==='diff')process.exit(7);
if(r.operation==='lock'||r.operation==='update')await new Promise(ok=>setTimeout(ok,1000));
if(r.operation==='commit')await writeFile(join(dirname(p),'fixture-state.json'),JSON.stringify({fixture:true,operation:r.operation,objects:r.parameters.explicitObjectList}));
await writeFile(o,JSON.stringify({schemaVersion:1,runId:r.operation==='history'?'wrong-run':r.runId,planDigest:r.planDigest,requestDigest:r.requestDigest,domain:r.domain,operation:r.operation,fixture:r.fixture,complete:true,assertions:[{id:'fixture.protocol',passed:true}]}));
`
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'onec-specialized-test-'))
  await mkdir(join(root, '.dsh')); await mkdir(join(root, 'tools/onec-specialized'), { recursive: true })
  await writeFile(join(root, 'tools/onec-specialized/runner.mjs'), DRIVER)
  const config = { schemaVersion: 1, repository: { allowForce: false, runner: { protocolVersion: 1, kind: 'node', path: 'tools/onec-specialized/runner.mjs', sha256: sha(DRIVER), fixture: true,
    operations: ['status', 'history', 'diff', 'lock', 'update', 'commit', 'unlock'], writeOperations: ['lock', 'update', 'commit', 'unlock'], timeoutMs: 5000 } } }
  const save = () => writeFile(join(root, '.dsh/onec-specialized.json'), JSON.stringify(config))
  await save()
  return { root, config, save }
}
// An actual subprocess proves the protocol and cancellation contract. The
// product plugin separately supplies the existing native workflow adapter.
function executeFixture({ projectRoot, runner, requestPath, resultPath, signal, timeoutMs }) {
  return new Promise((done, reject) => {
    let aborted = signal.aborted, timedOut = false
    const child = spawn(process.execPath, [join(projectRoot, runner.path), '--request', requestPath, '--result', resultPath], { cwd: projectRoot, shell: false, stdio: 'ignore' })
    const abort = () => { aborted = true; child.kill() }
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', reject)
    child.once('close', (exitCode, exitSignal) => { clearTimeout(timer); signal.removeEventListener('abort', abort); done({ exitCode, signal: exitSignal, aborted, timedOut, terminationConfirmed: true, outputLimitExceeded: false, startError: null }) })
  })
}
test('three-way classifier handles deletion, conflict and missing baseline conservatively', () => {
  assert.equal(classifyChange(undefined, 'vendor', 'baseline', true), 'twice-changed')
  assert.equal(classifyChange('old', undefined, 'old', true), 'vendor-only')
  assert.equal(classifyChange('local', 'old', 'old', true), 'local-only')
  assert.equal(classifyChange('a', 'b', undefined, false), 'twice-changed')
})
test('explicit runner trust, byte CAS, object list and force controls fail before process', async () => {
  const f = await fixture(); let calls = 0
  try {
    const service = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [sha(DRIVER)], executeProcess: async () => { calls++; throw new Error('UNREACHABLE') }, authorize: async () => true })
    for (const objects of [[], ['*'], ['Конфигурация', 'Документ.Заказ'], ['Документ.Заказ;Start-Process']]) await assert.rejects(service.plan({ domain: 'repository', operation: 'lock', objects }), /EXPLICIT_OBJECTS|ROOT_OBJECT/)
    await assert.rejects(service.plan({ domain: 'repository', operation: 'commit', objects: ['Документ.Заказ'] }), /COMMIT_COMMENT/)
    await assert.rejects(service.plan({ domain: 'repository', operation: 'unlock', objects: ['Документ.Заказ'], force: true }), /FORCE_CONFIRMATION/)
    const plan = await service.plan({ domain: 'repository', operation: 'status' })
    f.config.repository.allowForce = true; await f.save()
    await assert.rejects(service.run({ planDigest: plan.planDigest, requestId: 'cas' }), /PLAN_STALE/)
    await writeFile(join(f.root, 'tools/onec-specialized/runner.mjs'), DRIVER + '\n// changed')
    await assert.rejects(service.plan({ domain: 'repository', operation: 'status' }), /RUNNER_DIGEST/)
    assert.equal(calls, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('real fixture runner: invocation binding, nonzero exit, idempotence and inert comment text', async () => {
  const f = await fixture(); let approvals = 0
  try {
    const service = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [sha(DRIVER)], executeProcess: executeFixture, authorize: async ({ plan }) => { if (plan.approvalRequired) approvals++; return true } })
    const plan = await service.plan({ domain: 'repository', operation: 'commit', objects: ['Документ.Заказ'], comment: 'task42; $(Start-Process calc) & whoami' })
    const result = await service.run({ planDigest: plan.planDigest, requestId: 'one' })
    assert.equal(result.status, 'passed'); assert.equal(result.fixture, true); assert.equal(result.projectCertified, false); assert.equal(approvals, 1)
    const request = JSON.parse(await readFile(join(f.root, '.dsh/onec-specialized-runs', result.runId, 'request.json'), 'utf8'))
    assert.equal(request.parameters.comment, 'task42; $(Start-Process calc) & whoami')
    assert.deepEqual(JSON.parse(await readFile(join(f.root, '.dsh/onec-specialized-runs', result.runId, 'fixture-state.json'), 'utf8')), { fixture: true, operation: 'commit', objects: ['Документ.Заказ'] })
    assert.equal((await service.run({ planDigest: plan.planDigest, requestId: 'one' })).runId, result.runId)
    for (const operation of ['history', 'diff']) { const p = await service.plan({ domain: 'repository', operation }); const r = await service.run({ planDigest: p.planDigest, requestId: operation }); assert.equal(r.status, 'failed'); assert.equal(r.lockRetained, false); if (operation === 'history') assert.equal(r.reason, 'SPECIALIZED_REPORT_BINDING_INVALID'); else assert.equal(r.process.exitCode, 7) }
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('project lock, active cancel and timeout wait for actual child termination', async () => {
  const f = await fixture()
  try {
    const service = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [sha(DRIVER)], executeProcess: executeFixture, authorize: async () => true })
    const plan = await service.plan({ domain: 'repository', operation: 'lock', objects: ['Документ.Заказ'] })
    const running = service.run({ planDigest: plan.planDigest, requestId: 'cancelled' })
    let active
    for (let i = 0; i < 50 && !active; i++) { active = (await service.status()).activeRuns[0]; if (!active) await new Promise(ok => setTimeout(ok, 5)) }
    assert.ok(active)
    await assert.rejects(service.run({ planDigest: plan.planDigest, requestId: 'parallel' }), /PROJECT_BUSY/)
    assert.equal((await service.cancel({ runId: active.runId })).terminationConfirmed, false)
    const result = await running
    assert.equal(result.status, 'cancelled'); assert.equal(result.terminationConfirmed, true); assert.equal(result.lockRetained, false)
    f.config.repository.runner.timeoutMs = 100; await f.save()
    const timeoutPlan = await service.plan({ domain: 'repository', operation: 'update', objects: ['Документ.Заказ'] })
    const timed = await service.run({ planDigest: timeoutPlan.planDigest, requestId: 'timeout' })
    assert.equal(timed.status, 'timed-out'); assert.equal(timed.terminationConfirmed, true); assert.equal(timed.lockRetained, false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('local source comparison is real, bounded and refreshes CAS after a new file', async () => {
  const f = await fixture()
  try {
    for (const [name, text] of [['current', 'local'], ['vendor', 'upstream'], ['baseline', 'original']]) { await mkdir(join(f.root, name, 'CommonModules'), { recursive: true }); await writeFile(join(f.root, name, 'CommonModules/Test.xml'), text) }
    f.config.aiMerge = { current: 'current', vendor: 'vendor', baseline: 'baseline' }; await f.save()
    const service = await createSpecializedService({ projectRoot: f.root })
    const difference = await service.diff(); assert.equal(difference.objects[0].classification, 'twice-changed')
    const plan = await service.plan({ domain: 'ai-merge', operation: 'cfe-plan' }); assert.equal(plan.execution, 'local-plan-only'); assert.equal(plan.recommendations.length, 1)
    await writeFile(join(f.root, 'vendor/CommonModules/New.xml'), 'new')
    await assert.rejects(service.validatePlan({ planDigest: plan.planDigest }), /PLAN_STALE/)
    f.config.aiMerge.current = '../escape'; await f.save()
    await assert.rejects(service.status(), /PATH_INVALID/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('missing trust, native permission denial and symlink inputs never invoke runner', async () => {
  const f = await fixture(); let calls = 0
  try {
    const untrusted = await createSpecializedService({ projectRoot: f.root, executeProcess: async () => { calls++ }, authorize: async () => true })
    const p = await untrusted.plan({ domain: 'repository', operation: 'status' })
    assert.equal(p.execution, 'needs-runner-review')
    await assert.rejects(untrusted.run({ planDigest: p.planDigest, requestId: 'untrusted' }), /REVIEW_REQUIRED/)
    const denied = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [sha(DRIVER)], executeProcess: async () => { calls++ }, authorize: async () => false })
    const q = await denied.plan({ domain: 'repository', operation: 'status' })
    await assert.rejects(denied.run({ planDigest: q.planDigest, requestId: 'denied' }), /NATIVE_PERMISSION/)
    assert.equal(calls, 0)
    await mkdir(join(f.root, 'real')); await writeFile(join(f.root, 'real/Test.xml'), 'x')
    await symlink(join(f.root, 'real'), join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    f.config.aiMerge = { current: 'linked', vendor: 'real' }; await f.save()
    await assert.rejects(denied.diff(), /LINK_REFUSED/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('v8unpack never overwrites input or an existing output', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'artifacts')); await writeFile(join(f.root, 'artifacts/input.cf'), 'binary-fixture')
    f.config.v8unpack = { input: 'artifacts/input.cf', output: 'artifacts/input.cf' }; await f.save()
    const service = await createSpecializedService({ projectRoot: f.root })
    await assert.rejects(service.plan({ domain: 'v8unpack', operation: 'unpack' }), /IN_PLACE/)
    f.config.v8unpack.output = 'artifacts/existing'; await mkdir(join(f.root, 'artifacts/existing')); await f.save()
    await assert.rejects(service.plan({ domain: 'v8unpack', operation: 'unpack' }), /OUTPUT_MUST_NOT_EXIST/)
    assert.equal((await readFile(join(f.root, 'artifacts/input.cf'), 'utf8')), 'binary-fixture')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('failed real write leaves durable canonical-project guard across sessions and process restart', async () => {
  const f = await fixture(), privateState = await mkdtemp(join(tmpdir(), 'onec-reconciliation-'))
  const failedDriver = DRIVER.replace("if(r.operation==='diff')process.exit(7);", "if(r.operation==='commit')process.exit(7);")
  let calls = 0
  try {
    f.config.repository.runner.fixture = false; f.config.repository.runner.sha256 = sha(failedDriver)
    await writeFile(join(f.root, 'tools/onec-specialized/runner.mjs'), failedDriver)
    await mkdir(join(f.root, 'artifacts')); await writeFile(join(f.root, 'artifacts/history.json'), JSON.stringify({ records: [{ version: 42, state: 'unknown' }] }))
    f.config.repository.reports = { history: 'artifacts/history.json' }; await f.save()
    const options = { projectRoot: f.root, reconciliationRoot: privateState, trustedRunnerDigests: [sha(failedDriver)], executeProcess: async args => { calls++; return executeFixture(args) }, authorize: async () => true }
    const first = await createSpecializedService(options), args = { domain: 'repository', operation: 'commit', objects: ['Документ.Заказ'], comment: 'task42 guarded fixture' }
    const plan = await first.plan(args), result = await first.run({ planDigest: plan.planDigest, requestId: 'failed-write' })
    assert.equal(result.status, 'failed'); assert.equal(result.terminationConfirmed, true); assert.equal(result.reconciliationRequired, true); assert.equal(result.lockRetained, true)
    const second = await createSpecializedService({ ...options, projectRoot: process.platform === 'win32' ? f.root.toUpperCase() : f.root })
    assert.equal((await second.status()).reconciliation.required, true)
    assert.equal((await second.history()).records[0].version, 42)
    const blocked = await second.plan(args); assert.equal(blocked.execution, 'blocked-reconciliation')
    await assert.rejects(second.run({ planDigest: blocked.planDigest, requestId: 'blind-repeat' }), /RECONCILIATION_REQUIRED/)
    const read = await second.plan({ domain: 'repository', operation: 'status' })
    assert.equal((await second.run({ planDigest: read.planDigest, requestId: 'read-only-live-status' })).status, 'passed')
    assert.equal((await second.status()).reconciliation.required, true)
    assert.equal(calls, 2)
    const moduleUrl = new URL('../src/onec-specialized/lib/core.mjs', import.meta.url).href
    const code = `import{createSpecializedService}from${JSON.stringify(moduleUrl)};const s=await createSpecializedService(${JSON.stringify({ projectRoot: f.root, reconciliationRoot: privateState })});console.log(JSON.stringify((await s.status()).reconciliation));`
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])
    assert.equal(JSON.parse(stdout).required, true)
    // Relabelling a production binding as fixture cannot clear a real guard.
    f.config.repository.runner.fixture = true; await f.save()
    const fixtureLabel = await second.plan(args)
    await assert.rejects(second.run({ planDigest: fixtureLabel.planDigest, requestId: 'fixture-label-bypass' }), /RECONCILIATION_REQUIRED/)
    const files = await readdir(privateState); assert.equal(files.length, 1)
    await writeFile(join(privateState, files[0]), 'broken-record')
    assert.equal((await second.status()).reconciliation.code, 'SPECIALIZED_RECONCILIATION_RECORD_UNAVAILABLE')
    const corrupt = await second.plan(args)
    await assert.rejects(second.run({ planDigest: corrupt.planDigest, requestId: 'corrupt-record-bypass' }), /RECONCILIATION_RECORD_UNAVAILABLE/)
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(privateState, { recursive: true, force: true }) }
})
test('only a successful confirmed real invocation clears its own durable guard', async () => {
  const f = await fixture(), privateState = await mkdtemp(join(tmpdir(), 'onec-reconciliation-'))
  try {
    f.config.repository.runner.fixture = false; await f.save()
    const options = { projectRoot: f.root, reconciliationRoot: privateState, trustedRunnerDigests: [sha(DRIVER)], executeProcess: executeFixture, authorize: async () => true }
    const service = await createSpecializedService(options), args = { domain: 'repository', operation: 'commit', objects: ['Документ.Заказ'], comment: 'task42 successful fixture' }
    const plan = await service.plan(args), passed = await service.run({ planDigest: plan.planDigest, requestId: 'success' })
    assert.equal(passed.status, 'passed'); assert.equal(passed.reconciliationRequired, false)
    assert.equal((await service.status()).reconciliation.required, false); assert.equal((await readdir(privateState)).length, 0)
    const changedOwner = await createSpecializedService({ ...options, executeProcess: async input => {
      const output = await executeFixture(input), files = await readdir(privateState), file = join(privateState, files[0])
      const record = JSON.parse(await readFile(file, 'utf8')); record.runId = '11111111-1111-4111-8111-111111111111'; await writeFile(file, JSON.stringify(record))
      return output
    } })
    const secondPlan = await changedOwner.plan(args), protectedResult = await changedOwner.run({ planDigest: secondPlan.planDigest, requestId: 'foreign-owner' })
    assert.equal(protectedResult.status, 'failed'); assert.equal(protectedResult.reconciliationRequired, true)
    assert.equal((await changedOwner.status()).reconciliation.runId, '11111111-1111-4111-8111-111111111111')
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(privateState, { recursive: true, force: true }) }
})
test('cancelled and termination-uncertain real repository writes retain reconciliation state', async () => {
  for (const mode of ['cancelled', 'uncertain']) {
    const f = await fixture(), privateState = await mkdtemp(join(tmpdir(), 'onec-reconciliation-'))
    try {
      f.config.repository.runner.fixture = false; await f.save()
      const options = { projectRoot: f.root, reconciliationRoot: privateState, trustedRunnerDigests: [sha(DRIVER)], authorize: async () => true,
        executeProcess: mode === 'cancelled' ? executeFixture : async () => ({ exitCode: null, signal: null, timedOut: false, aborted: false, outputLimitExceeded: false, stdoutBytes: 0, stderrBytes: 0, startError: null, terminationConfirmed: false }) }
      const service = await createSpecializedService(options), request = { domain: 'repository', operation: 'lock', objects: ['Документ.Заказ'] }
      const plan = await service.plan(request), running = service.run({ planDigest: plan.planDigest, requestId: mode })
      if (mode === 'cancelled') {
        let active
        for (let i = 0; i < 100 && !active; i++) { active = (await service.status()).activeRuns[0]; if (!active) await new Promise(ok => setTimeout(ok, 5)) }
        assert.ok(active)
        const other = await createSpecializedService(options)
        assert.equal((await other.plan(request)).execution, 'blocked-reconciliation')
        assert.equal((await service.cancel({ runId: active.runId })).terminationConfirmed, false)
      }
      const result = await running
      assert.equal(result.status, mode === 'cancelled' ? 'cancelled' : 'failed')
      assert.equal(result.reconciliationRequired, true); assert.equal(result.lockRetained, true)
      const next = await createSpecializedService(options)
      assert.equal((await next.status()).reconciliation.required, true)
      const files = await readdir(privateState), record = JSON.parse(await readFile(join(privateState, files[0]), 'utf8'))
      assert.equal(record.state, 'reconciliation-required')
    } finally { await rm(f.root, { recursive: true, force: true }); await rm(privateState, { recursive: true, force: true }) }
  }
})
