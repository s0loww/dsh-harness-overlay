import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficialDesktop } from '../../src/targets/official-desktop/target.mjs'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt, verifyReceiptIntegrity } from '../receipt.mjs'
import { beneath, DEFAULT_ARTIFACT, loadCandidate, OfficialUiInstallerError, verifyUiArtifact } from './common.mjs'

async function readReceipt(path) {
  let value
  try { value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new OfficialUiInstallerError('RECEIPT_INVALID_JSON', error.message) }
  if (!verifyReceiptIntegrity(value)) throw new OfficialUiInstallerError('RECEIPT_INTEGRITY_MISMATCH')
  if (value.schemaVersion !== 1 || value.status !== 'applied' || !Array.isArray(value.operations) || !Array.isArray(value.packageNames) || !Array.isArray(value.createdParents)) {
    throw new OfficialUiInstallerError('RECEIPT_INVALID')
  }
  return value
}

function exactPath(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(rel).startsWith(`${sep}${sep}`)
}

function expectedTargets(candidate, packageNames) {
  const map = new Map()
  for (const name of packageNames) {
    const target = join(candidate.modulesRoot, ...name.split('/'))
    map.set(relative(candidate.root, target).replaceAll('\\', '/'), { type: 'copy-directory', package: name })
  }
  map.set(relative(candidate.root, join(candidate.profileRoot, 'cordis.patch.yml')).replaceAll('\\', '/'), { type: 'merge-cordis-fragment' })
  map.set(relative(candidate.root, candidate.marker).replaceAll('\\', '/'), { type: 'ready-marker' })
  return map
}

async function recover(swaps) {
  const errors = []
  for (const swap of [...swaps].reverse()) {
    try {
      if (swap.restored && await pathKind(swap.target) !== 'missing') {
        if (!sameState(await targetState(swap.target), swap.record.before)) throw new OfficialUiInstallerError('ROLLBACK_RECOVERY_OWNERSHIP_MISMATCH', swap.record.target)
        await rm(swap.target, { recursive: true, force: true })
      }
      if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'ROLLBACK_RECOVERY_FAILED')
}

export async function rollbackOfficialUi({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath, receiptPath, failAfterOperation = 0 }) {
  const candidate = await loadCandidate(candidateRoot)
  const artifact = await verifyUiArtifact(artifactRoot)
  await verifyOfficialDesktop({ installRoot: candidate.installRoot, releaseLockPath })
  const receipt = await readReceipt(resolve(String(receiptPath ?? '')))
  if (receipt.artifact?.id !== artifact.manifest.artifact.id || receipt.artifact?.version !== artifact.manifest.artifact.version || receipt.artifactManifestSha256 !== artifact.manifestSha256) {
    throw new OfficialUiInstallerError('RECEIPT_ARTIFACT_MISMATCH')
  }
  const official = JSON.parse(await readFile(join(artifact.root, 'official-ui-manifest.json'), 'utf8'))
  const packageNames = official.packages.map(item => item.name)
  if (canonicalSorted(receipt.packageNames) !== canonicalSorted(packageNames)) throw new OfficialUiInstallerError('RECEIPT_PACKAGE_ALLOWLIST_MISMATCH')
  const backupRoot = beneath(candidate.root, receipt.backupRoot, 'receipt backup root')
  if (!exactPath(backupRoot, resolve(receiptPath)) || resolve(receiptPath) !== join(backupRoot, 'receipt.json')) throw new OfficialUiInstallerError('RECEIPT_LOCATION_MISMATCH')
  const allowed = expectedTargets(candidate, packageNames)
  const allowedParents = new Set(packageNames.filter(name => name.includes('/')).map(name => relative(candidate.root, dirname(join(candidate.modulesRoot, ...name.split('/')))).replaceAll('\\', '/')))
  if (new Set(receipt.createdParents).size !== receipt.createdParents.length || receipt.createdParents.some(item => !allowedParents.has(item))) {
    throw new OfficialUiInstallerError('RECEIPT_CREATED_PARENTS_INVALID')
  }
  if (receipt.operations.length !== allowed.size) throw new OfficialUiInstallerError('RECEIPT_OPERATION_COUNT_MISMATCH')
  const records = []
  const seen = new Set()
  for (const record of receipt.operations) {
    const expectation = allowed.get(record.target)
    if (!expectation || seen.has(record.target) || record.type !== expectation.type || record.package !== expectation.package) throw new OfficialUiInstallerError('RECEIPT_OPERATION_INVALID', record.target)
    seen.add(record.target)
    const target = beneath(candidate.root, record.target, 'receipt target')
    if (!record.before || !record.after || !sameState(await targetState(target), record.after)) throw new OfficialUiInstallerError('ROLLBACK_OWNERSHIP_MISMATCH', record.target)
    let backup = null
    if (record.before.type !== 'missing') {
      if (record.backup !== `before/${record.target}`) throw new OfficialUiInstallerError('RECEIPT_BACKUP_INVALID', record.target)
      backup = beneath(backupRoot, record.backup, 'receipt backup')
      if (!sameState(await targetState(backup), record.before)) throw new OfficialUiInstallerError('ROLLBACK_BACKUP_MISMATCH', record.target)
    } else if (record.backup !== null) throw new OfficialUiInstallerError('RECEIPT_BACKUP_INVALID', record.target)
    records.push({ ...record, targetPath: target, backupPath: backup })
  }

  const stageRoot = join(backupRoot, 'rollback-stage')
  if (await pathKind(stageRoot) !== 'missing') throw new OfficialUiInstallerError('ROLLBACK_STAGE_EXISTS')
  await mkdir(stageRoot, { recursive: true })
  const swaps = []
  try {
    for (const record of records) {
      let stage = null
      if (record.before.type !== 'missing') {
        stage = beneath(stageRoot, record.target, 'rollback stage')
        await mkdir(dirname(stage), { recursive: true })
        if (record.before.type === 'directory') await cp(record.backupPath, stage, { recursive: true, force: false, errorOnExist: true })
        else await cp(record.backupPath, stage, { force: false, errorOnExist: true })
        if (!sameState(await targetState(stage), record.before)) throw new OfficialUiInstallerError('ROLLBACK_STAGE_HASH_MISMATCH', record.target)
      }
      swaps.push({ record, target: record.targetPath, stage, quarantine: join(dirname(record.targetPath), `.${randomUUID()}.ui-rollback`), quarantined: false, restored: false })
    }

    let receiptCommitted = false
    try {
      for (const swap of swaps) {
        if (!sameState(await targetState(swap.target), swap.record.after)) throw new OfficialUiInstallerError('ROLLBACK_TARGET_RACE', swap.record.target)
        await rename(swap.target, swap.quarantine)
        swap.quarantined = true
      }
      let count = 0
      for (const swap of swaps) {
        if (swap.stage) {
          await mkdir(dirname(swap.target), { recursive: true })
          await rename(swap.stage, swap.target)
          swap.restored = true
        }
        count += 1
        if (failAfterOperation && count === failAfterOperation) throw new OfficialUiInstallerError('INJECTED_ROLLBACK_FAILURE')
      }
      for (const swap of swaps) if (!sameState(await targetState(swap.target), swap.record.before)) throw new OfficialUiInstallerError('ROLLBACK_VERIFY_FAILED', swap.record.target)
      let completed = sealReceipt({ ...receipt, status: 'rolled-back', cleanupPending: swaps.map(item => item.quarantine) })
      await atomicWrite(resolve(receiptPath), canonical(completed), { expectedCurrentState: await targetState(resolve(receiptPath)) })
      receiptCommitted = true
      const cleanupPending = []
      for (const swap of swaps) {
        try { await rm(swap.quarantine, { recursive: true, force: true }) }
        catch { cleanupPending.push(swap.quarantine) }
      }
      for (const item of [...receipt.createdParents].sort().reverse()) {
        const parent = beneath(candidate.root, item, 'created package parent')
        try { if ((await readdir(parent)).length === 0) await rmdir(parent) }
        catch { cleanupPending.push(parent) }
      }
      completed = sealReceipt({ ...completed, cleanupPending })
      await atomicWrite(resolve(receiptPath), canonical(completed), { expectedCurrentState: await targetState(resolve(receiptPath)) })
      await rm(stageRoot, { recursive: true, force: true })
      return { status: 'rolled-back', receiptPath: resolve(receiptPath), receipt: completed }
    } catch (error) {
      if (!receiptCommitted) await recover(swaps)
      throw error
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }
}

function canonicalSorted(values) { return JSON.stringify([...values].sort()) }

function parseArgs(argv) {
  const result = { artifact: DEFAULT_ARTIFACT, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { result.json = true; continue }
    if (!['--candidate-root', '--artifact', '--receipt'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    result[key.slice(2)] = argv[++index]
  }
  if (!result['candidate-root'] || !result.receipt) throw new OfficialUiInstallerError('USAGE', '--candidate-root and --receipt are required')
  return result
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await rollbackOfficialUi({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, receiptPath: args.receipt })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: result.status, receiptPath: result.receiptPath }, null, 2)}\n`)
  else process.stdout.write(`Official UI rolled back from candidate; receipt: ${result.receiptPath}\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
