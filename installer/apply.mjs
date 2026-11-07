import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeCordis } from './cordis.mjs'
import {
  atomicWrite,
  canonical,
  directoryState,
  pathKind,
  sameState,
  sha256,
  targetState,
} from './fs-state.mjs'
import { buildInstallPlan, DEFAULT_BASELINE, PlanError } from './plan.mjs'
import { prepareReleasePatch } from './release-patch.mjs'
import { backupDirectoryName, sealReceipt } from './receipt.mjs'

const TARGETS = Object.freeze({
  provider: '.dsh-1c/home/profiles/node_modules/airules-dsh-provider',
  rulepack: '.dsh-1c/home/profiles/node_modules/airules-dsh-rulepack',
  cordis: 'dsh-1c-bundle/cordis.patch.yml',
})

export class ApplyError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ApplyError'
    this.code = code
  }
}

function portable(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new ApplyError('UNSAFE_PATH', label)
  if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new ApplyError('UNSAFE_PATH', label)
  return value
}

function beneath(root, rel, label) {
  const target = resolve(root, ...portable(rel, label).split('/'))
  const check = relative(resolve(root), target)
  if (!check || check.startsWith('..') || isAbsolute(check)) throw new ApplyError('UNSAFE_PATH', label)
  return target
}

function relativeTarget(installRoot, target) {
  const rel = relative(installRoot, target).replaceAll('\\', '/')
  portable(rel, 'operation target')
  return rel
}

function allowedCollision(collision) {
  return ['TARGET_ALREADY_EXISTS', 'CORDIS_ENTRY_DIFFERS'].includes(collision.reason)
}

function planSignature(plan) {
  return JSON.stringify({
    status: plan.status,
    collisions: plan.collisions.map(item => ({ kind: item.kind, target: item.target, reason: item.reason })),
    operations: plan.operations.map(item => ({
      kind: item.kind,
      package: item.package ?? null,
      target: item.target,
      action: item.action ?? null,
      collision: item.collision,
      collisionReason: item.collisionReason ?? null,
      contentSha256: item.contentSha256 ?? null,
      sourceSha256: item.sourceSha256 ?? null,
      resultSha256: item.resultSha256 ?? null,
      replacements: item.replacements ?? null,
      fragmentSha256: item.fragmentSha256 ?? null,
      resultBytes: item.resultBytes ?? null,
    })),
  })
}

async function backupTarget(source, destination, expected) {
  await mkdir(dirname(destination), { recursive: true })
  if (expected.type === 'directory') await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  else if (expected.type === 'file') await cp(source, destination, { force: false, errorOnExist: true })
  else return
  const copied = await targetState(destination)
  if (!sameState(copied, expected)) throw new ApplyError('BACKUP_HASH_MISMATCH', destination)
}

function pendingReceipt({ plan, backupRootRelative, records }) {
  return {
    schemaVersion: 1,
    status: 'pending',
    release: plan.release,
    overlay: { id: plan.overlay.id, version: plan.overlay.version },
    overlaySchemaVersion: plan.schemaVersion,
    releasePatch: plan.releasePatch,
    backupRoot: backupRootRelative,
    operations: records,
  }
}

export async function applyOverlay({
  installRoot,
  overlay,
  baselinePath = DEFAULT_BASELINE,
  replaceCollisions = false,
  operationHook = null,
}) {
  const root = resolve(installRoot)
  const overlayRoot = resolve(overlay)
  const plan = await buildInstallPlan({ installRoot: root, overlay: overlayRoot, baselinePath })
  if (plan.collisions.some(collision => !allowedCollision(collision))) {
    throw new ApplyError('UNSAFE_COLLISION', plan.collisions.map(item => item.reason).join(', '))
  }
  if (plan.collisions.length && !replaceCollisions) {
    throw new ApplyError('COLLISION_REQUIRES_EXPLICIT_REPLACE', plan.collisions.map(item => item.target).join(', '))
  }

  const backupRootRelative = `.airules-backups/${backupDirectoryName(plan.overlay)}`
  const backupRoot = beneath(root, backupRootRelative, 'backup root')
  if (await pathKind(backupRoot) !== 'missing') throw new ApplyError('BACKUP_ALREADY_EXISTS', backupRoot)

  const records = []
  const preparedPatches = []
  const preparedPackages = []
  let preparedCordis = null
  let releasePatchPrepared = []
  if (plan.schemaVersion === 2) {
    const [manifest, baseline] = await Promise.all([
      readFile(join(overlayRoot, 'overlay-manifest.json'), 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/u, ''))),
      readFile(resolve(baselinePath), 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/u, ''))),
    ])
    releasePatchPrepared = await prepareReleasePatch({
      installRoot: root,
      overlayRoot,
      manifest,
      baseline,
      includeBytes: true,
    })
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'patch-file') {
      const prepared = releasePatchPrepared.find(item => item.targetRelative === operation.targetRelative)
      if (!prepared || prepared.resultSha256 !== operation.resultSha256 || prepared.sourceSha256 !== operation.sourceSha256) {
        throw new ApplyError('RELEASE_PATCH_CHANGED_AFTER_PLAN', operation.targetRelative)
      }
      const target = relativeTarget(root, operation.target)
      const before = await targetState(operation.target)
      if (!sameState(before, operation.before)) throw new ApplyError('RELEASE_PATCH_SOURCE_DRIFT', target)
      records.push({
        kind: 'file',
        patch: true,
        patchId: operation.patchId,
        target,
        before,
        backup: target,
        after: operation.after,
      })
      preparedPatches.push({ operation, bytes: prepared.afterBytes, record: records.at(-1), stagePath: null })
    } else if (operation.kind === 'copy-directory') {
      const target = relativeTarget(root, operation.target)
      const expectedTarget = operation.package === 'provider' ? TARGETS.provider : TARGETS.rulepack
      if (target !== expectedTarget) throw new ApplyError('UNEXPECTED_TARGET', target)
      const sourceState = await directoryState(operation.source)
      if (sourceState.digest !== operation.contentSha256) throw new ApplyError('OVERLAY_CHANGED_AFTER_PLAN', operation.package)
      const before = await targetState(operation.target)
      const backup = before.type === 'missing' ? null : target
      records.push({ kind: 'directory', package: operation.package, target, before, backup, after: sourceState })
      preparedPackages.push({ operation, sourceState, record: records.at(-1) })
    } else {
      const target = relativeTarget(root, operation.target)
      if (target !== TARGETS.cordis) throw new ApplyError('UNEXPECTED_TARGET', target)
      const before = await targetState(operation.target)
      if (before.type !== 'file') throw new ApplyError('CORDIS_TARGET_INVALID')
      const [current, fragment] = await Promise.all([readFile(operation.target, 'utf8'), readFile(operation.source, 'utf8')])
      const merged = mergeCordis(current, fragment, { replaceCollision: replaceCollisions })
      if (merged.action !== 'noop') {
        const bytes = Buffer.from(merged.text, 'utf8')
        const after = { type: 'file', sha256: sha256(bytes), bytes: bytes.byteLength }
        if (sha256(Buffer.from(fragment, 'utf8')) !== operation.fragmentSha256 || after.sha256 !== operation.resultSha256 || after.bytes !== operation.resultBytes) {
          throw new ApplyError('CORDIS_CHANGED_AFTER_PLAN')
        }
        records.push({ kind: 'file', target, before, backup: target, after, action: merged.action })
        preparedCordis = { operation, bytes, after, record: records.at(-1) }
      }
    }
  }

  const stageRoot = await mkdtemp(join(root, '.airules-install-stage-'))
  const stagePaths = new Map()
  try {
    for (const record of records) {
      const stagePath = beneath(stageRoot, record.target, 'stage target')
      await mkdir(dirname(stagePath), { recursive: true })
      const patch = preparedPatches.find(item => item.record === record)
      const pkg = preparedPackages.find(item => item.record === record)
      if (patch) await writeFile(stagePath, patch.bytes)
      else if (pkg) await cp(pkg.operation.source, stagePath, { recursive: true, force: false, errorOnExist: true })
      else if (preparedCordis?.record === record) await writeFile(stagePath, preparedCordis.bytes)
      else throw new ApplyError('STAGE_SOURCE_MISSING', record.target)
      if (!sameState(await targetState(stagePath), record.after)) throw new ApplyError('STAGE_HASH_MISMATCH', record.target)
      stagePaths.set(record.target, stagePath)
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }

  try {
    await mkdir(dirname(backupRoot), { recursive: true })
    await mkdir(backupRoot, { recursive: false })
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }
  const pendingPath = join(backupRoot, 'receipt.pending.json')
  const receiptPath = join(backupRoot, 'receipt.json')
  const swaps = records.map(record => ({
    record,
    target: beneath(root, record.target, 'transaction target'),
    staged: stagePaths.get(record.target),
    quarantine: join(dirname(beneath(root, record.target, 'transaction target')), `.${randomUUID()}.apply-owned`),
    quarantined: false,
    installed: false,
  }))
  let receiptCommitted = false
  try {
    for (const record of records) {
      if (record.before.type === 'missing') continue
      await backupTarget(
        beneath(root, record.target, 'backup source'),
        beneath(backupRoot, record.backup, 'backup destination'),
        record.before,
      )
    }
    const pending = sealReceipt(pendingReceipt({ plan, backupRootRelative, records }))
    await atomicWrite(pendingPath, canonical(pending))

    const rechecked = await buildInstallPlan({ installRoot: root, overlay: overlayRoot, baselinePath })
    if (planSignature(rechecked) !== planSignature(plan)) {
      throw new ApplyError('INPUT_CHANGED_BEFORE_APPLY')
    }
    for (const record of records) {
      const current = await targetState(beneath(root, record.target, 'pre-commit target'))
      if (!sameState(current, record.before)) throw new ApplyError('TARGET_CHANGED_BEFORE_APPLY', record.target)
    }

    for (const swap of swaps) {
      const current = await targetState(swap.target)
      if (!sameState(current, swap.record.before)) throw new ApplyError('TARGET_CHANGED_DURING_APPLY', swap.record.target)
      if (swap.record.before.type !== 'missing') {
        await rename(swap.target, swap.quarantine)
        swap.quarantined = true
      }
    }
    for (const [index, swap] of swaps.entries()) {
      await mkdir(dirname(swap.target), { recursive: true })
      await rename(swap.staged, swap.target)
      swap.installed = true
      if (operationHook) {
        const kind = swap.record.patch ? 'patch-file' : swap.record.kind === 'directory' ? 'copy-directory' : 'merge-cordis-fragment'
        await operationHook({ kind, target: swap.record.target, applied: index + 1 })
      }
    }

    for (const record of records) {
      const actual = await targetState(beneath(root, record.target, 'verify target'))
      if (!sameState(actual, record.after)) throw new ApplyError('POST_APPLY_HASH_MISMATCH', record.target)
    }
    const cleanupPending = swaps.filter(swap => swap.quarantined).map(swap => relative(root, swap.quarantine).replaceAll('\\', '/'))
    let receipt = sealReceipt({ ...pending, status: 'applied', cleanupPending })
    await atomicWrite(receiptPath, canonical(receipt))
    receiptCommitted = true
    await rm(pendingPath, { force: true })
    const remainingCleanup = []
    for (const swap of swaps.filter(item => item.quarantined)) {
      try { await rm(swap.quarantine, { recursive: true, force: true }) } catch {
        remainingCleanup.push(relative(root, swap.quarantine).replaceAll('\\', '/'))
      }
    }
    if (remainingCleanup.length !== cleanupPending.length) {
      receipt = sealReceipt({ ...receipt, cleanupPending: remainingCleanup })
      try { await atomicWrite(receiptPath, canonical(receipt)) } catch { /* initial committed receipt remains valid */ }
    }
    await rm(stageRoot, { recursive: true, force: true })
    return { status: 'applied', receiptPath, plan, receipt }
  } catch (error) {
    if (receiptCommitted) {
      await rm(stageRoot, { recursive: true, force: true })
      throw new ApplyError('APPLY_COMMITTED_CLEANUP_FAILED', error.message)
    }
    if (!receiptCommitted) {
      try {
        for (const swap of [...swaps].reverse()) {
          if (swap.installed) {
            const current = await targetState(swap.target)
            if (!sameState(current, swap.record.after)) throw new ApplyError('RECOVERY_TARGET_CHANGED', swap.record.target)
            await mkdir(dirname(swap.staged), { recursive: true })
            await rename(swap.target, swap.staged)
          }
          if (swap.quarantined) await rename(swap.quarantine, swap.target)
        }
      } catch (recoveryError) {
        throw new ApplyError('APPLY_FAILED_AND_RECOVERY_FAILED', `${error.message}; ${recoveryError.message}`)
      }
    }
    await rm(stageRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
    throw error
  }
}

function parseArgs(argv) {
  const result = { json: false, replaceCollisions: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { result.json = true; continue }
    if (key === '--replace-collisions') { result.replaceCollisions = true; continue }
    if (!['--install-root', '--overlay'].includes(key) || argv[index + 1] === undefined) {
      throw new ApplyError('USAGE', 'node installer/apply.mjs --install-root <DSH root> --overlay <artifact> [--replace-collisions] [--json]')
    }
    result[key.slice(2)] = argv[index + 1]
    index += 1
  }
  if (!result['install-root'] || !result.overlay) throw new ApplyError('USAGE')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await applyOverlay({
    installRoot: args['install-root'],
    overlay: args.overlay,
    replaceCollisions: args.replaceCollisions,
  })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: result.status, receiptPath: result.receiptPath }, null, 2)}\n`)
  else process.stdout.write(`Overlay applied; receipt: ${result.receiptPath}\n`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => {
  const code = error.code ?? (error instanceof PlanError ? error.code : 'APPLY_FAILED')
  console.error(error.message.startsWith(code) ? error.message : `${code}: ${error.message}`)
  process.exitCode = 1
})
