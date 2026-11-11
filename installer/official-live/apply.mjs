import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt } from '../receipt.mjs'
import { assertDesktopStopped } from './process-guard.mjs'
import { buildLivePromotionPlan, DEFAULT_POLICY_ARTIFACT, DEFAULT_UI_ARTIFACT, liveProfileStageRoot, LIVE_ACKNOWLEDGEMENT, OfficialUiInstallerError } from './common.mjs'

async function copyChecked(source, destination, expected) {
  await mkdir(dirname(destination), { recursive: true })
  if (expected.type === 'directory') await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  else await cp(source, destination, { force: false, errorOnExist: true })
  if (!sameState(await targetState(destination), expected)) throw new OfficialUiInstallerError('LIVE_STAGE_HASH_MISMATCH')
}

export async function stagePackage(operation, stage) {
  if (operation.type === 'copy-directory') return copyChecked(operation.source, stage, operation.after)
  if (operation.type !== 'copy-directory-with-nested-dependency') throw new OfficialUiInstallerError('LIVE_OPERATION_INVALID')
  await cp(operation.source, stage, { recursive: true, force: false, errorOnExist: true })
  const nestedTarget = join(stage, ...operation.nestedDependency.targetRelative.split('/'))
  await mkdir(dirname(nestedTarget), { recursive: true })
  await cp(operation.nestedDependency.source, nestedTarget, { recursive: true, force: false, errorOnExist: true })
  if (!sameState(await targetState(stage), operation.after)) throw new OfficialUiInstallerError('LIVE_STAGE_HASH_MISMATCH', operation.targetRelative)
}

async function recover(swaps) {
  const errors = []
  for (const swap of [...swaps].reverse()) {
    try {
      if (swap.installed && await pathKind(swap.target) !== 'missing') await rm(swap.target, { recursive: true, force: true })
      if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'LIVE_PROMOTION_RECOVERY_FAILED')
}

export async function applyLivePromotion(options) {
  if (options?.acknowledgement !== LIVE_ACKNOWLEDGEMENT) throw new OfficialUiInstallerError('LIVE_ACKNOWLEDGEMENT_REQUIRED')
  const plan = await buildLivePromotionPlan(options)
  if (plan.status !== 'ready') throw new OfficialUiInstallerError('LIVE_PLAN_BLOCKED')
  await assertDesktopStopped(plan.installRoot)
  await mkdir(dirname(plan.backupRoot), { recursive: true })
  await mkdir(plan.backupRoot, { recursive: false })
  const stageRoot = liveProfileStageRoot(plan.profileRoot, 'apply', randomUUID()), beforeRoot = join(plan.backupRoot, 'before')
  if (await pathKind(stageRoot) !== 'missing') throw new OfficialUiInstallerError('LIVE_STAGE_EXISTS')
  await mkdir(beforeRoot); await mkdir(stageRoot)
  const records = []
  try {
    for (const operation of plan.operations) {
      const stage = join(stageRoot, operation.targetRelative)
      await mkdir(dirname(stage), { recursive: true })
      if (['copy-directory', 'copy-directory-with-nested-dependency'].includes(operation.type)) await stagePackage(operation, stage)
      else if (operation.type === 'merge-cordis') {
        await writeFile(stage, operation.content, 'utf8')
        if (!sameState(await targetState(stage), operation.after)) throw new OfficialUiInstallerError('LIVE_STAGE_HASH_MISMATCH', operation.targetRelative)
      } else throw new OfficialUiInstallerError('LIVE_OPERATION_INVALID')
      let backup = null
      if (operation.before.type !== 'missing') {
        backup = `before/${operation.targetRelative}`
        await copyChecked(operation.target, join(plan.backupRoot, backup), operation.before)
      }
      records.push({ operation, stage, backup })
    }
    const cordisRecord = records.find(row => row.operation.type === 'merge-cordis')
    if (!cordisRecord) throw new OfficialUiInstallerError('LIVE_CORDIS_SNAPSHOT_REQUIRED')
    await copyChecked(cordisRecord.stage, join(plan.backupRoot, 'after/cordis.patch.yml'), cordisRecord.operation.after)
    const receipt = sealReceipt({
      schemaVersion: 1,
      status: 'pending',
      target: plan.target,
      installRoot: plan.installRoot,
      profileRoot: plan.profileRoot,
      backupRoot: plan.backupRoot,
      artifacts: plan.artifacts,
      certification: plan.certification,
      artifactPackageNames: plan.artifactPackageNames,
      dependencyResolution: plan.dependencyResolution,
      previousPromotion: plan.previousPromotion,
      cordisAfterSnapshot: 'after/cordis.patch.yml',
      transactionStage: { strategy: 'profile-same-volume', directory: relative(plan.profileRoot, stageRoot).replaceAll('\\', '/') },
      planSignature: plan.signature,
      packageNames: plan.packageNames,
      operations: records.map(({ operation, backup }) => ({ type: operation.type, package: operation.package, target: operation.targetRelative, before: operation.before, after: operation.after, backup })),
      cleanupPending: [],
    })
    const pendingPath = join(plan.backupRoot, 'receipt.pending.json')
    await writeFile(pendingPath, canonical(receipt), { flag: 'wx' })
    const rechecked = await buildLivePromotionPlan({ ...options, allowExistingBackup: true })
    await assertDesktopStopped(plan.installRoot)
    if (rechecked.status !== 'ready' || rechecked.signature !== plan.signature) throw new OfficialUiInstallerError('LIVE_PLAN_CHANGED_BEFORE_COMMIT')
    const targetRecordsUnchanged = await Promise.all(records.map(async row => sameState(await targetState(row.operation.target), row.operation.before)))
    if (!targetRecordsUnchanged.every(Boolean)) throw new OfficialUiInstallerError('LIVE_TARGET_CHANGED_BEFORE_COMMIT')
    const swaps = records.map(row => ({ row, target: row.operation.target, stage: row.stage, quarantine: join(dirname(row.operation.target), `.${randomUUID()}.airules-live-owned`), quarantined: false, installed: false }))
    let committed = false
    try {
      for (const swap of swaps) {
        if (swap.row.operation.before.type === 'missing') continue
        await rename(swap.target, swap.quarantine); swap.quarantined = true
      }
      for (const swap of swaps) {
        await mkdir(dirname(swap.target), { recursive: true })
        await rename(swap.stage, swap.target); swap.installed = true
      }
      for (const swap of swaps) if (!sameState(await targetState(swap.target), swap.row.operation.after)) throw new OfficialUiInstallerError('LIVE_APPLY_VERIFY_FAILED', swap.row.operation.targetRelative)
      const receiptPath = join(plan.backupRoot, 'receipt.json')
      let applied = sealReceipt({ ...receipt, status: 'applied', cleanupPending: swaps.filter(row => row.quarantined).map(row => row.quarantine) })
      await atomicWrite(receiptPath, canonical(applied)); committed = true
      const cleanupPending = []
      for (const swap of swaps.filter(row => row.quarantined)) { try { await rm(swap.quarantine, { recursive: true, force: true }) } catch { cleanupPending.push(swap.quarantine) } }
      try { await rm(stageRoot, { recursive: true, force: true }) } catch { cleanupPending.push(stageRoot) }
      applied = sealReceipt({ ...applied, cleanupPending })
      await atomicWrite(receiptPath, canonical(applied), { expectedCurrentState: await targetState(receiptPath) })
      await rm(pendingPath, { force: true })
      return Object.freeze({ status: 'applied', receiptPath, receipt: applied, plan })
    } catch (error) { if (!committed) await recover(swaps); throw error }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    const restored = await Promise.all(records.map(async row => sameState(await targetState(row.operation.target), row.operation.before)))
    if (restored.every(Boolean)) await rm(plan.backupRoot, { recursive: true, force: true })
    throw error
  }
}

function parseArgs(argv) {
  const args = { 'ui-artifact': DEFAULT_UI_ARTIFACT, 'policy-artifact': DEFAULT_POLICY_ARTIFACT }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--install-root', '--profile-root', '--backup-root', '--candidate-root', '--ui-artifact', '--policy-artifact', '--release-lock', '--acknowledge', '--previous-receipt', '--migrate-owned-fragments'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    args[key.slice(2)] = argv[++index]
  }
  for (const key of ['install-root', 'profile-root', 'backup-root', 'candidate-root', 'acknowledge']) if (!args[key]) throw new OfficialUiInstallerError('USAGE', `--${key} is required`)
  if (args['migrate-owned-fragments'] !== undefined && !['true', 'false'].includes(args['migrate-owned-fragments'])) throw new OfficialUiInstallerError('USAGE')
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await applyLivePromotion({ installRoot: args['install-root'], profileRoot: args['profile-root'], backupRoot: args['backup-root'], candidateRoot: args['candidate-root'], uiArtifactRoot: args['ui-artifact'], policyArtifactRoot: args['policy-artifact'], releaseLockPath: args['release-lock'], acknowledgement: args.acknowledge, previousReceiptPath: args['previous-receipt'], allowOwnedFragmentMigration: args['migrate-owned-fragments'] === 'true' })
  process.stdout.write(`Live promotion applied; receipt: ${result.receiptPath}\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
