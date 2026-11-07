import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { bundledRunnerTemplate } from '../src/onec-specialized/lib/bridge.mjs'
import { createSpecializedService } from '../src/onec-specialized/lib/core.mjs'
import { executeBridge, validateDriverConfig, verifyRepoOpsText, decodePlatformText, scrubDriverEnvironment } from '../src/onec-specialized/runners/runner.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row)
const ps = process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : '/usr/bin/pwsh'
const STUB_REPO = `param([string]$Operation,[string]$ReportFile,[string]$Objects,[string]$Comment,[int]$TimeoutSeconds,[int]$MaxReportChars)
if($Operation -eq 'history'){Write-Host "Repository operation 'history' completed successfully";exit 0}
if($ReportFile){[System.IO.File]::WriteAllText($ReportFile,"Версия 42",[System.Text.Encoding]::Unicode)}
Write-Host 'password=PRIVATE_FIXTURE_SENTINEL'
Write-Host "Repository operation '$Operation' completed successfully"
exit 0
`
async function setup() {
  const area = await mkdtemp(join(tmpdir(), 'onec-bridge-test-')), root = join(area, 'project')
  await mkdir(join(root, 'tools/onec-specialized'), { recursive: true }); await mkdir(join(root, '.dsh'))
  const template = await bundledRunnerTemplate(); await writeFile(join(root, template.path), template.source)
  await writeFile(join(root, 'tools/repo-ops.ps1'), STUB_REPO)
  return { area, root, template }
}
async function request(f, domain, operation, parameters, driver) {
  const config = { schemaVersion: 1, [domain]: driver }, configData = JSON.stringify(config)
  await writeFile(join(f.root, '.dsh/onec-specialized-driver.json'), configData)
  const runId = randomUUID(), folder = join(f.root, '.dsh/onec-specialized-runs', runId)
  await mkdir(folder, { recursive: true })
  const data = { schemaVersion: 1, runId, planDigest: 'a'.repeat(64), domain, operation, fixture: true, parameters: { ...parameters, driverConfigSha256: sha(configData) }, objects: [], sourceEvidenceDigest: 'b'.repeat(64) }
  data.requestDigest = sha(canonical(data))
  const requestPath = join(folder, 'request.json'), resultPath = join(folder, 'result.json')
  await writeFile(requestPath, JSON.stringify(data))
  return { requestPath, resultPath, folder }
}
test('known repo text parser is strict, bounded and decodes BOM once', () => {
  const marker = Buffer.from("Repository operation 'status' completed successfully\r\n")
  const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Версия 42', 'utf16le')])
  assert.equal(decodePlatformText(text), 'Версия 42')
  assert.equal(verifyRepoOpsText({ operation: 'status', stdout: marker, stderr: Buffer.alloc(0), reportBytes: text }).length, 3)
  assert.throws(() => verifyRepoOpsText({ operation: 'status', stdout: Buffer.from('exit code 0'), stderr: Buffer.alloc(0), reportBytes: text }), /VERDICT_UNKNOWN/)
  assert.throws(() => verifyRepoOpsText({ operation: 'status', stdout: marker, stderr: Buffer.from('Ошибка соединения'), reportBytes: text }), /ERROR_OR_CONFLICT/)
  assert.throws(() => verifyRepoOpsText({ operation: 'status', stdout: marker, stderr: Buffer.alloc(0), reportBytes: Buffer.alloc(0) }), /REPORT_MISSING/)
  assert.throws(() => validateDriverConfig({ schemaVersion: 1, repository: { format: 'unknown' } }), /CONFIG/)
  assert.deepEqual(scrubDriverEnvironment({ PATH: '/bin', PYTHONPATH: '/evil', PYTHONHOME: '/evil', VIRTUAL_ENV: '/evil', TOKEN: 'secret' }), { PATH: '/bin' })
})
test('bundled Node bridge invokes actual isolated PowerShell fixture and never persists raw secrets', async t => {
  if (!await access(ps).then(() => true, () => false)) return t.skip('PowerShell is absent; no actual child-process acceptance claimed')
  const f = await setup()
  try {
    const psSha = sha(await readFile(ps)), driver = { format: 'repo-ops-v1.1-text', scriptPath: 'tools/repo-ops.ps1', scriptSha256: sha(STUB_REPO), powerShellPath: ps, powerShellSha256: psSha }
    const req = await request(f, 'repository', 'status', { explicitObjectList: [], force: false, comment: null }, driver)
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(f.root, f.template.path), '--request', req.requestPath, '--result', req.resultPath], { cwd: f.root, timeout: 20000 })
    assert.equal(stdout, ''); assert.equal(stderr, '')
    const result = JSON.parse(await readFile(req.resultPath, 'utf8'))
    assert.equal(result.complete, true); assert.equal(result.fixture, true); assert.equal(result.assertions.length, 3)
    const summary = await readFile(join(req.folder, 'repository-report-summary.json'), 'utf8')
    assert.ok(!summary.includes('PRIVATE_FIXTURE_SENTINEL')); assert.ok(!summary.includes('Версия'))
    assert.equal(JSON.parse(summary).perObjectResult, 'not-parsed')
    const missing = await request(f, 'repository', 'history', { explicitObjectList: [], force: false, comment: null }, driver)
    await assert.rejects(promisify(execFile)(process.execPath, [join(f.root, f.template.path), '--request', missing.requestPath, '--result', missing.resultPath], { cwd: f.root, timeout: 20000 }))
    assert.equal(await access(missing.resultPath).then(() => true, () => false), false)
  } finally { await rm(f.area, { recursive: true, force: true }) }
})
test('driver config, transitive declared script and interpreter identities participate in trust and CAS', async () => {
  const f = await setup()
  try {
    const interpreter = process.execPath, executableSha = sha(await readFile(interpreter))
    const driver = { schemaVersion: 1, repository: { format: 'repo-ops-v1.1-text', scriptPath: 'tools/repo-ops.ps1', scriptSha256: sha(STUB_REPO), powerShellPath: interpreter, powerShellSha256: executableSha } }
    await writeFile(join(f.root, '.dsh/onec-specialized-driver.json'), JSON.stringify(driver))
    const binding = { schemaVersion: 1, repository: { runner: { protocolVersion: 1, kind: 'node', path: f.template.path, sha256: f.template.sha256, driverConfigPath: f.template.driverConfigPath,
      operations: ['status'], writeOperations: [], fixture: true } } }
    await writeFile(join(f.root, '.dsh/onec-specialized.json'), JSON.stringify(binding))
    const untrusted = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [f.template.sha256], executeProcess: async () => {}, authorize: async () => true })
    const blocked = await untrusted.plan({ domain: 'repository', operation: 'status' })
    assert.equal(blocked.execution, 'needs-driver-review'); assert.ok(blocked.requiredTrustedDigests.includes(sha(STUB_REPO)))
    const trusted = await createSpecializedService({ projectRoot: f.root, trustedRunnerDigests: [f.template.sha256, sha(STUB_REPO), executableSha], executeProcess: async () => {}, authorize: async () => true })
    const plan = await trusted.plan({ domain: 'repository', operation: 'status' })
    assert.equal(plan.execution, 'configured'); assert.ok(plan.driverEvidence.length >= 3)
    driver.repository.dependencies = [{ path: 'tools/helper.ps1', sha256: sha('helper') }]; await writeFile(join(f.root, 'tools/helper.ps1'), 'helper'); await writeFile(join(f.root, '.dsh/onec-specialized-driver.json'), JSON.stringify(driver))
    await assert.rejects(trusted.validatePlan({ planDigest: plan.planDigest }), /PLAN_STALE/)
    const next = await trusted.plan({ domain: 'repository', operation: 'status' }); assert.equal(next.execution, 'needs-driver-review')
    await writeFile(join(f.root, 'tools/helper.ps1'), 'modified-helper')
    await assert.rejects(trusted.plan({ domain: 'repository', operation: 'status' }), /DEPENDENCY_CHANGED/)
    delete driver.repository.dependencies
    binding.repository.runner.fixture = false
    await writeFile(join(f.root, '.dsh/onec-specialized.json'), JSON.stringify(binding))
    await writeFile(join(f.root, '.dsh/onec-specialized-driver.json'), JSON.stringify(driver))
    await assert.rejects(trusted.plan({ domain: 'repository', operation: 'status' }), /ENV_BINDING_REQUIRED/)
    driver.repository.environmentFile = '.dev.env'
    await writeFile(join(f.root, '.dsh/onec-specialized-driver.json'), JSON.stringify(driver))
    await writeFile(join(f.root, '.dev.env'), 'REPOSITORY_PASSWORD=PRIVATE_ENV_FIXTURE_SENTINEL\n')
    const productionPlan = await trusted.plan({ domain: 'repository', operation: 'status' })
    assert.ok(productionPlan.runnerRequest.environmentSha256)
    assert.ok(!JSON.stringify(productionPlan).includes('PRIVATE_ENV_FIXTURE_SENTINEL'))
    await writeFile(join(f.root, '.dev.env'), 'REPOSITORY_PASSWORD=CHANGED_PRIVATE_ENV_FIXTURE\n')
    await assert.rejects(trusted.validatePlan({ planDigest: productionPlan.planDigest }), /PLAN_STALE/)
  } finally { await rm(f.area, { recursive: true, force: true }) }
})
test('v8unpack bridge uses isolated Python argv, fresh cwd and confirmed external module origin', async () => {
  const f = await setup()
  try {
    const externalModule = join(f.area, 'installed/v8unpack/__main__.py'); await mkdir(dirname(externalModule), { recursive: true }); await writeFile(externalModule, '# fake installed module metadata')
    await mkdir(join(f.root, 'artifacts')); await writeFile(join(f.root, 'artifacts/input.cfe'), 'not-a-real-binary-fixture')
    const driver = { format: 'v8unpack-cli', pythonPath: process.execPath, pythonSha256: sha(await readFile(process.execPath)), version: '1.2.6' }
    const req = await request(f, 'v8unpack', 'unpack', { input: 'artifacts/input.cfe', output: 'artifacts/unpacked' }, driver)
    const invocations = []
    await executeBridge({ ...req, root: f.root, processRunner: async call => {
      invocations.push(call)
      assert.equal(call.args[0], '-I'); assert.equal(call.env.PYTHONPATH, undefined); assert.equal(call.env.VIRTUAL_ENV, undefined)
      assert.ok(call.cwd.startsWith(req.folder))
      if (call.args[1] === '-c') return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ version: '1.2.6', origin: externalModule, paths: [dirname(externalModule)] })), stderr: Buffer.alloc(0) }
      assert.deepEqual(call.args.slice(0, 4), ['-I', '-m', 'v8unpack', '-E'])
      assert.deepEqual(call.args.slice(6, 8), ['--processes', '1'])
      await promisify(execFile)(process.execPath, ['-e', "require('fs').mkdirSync(process.argv[1],{recursive:true});require('fs').writeFileSync(require('path').join(process.argv[1],'Configuration.json'),'{}')", call.args[5]], { cwd: call.cwd, env: call.env })
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    } })
    assert.equal(invocations.length, 2)
    assert.equal(JSON.parse(await readFile(req.resultPath, 'utf8')).fixture, true)
    const bad = await request(f, 'v8unpack', 'unpack', { input: 'artifacts/input.cfe', output: 'artifacts/second' }, driver)
    let attempted = 0
    await assert.rejects(executeBridge({ ...bad, root: f.root, processRunner: async () => { attempted++; return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ version: '1.2.6', origin: externalModule, paths: [f.root] })), stderr: Buffer.alloc(0) } } }), /VERSION_UNVERIFIED/)
    assert.equal(attempted, 1)
  } finally { await rm(f.area, { recursive: true, force: true }) }
})
