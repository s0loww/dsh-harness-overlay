import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CANDIDATE_PARENT, CandidateError, createOfficialCandidate, resolveCliCandidateRoot } from '../scripts/create-official-candidate.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'official-candidate-'))
  const source = join(root, 'source')
  await mkdir(join(source, 'resources'), { recursive: true })
  const content = {
    'DeepSeek Harness.exe': 'exe-fixture',
    'resources/app-update.yml': 'provider: generic',
    'resources/app.asar': 'asar-fixture',
    'resources/default_app.asar': 'default-asar',
    version: '44.7.0',
  }
  const files = {}
  for (const [relative, value] of Object.entries(content)) {
    const path = join(source, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    const bytes = Buffer.from(value)
    await writeFile(path, bytes)
    files[relative] = { bytes: bytes.length, sha256: hash(bytes) }
  }
  const lock = join(root, 'release.lock.json')
  await writeFile(lock, JSON.stringify({
    schemaVersion: 1,
    target: 'official-desktop',
    product: 'DeepSeek Harness',
    hostVersion: '0.2.1-rc.5',
    buildCommit: 'fixture',
    platform: 'win32-x64',
    profileLayout: '.dsh/profiles/desktop',
    files,
  }))
  return { root, source, lock, candidate: join(root, 'candidate') }
}

test('creates an isolated unlaunched official candidate without a live profile copy', async () => {
  const data = await fixture()
  const result = await createOfficialCandidate({
    sourceRoot: data.source,
    candidateRoot: data.candidate,
    releaseLockPath: data.lock,
    minimumFreeMultiplier: 0,
  })
  assert.equal(result.manifest.status, 'created-not-launched')
  assert.equal(result.manifest.candidate.launchAllowed, false)
  assert.equal(result.manifest.isolation.copiesLiveProfile, false)
  assert.equal((await stat(join(data.candidate, 'home', 'profiles', 'desktop', 'node_modules'))).isDirectory(), true)
  const profile = JSON.parse(await readFile(join(data.candidate, 'home', 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(await readFile(join(data.candidate, 'home', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
    '',
  ].join('\n'))
  assert.equal(await readFile(join(data.candidate, 'home', 'profiles', 'desktop', 'pnpm-workspace.yaml'), 'utf8'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n'))
  await assert.rejects(access(join(data.candidate, 'home', 'profiles', 'desktop', 'cordis.yml')))
  assert.deepEqual(Object.keys(result.manifest.profileFiles).sort(), ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'])
  assert.equal(result.manifest.installationTree.fileCount, 5)
  assert.match(result.manifest.installationTree.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(result.manifest.source.installationTreeSha256, result.manifest.installationTree.sha256)
})

test('refuses an existing candidate and overlapping source/output', async () => {
  const data = await fixture()
  await mkdir(data.candidate)
  await assert.rejects(
    createOfficialCandidate({ sourceRoot: data.source, candidateRoot: data.candidate, releaseLockPath: data.lock, minimumFreeMultiplier: 0 }),
    error => error instanceof CandidateError && error.code === 'CANDIDATE_ALREADY_EXISTS',
  )
  await assert.rejects(
    createOfficialCandidate({ sourceRoot: data.source, candidateRoot: join(data.source, 'nested'), releaseLockPath: data.lock, minimumFreeMultiplier: 0 }),
    error => error instanceof CandidateError && error.code === 'SOURCE_CANDIDATE_OVERLAP',
  )
})

test('CLI candidate roots are fresh immediate children of repo var/candidate only', () => {
  const allowed = join(CANDIDATE_PARENT, 'official-desktop-test-fresh')
  assert.equal(resolveCliCandidateRoot(allowed), allowed)
  assert.throws(() => resolveCliCandidateRoot(join(CANDIDATE_PARENT, 'nested', 'candidate')), error => (
    error instanceof CandidateError && error.code === 'CANDIDATE_ROOT_OUTSIDE_REPOSITORY'
  ))
  assert.throws(() => resolveCliCandidateRoot(join(CANDIDATE_PARENT, '..', 'outside')), error => (
    error instanceof CandidateError && error.code === 'CANDIDATE_ROOT_OUTSIDE_REPOSITORY'
  ))
})

test('candidate launcher is fail-closed until UI and policy markers exist', async () => {
  const launcher = await readFile(new URL('../scripts/launch-official-candidate.ps1', import.meta.url), 'utf8')
  const smoke = await readFile(new URL('../scripts/smoke-official-candidate.mjs', import.meta.url), 'utf8')
  const launchPath = `${launcher}\n${smoke}`
  assert.match(launchPath, /ui-ready\.json/u)
  assert.match(launchPath, /policy-ready\.json/u)
  assert.match(launchPath, /READY_MISSING/u)
  assert.match(launchPath, /DSH_HOME/u)
  assert.match(launchPath, /--user-data-dir=/u)
  assert.doesNotMatch(launchPath, /env:\\DSH_HOME/u)
})
