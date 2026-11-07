import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { applyOfficialUi } from '../installer/official-ui/apply.mjs'
import { buildOfficialUiInstallPlan } from '../installer/official-ui/common.mjs'
import { rollbackOfficialUi } from '../installer/official-ui/rollback.mjs'
import { UI_CORDIS_IDS } from '../installer/official-ui/ui-cordis.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packageNames = ['@deepseek-ai/cosmokit', 'airules-provider-limits-hud']

async function file(path, content) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content) }

async function fileMap(root) {
  const result = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), rel = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && rel !== 'ui-overlay-manifest.json') {
        const bytes = await readFile(path)
        result[rel] = { sha256: sha(bytes), bytes: bytes.byteLength }
      }
    }
  }
  await visit(root)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en')))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'official-ui-installer-'))
  const candidate = join(root, 'candidate'), install = join(candidate, 'install'), profile = join(candidate, 'home', 'profiles', 'desktop')
  const artifact = join(root, 'artifact'), lockPath = join(root, 'release.lock.json')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(install, { recursive: true })
  await mkdir(artifact, { recursive: true })
  const releaseFiles = {
    'resources/app.asar': Buffer.from('fixture-app-asar'),
    'version': Buffer.from('44.7.0'),
  }
  for (const [name, bytes] of Object.entries(releaseFiles)) await file(join(install, name), bytes)
  const lock = {
    schemaVersion: 1, target: 'official-desktop', product: 'DeepSeek Harness', hostVersion: '0.2.1-rc.5', buildCommit: 'fixture', platform: 'win32-x64', profileLayout: '.dsh/profiles/desktop',
    files: Object.fromEntries(Object.entries(releaseFiles).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  await writeFile(join(candidate, 'candidate-manifest.json'), `${JSON.stringify({
    schemaVersion: 1, status: 'created-not-launched',
    candidate: { install: 'install', dshHome: 'home', profile: 'home/profiles/desktop', electronUserData: 'electron-user-data', uiReadyMarker: 'ui-ready.json', launchAllowed: false },
    isolation: { copiesLiveProfile: false },
  }, null, 2)}\n`)
  const originalCordis = '# isolated profile\n[]\n'
  await writeFile(join(profile, 'cordis.patch.yml'), originalCordis)
  for (const name of packageNames) {
    const body = `${JSON.stringify({ name, version: '1.0.0', license: 'MIT' }, null, 2)}\n`
    await file(join(artifact, 'payload', 'packages', name, 'package.json'), body)
    await file(join(artifact, 'payload', 'packages', name, 'lib', 'index.js'), `export const name = ${JSON.stringify(name)}\n`)
  }
  const fragment = `- insert:\n${UI_CORDIS_IDS.map((id, index) => `    - id: ${id}\n      name: fixture-ui-${index}`).join('\n')}\n`
  await writeFile(join(artifact, 'cordis.ui.fragment.yml'), fragment)
  const official = {
    schemaVersion: 1,
    artifact: { id: 'airules-dsh-ui-overlay', version: 'test.1' },
    target: { kind: 'official-desktop', hostVersion: lock.hostVersion, appAsarSha256: lock.files['resources/app.asar'].sha256 },
    packages: packageNames.map(name => ({ name, source: `payload/packages/${name}` })),
    cordisFragment: 'cordis.ui.fragment.yml', internalPatches: [],
  }
  await writeFile(join(artifact, 'official-ui-manifest.json'), `${JSON.stringify(official, null, 2)}\n`)
  const operations = packageNames.map(name => ({ component: 'fixture', type: 'package-copy', source: `payload/packages/${name}/package.json`, target: `node_modules/${name}`, sha256: 'fixture' }))
  operations.push({ component: 'fixture', type: 'config-fragment', source: 'cordis.ui.fragment.yml', target: 'cordis.patch.yml', sha256: sha(Buffer.from(fragment)) })
  const manifest = {
    schemaVersion: 1, artifact: official.artifact,
    sourceRelease: { product: 'fixture', releaseId: 'fixture' },
    target: { releaseIds: ['fixture'], hostVersions: [lock.hostVersion], baselineLockSha256: sha(await readFile(lockPath)), unknownTargetPolicy: 'block' },
    separation: { includesPolicy: false, includesRulepack: false, includesMcpBindings: false, includesCredentials: false, includesRuntimeState: false },
    components: [{ id: 'fixture', required: true, enabledByDefault: true, installOrder: 1 }], operations, files: await fileMap(artifact),
  }
  await writeFile(join(artifact, 'ui-overlay-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { root, candidate, artifact, lockPath, profile, originalCordis }
}

test('official UI plan verifies payload and performs no candidate writes', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  const before = await fileMap(data.candidate)
  const plan = await buildOfficialUiInstallPlan({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath })
  assert.equal(plan.status, 'ready')
  assert.equal(plan.operations.length, packageNames.length + 2)
  assert.deepEqual(await fileMap(data.candidate), before)
})

test('official UI apply and guarded rollback restore profile byte-for-byte', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  const applied = await applyOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath })
  assert.equal(applied.status, 'applied')
  for (const name of packageNames) assert.equal(JSON.parse(await readFile(join(data.profile, 'node_modules', name, 'package.json'), 'utf8')).name, name)
  assert.match(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8'), /airules-provider-limits-hud/u)
  assert.equal(JSON.parse(await readFile(join(data.candidate, 'ui-ready.json'), 'utf8')).status, 'ui-ready')
  const rolled = await rollbackOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath, receiptPath: applied.receiptPath })
  assert.equal(rolled.status, 'rolled-back')
  for (const name of packageNames) await assert.rejects(readFile(join(data.profile, 'node_modules', name, 'package.json')), /ENOENT/u)
  assert.equal(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8'), data.originalCordis)
  await assert.rejects(readFile(join(data.candidate, 'ui-ready.json')), /ENOENT/u)
  assert.deepEqual(await readdir(join(data.profile, 'node_modules')), [])
})

test('collision blocks without override before backup writes', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  await file(join(data.profile, 'node_modules', packageNames[0], 'foreign.txt'), 'foreign')
  const plan = await buildOfficialUiInstallPlan({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath })
  assert.equal(plan.status, 'blocked')
  await assert.rejects(applyOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath }), /PLAN_BLOCKED/u)
  await assert.rejects(readFile(join(data.candidate, '.airules-ui-backups', 'airules-dsh-ui-overlay-test.1', 'receipt.pending.json')), /ENOENT/u)
})

test('partial apply failure restores every owned target', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  await assert.rejects(applyOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath, failAfterOperation: 3 }), /INJECTED_APPLY_FAILURE/u)
  for (const name of packageNames) await assert.rejects(readFile(join(data.profile, 'node_modules', name, 'package.json')), /ENOENT/u)
  assert.equal(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8'), data.originalCordis)
  await assert.rejects(readFile(join(data.candidate, 'ui-ready.json')), /ENOENT/u)
  assert.deepEqual(await readdir(join(data.profile, 'node_modules')), [])
})

test('partial rollback failure recovers the fully applied UI', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  const applied = await applyOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath })
  const appliedCordis = await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8')
  await assert.rejects(rollbackOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath, receiptPath: applied.receiptPath, failAfterOperation: 2 }), /INJECTED_ROLLBACK_FAILURE/u)
  for (const name of packageNames) assert.equal(JSON.parse(await readFile(join(data.profile, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).name, name)
  assert.equal(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8'), appliedCordis)
  assert.equal(JSON.parse(await readFile(join(data.candidate, 'ui-ready.json'), 'utf8')).status, 'ui-ready')
  const rolled = await rollbackOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath, receiptPath: applied.receiptPath })
  assert.equal(rolled.status, 'rolled-back')
})

test('tampered owned package blocks rollback without modifying other targets', async t => {
  const data = await fixture(); t.after(() => rm(data.root, { recursive: true, force: true }))
  const applied = await applyOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath })
  const cordis = await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8')
  await writeFile(join(data.profile, 'node_modules', packageNames[0], 'lib', 'index.js'), 'tampered')
  await assert.rejects(rollbackOfficialUi({ candidateRoot: data.candidate, artifactRoot: data.artifact, releaseLockPath: data.lockPath, receiptPath: applied.receiptPath }), /ROLLBACK_OWNERSHIP_MISMATCH/u)
  assert.equal(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8'), cordis)
  assert.equal((await readFile(join(data.profile, 'node_modules', packageNames[0], 'lib', 'index.js'), 'utf8')), 'tampered')
})
