import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  atomicWrite,
  canonical,
  pathKind,
  sameState,
  targetState,
} from './fs-state.mjs'
import { DEFAULT_BASELINE, verifyInstalledBaseline } from './plan.mjs'
import { backupDirectoryName, sealReceipt, verifyReceiptIntegrity } from './receipt.mjs'

const FIXED_TARGETS = new Map([
  ['.dsh-1c/home/profiles/node_modules/airules-dsh-provider', 'directory'],
  ['.dsh-1c/home/profiles/node_modules/airules-dsh-rulepack', 'directory'],
  ['dsh-1c-bundle/cordis.patch.yml', 'file'],
])

export class RollbackError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'RollbackError'
    this.code = code
  }
}

function portable(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new RollbackError('UNSAFE_RECEIPT_PATH', label)
  if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new RollbackError('UNSAFE_RECEIPT_PATH', label)
  return value
}

function beneath(root, rel, label) {
  const target = resolve(root, ...portable(rel, label).split('/'))
  const check = relative(resolve(root), target)
  if (!check || check.startsWith('..') || isAbsolute(check)) throw new RollbackError('UNSAFE_RECEIPT_PATH', label)
  return target
}

async function readReceipt(path) {
  let receipt
  try {
    receipt = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new RollbackError('RECEIPT_INVALID', error.message)
  }
  if (!verifyReceiptIntegrity(receipt)) throw new RollbackError('RECEIPT_INTEGRITY_MISMATCH')
  if (receipt.schemaVersion !== 1 || receipt.status !== 'applied' || !receipt.release || !receipt.overlay || !Array.isArray(receipt.operations)) {
    throw new RollbackError('RECEIPT_INVALID')
  }
  return receipt
}

function validateReceipt(root, receiptPath, receipt) {
  const expectedBackupRoot = `.airules-backups/${backupDirectoryName(receipt.overlay)}`
  if (receipt.backupRoot !== expectedBackupRoot) throw new RollbackError('RECEIPT_BACKUP_ROOT_MISMATCH')
  const backupRoot = beneath(root, receipt.backupRoot, 'backup root')
  if (resolve(receiptPath) !== join(backupRoot, 'receipt.json')) throw new RollbackError('RECEIPT_LOCATION_MISMATCH')
  const seen = new Set()
  const allowedTargets = new Map(FIXED_TARGETS)
  const patchFiles = new Map()
  if (receipt.overlaySchemaVersion === 2) {
    if (!receipt.releasePatch?.required || receipt.releasePatch.engine !== 'exact-text-replacements/v1' || !Array.isArray(receipt.releasePatch.files)) {
      throw new RollbackError('RECEIPT_RELEASE_PATCH_INVALID')
    }
    for (const file of receipt.releasePatch.files) {
      portable(file.target, 'release patch target')
      const parts = file.target.split('/')
      const allowedRoot = file.target.startsWith('scripts/') || file.target.startsWith('dsh-1c-bundle/')
      if (!allowedRoot || parts.includes('.desktop-local') || parts.includes('.dsh-1c') ||
          allowedTargets.has(file.target) || patchFiles.has(file.target) || !/^[a-f0-9]{64}$/u.test(file.sourceSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(file.resultSha256 ?? '')) {
        throw new RollbackError('RECEIPT_RELEASE_PATCH_INVALID', file.target)
      }
      allowedTargets.set(file.target, 'file')
      patchFiles.set(file.target, file)
    }
  } else if (receipt.overlaySchemaVersion !== 1 || receipt.releasePatch !== null) {
    throw new RollbackError('RECEIPT_SCHEMA_INVALID')
  }
  for (const record of receipt.operations) {
    portable(record.target, 'target')
    const expectedKind = allowedTargets.get(record.target)
    if (!expectedKind || record.kind !== expectedKind || seen.has(record.target)) throw new RollbackError('RECEIPT_OPERATION_INVALID', record.target)
    seen.add(record.target)
    if (!record.before || !record.after || record.after.type !== expectedKind) throw new RollbackError('RECEIPT_STATE_INVALID', record.target)
    const patchFile = patchFiles.get(record.target)
    if (patchFile) {
      if (record.patch !== true || record.patchId !== receipt.releasePatch.id || record.before.sha256 !== patchFile.sourceSha256 || record.after.sha256 !== patchFile.resultSha256) {
        throw new RollbackError('RECEIPT_RELEASE_PATCH_INVALID', record.target)
      }
    } else if (record.patch === true) throw new RollbackError('RECEIPT_RELEASE_PATCH_INVALID', record.target)
    if (record.before.type === 'missing') {
      if (record.backup !== null) throw new RollbackError('RECEIPT_BACKUP_INVALID', record.target)
    } else {
      if (record.before.type !== expectedKind || record.backup !== record.target) throw new RollbackError('RECEIPT_BACKUP_INVALID', record.target)
    }
  }
  if (!seen.has('.dsh-1c/home/profiles/node_modules/airules-dsh-provider') ||
      !seen.has('.dsh-1c/home/profiles/node_modules/airules-dsh-rulepack')) {
    throw new RollbackError('RECEIPT_OPERATION_SET_INCOMPLETE')
  }
  if ([...patchFiles.keys()].some(target => !seen.has(target))) throw new RollbackError('RECEIPT_OPERATION_SET_INCOMPLETE')
  return backupRoot
}

export async function rollbackOverlay({ installRoot, receiptPath, baselinePath = DEFAULT_BASELINE }) {
  const root = resolve(installRoot)
  const absoluteReceipt = resolve(receiptPath)
  const receipt = await readReceipt(absoluteReceipt)
  const backupRoot = validateReceipt(root, absoluteReceipt, receipt)
  const acceptedSourceHashes = {}
  for (const file of receipt.releasePatch?.files ?? []) acceptedSourceHashes[file.target] = [file.resultSha256]
  const { baseline } = await verifyInstalledBaseline({ installRoot: root, baselinePath, acceptedSourceHashes })
  for (const file of receipt.releasePatch?.files ?? []) {
    if (baseline.sourceFiles?.[file.target] !== file.sourceSha256) {
      throw new RollbackError('RECEIPT_RELEASE_PATCH_BASELINE_MISMATCH', file.target)
    }
  }
  if (baseline.releaseId !== receipt.release.releaseId || baseline.product !== receipt.release.product) {
    throw new RollbackError('RECEIPT_RELEASE_MISMATCH')
  }

  for (const record of receipt.operations) {
    const target = beneath(root, record.target, 'target')
    const current = await targetState(target)
    if (!sameState(current, record.after)) throw new RollbackError('OWNERSHIP_HASH_MISMATCH', record.target)
    if (record.before.type !== 'missing') {
      const backup = beneath(backupRoot, record.backup, 'backup')
      const backupState = await targetState(backup)
      if (!sameState(backupState, record.before)) throw new RollbackError('BACKUP_HASH_MISMATCH', record.target)
    }
  }

  const swaps = []
  try {
    for (const record of receipt.operations) {
      const target = beneath(root, record.target, 'target')
      const stage = join(dirname(target), `.${randomUUID()}.rollback-stage`)
      const quarantine = join(dirname(target), `.${randomUUID()}.rollback-owned`)
      const swap = { record, target, stage, quarantine, quarantined: false, installed: false }
      swaps.push(swap)
      if (record.before.type !== 'missing') {
        const backup = beneath(backupRoot, record.backup, 'backup')
        await mkdir(dirname(target), { recursive: true })
        if (record.before.type === 'directory') await cp(backup, stage, { recursive: true, force: false, errorOnExist: true })
        else await writeFile(stage, await readFile(backup))
        if (!sameState(await targetState(stage), record.before)) throw new RollbackError('ROLLBACK_STAGE_HASH_MISMATCH', record.target)
      }
    }
  } catch (error) {
    for (const swap of swaps) await rm(swap.stage, { recursive: true, force: true })
    throw error
  }

  let receiptCommitted = false
  let completed
  try {
    for (const swap of swaps) {
      const current = await targetState(swap.target)
      if (!sameState(current, swap.record.after)) throw new RollbackError('TARGET_CHANGED_DURING_ROLLBACK', swap.record.target)
      await rename(swap.target, swap.quarantine)
      swap.quarantined = true
    }
    for (const swap of swaps) {
      if (swap.record.before.type === 'missing') continue
      await rename(swap.stage, swap.target)
      swap.installed = true
    }
    for (const swap of swaps) {
      const restored = await targetState(swap.target)
      if (!sameState(restored, swap.record.before)) throw new RollbackError('POST_ROLLBACK_HASH_MISMATCH', swap.record.target)
    }

    const cleanupPending = swaps.map(swap => relative(root, swap.quarantine).replaceAll('\\', '/'))
    completed = sealReceipt({ ...receipt, status: 'rolled-back', cleanupPending })
    await atomicWrite(absoluteReceipt, canonical(completed))
    receiptCommitted = true
  } catch (error) {
    if (!receiptCommitted) {
      try {
        for (const swap of [...swaps].reverse()) {
          if (swap.installed && await pathKind(swap.target) !== 'missing') await rename(swap.target, swap.stage)
          if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
          if (await pathKind(swap.stage) !== 'missing') await rm(swap.stage, { recursive: true, force: true })
        }
      } catch (recoveryError) {
        throw new RollbackError('ROLLBACK_FAILED_AND_RECOVERY_FAILED', `${error.message}; ${recoveryError.message}`)
      }
    }
    throw error
  }

  const cleanupPending = []
  for (const swap of swaps) {
    try {
      await rm(swap.quarantine, { recursive: true, force: true })
    } catch {
      cleanupPending.push(relative(root, swap.quarantine).replaceAll('\\', '/'))
    }
  }
  if (cleanupPending.length !== completed.cleanupPending.length) {
    completed = sealReceipt({ ...completed, cleanupPending })
    await atomicWrite(absoluteReceipt, canonical(completed))
  }
  return { status: 'rolled-back', receiptPath: absoluteReceipt, receipt: completed }
}

function parseArgs(argv) {
  const result = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { result.json = true; continue }
    if (!['--install-root', '--receipt'].includes(key) || argv[index + 1] === undefined) {
      throw new RollbackError('USAGE', 'node installer/rollback.mjs --install-root <DSH root> --receipt <receipt.json> [--json]')
    }
    result[key.slice(2)] = argv[index + 1]
    index += 1
  }
  if (!result['install-root'] || !result.receipt) throw new RollbackError('USAGE')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await rollbackOverlay({ installRoot: args['install-root'], receiptPath: args.receipt })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: result.status, receiptPath: result.receiptPath }, null, 2)}\n`)
  else process.stdout.write(`Overlay rolled back; receipt: ${result.receiptPath}\n`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => {
  const code = error.code ?? 'ROLLBACK_FAILED'
  console.error(error.message.startsWith(code) ? error.message : `${code}: ${error.message}`)
  process.exitCode = 1
})
