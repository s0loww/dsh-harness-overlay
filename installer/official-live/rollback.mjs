import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficialDesktop } from '../../src/targets/official-desktop/target.mjs'
import { atomicWrite, canonical, pathKind, sameState, targetState } from '../fs-state.mjs'
import { sealReceipt, verifyReceiptIntegrity } from '../receipt.mjs'
import { assertDesktopStopped } from './process-guard.mjs'
import { verifyUiArtifact } from '../official-ui/common.mjs'
import { verifyPolicyArtifact } from '../official-policy/common.mjs'
import { assertPromotionPaths, DEFAULT_POLICY_ARTIFACT, DEFAULT_RELEASE_LOCK, DEFAULT_UI_ARTIFACT, liveProfileStageRoot, LIVE_ACKNOWLEDGEMENT, NESTED_ZOD, OfficialUiInstallerError, SHARED_SUBSET_DEPENDENCIES, STORAGE_DOMAIN } from './common.mjs'

async function readJson(path, code) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { throw new OfficialUiInstallerError(code, error.message) }
}

async function recover(swaps) {
  for (const swap of [...swaps].reverse()) {
    if (swap.restored && await pathKind(swap.target) !== 'missing') await rm(swap.target, { recursive: true, force: true })
    if (swap.quarantined && await pathKind(swap.quarantine) !== 'missing') await rename(swap.quarantine, swap.target)
  }
}

export async function rollbackLivePromotion({ installRoot, profileRoot, receiptPath, uiArtifactRoot = DEFAULT_UI_ARTIFACT, policyArtifactRoot = DEFAULT_POLICY_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK, acknowledgement }) {
  if (acknowledgement !== LIVE_ACKNOWLEDGEMENT) throw new OfficialUiInstallerError('LIVE_ACKNOWLEDGEMENT_REQUIRED')
  const receiptFile = resolve(String(receiptPath ?? ''))
  const receipt = await readJson(receiptFile, 'LIVE_RECEIPT_INVALID')
  if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'applied' || receipt.schemaVersion !== 1) throw new OfficialUiInstallerError('LIVE_RECEIPT_INVALID')
  const paths = assertPromotionPaths({ installRoot, profileRoot, backupRoot: receipt.backupRoot })
  await assertDesktopStopped(paths.install)
  if (paths.install !== resolve(receipt.installRoot) || paths.profile !== resolve(receipt.profileRoot) || receiptFile !== join(paths.backup, 'receipt.json')) throw new OfficialUiInstallerError('LIVE_RECEIPT_TARGET_MISMATCH')
  const verified = await verifyOfficialDesktop({ installRoot: paths.install, releaseLockPath })
  if (receipt.target?.hostVersion !== verified.lock.hostVersion || receipt.target?.appAsarSha256 !== verified.lock.files['resources/app.asar']?.sha256) throw new OfficialUiInstallerError('LIVE_RECEIPT_BASELINE_MISMATCH')
  const ui = await verifyUiArtifact(uiArtifactRoot), policy = await verifyPolicyArtifact(policyArtifactRoot)
  if (receipt.artifacts?.ui?.id !== ui.manifest.artifact.id || receipt.artifacts?.ui?.version !== ui.manifest.artifact.version || receipt.artifacts?.ui?.manifestSha256 !== ui.manifestSha256 ||
      receipt.artifacts?.policy?.id !== policy.manifest.artifact.id || receipt.artifacts?.policy?.version !== policy.manifest.artifact.version || receipt.artifacts?.policy?.manifestSha256 !== policy.manifestSha256) throw new OfficialUiInstallerError('LIVE_RECEIPT_ARTIFACT_MISMATCH')
  const officialUi = await readJson(join(ui.root, 'official-ui-manifest.json'), 'OFFICIAL_UI_MANIFEST_INVALID')
  const artifactPackageNames = [...officialUi.packages.map(row => row.name), ...policy.packageNames].sort()
  if (canonical(receipt.artifactPackageNames) !== canonical(artifactPackageNames)) throw new OfficialUiInstallerError('LIVE_RECEIPT_ARTIFACT_ALLOWLIST_MISMATCH')
  const resolution = receipt.dependencyResolution
  const noops = resolution?.verifiedNoops
  const nested = resolution?.nested
  const preserved = resolution?.preservedTopLevel
  if (!Array.isArray(noops) || !Array.isArray(nested) || !Array.isArray(preserved) || nested.length !== 1 || preserved.length !== 1 ||
      nested[0]?.name !== NESTED_ZOD || nested[0]?.version !== '4.4.3' || nested[0]?.parent !== STORAGE_DOMAIN || nested[0]?.target !== `node_modules/${STORAGE_DOMAIN}/node_modules/${NESTED_ZOD}` ||
      preserved[0]?.name !== NESTED_ZOD) throw new OfficialUiInstallerError('LIVE_RECEIPT_DEPENDENCY_RESOLUTION_INVALID')
  const noopNames = noops.map(row => row?.package)
  if (new Set(noopNames).size !== noopNames.length || noopNames.some(name => !SHARED_SUBSET_DEPENDENCIES.has(name) && name !== STORAGE_DOMAIN)) throw new OfficialUiInstallerError('LIVE_RECEIPT_DEPENDENCY_RESOLUTION_INVALID')
  const packageNames = artifactPackageNames.filter(name => name !== NESTED_ZOD && !noopNames.includes(name)).sort()
  if (canonical(receipt.packageNames) !== canonical(packageNames)) throw new OfficialUiInstallerError('LIVE_RECEIPT_PACKAGE_ALLOWLIST_MISMATCH')
  const expected = new Map(packageNames.map(name => [`node_modules/${name}`, { type: name === STORAGE_DOMAIN ? 'copy-directory-with-nested-dependency' : 'copy-directory', package: name }]))
  expected.set('cordis.patch.yml', { type: 'merge-cordis', package: undefined })
  if (!Array.isArray(receipt.operations) || receipt.operations.length !== expected.size) throw new OfficialUiInstallerError('LIVE_RECEIPT_OPERATION_COUNT_MISMATCH')
  const records = [], seen = new Set()
  for (const row of receipt.operations) {
    const contract = expected.get(row.target)
    if (!contract || seen.has(row.target) || row.type !== contract.type || row.package !== contract.package) throw new OfficialUiInstallerError('LIVE_RECEIPT_OPERATION_INVALID')
    seen.add(row.target)
    const target = row.target === 'cordis.patch.yml' ? join(paths.profile, row.target) : join(paths.profile, ...row.target.split('/'))
    if (!sameState(await targetState(target), row.after)) throw new OfficialUiInstallerError('LIVE_ROLLBACK_OWNERSHIP_MISMATCH', row.target)
    const expectedBackup = row.before.type === 'missing' ? null : `before/${row.target}`
    if (row.backup !== expectedBackup) throw new OfficialUiInstallerError('LIVE_RECEIPT_BACKUP_PATH_INVALID', row.target)
    const backup = expectedBackup === null ? null : join(paths.backup, ...expectedBackup.split('/'))
    if (backup && !sameState(await targetState(backup), row.before)) throw new OfficialUiInstallerError('LIVE_ROLLBACK_BACKUP_MISMATCH', row.target)
    records.push({ row, target, backup })
  }
  const stageRoot = liveProfileStageRoot(paths.profile, 'rollback', randomUUID())
  await assertDesktopStopped(paths.install)
  if (await pathKind(stageRoot) !== 'missing') throw new OfficialUiInstallerError('LIVE_ROLLBACK_STAGE_EXISTS')
  await mkdir(stageRoot)
  const swaps = []
  try {
    for (const record of records) {
      let stage = null
      if (record.backup) {
        stage = join(stageRoot, record.row.target)
        await mkdir(dirname(stage), { recursive: true })
        if (record.row.before.type === 'directory') await cp(record.backup, stage, { recursive: true, force: false, errorOnExist: true })
        else await cp(record.backup, stage, { force: false, errorOnExist: true })
        if (!sameState(await targetState(stage), record.row.before)) throw new OfficialUiInstallerError('LIVE_ROLLBACK_STAGE_HASH_MISMATCH', record.row.target)
      }
      swaps.push({ ...record, stage, quarantine: join(dirname(record.target), `.${randomUUID()}.airules-live-rollback`), quarantined: false, restored: false })
    }
    let committed = false
    try {
      for (const swap of swaps) {
        if (!sameState(await targetState(swap.target), swap.row.after)) throw new OfficialUiInstallerError('LIVE_ROLLBACK_TARGET_RACE', swap.row.target)
        await rename(swap.target, swap.quarantine); swap.quarantined = true
      }
      for (const swap of swaps) if (swap.stage) { await mkdir(dirname(swap.target), { recursive: true }); await rename(swap.stage, swap.target); swap.restored = true }
      const rollbackStage = { strategy: 'profile-same-volume', directory: relative(paths.profile, stageRoot).replaceAll('\\', '/') }
      let completed = sealReceipt({ ...receipt, status: 'rolled-back', rollbackStage, cleanupPending: swaps.map(row => row.quarantine) })
      await atomicWrite(receiptFile, canonical(completed), { expectedCurrentState: await targetState(receiptFile) }); committed = true
      const cleanupPending = []
      for (const swap of swaps) { try { await rm(swap.quarantine, { recursive: true, force: true }) } catch { cleanupPending.push(swap.quarantine) } }
      try { await rm(stageRoot, { recursive: true, force: true }) } catch { cleanupPending.push(stageRoot) }
      completed = sealReceipt({ ...completed, cleanupPending })
      await atomicWrite(receiptFile, canonical(completed), { expectedCurrentState: await targetState(receiptFile) })
      return Object.freeze({ status: 'rolled-back', receiptPath: receiptFile, receipt: completed })
    } catch (error) { if (!committed) await recover(swaps); throw error }
  } catch (error) { await rm(stageRoot, { recursive: true, force: true }); throw error }
}

function parseArgs(argv) {
  const args = { 'ui-artifact': DEFAULT_UI_ARTIFACT, 'policy-artifact': DEFAULT_POLICY_ARTIFACT }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--install-root', '--profile-root', '--receipt', '--ui-artifact', '--policy-artifact', '--release-lock', '--acknowledge'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    args[key.slice(2)] = argv[++index]
  }
  for (const key of ['install-root', 'profile-root', 'receipt', 'acknowledge']) if (!args[key]) throw new OfficialUiInstallerError('USAGE', `--${key} is required`)
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await rollbackLivePromotion({ installRoot: args['install-root'], profileRoot: args['profile-root'], receiptPath: args.receipt, uiArtifactRoot: args['ui-artifact'], policyArtifactRoot: args['policy-artifact'], releaseLockPath: args['release-lock'], acknowledgement: args.acknowledge })
  process.stdout.write(`Live promotion rolled back; receipt: ${result.receiptPath}\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
