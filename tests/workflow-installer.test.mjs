import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { policyPackageNames, verifyPolicyArtifact } from '../installer/official-policy/common.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const hash = value => sha(Buffer.from(stable(value)))
const clone = value => JSON.parse(JSON.stringify(value))
const roots = ['core/tools/workflow', 'overlays/1c/tools/workflow-onec', 'overlays/1c/tools/workflow-runners']
const prefix = 'payload/packages/airules-dsh-workflows/'
async function put(path, data) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data) }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-installer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rulepack = join(root, 'rulepack'); const canonicalRoot = join(root, 'canonical')
  await put(join(rulepack, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'test.workflow' },
    source: { dirty: true }, counts: { files: 0, rules: 0, roles: 0, skills: 0 }, mcp: { mode: 'logical-only', logical_roles: [] } }))
  for (const dir of roots) {
    await put(join(canonicalRoot, dir, 'index.mjs'), 'export const fixture = true\n')
    await put(join(canonicalRoot, dir, 'package.json'), JSON.stringify({ name: `fixture-${dir.split('/').at(-1)}`, type: 'module' }))
    await put(join(canonicalRoot, dir, 'test/ignored.test.mjs'), 'not shipped')
    await put(join(canonicalRoot, dir, '.env'), 'not shipped')
  }
  await put(join(canonicalRoot, 'overlays/1c/tools/agent-1c/agent-1c.ps1'), '# fixture reviewed source')
  await put(join(canonicalRoot, 'overlays/1c/tools/agent-1c/lib/1c-guard.ps1'), '# fixture guard source')
  await put(join(canonicalRoot, 'overlays/1c/tools/agent-1c/toolchain.lock.json'), '{}')
  const artifact = join(root, 'airules-official-policy-test.workflow')
  const manifest = await stageOfficialPolicy({ rulepack, output: artifact, artifactVersion: 'test.workflow', includeOpenSpec: false,
    includeWorkflows: true, workflowRulesRoot: canonicalRoot })
  const manifestPath = join(artifact, 'official-policy-manifest.json')
  const reviewPath = join(artifact, `${prefix}runtime/reviewed-runners.json`)
  const reviewBytes = await readFile(reviewPath)
  return { root, artifact, manifest, manifestPath, reviewPath, reviewBytes,
    save: value => writeFile(manifestPath, JSON.stringify(value)) }
}

test('valid staged canonical workflow artifact verifies with exact package ordering and old manifests remain compatible', async t => {
  const f = await fixture(t)
  const verified = await verifyPolicyArtifact(f.artifact)
  assert.equal(verified.packageNames.at(-1), 'airules-dsh-workflows')
  assert.deepEqual(f.manifest.integrations.workflows.provenance.roots.map(row => row.source), roots)
  assert.equal(Object.keys(f.manifest.files).some(path => path.endsWith('/.env') || path.includes('/test/')), false)
  const combined = clone(f.manifest)
  combined.integrations.domainPresets = { package: 'airules-dsh-domain-presets', presets: ['python-airules', 'sysadmin-airules'], mcp: false, policyOwner: 'project_rules' }
  assert.deepEqual(policyPackageNames(combined).slice(-2), ['airules-dsh-domain-presets', 'airules-dsh-workflows'])
  assert.equal(policyPackageNames({}).length, 7)
})

test('workflow integration flags, canonical provenance and inventory paths fail closed', async t => {
  const f = await fixture(t)
  const mutations = [
    feature => { feature.deployEnabled = true },
    feature => { feature.nativeSandbox = false },
    feature => { feature.policyOwner = 'other' },
    feature => { feature.extraFlag = true },
    feature => { feature.provenance.layout = 'flat' },
    feature => { feature.provenance.source = 'bundled-copy' },
    feature => { feature.provenance.roots.reverse() },
    feature => { feature.provenance.roots[0].source = '/absolute' },
    feature => { feature.provenance.roots[0].target = '../escape' },
    feature => { feature.provenance.roots[0].inventoryDigest = 'a'.repeat(64) },
    feature => { feature.reviewedRunners.operations.push('deploy') },
    feature => { const row = feature.provenance.roots[0]; row.inventory['../escape'] = row.inventory['index.mjs']; row.files++; row.inventoryDigest = hash(row.inventory) },
    feature => { const row = feature.provenance.roots[0]; row.inventory['C:/escape'] = row.inventory['index.mjs']; row.files++; row.inventoryDigest = hash(row.inventory) },
    feature => { const row = feature.provenance.roots[0]; row.inventory['.env'] = row.inventory['index.mjs']; row.files++; row.inventoryDigest = hash(row.inventory) },
  ]
  for (const mutate of mutations) {
    const manifest = clone(f.manifest); mutate(manifest.integrations.workflows); await f.save(manifest)
    await assert.rejects(verifyPolicyArtifact(f.artifact), /POLICY_(?:INTEGRATION|WORKFLOW_PROVENANCE)_INVALID/u)
  }
})

test('canonical inventory must correspond to actual manifest payload hashes, even after resealing file manifest', async t => {
  const f = await fixture(t)
  const manifest = clone(f.manifest)
  const relativePath = `${prefix}runtime/core/tools/workflow/index.mjs`
  const bytes = Buffer.from('export const substituted = true\n')
  await writeFile(join(f.artifact, relativePath), bytes)
  manifest.files[relativePath] = { sha256: sha(bytes), bytes: bytes.length }
  await f.save(manifest)
  await assert.rejects(verifyPolicyArtifact(f.artifact), /POLICY_WORKFLOW_INVENTORY_MISMATCH/u)
  const row = manifest.integrations.workflows.provenance.roots[0]
  row.inventory['index.mjs'] = manifest.files[relativePath]; row.inventoryDigest = hash(row.inventory)
  await f.save(manifest)
  await verifyPolicyArtifact(f.artifact)
  const extra = `${prefix}runtime/unlisted.mjs`; const extraBytes = Buffer.from('unlisted')
  await writeFile(join(f.artifact, extra), extraBytes); manifest.files[extra] = { bytes: extraBytes.length, sha256: sha(extraBytes) }
  await f.save(manifest)
  await assert.rejects(verifyPolicyArtifact(f.artifact), /POLICY_WORKFLOW_INVENTORY_MISMATCH/u)
})

test('reviewed runner metadata authorizes only its single declared closure and doctor/analyze', async t => {
  const f = await fixture(t)
  const original = JSON.parse(f.reviewBytes.toString('utf8'))
  const mutations = [
    review => { review.reviewedDigests.push('b'.repeat(64)) },
    review => { review.operations.push('deploy') },
    review => { review.deployEnabled = true },
    review => { review.policyOwner = 'other' },
    review => { review.codeClosure.files[0].digest = 'c'.repeat(64) },
    review => { review.codeClosure.files[0].path = 'tools/agent-1c/../../escape.ps1' },
    review => { review.codeClosure.files.push(clone(review.codeClosure.files[0])) },
    review => { review.codeClosure.files.reverse() },
    review => { review.codeClosure.files[0].bytes = -1 },
    review => { review.unreviewedDigests = ['d'.repeat(64)] },
  ]
  for (const mutate of mutations) {
    const review = clone(original); mutate(review)
    const bytes = Buffer.from(JSON.stringify(review)); await writeFile(f.reviewPath, bytes)
    const manifest = clone(f.manifest)
    manifest.files[`${prefix}runtime/reviewed-runners.json`] = { bytes: bytes.length, sha256: sha(bytes) }
    await f.save(manifest)
    await assert.rejects(verifyPolicyArtifact(f.artifact), /POLICY_WORKFLOW_(?:REVIEW|PROVENANCE)_INVALID/u)
  }
})
