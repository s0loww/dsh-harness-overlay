import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt } from '../receipt.mjs'
import { beneath, buildOfficialPolicyPlan, DEFAULT_ARTIFACT, OfficialUiInstallerError } from './common.mjs'
import { mergePolicyCordis } from './policy-cordis.mjs'

async function copyChecked(source, target, expected) {
  await mkdir(dirname(target), { recursive: true })
  if (expected.type === 'directory') await cp(source, target, { recursive: true, force: false, errorOnExist: true })
  else await cp(source, target, { force: false, errorOnExist: true })
  if (!sameState(await targetState(target), expected)) throw new OfficialUiInstallerError('POLICY_COPY_HASH_MISMATCH')
}

async function recover(swaps) {
  for (const swap of [...swaps].reverse()) {
    if (swap.installed && await pathKind(swap.target) !== 'missing') await rm(swap.target, { recursive: true, force: true })
    if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
  }
}

export async function applyOfficialPolicy({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath, replaceCollisions = false, failAfterOperation = 0 }) {
  const plan = await buildOfficialPolicyPlan({ candidateRoot, artifactRoot, releaseLockPath, replaceCollisions })
  if (plan.status !== 'ready') throw new OfficialUiInstallerError('PLAN_BLOCKED')
  const backupRoot = beneath(plan.candidateRoot, plan.backupRootRelative, 'policy backup')
  if (await pathKind(backupRoot) !== 'missing') throw new OfficialUiInstallerError('BACKUP_ALREADY_EXISTS')
  const stageRoot = join(backupRoot, 'stage'), beforeRoot = join(backupRoot, 'before')
  await mkdir(stageRoot, { recursive: true }); await mkdir(beforeRoot, { recursive: true })
  const records = []
  try {
    for (const op of plan.operations) {
      const stage = beneath(stageRoot, op.targetRelative, 'policy stage'); await mkdir(dirname(stage), { recursive: true })
      if (op.type === 'copy-directory') await copyChecked(op.source, stage, op.after)
      else if (op.type === 'merge-cordis-fragment') {
        const current = op.before.type === 'file' ? await readFile(op.target, 'utf8') : ''
        await writeFile(stage, mergePolicyCordis(current, await readFile(op.source, 'utf8'), { replaceCollisions }).text, 'utf8')
      } else if (op.type === 'ready-marker') await writeFile(stage, op.content, 'utf8')
      else throw new OfficialUiInstallerError('POLICY_OPERATION_INVALID')
      if (!sameState(await targetState(stage), op.after)) throw new OfficialUiInstallerError('POLICY_STAGE_HASH_MISMATCH', op.targetRelative)
      let backup = null
      if (op.before.type !== 'missing') { backup = `before/${op.targetRelative}`; await copyChecked(op.target, beneath(backupRoot, backup, 'policy before'), op.before) }
      records.push({ operation: op, target: op.target, stage, before: op.before, after: op.after, backup })
    }
    const pending = sealReceipt({ schemaVersion: 1, status: 'pending', artifact: plan.artifact, target: plan.target, artifactManifestSha256: plan.artifactManifestSha256,
      backupRoot: plan.backupRootRelative, packageNames: records.filter(row => row.operation.package).map(row => row.operation.package), operations: records.map(row => ({ type: row.operation.type, package: row.operation.package,
        target: row.operation.targetRelative, before: row.before, after: row.after, backup: row.backup })), cleanupPending: [] })
    await writeFile(join(backupRoot, 'receipt.pending.json'), canonical(pending), { flag: 'wx' })
    const check = await buildOfficialPolicyPlan({ candidateRoot, artifactRoot, releaseLockPath, replaceCollisions })
    if (check.status !== 'ready' || check.signature !== plan.signature) throw new OfficialUiInstallerError('PLAN_CHANGED_BEFORE_COMMIT')
    const swaps = records.map(row => ({ record: row, target: row.target, stage: row.stage, quarantine: join(dirname(row.target), `.${randomUUID()}.policy-owned`), quarantined: false, installed: false }))
    let committed = false
    try {
      for (const swap of swaps) if (swap.record.before.type !== 'missing') { if (!sameState(await targetState(swap.target), swap.record.before)) throw new OfficialUiInstallerError('POLICY_TARGET_RACE'); await rename(swap.target, swap.quarantine); swap.quarantined = true }
      let count = 0
      for (const swap of swaps) { await mkdir(dirname(swap.target), { recursive: true }); await rename(swap.stage, swap.target); swap.installed = true; if (failAfterOperation && ++count === failAfterOperation) throw new OfficialUiInstallerError('INJECTED_POLICY_APPLY_FAILURE') }
      for (const swap of swaps) if (!sameState(await targetState(swap.target), swap.record.after)) throw new OfficialUiInstallerError('POLICY_APPLY_VERIFY_FAILED')
      const receiptPath = join(backupRoot, 'receipt.json')
      let receipt = sealReceipt({ ...pending, status: 'applied', cleanupPending: swaps.filter(row => row.quarantined).map(row => row.quarantine) })
      await atomicWrite(receiptPath, canonical(receipt)); committed = true
      const cleanupPending = []
      for (const swap of swaps.filter(row => row.quarantined)) { try { await rm(swap.quarantine, { recursive: true, force: true }) } catch { cleanupPending.push(swap.quarantine) } }
      receipt = sealReceipt({ ...receipt, cleanupPending }); await atomicWrite(receiptPath, canonical(receipt), { expectedCurrentState: await targetState(receiptPath) })
      await rm(join(backupRoot, 'receipt.pending.json'), { force: true })
      return { status: 'applied', receiptPath, receipt, plan }
    } catch (error) { if (!committed) await recover(swaps); throw error }
  } catch (error) {
    const restored = await Promise.all(records.map(async row => sameState(await targetState(row.target), row.before)))
    if (restored.every(Boolean)) await rm(backupRoot, { recursive: true, force: true })
    throw error
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = { artifact: DEFAULT_ARTIFACT, replaceCollisions: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--replace-collisions') { args.replaceCollisions = true; continue }
    if (!['--candidate-root', '--artifact'].includes(argv[i]) || !argv[i + 1]) throw new OfficialUiInstallerError('USAGE')
    args[argv[i++].slice(2)] = argv[i]
  }
  if (!args['candidate-root']) throw new OfficialUiInstallerError('USAGE')
  const result = await applyOfficialPolicy({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, replaceCollisions: args.replaceCollisions })
  process.stdout.write(`Official policy applied to candidate; receipt: ${result.receiptPath}\n`); return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
