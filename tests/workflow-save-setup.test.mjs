import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveSetup, bindingRevision } from '../src/workflow-integration/lib/save-setup.js'
import { loadRuntime } from '../src/workflow-integration/lib/runtime.js'

const core = await loadRuntime(new URL('../../project_rules/', import.meta.url))
const setup = { candidateId: 'deploy-fixture' }
async function fixture(t, existing) {
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-save-setup-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'project'), stateDir = join(temporary, 'private-state')
  await mkdir(root); await mkdir(stateDir)
  const bindingPath = join(root, '.airules/workflows.json'), scope = { root, writable: true }
  if (existing) { await mkdir(join(root, '.airules')); await writeFile(bindingPath, JSON.stringify(existing)) }
  let authorizations = 0
  return { root, stateDir, bindingPath, scope,
    get authorizations() { return authorizations },
    async save(options = {}) { return saveSetup({ scope, setup, core, stateDir,
      revision: await bindingRevision(scope, core), authorizeWrite: async () => { authorizations++ }, ...options }) },
    async data() { return JSON.parse(await readFile(bindingPath, 'utf8')) },
  }
}
function existingConfiguration() {
  return { schemaVersion: 1, projectId: 'existing-project', sourcePaths: ['existing-src'], configPaths: ['existing-config.json'],
    inputs: { oldStep: { preserved: true } },
    runners: { 'deploy-stub': { schemaVersion: 1, kind: 'deploy-fixture', outcome: 'partial' } },
    providers: { deploy: { adapterId: 'deploy-stub' } },
    mcpProviders: { retained: { schemaVersion: 1, tool: 'mcp__fixture__read' } },
    workflows: { 'deploy-fixture': { schemaVersion: 1, id: 'deploy-fixture', version: 'old', label: 'Existing scenario',
      steps: [{ id: 'oldStep', adapter: 'deploy', operation: 'deploy-apply', resources: ['deploy-stub'] }] } } }
}

test('settings save creates a fixture scenario with current revision and no runner or platform installation', async t => {
  const f = await fixture(t)
  assert.equal(await bindingRevision(f.scope, core), null)
  const result = await f.save({ revision: null })
  assert.equal(result.saved, true)
  assert.equal(result.workflowId, 'deploy-fixture')
  assert.equal(result.bindingPath, '.airules/workflows.json')
  assert.match(result.revision, /^[a-f0-9]{64}$/u)
  assert.equal(result.revision, await bindingRevision(f.scope, core))
  assert.equal(f.authorizations, 2)
  const data = await f.data()
  assert.equal(data.runners['deploy-stub'].kind, 'deploy-fixture')
  assert.deepEqual(data.workflows['deploy-fixture'].steps[0].resources, ['deploy-stub'])
  assert.deepEqual(await readdir(f.root), ['.airules'])
  assert.deepEqual(await readdir(join(f.root, '.airules')), ['workflows.json'])
  assert.deepEqual(await readdir(f.stateDir), [])
})

test('read-only scope and stale revision cannot create or replace project settings', async t => {
  const f = await fixture(t)
  await assert.rejects(f.save({ scope: { ...f.scope, writable: false }, revision: null }), /SETUP_WRITE_PERMISSION_REQUIRED/u)
  assert.deepEqual(await readdir(f.root), [])
  assert.equal(f.authorizations, 0)
  await f.save({ revision: null })
  const before = await readFile(f.bindingPath, 'utf8')
  await assert.rejects(f.save({ revision: null }), /STALE_BINDING/u)
  assert.equal(await readFile(f.bindingPath, 'utf8'), before)
  await assert.rejects(f.save({ revision: 'invalid-revision' }), /SETUP_WRITE_PERMISSION_REQUIRED/u)
})

test('native permission changes are rechecked before commit and leave existing settings untouched', async t => {
  const f = await fixture(t, existingConfiguration())
  const before = await readFile(f.bindingPath, 'utf8')
  let checks = 0
  await assert.rejects(f.save({ authorizeWrite: async () => {
    if (++checks === 2) throw new Error('WORKSPACE_WRITE_REQUIRED')
  } }), /WORKSPACE_WRITE_REQUIRED/u)
  assert.equal(checks, 2)
  assert.equal(await readFile(f.bindingPath, 'utf8'), before)
  assert.deepEqual(await readdir(join(f.root, '.airules')), ['workflows.json'])
})

test('a concurrent binding change at the final authorization point is preserved by CAS', async t => {
  const f = await fixture(t, existingConfiguration())
  const concurrent = { ...existingConfiguration(), projectId: 'concurrent-project' }
  let checks = 0
  await assert.rejects(f.save({ authorizeWrite: async () => {
    if (++checks === 2) await writeFile(f.bindingPath, JSON.stringify(concurrent))
  } }), /STALE_BINDING/u)
  assert.deepEqual(await f.data(), concurrent)
  assert.deepEqual(await readdir(join(f.root, '.airules')), ['workflows.json'])
})

test('merge preserves existing settings and consistently namespaces runner, provider and workflow collisions', async t => {
  const existing = existingConfiguration(), f = await fixture(t, existing)
  const before = await readFile(f.bindingPath, 'utf8')
  const saved = await f.save(), merged = await f.data()
  assert.equal(merged.projectId, existing.projectId)
  assert.deepEqual(merged.inputs, existing.inputs)
  assert.deepEqual(merged.mcpProviders, existing.mcpProviders)
  assert.deepEqual(merged.sourcePaths, existing.sourcePaths)
  assert.deepEqual(merged.configPaths, existing.configPaths)
  assert.deepEqual(merged.runners['deploy-stub'], existing.runners['deploy-stub'])
  assert.deepEqual(merged.providers.deploy, existing.providers.deploy)
  assert.deepEqual(merged.workflows['deploy-fixture'], existing.workflows['deploy-fixture'])
  assert.notEqual(saved.workflowId, 'deploy-fixture')
  const workflow = merged.workflows[saved.workflowId]
  assert.equal(workflow.id, saved.workflowId)
  const apply = workflow.steps[0], provider = merged.providers[apply.adapter]
  assert.notEqual(apply.adapter, 'deploy')
  assert.notEqual(provider.adapterId, 'deploy-stub')
  assert.equal(merged.runners[provider.adapterId].outcome, 'pass')
  assert.deepEqual(apply.resources, [provider.adapterId])
  const backups = await readdir(join(f.stateDir, 'setup-backups'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(f.stateDir, 'setup-backups', backups[0]), 'utf8'), before)
  const repeated = await f.save(), again = await f.data()
  assert.equal(repeated.workflowId, saved.workflowId)
  assert.deepEqual(again, merged)
  assert.equal(Object.keys(again.runners).length, 2)
  assert.equal(Object.keys(again.providers).length, 2)
  assert.equal(Object.keys(again.workflows).length, 2)
})

test('save refuses a merged configuration exceeding supported limits before replacing the binding', async t => {
  const existing = existingConfiguration()
  existing.runners = Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`runner-${n}`, { schemaVersion: 1, kind: 'deploy-fixture', outcome: 'pass' }]))
  existing.providers = { deploy: { adapterId: 'runner-0' } }
  existing.workflows = { existing: { schemaVersion: 1, id: 'existing', version: '1', steps: [{ id: 'check', adapter: 'deploy', operation: 'deploy-apply', resources: ['runner-0'] }] } }
  const f = await fixture(t, existing), before = await readFile(f.bindingPath, 'utf8')
  await assert.rejects(f.save(), /BINDING_LIMIT/u)
  assert.equal(await readFile(f.bindingPath, 'utf8'), before)
})

test('symlinked settings parent is rejected without writing through it', async t => {
  const f = await fixture(t), outside = join(f.stateDir, 'outside')
  await mkdir(outside)
  try { await symlink(outside, join(f.root, '.airules'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink privilege unavailable'); throw error }
  await assert.rejects(f.save({ revision: null }), /SYMLINK_INPUT|BINDING_PATH_REJECTED/u)
  assert.deepEqual(await readdir(outside), [])
})
