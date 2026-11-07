import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSetup, previewSetup } from '../src/workflow-integration/lib/setup.js'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'

const runtime = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const runner = "param([ValidateSet('doctor','analyze','deploy')] [string]$Command='doctor', [string]$Profile, [switch]$Apply)\nfunction FixtureOnly {}"
async function fixture(t, { prefix = '8.3.27', existing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'tools/agent-1c/lib'), { recursive: true }); await mkdir(join(root, 'src'))
  await writeFile(join(root, 'tools/agent-1c/agent-1c.ps1'), runner)
  await writeFile(join(root, 'tools/agent-1c/lib/1c-guard.ps1'), '# fixture only')
  await writeFile(join(root, 'tools/agent-1c/toolchain.lock.json'), '{}')
  const profile = { schemaVersion: 1, projectId: 'fixture', sourceDir: 'src', resultDir: 'reports',
    platform: { engine: 'auto', versionPrefix: prefix }, extension: { name: 'Fixture' },
    testTarget: { kind: 'file', environment: 'test', envFile: '../private.env', envSection: 'PRIVATE' } }
  await writeFile(join(root, 'agent-1c.json'), JSON.stringify(profile))
  if (existing) { await mkdir(join(root, '.airules')); await writeFile(join(root, '.airules/workflows.json'), 'DO_NOT_READ_OR_OVERWRITE') }
  const reads = [], core = { ...runtime, async safeRead(root, path, limit) { reads.push(path); return runtime.safeRead(root, path, limit) } }
  return { root, scope: { root }, profile, core, reads }
}

test('discovery is fixed-path, read-only and never invents exact build from prefix', async t => {
  const f = await fixture(t)
  const before = await readdir(f.root, { recursive: true })
  const result = await discoverSetup(f.scope, f.core)
  assert.equal(result.bindingPath, '.airules/workflows.json')
  assert.equal(result.existingBinding, false)
  assert.equal(result.candidates.length, 2)
  assert.equal(result.candidates[0].sourceKind, 'extension')
  assert.equal(result.candidates[0].extensionName, 'Fixture')
  assert.deepEqual(result.candidates[0].sourcePaths, ['src'])
  assert.equal(result.candidates[0].exactBuild, undefined)
  assert.deepEqual(result.candidates[0].missingFields, ['exactBuild'])
  assert.ok(f.reads.every(path => /(?:agent-1c\.ps1|agent-1c\.json)$/u.test(path)))
  assert.deepEqual(await readdir(f.root, { recursive: true }), before)
})

test('full build metadata may prefill draft but never claims platform verified', async t => {
  const f = await fixture(t, { prefix: '8.3.27.1989' })
  const result = await discoverSetup(f.scope, f.core)
  assert.equal(result.candidates[0].exactBuild, '8.3.27.1989')
  const preview = await previewSetup(f.scope, f.core, { candidateId: 'agent-1c' })
  assert.equal(preview.configuration.runners['runner-onec'].exactBuild, '8.3.27.1989')
  assert.ok(preview.notes.some(text => text.includes('не проверены')))
})

test('preview yields valid static checks and preserves existing bindings without reading them', async t => {
  const f = await fixture(t, { existing: true })
  const path = join(f.root, '.airules/workflows.json')
  const before = await readFile(path, 'utf8')
  const result = await previewSetup(f.scope, f.core, { candidateId: 'agent-1c', exactBuild: '8.3.27.1989', sourcePath: 'src' })
  assert.equal(result.existingBinding, true)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.ok(f.reads.every(read => !read.endsWith('workflows.json') && !read.endsWith('.env')))
  const workflow = result.configuration.workflows['static-checks']
  const { label, ...contract } = workflow
  runtime.validateWorkflow(contract)
  assert.deepEqual(workflow.steps.map(step => step.operation), ['doctor', 'analyze'])
  assert.deepEqual(workflow.steps[1].dependsOn, ['doctor'])
  assert.equal(result.configuration.runners['runner-onec'].extensionName, 'Fixture')
  assert.equal(result.inspection.closureDigest.length, 64)
  assert.ok(result.notes[0].includes('сохранятся'))
})

test('deploy preview prepares dependent checks and apply with the real profile project identity and a computed target resource', async t => {
  const f = await fixture(t, { prefix: '8.3.27.1989', existing: true })
  const flags = ['RunId', 'StepId', 'SourceDigest', 'TargetDigest', 'ProfileDigest', 'ExactBuild', 'TargetPath'].map(key => `[string]$Workflow${key}`).join(', ')
  await writeFile(join(f.root, 'tools/agent-1c/agent-1c.ps1'), runner.replace('[switch]$Apply)', `[switch]$Apply, ${flags})`))
  f.profile.testTarget.path = join(f.root, 'test-database-not-opened')
  await writeFile(join(f.root, 'agent-1c.json'), JSON.stringify(f.profile))
  const before = await readFile(join(f.root, '.airules/workflows.json'), 'utf8')
  const result = await previewSetup(f.scope, f.core, { candidateId: 'agent-1c', scenario: 'deploy' })
  const workflow = result.configuration.workflows['checked-deploy']
  assert.equal(result.configuration.projectId, 'fixture')
  assert.deepEqual(workflow.steps.map(step => step.operation), ['doctor', 'analyze', 'deploy-preview', 'deploy-apply'])
  assert.deepEqual(workflow.steps[2].dependsOn, ['doctor', 'analyze'])
  assert.deepEqual(workflow.steps[3].dependsOn, ['preview'])
  assert.deepEqual(workflow.steps[2].resources, ['runner-onec'])
  const { label: _label, ...contract } = workflow
  runtime.validateWorkflow(contract)
  assert.match(result.inspection.target.id, /^onec-[a-f0-9]{64}$/u)
  assert.equal(result.inspection.target.kind, 'file')
  assert.equal(result.inspection.target.environment, 'test')
  assert.doesNotMatch(JSON.stringify(result), /test-database-not-opened|private\.env|PRIVATE/u)
  assert.equal(await readFile(join(f.root, '.airules/workflows.json'), 'utf8'), before)
  assert.ok(f.reads.every(path => !path.endsWith('.env')))
})

test('deploy setup rejects unsupported protocol and unknown scenario instead of producing an unusable apply step', async t => {
  const f = await fixture(t, { prefix: '8.3.27.1989' })
  await assert.rejects(previewSetup(f.scope, f.core, { candidateId: 'agent-1c', scenario: 'deploy' }), /DEPLOY_PROTOCOL_REQUIRED/u)
  await assert.rejects(previewSetup(f.scope, f.core, { candidateId: 'agent-1c', scenario: 'arbitrary-shell' }), /SETUP_SCENARIO_INVALID/u)
})

test('server deployment draft exposes only target class and identity, never endpoint or credential references', async t => {
  const f = await fixture(t, { prefix: '8.3.27.1989' })
  const flags = ['RunId', 'StepId', 'SourceDigest', 'TargetDigest', 'ProfileDigest', 'ExactBuild', 'TargetPath'].map(key => `[string]$Workflow${key}`).join(', ')
  await writeFile(join(f.root, 'tools/agent-1c/agent-1c.ps1'), runner.replace('[switch]$Apply)', `[switch]$Apply, ${flags})`))
  f.profile.testTarget = { kind: 'server', environment: 'test', server: 'PRIVATE_SERVER', ref: 'PRIVATE_DATABASE', envFile: '../PRIVATE.env' }
  await writeFile(join(f.root, 'agent-1c.json'), JSON.stringify(f.profile))
  const core = { ...f.core, async inspectDeployBinding({ root, binding }) {
    const info = await f.core.inspectRunnerBinding({ root, binding })
    return { projectId: 'fixture', profileDigest: info.profile.digest, target: { id: `onec-${'a'.repeat(64)}`, kind: 'server', environment: 'test' } }
  } }
  const discovery = await discoverSetup(f.scope, core)
  assert.deepEqual(discovery.candidates[0].target, { kind: 'server', environment: 'test' })
  const result = await previewSetup(f.scope, core, { candidateId: 'agent-1c', scenario: 'deploy' })
  assert.equal(result.inspection.target.kind, 'server')
  assert.doesNotMatch(JSON.stringify({ discovery, result }), /PRIVATE_SERVER|PRIVATE_DATABASE|PRIVATE\.env/u)
})

test('setup rejects missing facts, unknown fields, path escape and mismatched source snapshot', async t => {
  const f = await fixture(t)
  for (const [setup, code] of [
    [{ candidateId: 'agent-1c' }, 'EXACT_BUILD_REQUIRED'],
    [{ candidateId: 'unknown' }, 'SETUP_RUNNER_NOT_FOUND'],
    [{ candidateId: 'agent-1c', password: 'synthetic-rejected-field' }, 'SETUP_FIELDS_REJECTED'],
    [{ candidateId: 'agent-1c', exactBuild: '8.3.27.1989', sourcePath: '../escape' }, 'SOURCE_PATH_REQUIRED'],
    [{ candidateId: 'agent-1c', exactBuild: '8.3.27.1989', sourcePath: '.env' }, 'SOURCE_PATH_REQUIRED'],
    [{ candidateId: 'agent-1c', exactBuild: '8.3.27.1989', sourcePath: 'other' }, 'SOURCE_PATH_PROFILE_MISMATCH'],
  ]) await assert.rejects(previewSetup(f.scope, f.core, setup), error => error.code === code)
})

test('inline credentials never appear in discovery or errors', async t => {
  const f = await fixture(t)
  const secret = 'SYNTHETIC_VALUE_MUST_NOT_ESCAPE'
  f.profile.testTarget.password = secret // airules:allow creds-password — synthetic rejection fixture
  await writeFile(join(f.root, 'agent-1c.json'), JSON.stringify(f.profile))
  const discovery = await discoverSetup(f.scope, f.core)
  assert.equal(discovery.candidates[0].error, 'INLINE_CREDENTIALS_NOT_SUPPORTED')
  assert.equal(JSON.stringify(discovery).includes(secret), false)
  await assert.rejects(previewSetup(f.scope, f.core, { candidateId: 'agent-1c', exactBuild: '8.3.27.1989' }),
    error => error.code === 'INLINE_CREDENTIALS_NOT_SUPPORTED' && !error.message.includes(secret))
})

test('TestEnv discovered without execution; preview does not manufacture runnable checks', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'scripts'))
  await writeFile(join(f.root, 'scripts/RunUnitTests.ps1'), '# never execute')
  const result = await previewSetup(f.scope, f.core, { candidateId: 'test-env' })
  assert.equal(result.configuration, null)
  assert.ok(result.notes.some(text => text.includes('изменяет тестовую базу')))
})

test('malformed and oversized profiles are unavailable without echoing raw content', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'agent-1c.json'), '{ DO_NOT_ECHO')
  let result = await discoverSetup(f.scope, f.core)
  assert.equal(result.candidates[0].error, 'PROFILE_JSON_INVALID')
  assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false)
  await writeFile(join(f.root, 'agent-1c.json'), 'x'.repeat(512 * 1024 + 1))
  result = await discoverSetup(f.scope, f.core)
  assert.equal(result.candidates[0].reviewStatus, 'unavailable')
})

test('symlink runner path is rejected instead of followed', async t => {
  const f = await fixture(t)
  await rm(join(f.root, 'tools/agent-1c/agent-1c.ps1'))
  const external = join(f.root, 'outside.ps1')
  await writeFile(external, runner)
  try { await symlink(external, join(f.root, 'tools/agent-1c/agent-1c.ps1'), 'file') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink privilege unavailable'); throw error }
  const result = await discoverSetup(f.scope, f.core)
  assert.equal(result.candidates[0].error, 'SYMLINK_INPUT')
})

test('absolute sourceDir cannot silently snapshot a different user-supplied directory', async t => {
  const f = await fixture(t)
  f.profile.sourceDir = f.root
  await writeFile(join(f.root, 'agent-1c.json'), JSON.stringify(f.profile))
  await assert.rejects(previewSetup(f.scope, f.core, { candidateId: 'agent-1c', exactBuild: '8.3.27.1989', sourcePath: 'src' }),
    error => error.code === 'PROFILE_SOURCE_PATH_REQUIRED')
})

test('profile changes during preview invalidate configuration instead of mixing facts', async t => {
  const f = await fixture(t)
  const core = { ...f.core, async inspectRunnerBinding(input) {
    await writeFile(join(f.root, 'agent-1c.json'), JSON.stringify({ ...f.profile, resultDir: 'other-reports' }))
    return runtime.inspectRunnerBinding(input)
  } }
  await assert.rejects(previewSetup(f.scope, core, { candidateId: 'agent-1c', exactBuild: '8.3.27.1989' }),
    error => error.code === 'PROFILE_CHANGED_DURING_SETUP')
})

test('built-in deploy fixture is available without 1C files and preview never inspects profiles or runners', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-empty-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const discovery = await discoverSetup({ root }, runtime)
  assert.deepEqual(discovery.candidates, [{ id: 'deploy-fixture', kind: 'deploy-fixture', sourcePaths: [], missingFields: [], reviewStatus: 'configured' }])
  const core = { ...runtime, safeRead: () => assert.fail('fixture must not read a profile or runner'),
    inspectRunnerBinding: () => assert.fail('fixture must not inspect a project runner') }
  const result = await previewSetup({ root }, core, { candidateId: 'deploy-fixture' })
  assert.equal(result.existingBinding, false)
  assert.deepEqual(await readdir(root), [])
  assert.equal(result.configuration.runners['deploy-stub'].kind, 'deploy-fixture')
  assert.equal(result.configuration.runners['deploy-stub'].outcome, 'pass')
  assert.deepEqual(result.configuration.sourcePaths, [])
  assert.deepEqual(result.configuration.configPaths, [])
  const { label, ...contract } = result.configuration.workflows['deploy-fixture']
  runtime.validateWorkflow(contract)
  assert.equal(contract.steps[0].operation, 'deploy-apply')
  assert.deepEqual(contract.steps[0].resources, ['deploy-stub'])
  assert.deepEqual(result.configuration.providers, { deploy: { adapterId: 'deploy-stub' } })
  assert.ok(result.notes.some(note => note.includes('не доказывает готовность реального деплоя')))
  assert.doesNotMatch(JSON.stringify(result.configuration), /profilePath|runnerPath|exactBuild|password|envFile/u)
})

test('fixture preview preserves existing binding and accepts no real runner facts or custom outcomes', async t => {
  const f = await fixture(t, { existing: true })
  const path = join(f.root, '.airules/workflows.json'), before = await readFile(path, 'utf8')
  const result = await previewSetup(f.scope, f.core, { candidateId: 'deploy-fixture' })
  assert.equal(result.existingBinding, true)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.match(result.notes[0], /Действующие сценарии сохранятся|объединить/u)
  assert.deepEqual(f.reads, [])
  for (const extra of [{ exactBuild: '8.3.27.1989' }, { sourcePath: 'src' }, { outcome: 'fail' }]) {
    await assert.rejects(previewSetup(f.scope, f.core, { candidateId: 'deploy-fixture', ...extra }), error => error.code === 'SETUP_FIELDS_REJECTED')
  }
})
