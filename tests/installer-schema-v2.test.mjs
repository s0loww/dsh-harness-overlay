import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { applyOverlay } from '../installer/apply.mjs'
import { pathKind } from '../installer/fs-state.mjs'
import { buildInstallPlan, verifyInstalledBaseline } from '../installer/plan.mjs'
import { sealReceipt } from '../installer/receipt.mjs'
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

async function fixture({ cardinalityMismatch = false, badResultHash = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-schema-v2-'))
  const installRoot = join(base, 'install')
  const overlay = join(base, 'overlay')
  const baselinePath = join(base, 'release.lock.json')
  await mkdir(installRoot, { recursive: true })
  const release = {
    schemaVersion: 1,
    product: 'DSH Desktop 1C',
    releaseId: 'fixture-release-v2',
    hostVersion: 'fixture-host',
    bundleVersion: 'fixture-bundle',
  }
  await put(join(installRoot, 'RELEASE-MANIFEST.json'), canonical(release))
  await put(join(installRoot, 'dsh-1c-bundle', 'package.json'), '{"name":"fixture"}\n')
  await put(join(installRoot, 'dsh-1c-bundle', 'cordis.patch.yml'), '- insert:\n    - id: existing-provider\n')

  const patchFiles = []
  for (let index = 0; index < 7; index += 1) {
    const target = index === 0 ? 'scripts/repair-fixture.mjs' : `dsh-1c-bundle/lib/fixture-${index}.js`
    const source = `const fixture${index} = "OLD_${index}";\r\n`
    const from = cardinalityMismatch && index === 3 ? 'NOT_PRESENT' : `OLD_${index}`
    const to = `NEW_${index}`
    const result = source.replace(from, to)
    await put(join(installRoot, ...target.split('/')), source)
    patchFiles.push({
      target,
      sourceSha256: sha256(Buffer.from(source)),
      resultSha256: badResultHash && index === 5 ? '0'.repeat(64) : sha256(Buffer.from(result)),
      replacements: [{ from, to, count: 1 }],
    })
  }

  const sourceFiles = {}
  for (const rel of ['RELEASE-MANIFEST.json', 'dsh-1c-bundle/package.json', ...patchFiles.map(file => file.target)]) {
    sourceFiles[rel] = sha256(await readFile(join(installRoot, ...rel.split('/'))))
  }
  const baseline = { ...release, sourceFiles }
  const baselineBytes = Buffer.from(canonical(baseline))
  await put(baselinePath, baselineBytes)

  const providerSource = 'payload/packages/airules-dsh-provider'
  const rulepackSource = 'payload/packages/airules-dsh-rulepack'
  await put(join(overlay, ...providerSource.split('/'), 'index.js'), 'export default { fixture: true }\n')
  await put(join(overlay, ...rulepackSource.split('/'), 'manifest.json'), '{"package":{"id":"fixture"}}\n')
  await put(join(overlay, 'cordis.patch.fragment.yml'), [
    '- insert:',
    '    - id: airules-policy',
    '      name: airules-dsh-provider',
    '      config:',
    "        rulepackRoot: !!js dshHomePath('profiles/node_modules/airules-dsh-rulepack')",
    '',
  ].join('\n'))
  const patchDocument = {
    schemaVersion: 1,
    id: 'project-preset-1c-airules',
    releaseId: release.releaseId,
    preset: { id: '1c-airules', label: '1С' },
    files: patchFiles,
  }
  const patchSource = 'payload/patches/project-preset-1c-airules.json'
  await put(join(overlay, ...patchSource.split('/')), canonical(patchDocument))

  const files = {}
  for (const [rel, hash] of Object.entries(await fileMap(overlay))) {
    const bytes = await readFile(join(overlay, ...rel.split('/')))
    files[rel] = { sha256: hash, bytes: bytes.byteLength }
  }
  const manifest = {
    schemaVersion: 2,
    overlay: { id: 'airules-dsh-overlay', version: 'fixture-v2' },
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
    releasePatch: {
      required: true,
      engine: 'exact-text-replacements/v1',
      source: patchSource,
      id: patchDocument.id,
      preset: patchDocument.preset,
      files: patchFiles.map(({ target, sourceSha256, resultSha256 }) => ({ target, sourceSha256, resultSha256 })),
    },
    files,
  }
  await put(join(overlay, 'overlay-manifest.json'), canonical(manifest))
  return { base, installRoot, overlay, baselinePath, patchFiles }
}

async function withFixture(options, run) {
  const input = await fixture(options)
  try { await run(input) } finally { await rm(input.base, { recursive: true, force: true }) }
}

test('schema v2 plan validates seven sources, cardinality and result hashes', async () => withFixture({}, async input => {
  const before = await fileMap(input.installRoot)
  const plan = await buildInstallPlan(input)
  assert.equal(plan.schemaVersion, 2)
  assert.equal(plan.status, 'ready')
  assert.equal(plan.checks.releasePatch.files, 7)
  assert.equal(plan.operations.filter(operation => operation.kind === 'patch-file').length, 7)
  assert.deepEqual(plan.operations.slice(0, 7).map(operation => operation.kind), Array(7).fill('patch-file'))
  assert.deepEqual(await fileMap(input.installRoot), before)
}))

test('schema v2 refuses one replacement cardinality mismatch', async () => withFixture({ cardinalityMismatch: true }, async input => {
  await assert.rejects(buildInstallPlan(input), /RELEASE_PATCH_MATCH_COUNT_MISMATCH/u)
  assert.equal(await pathKind(join(input.installRoot, '.airules-backups')), 'missing')
}))

test('schema v2 refuses an incorrect computed result hash', async () => withFixture({ badResultHash: true }, async input => {
  await assert.rejects(buildInstallPlan(input), /RELEASE_PATCH_RESULT_HASH_MISMATCH/u)
  assert.equal(await pathKind(join(input.installRoot, '.airules-backups')), 'missing')
}))

test('schema v2 refuses source drift before writes', async () => withFixture({}, async input => {
  const target = join(input.installRoot, ...input.patchFiles[2].target.split('/'))
  await put(target, 'source drift\n')
  const before = await fileMap(input.installRoot)
  await assert.rejects(applyOverlay(input), /(?:BASELINE_SOURCE_HASH_MISMATCH|RELEASE_PATCH_SOURCE_HASH_MISMATCH)/u)
  assert.deepEqual(await fileMap(input.installRoot), before)
}))

test('schema v2 partial apply failure recovers every target', async () => withFixture({}, async input => {
  const before = await fileMap(input.installRoot)
  await assert.rejects(
    applyOverlay({
      ...input,
      operationHook: ({ applied }) => { if (applied === 3) throw new Error('INJECTED_PARTIAL_FAILURE') },
    }),
    /INJECTED_PARTIAL_FAILURE/u,
  )
  assert.deepEqual(await fileMap(input.installRoot), before)
  await verifyInstalledBaseline(input)
  assert.equal(await pathKind(join(input.installRoot, '.dsh-1c', 'home', 'profiles', 'node_modules', 'airules-dsh-provider')), 'missing')
}))

for (const failAfter of [8, 10]) {
  test(`schema v2 recovery covers failure after committed operation ${failAfter}`, async () => withFixture({}, async input => {
    const before = await fileMap(input.installRoot)
    await assert.rejects(
      applyOverlay({
        ...input,
        operationHook: ({ applied }) => { if (applied === failAfter) throw new Error(`INJECTED_FAILURE_${failAfter}`) },
      }),
      new RegExp(`INJECTED_FAILURE_${failAfter}`, 'u'),
    )
    assert.deepEqual(await fileMap(input.installRoot), before)
    await verifyInstalledBaseline(input)
  }))
}

test('schema v2 apply and guarded rollback restore all patch files byte-for-byte', async () => withFixture({}, async input => {
  const before = await fileMap(input.installRoot)
  const applied = await applyOverlay(input)
  for (const file of input.patchFiles) {
    assert.equal(sha256(await readFile(join(input.installRoot, ...file.target.split('/')))), file.resultSha256)
  }
  const rolledBack = await rollbackOverlay({ ...input, receiptPath: applied.receiptPath })
  assert.equal(rolledBack.status, 'rolled-back')
  const restored = await fileMap(input.installRoot)
  for (const [path, hash] of Object.entries(before)) assert.equal(restored[path], hash, path)
  await verifyInstalledBaseline(input)
}))

test('schema v2 rollback refuses a tampered patched target before writes', async () => withFixture({}, async input => {
  const applied = await applyOverlay(input)
  const target = join(input.installRoot, ...input.patchFiles[4].target.split('/'))
  await put(target, 'tampered after apply\n')
  const beforeRefusal = await fileMap(input.installRoot)
  await assert.rejects(
    rollbackOverlay({ ...input, receiptPath: applied.receiptPath }),
    error => (error instanceof RollbackError && error.code === 'OWNERSHIP_HASH_MISMATCH') || error.code === 'BASELINE_SOURCE_HASH_MISMATCH',
  )
  assert.deepEqual(await fileMap(input.installRoot), beforeRefusal)
}))

test('schema v2 rollback binds a resealed receipt patch allowlist to baseline', async () => withFixture({}, async input => {
  const applied = await applyOverlay(input)
  const receipt = JSON.parse(await readFile(applied.receiptPath, 'utf8'))
  const forgedHash = 'f'.repeat(64)
  const target = receipt.releasePatch.files[0].target
  receipt.releasePatch.files[0].sourceSha256 = forgedHash
  receipt.operations.find(operation => operation.target === target).before.sha256 = forgedHash
  await put(applied.receiptPath, canonical(sealReceipt(receipt)))
  const beforeRefusal = await fileMap(input.installRoot)
  await assert.rejects(
    rollbackOverlay({ ...input, receiptPath: applied.receiptPath }),
    error => error instanceof RollbackError && error.code === 'RECEIPT_RELEASE_PATCH_BASELINE_MISMATCH',
  )
  assert.deepEqual(await fileMap(input.installRoot), beforeRefusal)
}))
