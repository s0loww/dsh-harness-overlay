import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildInstallPlan, PlanError } from '../installer/plan.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => `${JSON.stringify(value, null, 2)}\n`

async function put(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

async function fileMap(root) {
  const result = {}
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, rel)
      else result[rel] = sha256(await readFile(path))
    }
  }
  await walk(root)
  return result
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-plan-'))
  const installRoot = join(base, 'install')
  const overlay = join(base, 'overlay')
  const baselinePath = join(base, 'release.lock.json')
  await mkdir(installRoot, { recursive: true })

  const release = {
    schemaVersion: 1,
    product: 'DSH Desktop 1C',
    releaseId: 'fixture-release',
    hostVersion: 'fixture-host',
    bundleVersion: 'fixture-bundle',
  }
  await put(join(installRoot, 'RELEASE-MANIFEST.json'), canonical(release))
  await put(join(installRoot, 'dsh-1c-bundle', 'package.json'), '{"name":"fixture"}\n')
  await put(join(installRoot, 'dsh-1c-bundle', 'cordis.patch.yml'), '- insert:\n    - id: existing-provider\n')

  const sourceFiles = {}
  for (const rel of ['RELEASE-MANIFEST.json', 'dsh-1c-bundle/package.json']) {
    sourceFiles[rel] = sha256(await readFile(join(installRoot, ...rel.split('/'))))
  }
  const baseline = { ...release, sourceFiles }
  const baselineBytes = Buffer.from(canonical(baseline))
  await put(baselinePath, baselineBytes)

  const providerSource = 'payload/packages/airules-dsh-provider'
  const rulepackSource = 'payload/packages/airules-dsh-rulepack'
  const fragment = [
    '- insert:',
    '    - id: airules-policy',
    '      name: airules-dsh-provider',
    '      config:',
    "        rulepackRoot: !!js dshHomePath('profiles/node_modules/airules-dsh-rulepack')",
    '',
  ].join('\n')
  await put(join(overlay, ...providerSource.split('/'), 'index.js'), 'export default {}\n')
  await put(join(overlay, ...rulepackSource.split('/'), 'manifest.json'), '{"package":{"id":"fixture"}}\n')
  await put(join(overlay, 'cordis.patch.fragment.yml'), fragment)

  const files = {}
  for (const [rel, hash] of Object.entries(await fileMap(overlay))) {
    const bytes = await readFile(join(overlay, ...rel.split('/')))
    files[rel] = { sha256: hash, bytes: bytes.byteLength }
  }
  const manifest = {
    schemaVersion: 1,
    overlay: { id: 'airules-dsh-overlay', version: 'fixture' },
    target: {
      product: release.product,
      releaseId: release.releaseId,
      hostVersion: release.hostVersion,
      bundleVersion: release.bundleVersion,
      releaseLockSha256: sha256(baselineBytes),
    },
    install: {
      providerSource,
      providerTarget: 'profiles/node_modules/airules-dsh-provider',
      rulepackSource,
      rulepackTarget: 'profiles/node_modules/airules-dsh-rulepack',
      cordisFragment: 'cordis.patch.fragment.yml',
    },
    files,
  }
  await put(join(overlay, 'overlay-manifest.json'), canonical(manifest))
  return { base, installRoot, overlay, baselinePath, release, manifest }
}

async function withFixture(run) {
  const value = await fixture()
  try {
    await run(value)
  } finally {
    await rm(value.base, { recursive: true, force: true })
  }
}

test('valid fixture produces a ready no-write install plan', async () => withFixture(async input => {
  const before = await fileMap(input.base)
  const plan = await buildInstallPlan(input)
  const after = await fileMap(input.base)

  assert.equal(plan.mode, 'read-only-plan')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.checks.releaseGuard, 'passed')
  assert.equal(plan.checks.baselineSourceHashes.verified, 2)
  assert.equal(plan.operations.length, 3)
  assert.deepEqual(plan.operations.map(operation => operation.kind), [
    'copy-directory',
    'copy-directory',
    'merge-cordis-fragment',
  ])
  assert.equal(plan.operations[0].target, join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider'))
  assert.equal(plan.operations[2].target, join(input.installRoot, 'dsh-1c-bundle', 'cordis.patch.yml'))
  assert.deepEqual(before, after)
}))

test('unknown installed release is rejected by release guard', async () => withFixture(async input => {
  const unknown = { ...input.release, releaseId: 'unknown-release' }
  await put(join(input.installRoot, 'RELEASE-MANIFEST.json'), canonical(unknown))
  await assert.rejects(
    buildInstallPlan(input),
    error => error instanceof PlanError && error.code === 'UNKNOWN_RELEASE',
  )
}))

test('tampered overlay payload is rejected', async () => withFixture(async input => {
  await put(join(input.overlay, 'payload', 'packages', 'airules-dsh-provider', 'index.js'), 'tampered\n')
  await assert.rejects(
    buildInstallPlan(input),
    error => error instanceof PlanError && error.code === 'OVERLAY_PAYLOAD_HASH_MISMATCH',
  )
}))

test('existing package target is reported as a blocking collision with backup target', async () => withFixture(async input => {
  const target = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider')
  await mkdir(target, { recursive: true })
  const plan = await buildInstallPlan(input)

  assert.equal(plan.status, 'blocked')
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].target, target)
  assert.equal(plan.collisions[0].reason, 'TARGET_ALREADY_EXISTS')
  assert.equal(plan.operations[0].collision, true)
  assert.ok(plan.operations[0].backupTarget)
  assert.ok(plan.backupTargets.includes(plan.operations[0].backupTarget))
}))
