import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt } from '../receipt.mjs'
import { beneath, buildOfficialUiInstallPlan, DEFAULT_ARTIFACT, OfficialUiInstallerError } from './common.mjs'
import { mergeUiCordis } from './ui-cordis.mjs'

async function copyChecked(source, destination, expected) {
  await mkdir(dirname(destination), { recursive: true })
  if (expected.type === 'directory') await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  else if (expected.type === 'file') await cp(source, destination, { force: false, errorOnExist: true })
  else throw new OfficialUiInstallerError('COPY_STATE_INVALID')
  if (!sameState(await targetState(destination), expected)) throw new OfficialUiInstallerError('COPY_HASH_MISMATCH', destination)
}

function receiptFor(plan, records, createdParents) {
  return sealReceipt({
    schemaVersion: 1,
    status: 'pending',
    artifact: plan.artifact,
    target: plan.target,
    artifactManifestSha256: plan.artifactManifestSha256,
    backupRoot: plan.backupRootRelative,
    packageNames: plan.operations.filter(item => item.package).map(item => item.package),
    createdParents,
    operations: records.map(record => ({
      type: record.operation.type,
      package: record.operation.package,
      target: record.operation.targetRelative,
      before: record.before,
      after: record.after,
      backup: record.backupRelative,
    })),
    cleanupPending: [],
  })
}

async function recover(swaps) {
  const errors = []
  for (const swap of [...swaps].reverse()) {
    try {
      if (swap.installed && await pathKind(swap.target) !== 'missing') {
        if (!sameState(await targetState(swap.target), swap.record.after)) throw new OfficialUiInstallerError('RECOVERY_OWNERSHIP_MISMATCH', swap.record.operation.targetRelative)
        await rm(swap.target, { recursive: true, force: true })
      }
      if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'OFFICIAL_UI_RECOVERY_FAILED')
}

export async function applyOfficialUi({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath, replaceCollisions = false, failAfterOperation = 0 }) {
  const plan = await buildOfficialUiInstallPlan({ candidateRoot, artifactRoot, releaseLockPath, replaceCollisions })
  if (plan.status !== 'ready') throw new OfficialUiInstallerError('PLAN_BLOCKED')
  const backupRoot = beneath(plan.candidateRoot, plan.backupRootRelative, 'backup root')
  if (await pathKind(backupRoot) !== 'missing') throw new OfficialUiInstallerError('BACKUP_ALREADY_EXISTS')
  const stageRoot = join(backupRoot, 'stage'), beforeRoot = join(backupRoot, 'before')
  await mkdir(stageRoot, { recursive: true })
  await mkdir(beforeRoot, { recursive: true })
  const records = []
  const createdParents = []
  try {
    for (const operation of plan.operations) {
      if (operation.package?.includes('/')) {
        const parent = dirname(operation.target)
        if (await pathKind(parent) === 'missing') createdParents.push(relative(plan.candidateRoot, parent).replaceAll('\\', '/'))
      }
      const stage = beneath(stageRoot, operation.targetRelative, 'stage target')
      await mkdir(dirname(stage), { recursive: true })
      if (operation.type === 'copy-directory') await copyChecked(operation.source, stage, operation.after)
      else if (operation.type === 'merge-cordis-fragment') {
        const current = operation.before.type === 'file' ? await readFile(operation.target, 'utf8') : ''
        const fragment = await readFile(operation.source, 'utf8')
        const merged = mergeUiCordis(current, fragment, { replaceCollision: replaceCollisions }).text
        await writeFile(stage, merged, 'utf8')
        if (!sameState(await targetState(stage), operation.after)) throw new OfficialUiInstallerError('STAGE_HASH_MISMATCH', operation.targetRelative)
      } else if (operation.type === 'ready-marker') {
        await writeFile(stage, operation.content, 'utf8')
        if (!sameState(await targetState(stage), operation.after)) throw new OfficialUiInstallerError('STAGE_HASH_MISMATCH', operation.targetRelative)
      } else throw new OfficialUiInstallerError('OPERATION_INVALID')

      let backupRelative = null
      if (operation.before.type !== 'missing') {
        backupRelative = `before/${operation.targetRelative}`
        await copyChecked(operation.target, beneath(backupRoot, backupRelative, 'backup target'), operation.before)
      }
      records.push({ operation, target: operation.target, stage, before: operation.before, after: operation.after, backupRelative })
    }

    const uniqueCreatedParents = [...new Set(createdParents)].sort()
    const pending = receiptFor(plan, records, uniqueCreatedParents)
    const pendingPath = join(backupRoot, 'receipt.pending.json')
    await writeFile(pendingPath, canonical(pending), { encoding: 'utf8', flag: 'wx' })
    const rechecked = await buildOfficialUiInstallPlan({ candidateRoot, artifactRoot, releaseLockPath, replaceCollisions })
    if (rechecked.status !== 'ready' || rechecked.signature !== plan.signature) throw new OfficialUiInstallerError('PLAN_CHANGED_BEFORE_COMMIT')
    for (const record of records) if (!sameState(await targetState(record.target), record.before)) throw new OfficialUiInstallerError('TARGET_CHANGED_BEFORE_COMMIT', record.operation.targetRelative)

    const swaps = records.map(record => ({ record, target: record.target, stage: record.stage, quarantine: join(dirname(record.target), `.${randomUUID()}.ui-owned`), quarantined: false, installed: false }))
    let receiptCommitted = false
    try {
      for (const swap of swaps) {
        if (swap.record.before.type === 'missing') continue
        if (!sameState(await targetState(swap.target), swap.record.before)) throw new OfficialUiInstallerError('TARGET_RACE', swap.record.operation.targetRelative)
        await rename(swap.target, swap.quarantine)
        swap.quarantined = true
      }
      let count = 0
      for (const swap of swaps) {
        await mkdir(dirname(swap.target), { recursive: true })
        await rename(swap.stage, swap.target)
        swap.installed = true
        count += 1
        if (failAfterOperation && count === failAfterOperation) throw new OfficialUiInstallerError('INJECTED_APPLY_FAILURE')
      }
      for (const swap of swaps) if (!sameState(await targetState(swap.target), swap.record.after)) throw new OfficialUiInstallerError('APPLY_VERIFY_FAILED', swap.record.operation.targetRelative)
      const receiptPath = join(backupRoot, 'receipt.json')
      let receipt = sealReceipt({ ...pending, status: 'applied', cleanupPending: swaps.filter(item => item.quarantined).map(item => item.quarantine) })
      await atomicWrite(receiptPath, canonical(receipt))
      receiptCommitted = true
      const cleanupPending = []
      for (const swap of swaps) {
        if (!swap.quarantined) continue
        try { await rm(swap.quarantine, { recursive: true, force: true }) }
        catch { cleanupPending.push(swap.quarantine) }
      }
      receipt = sealReceipt({ ...receipt, cleanupPending })
      await atomicWrite(receiptPath, canonical(receipt), { expectedCurrentState: await targetState(receiptPath) })
      await rm(pendingPath, { force: true })
      return { status: 'applied', receiptPath, receipt, plan }
    } catch (error) {
      if (!receiptCommitted) await recover(swaps)
      throw error
    }
  } catch (error) {
    if (await pathKind(backupRoot) !== 'missing') {
      const targetsRestored = await Promise.all(records.map(async record => sameState(await targetState(record.target), record.before)))
      if (targetsRestored.every(Boolean)) await rm(backupRoot, { recursive: true, force: true })
    }
    for (const item of [...new Set(createdParents)].sort().reverse()) {
      const parent = beneath(plan.candidateRoot, item, 'created package parent')
      try { if ((await readdir(parent)).length === 0) await rmdir(parent) } catch {}
    }
    throw error
  }
}

function parseArgs(argv) {
  const result = { artifact: DEFAULT_ARTIFACT, replaceCollisions: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--replace-collisions') { result.replaceCollisions = true; continue }
    if (key === '--json') { result.json = true; continue }
    if (!['--candidate-root', '--artifact'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    result[key.slice(2)] = argv[++index]
  }
  if (!result['candidate-root']) throw new OfficialUiInstallerError('USAGE', '--candidate-root is required')
  return result
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await applyOfficialUi({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, replaceCollisions: args.replaceCollisions })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: result.status, receiptPath: result.receiptPath }, null, 2)}\n`)
  else process.stdout.write(`Official UI applied to candidate; receipt: ${result.receiptPath}\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
