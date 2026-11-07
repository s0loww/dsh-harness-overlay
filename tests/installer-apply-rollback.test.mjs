import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { applyOverlay, ApplyError } from '../installer/apply.mjs'
import { analyzeCordis, mergeCordis } from '../installer/cordis.mjs'
import { pathKind } from '../installer/fs-state.mjs'
import { buildInstallPlan, verifyInstalledBaseline } from '../installer/plan.mjs'
import { rollbackOverlay, RollbackError } from '../installer/rollback.mjs'

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
  const base = await mkdtemp(join(tmpdir(), 'dsh-apply-'))
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
  await put(join(installRoot, 'dsh-1c-bundle', 'cordis.patch.yml'), '- insert:\n    - id: existing-provider\n      name: existing\n')

  const sourceFiles = {}
  for (const rel of ['RELEASE-MANIFEST.json', 'dsh-1c-bundle/package.json']) {
    sourceFiles[rel] = sha256(await readFile(join(installRoot, ...rel.split('/'))))
  }
  const baseline = { ...release, sourceFiles }
  const baselineBytes = Buffer.from(canonical(baseline))
  await put(baselinePath, baselineBytes)

  const providerSource = 'payload/packages/airules-dsh-provider'
  const rulepackSource = 'payload/packages/airules-dsh-rulepack'
  await put(join(overlay, ...providerSource.split('/'), 'index.js'), 'export default { fixture: true }\n')
  await put(join(overlay, ...providerSource.split('/'), 'package.json'), '{"name":"airules-dsh-provider"}\n')
  await put(join(overlay, ...rulepackSource.split('/'), 'manifest.json'), '{"package":{"id":"fixture"}}\n')
  await put(join(overlay, ...rulepackSource.split('/'), 'rules', 'rule.md'), '# Fixture rule\n')
  await put(join(overlay, 'cordis.patch.fragment.yml'), [
    '- insert:',
    '    - id: airules-policy',
    '      name: airules-dsh-provider',
    '      inject: [skills, systemPrompt, tools]',
    '      config:',
    "        rulepackRoot: !!js dshHomePath('profiles/node_modules/airules-dsh-rulepack')",
    '',
  ].join('\n'))

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
  return { base, installRoot, overlay, baselinePath }
}

async function withFixture(run) {
  const input = await fixture()
  try { await run(input) } finally { await rm(input.base, { recursive: true, force: true }) }
}

test('apply verifies, backs up, installs once, then rollback restores byte-for-byte', async () => withFixture(async input => {
  const cordisPath = join(input.installRoot, 'dsh-1c-bundle', 'cordis.patch.yml')
  const providerPath = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider')
  const rulepackPath = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-rulepack')
  const beforeCordis = await readFile(cordisPath)

  const applied = await applyOverlay(input)
  assert.equal(applied.status, 'applied')
  assert.equal(await pathKind(providerPath), 'directory')
  assert.equal(await pathKind(rulepackPath), 'directory')
  const installedCordis = await readFile(cordisPath, 'utf8')
  assert.equal((installedCordis.match(/id:\s*airules-policy/gu) ?? []).length, 1)
  const postApplyPlan = await buildInstallPlan(input)
  assert.equal(postApplyPlan.operations.find(operation => operation.kind === 'merge-cordis-fragment').action, 'noop')
  assert.equal(postApplyPlan.collisions.filter(collision => collision.kind === 'merge-cordis-fragment').length, 0)
  assert.deepEqual(await readFile(join(input.installRoot, applied.receipt.backupRoot, 'dsh-1c-bundle', 'cordis.patch.yml')), beforeCordis)
  await verifyInstalledBaseline(input)

  const rolledBack = await rollbackOverlay({ ...input, receiptPath: applied.receiptPath })
  assert.equal(rolledBack.status, 'rolled-back')
  assert.equal(await pathKind(providerPath), 'missing')
  assert.equal(await pathKind(rulepackPath), 'missing')
  assert.deepEqual(await readFile(cordisPath), beforeCordis)
  await verifyInstalledBaseline(input)
}))

test('collision without explicit replace performs no writes', async () => withFixture(async input => {
  const target = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider')
  await put(join(target, 'local.js'), 'keep me\n')
  const before = await fileMap(input.base)
  await assert.rejects(
    applyOverlay(input),
    error => error instanceof ApplyError && error.code === 'COLLISION_REQUIRES_EXPLICIT_REPLACE',
  )
  assert.deepEqual(await fileMap(input.base), before)
}))

test('explicit replacement is fully backed up and restored', async () => withFixture(async input => {
  const target = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider')
  await put(join(target, 'local.js'), 'original bytes\r\n')
  const before = await fileMap(target)
  const applied = await applyOverlay({ ...input, replaceCollisions: true })
  assert.notDeepEqual(await fileMap(target), before)
  await rollbackOverlay({ ...input, receiptPath: applied.receiptPath })
  assert.deepEqual(await fileMap(target), before)
}))

test('a differing dedicated Cordis block requires the flag and is replaced idempotently', async () => withFixture(async input => {
  const cordis = join(input.installRoot, 'dsh-1c-bundle', 'cordis.patch.yml')
  const old = Buffer.from('- insert:\r\n    - id: airules-policy\r\n      name: old-provider\r\n')
  await put(cordis, old)
  const beforeRefusal = await fileMap(input.installRoot)
  await assert.rejects(
    applyOverlay(input),
    error => error instanceof ApplyError && error.code === 'COLLISION_REQUIRES_EXPLICIT_REPLACE',
  )
  assert.deepEqual(await fileMap(input.installRoot), beforeRefusal)

  const applied = await applyOverlay({ ...input, replaceCollisions: true })
  const current = await readFile(cordis, 'utf8')
  assert.equal((current.match(/id:\s*airules-policy/gu) ?? []).length, 1)
  assert.match(current, /name:\s*airules-dsh-provider/u)
  const plan = await buildInstallPlan(input)
  assert.equal(plan.operations.find(operation => operation.kind === 'merge-cordis-fragment').action, 'noop')
  await rollbackOverlay({ ...input, receiptPath: applied.receiptPath })
  assert.deepEqual(await readFile(cordis), old)
}))

test('tampered overlay is refused before backup or target writes', async () => withFixture(async input => {
  await put(join(input.overlay, 'payload', 'packages', 'airules-dsh-provider', 'index.js'), 'tampered\n')
  const before = await fileMap(input.base)
  await assert.rejects(applyOverlay(input), /OVERLAY_PAYLOAD_HASH_MISMATCH/u)
  assert.deepEqual(await fileMap(input.base), before)
}))

test('rollback refuses a modified owned target without changing anything', async () => withFixture(async input => {
  const applied = await applyOverlay(input)
  const owned = join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider', 'index.js')
  await put(owned, 'user changed this\n')
  const beforeRefusal = await fileMap(input.installRoot)
  await assert.rejects(
    rollbackOverlay({ ...input, receiptPath: applied.receiptPath }),
    error => error instanceof RollbackError && error.code === 'OWNERSHIP_HASH_MISMATCH',
  )
  assert.deepEqual(await fileMap(input.installRoot), beforeRefusal)
}))

test('tampered receipt is rejected before rollback writes', async () => withFixture(async input => {
  const applied = await applyOverlay(input)
  const receipt = JSON.parse(await readFile(applied.receiptPath, 'utf8'))
  receipt.operations[0].target = 'dsh-1c-bundle/package.json'
  await put(applied.receiptPath, canonical(receipt))
  const beforeRefusal = await fileMap(input.installRoot)
  await assert.rejects(
    rollbackOverlay({ ...input, receiptPath: applied.receiptPath }),
    error => error instanceof RollbackError && error.code === 'RECEIPT_INTEGRITY_MISMATCH',
  )
  assert.deepEqual(await fileMap(input.installRoot), beforeRefusal)
  await access(join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider'))
}))

test('Cordis analysis preserves BOM and comments and stays idempotent', async () => withFixture(async input => {
  const fragment = await readFile(join(input.overlay, 'cordis.patch.fragment.yml'), 'utf8')
  const exactWithBomAndComment = `\uFEFF${fragment}# keep this comment\n`
  assert.equal(analyzeCordis(exactWithBomAndComment, fragment).action, 'noop')
  assert.equal(mergeCordis(exactWithBomAndComment, fragment).text, exactWithBomAndComment)

  const differing = '\uFEFF- insert:\r\n    - id: airules-policy\r\n      name: old-provider\r\n# keep this comment\r\n'
  const replaced = mergeCordis(differing, fragment, { replaceCollision: true }).text
  assert.ok(replaced.startsWith('\uFEFF'))
  assert.match(replaced, /# keep this comment/u)
  assert.equal((replaced.match(/id:\s*airules-policy/gu) ?? []).length, 1)
}))
