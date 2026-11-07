import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficialDesktop } from '../../src/targets/official-desktop/target.mjs'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt, verifyReceiptIntegrity } from '../receipt.mjs'
import { beneath, DEFAULT_ARTIFACT, DEFAULT_RELEASE_LOCK, loadCandidate, OfficialUiInstallerError, POLICY_PACKAGES, verifyPolicyArtifact } from './common.mjs'

export async function rollbackOfficialPolicy({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK, receiptPath, failAfterOperation = 0 }) {
  const candidate = await loadCandidate(candidateRoot), artifact = await verifyPolicyArtifact(artifactRoot)
  await verifyOfficialDesktop({ installRoot: candidate.installRoot, releaseLockPath })
  let receipt
  try { receipt = JSON.parse(await readFile(resolve(receiptPath), 'utf8')) } catch { throw new OfficialUiInstallerError('RECEIPT_INVALID') }
  if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'applied' || receipt.artifact?.id !== artifact.manifest.artifact.id || receipt.artifactManifestSha256 !== artifact.manifestSha256) throw new OfficialUiInstallerError('RECEIPT_INVALID')
  if (JSON.stringify([...receipt.packageNames].sort()) !== JSON.stringify([...artifact.packageNames].sort())) throw new OfficialUiInstallerError('RECEIPT_PACKAGE_ALLOWLIST_MISMATCH')
  const expected = new Map(artifact.packageNames.map(name => [`home/profiles/desktop/node_modules/${name}`, { type: 'copy-directory', package: name }]))
  expected.set('home/profiles/desktop/cordis.patch.yml', { type: 'merge-cordis-fragment', package: undefined }); expected.set('policy-ready.json', { type: 'ready-marker', package: undefined })
  if (receipt.operations.length !== expected.size) throw new OfficialUiInstallerError('RECEIPT_OPERATION_COUNT_MISMATCH')
  const backupRoot = beneath(candidate.root, receipt.backupRoot, 'policy receipt backup'), records = [], seen = new Set()
  if (resolve(receiptPath) !== join(backupRoot, 'receipt.json')) throw new OfficialUiInstallerError('RECEIPT_LOCATION_MISMATCH')
  for (const row of receipt.operations) {
    const exp = expected.get(row.target)
    if (!exp || seen.has(row.target) || row.type !== exp.type || row.package !== exp.package) throw new OfficialUiInstallerError('RECEIPT_OPERATION_INVALID')
    seen.add(row.target); const target = beneath(candidate.root, row.target, 'policy receipt target')
    if (!sameState(await targetState(target), row.after)) throw new OfficialUiInstallerError('ROLLBACK_OWNERSHIP_MISMATCH')
    const backup = row.before.type === 'missing' ? null : beneath(backupRoot, `before/${row.target}`, 'policy receipt before')
    if (backup && !sameState(await targetState(backup), row.before)) throw new OfficialUiInstallerError('ROLLBACK_BACKUP_MISMATCH')
    records.push({ ...row, targetPath: target, backupPath: backup })
  }
  const stageRoot = join(backupRoot, 'rollback-stage'); if (await pathKind(stageRoot) !== 'missing') throw new OfficialUiInstallerError('ROLLBACK_STAGE_EXISTS')
  await mkdir(stageRoot, { recursive: true }); const swaps = []
  try {
    for (const row of records) {
      let stage = null
      if (row.backupPath) { stage = beneath(stageRoot, row.target, 'policy rollback stage'); await mkdir(dirname(stage), { recursive: true }); if (row.before.type === 'directory') await cp(row.backupPath, stage, { recursive: true }); else await cp(row.backupPath, stage); if (!sameState(await targetState(stage), row.before)) throw new OfficialUiInstallerError('ROLLBACK_STAGE_HASH_MISMATCH') }
      swaps.push({ row, target: row.targetPath, stage, quarantine: join(dirname(row.targetPath), `.${randomUUID()}.policy-rollback`), quarantined: false, restored: false })
    }
    let committed = false
    try {
      for (const swap of swaps) { if (!sameState(await targetState(swap.target), swap.row.after)) throw new OfficialUiInstallerError('ROLLBACK_TARGET_RACE'); await rename(swap.target, swap.quarantine); swap.quarantined = true }
      let count = 0
      for (const swap of swaps) { if (swap.stage) { await mkdir(dirname(swap.target), { recursive: true }); await rename(swap.stage, swap.target); swap.restored = true } if (failAfterOperation && ++count === failAfterOperation) throw new OfficialUiInstallerError('INJECTED_POLICY_ROLLBACK_FAILURE') }
      let completed = sealReceipt({ ...receipt, status: 'rolled-back', cleanupPending: swaps.map(row => row.quarantine) })
      await atomicWrite(resolve(receiptPath), canonical(completed), { expectedCurrentState: await targetState(resolve(receiptPath)) }); committed = true
      for (const swap of swaps) await rm(swap.quarantine, { recursive: true, force: true })
      completed = sealReceipt({ ...completed, cleanupPending: [] }); await atomicWrite(resolve(receiptPath), canonical(completed), { expectedCurrentState: await targetState(resolve(receiptPath)) })
      await rm(stageRoot, { recursive: true, force: true }); return { status: 'rolled-back', receiptPath: resolve(receiptPath), receipt: completed }
    } catch (error) {
      if (!committed) for (const swap of [...swaps].reverse()) { if (swap.restored && await pathKind(swap.target) !== 'missing') await rm(swap.target, { recursive: true, force: true }); if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target) }
      throw error
    }
  } catch (error) { await rm(stageRoot, { recursive: true, force: true }); throw error }
}

export async function main(argv = process.argv.slice(2)) {
  const args = { artifact: DEFAULT_ARTIFACT }
  for (let i = 0; i < argv.length; i += 1) { if (!['--candidate-root', '--artifact', '--receipt'].includes(argv[i]) || !argv[i + 1]) throw new OfficialUiInstallerError('USAGE'); args[argv[i++].slice(2)] = argv[i] }
  if (!args['candidate-root'] || !args.receipt) throw new OfficialUiInstallerError('USAGE')
  const result = await rollbackOfficialPolicy({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, receiptPath: args.receipt })
  process.stdout.write(`Official policy rolled back; receipt: ${result.receiptPath}\n`); return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
