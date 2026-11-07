import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readLiveUpdateReceipt, assertLiveUpdateFragments, PROMOTION_BACKUPS_ROOT } from '../installer/official-live/common.mjs'
import { targetState } from '../installer/fs-state.mjs'
import { sealReceipt } from '../installer/receipt.mjs'
import { parsePlanArgs } from '../installer/official-live/plan.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-update-')), previousBackup = join(PROMOTION_BACKUPS_ROOT, 'test-update-' + randomUUID())
  const paths = { install: join(root, 'install'), profile: join(root, 'profile'), backup: join(PROMOTION_BACKUPS_ROOT, 'test-update-next-' + randomUUID()) }
  await mkdir(join(paths.profile, 'node_modules/owned-package'), { recursive: true }); await mkdir(previousBackup, { recursive: true })
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(previousBackup, { recursive: true, force: true }) })
  await writeFile(join(paths.profile, 'node_modules/owned-package/index.js'), 'old managed bytes')
  await writeFile(join(paths.profile, 'cordis.patch.yml'), '\uFEFF# user settings\r\n- user: preserved\r\n')
  const target = { kind: 'official-desktop', hostVersion: 'test', appAsarSha256: 'a'.repeat(64) }
  const packageState = await targetState(join(paths.profile, 'node_modules/owned-package'))
  const receipt = { schemaVersion: 1, status: 'applied', installRoot: paths.install, profileRoot: paths.profile, backupRoot: previousBackup, target, artifactPackageNames: ['owned-package'], packageNames: ['owned-package'], cleanupPending: [], operations: [
    { type: 'copy-directory', package: 'owned-package', target: 'node_modules/owned-package', before: { type: 'missing' }, after: packageState },
    { type: 'merge-cordis', target: 'cordis.patch.yml', before: { type: 'missing' }, after: { type: 'file', bytes: 0, sha256: 'old-cordis-no-longer-current' } },
  ] }
  const previousReceiptPath = join(previousBackup, 'receipt.json')
  async function save(value = receipt) { await writeFile(previousReceiptPath, JSON.stringify(sealReceipt(value))) }
  await save()
  return { root, paths, target, receipt, previousReceiptPath, save, options: { previousReceiptPath, paths, target, packageNames: ['owned-package', 'new-package'] } }
}

test('guarded update owns only receipt packages and accepts user cordis drift without writing it', async t => {
  const f = await fixture(t), originalReceipt = await readFile(f.previousReceiptPath), config = await readFile(join(f.paths.profile, 'cordis.patch.yml'))
  const result = await readLiveUpdateReceipt(f.options)
  assert.equal(result.owned.size, 1); assert.ok(result.owned.has('owned-package'))
  assert.deepEqual(await readFile(f.previousReceiptPath), originalReceipt)
  assert.deepEqual(await readFile(join(f.paths.profile, 'cordis.patch.yml')), config)
})
test('guarded update rejects package drift', async t => {
  const f = await fixture(t); await writeFile(join(f.paths.profile, 'node_modules/owned-package/index.js'), 'foreign drift')
  await assert.rejects(readLiveUpdateReceipt(f.options), { code: 'LIVE_UPDATE_PACKAGE_DRIFT' })
})
test('guarded update rejects tampered, non-applied and foreign-root receipts', async t => {
  const f = await fixture(t)
  const tampered = JSON.parse(await readFile(f.previousReceiptPath, 'utf8')); tampered.status = 'rolled-back'
  await writeFile(f.previousReceiptPath, JSON.stringify(tampered)); await assert.rejects(readLiveUpdateReceipt(f.options), { code: 'LIVE_PREVIOUS_RECEIPT_INVALID' })
  await f.save({ ...f.receipt, status: 'rolled-back' }); await assert.rejects(readLiveUpdateReceipt(f.options), { code: 'LIVE_PREVIOUS_RECEIPT_INVALID' })
  await f.save({ ...f.receipt, profileRoot: resolve(f.root, 'foreign-profile') }); await assert.rejects(readLiveUpdateReceipt(f.options), { code: 'LIVE_PREVIOUS_RECEIPT_TARGET_MISMATCH' })
})
test('guarded update rejects removed packages and fabricated operation targets', async t => {
  const f = await fixture(t)
  await assert.rejects(readLiveUpdateReceipt({ ...f.options, packageNames: [] }), { code: 'LIVE_UPDATE_REMOVED_PACKAGE' })
  await f.save({ ...f.receipt, operations: [{ ...f.receipt.operations[0], target: '../../foreign' }, f.receipt.operations[1]] })
  await assert.rejects(readLiveUpdateReceipt(f.options), { code: 'LIVE_PREVIOUS_RECEIPT_OPERATIONS_INVALID' })
})
test('both old and new artifact fragments must match byte for byte', async t => {
  const f = await fixture(t), roots = ['old-ui', 'new-ui', 'old-policy', 'new-policy'].map(name => join(f.root, name))
  for (const root of roots) await mkdir(root)
  for (const root of roots.slice(0, 2)) await writeFile(join(root, 'fragment.yml'), '# same\r\n')
  for (const root of roots.slice(2)) await writeFile(join(root, 'cordis.policy.fragment.yml'), '# policy\n')
  const options = { oldUiRoot: roots[0], newUiRoot: roots[1], oldPolicyRoot: roots[2], newPolicyRoot: roots[3], oldUiFragment: 'fragment.yml', newUiFragment: 'fragment.yml' }
  await assertLiveUpdateFragments(options)
  await writeFile(join(roots[1], 'fragment.yml'), '# same\n')
  await assert.rejects(assertLiveUpdateFragments(options), { code: 'LIVE_UPDATE_FRAGMENT_CHANGED' })
  await writeFile(join(roots[1], 'fragment.yml'), '# same\r\n'); await writeFile(join(roots[3], 'cordis.policy.fragment.yml'), '# changed\n')
  await assert.rejects(assertLiveUpdateFragments(options), { code: 'LIVE_UPDATE_FRAGMENT_CHANGED' })
})
test('plan CLI forwards an explicit previous receipt and rejects a missing argument', () => {
  const args = ['--install-root', 'install', '--profile-root', 'profile', '--backup-root', 'backup', '--candidate-root', 'candidate']
  assert.equal(parsePlanArgs([...args, '--previous-receipt', 'previous.json'])['previous-receipt'], 'previous.json')
  assert.throws(() => parsePlanArgs([...args, '--previous-receipt']), { code: 'USAGE' })
})
