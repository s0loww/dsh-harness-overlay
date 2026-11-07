import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildOfficialDesktopPlan,
  OfficialDesktopTargetError,
  snapshotOfficialDesktop,
  verifyOfficialDesktop,
} from '../src/targets/official-desktop/target.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'official-desktop-target-'))
  const install = join(root, 'install')
  const profile = join(root, 'profile')
  const artifact = join(root, 'artifact')
  await mkdir(join(install, 'resources'), { recursive: true })
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(join(artifact, 'payload', 'packages', 'ui-demo'), { recursive: true })
  const immutable = {
    'DeepSeek Harness.exe': Buffer.from('exe'),
    'resources/app.asar': Buffer.from('clean-asar'),
    'resources/app-update.yml': Buffer.from('provider: test\n'),
    'resources/default_app.asar': Buffer.from('default-asar'),
    version: Buffer.from('44.7.0'),
  }
  for (const [relative, bytes] of Object.entries(immutable)) await writeFile(join(install, ...relative.split('/')), bytes)
  const lock = {
    schemaVersion: 1,
    target: 'official-desktop',
    product: 'DeepSeek Harness',
    hostVersion: '0.2.1-rc.5',
    buildCommit: 'fixture',
    platform: 'win32-x64',
    profileLayout: '.dsh/profiles/desktop',
    files: Object.fromEntries(Object.entries(immutable).sort().map(([path, bytes]) => [path, { bytes: bytes.length, sha256: sha256(bytes) }])),
  }
  const lockPath = join(root, 'release.lock.json')
  await writeFile(lockPath, JSON.stringify(lock), 'utf8')
  await writeFile(join(profile, 'cordis.patch.yml'), 'TOP-SECRET-PROFILE-CONTENT\n', 'utf8')
  await writeFile(join(artifact, 'payload', 'packages', 'ui-demo', 'package.json'), '{"name":"ui-demo"}\n', 'utf8')
  await writeFile(join(artifact, 'cordis.patch.fragment.yml'), '- id: ui-demo\n', 'utf8')
  const manifest = {
    schemaVersion: 1,
    artifact: { id: 'ui-demo-overlay', version: '0.1.0' },
    target: { kind: 'official-desktop', hostVersion: lock.hostVersion, appAsarSha256: lock.files['resources/app.asar'].sha256 },
    packages: [{ name: 'ui-demo', source: 'payload/packages/ui-demo' }],
    cordisFragment: 'cordis.patch.fragment.yml',
    internalPatches: [],
  }
  await writeFile(join(artifact, 'official-ui-manifest.json'), JSON.stringify(manifest), 'utf8')
  return { root, install, profile, artifact, lockPath, lock, manifest }
}

test('verifies immutable official baseline and builds a no-read profile plan', async () => {
  const item = await fixture()
  try {
    const snapshot = await snapshotOfficialDesktop({ installRoot: item.install, releaseLockPath: item.lockPath })
    assert.equal(snapshot.hostVersion, '0.2.1-rc.5')
    assert.equal(Object.keys(snapshot.files).length, 5)
    await verifyOfficialDesktop({ installRoot: item.install, releaseLockPath: item.lockPath })
    const plan = await buildOfficialDesktopPlan({
      installRoot: item.install,
      profileRoot: item.profile,
      artifactRoot: item.artifact,
      releaseLockPath: item.lockPath,
    })
    assert.equal(plan.status, 'ready')
    assert.equal(plan.readOnly, true)
    assert.deepEqual(plan.operations.map(row => row.type), ['copy-directory', 'merge-cordis-fragment'])
    assert.equal(plan.operations[0].target, join(item.profile, 'node_modules', 'ui-demo'))
    assert.equal(plan.operations[1].target, join(item.profile, 'cordis.patch.yml'))
    assert.equal(JSON.stringify(plan).includes('TOP-SECRET-PROFILE-CONTENT'), false)
  } finally { await rm(item.root, { recursive: true, force: true }) }
})

test('unknown app.asar and source drift fail closed', async () => {
  const item = await fixture()
  try {
    const path = join(item.artifact, 'official-ui-manifest.json')
    await writeFile(path, JSON.stringify({ ...item.manifest, target: { ...item.manifest.target, appAsarSha256: '0'.repeat(64) } }), 'utf8')
    await assert.rejects(
      buildOfficialDesktopPlan({ installRoot: item.install, profileRoot: item.profile, artifactRoot: item.artifact, releaseLockPath: item.lockPath }),
      error => error instanceof OfficialDesktopTargetError && error.code === 'ARTIFACT_TARGET_MISMATCH',
    )
    await writeFile(path, JSON.stringify(item.manifest), 'utf8')
    await writeFile(join(item.install, 'resources', 'app.asar'), 'drift', 'utf8')
    await assert.rejects(
      buildOfficialDesktopPlan({ installRoot: item.install, profileRoot: item.profile, artifactRoot: item.artifact, releaseLockPath: item.lockPath }),
      error => error instanceof OfficialDesktopTargetError && error.code === 'BASELINE_HASH_MISMATCH',
    )
  } finally { await rm(item.root, { recursive: true, force: true }) }
})

test('known internal patch is review-required and mismatched patch hash is rejected', async () => {
  const item = await fixture()
  try {
    await writeFile(join(item.artifact, 'internal-patch.json'), '{}\n', 'utf8')
    const known = {
      ...item.manifest,
      internalPatches: [{ id: 'runtime-locale-hook', appAsarSha256: item.lock.files['resources/app.asar'].sha256, descriptor: 'internal-patch.json' }],
    }
    const path = join(item.artifact, 'official-ui-manifest.json')
    await writeFile(path, JSON.stringify(known), 'utf8')
    const plan = await buildOfficialDesktopPlan({ installRoot: item.install, profileRoot: item.profile, artifactRoot: item.artifact, releaseLockPath: item.lockPath })
    assert.equal(plan.status, 'review-required')
    assert.deepEqual(plan.blockers, ['INTERNAL_APP_ASAR_PATCH_REQUIRES_SEPARATE_INSTALLER'])
    await writeFile(path, JSON.stringify({ ...known, internalPatches: [{ ...known.internalPatches[0], appAsarSha256: 'f'.repeat(64) }] }), 'utf8')
    await assert.rejects(
      buildOfficialDesktopPlan({ installRoot: item.install, profileRoot: item.profile, artifactRoot: item.artifact, releaseLockPath: item.lockPath }),
      error => error instanceof OfficialDesktopTargetError && error.code === 'INTERNAL_PATCH_BASELINE_MISMATCH',
    )
  } finally { await rm(item.root, { recursive: true, force: true }) }
})

test('runtime-state and traversal sources are rejected', async () => {
  const item = await fixture()
  try {
    const path = join(item.artifact, 'official-ui-manifest.json')
    for (const source of ['../outside', '.desktop-local/plugin', '.dsh-1c/state', 'payload/.env']) {
      const manifest = { ...item.manifest, packages: [{ name: 'ui-demo', source }] }
      await writeFile(path, JSON.stringify(manifest), 'utf8')
      await assert.rejects(
        buildOfficialDesktopPlan({ installRoot: item.install, profileRoot: item.profile, artifactRoot: item.artifact, releaseLockPath: item.lockPath }),
        error => error instanceof OfficialDesktopTargetError && error.code === 'UNSAFE_PATH',
        source,
      )
    }
  } finally { await rm(item.root, { recursive: true, force: true }) }
})
