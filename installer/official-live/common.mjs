import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfficialDesktop, DEFAULT_RELEASE_LOCK } from '../../src/targets/official-desktop/target.mjs'
import { canonical, directoryState, pathKind, sameState, sha256, targetState } from '../fs-state.mjs'
import { verifyReceiptIntegrity } from '../receipt.mjs'
import { loadCandidate, OfficialUiInstallerError, verifyUiArtifact } from '../official-ui/common.mjs'
import { mergeUiCordis } from '../official-ui/ui-cordis.mjs'
import { verifyPolicyArtifact } from '../official-policy/common.mjs'
import { mergePolicyCordis } from '../official-policy/policy-cordis.mjs'
import { migrateCordisFragments } from './cordis-migration.mjs'

const MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const REPO_ROOT = resolve(MODULE_DIR, '../..')
export const DEFAULT_UI_ARTIFACT = resolve(REPO_ROOT, 'dist/airules-ui-overlay-0.1.0-dev5')
export const DEFAULT_POLICY_ARTIFACT = resolve(REPO_ROOT, 'dist/airules-official-policy-0.12.0-dev7')
export const PROMOTION_BACKUPS_ROOT = resolve(REPO_ROOT, 'var/live-promotion-backups')
export const LIVE_ACKNOWLEDGEMENT = 'I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_MODIFIES_ITS_PROFILE'
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const SHARED_SUBSET_DEPENDENCIES = new Set(['@deepseek-ai/cosmokit', '@deepseek-ai/schemastery', '@standard-schema/spec'])
const STORAGE_DOMAIN = '@deepseek-ai/dsh-storage-domain'
const NESTED_ZOD = 'zod'
const SAFE_EXTRA_FILE = /(?:\.d\.[cm]?ts|\.d\.[cm]?ts\.map|\.[cm]?js\.map)$/u
const STAGE_NONCE = /^[a-f0-9-]{16,64}$/u

function overlap(left, right) {
  const a = resolve(left).toLowerCase(), b = resolve(right).toLowerCase()
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}

function requireAbsolute(value, code) {
  if (typeof value !== 'string' || !value || !isAbsolute(value)) throw new OfficialUiInstallerError(code)
  return resolve(value)
}

export function assertPromotionPaths({ installRoot, profileRoot, backupRoot }) {
  const install = requireAbsolute(installRoot, 'LIVE_INSTALL_PATH_REQUIRED')
  const profile = requireAbsolute(profileRoot, 'LIVE_PROFILE_PATH_REQUIRED')
  const backup = requireAbsolute(backupRoot, 'LIVE_BACKUP_PATH_REQUIRED')
  if (overlap(install, profile)) throw new OfficialUiInstallerError('LIVE_ROOTS_OVERLAP')
  if (overlap(backup, install) || overlap(backup, profile)) throw new OfficialUiInstallerError('LIVE_BACKUP_OVERLAPS_TARGET')
  const rel = relative(PROMOTION_BACKUPS_ROOT, backup)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
    throw new OfficialUiInstallerError('LIVE_BACKUP_NOT_DIRECT_CHILD')
  }
  return Object.freeze({ install, profile, backup })
}

export function liveProfileStageRoot(profileRoot, phase, nonce) {
  const profile = requireAbsolute(profileRoot, 'LIVE_PROFILE_PATH_REQUIRED')
  if (!['apply', 'rollback'].includes(phase) || typeof nonce !== 'string' || !STAGE_NONCE.test(nonce)) throw new OfficialUiInstallerError('LIVE_STAGE_ID_INVALID')
  const stage = join(profile, `.airules-live-${phase}-stage-${nonce}`)
  const rel = relative(profile, stage)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OfficialUiInstallerError('LIVE_STAGE_PATH_INVALID')
  return stage
}

async function readJson(path, code) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new OfficialUiInstallerError(code, error.message) }
}

function artifactPackages(ui) {
  const rows = ui.manifest.operations.filter(row => ['package-copy', 'data-overlay'].includes(row.type))
  const names = rows.map(row => row.target.replace(/^node_modules\//u, ''))
  if (names.some(name => !PACKAGE.test(name)) || new Set(names).size !== names.length) throw new OfficialUiInstallerError('LIVE_UI_PACKAGE_ALLOWLIST_INVALID')
  return names
}

async function packageIdentity(root) {
  const value = await readJson(join(root, 'package.json'), 'LIVE_PACKAGE_IDENTITY_INVALID')
  if (!PACKAGE.test(value?.name ?? '') || typeof value?.version !== 'string' || !value.version) throw new OfficialUiInstallerError('LIVE_PACKAGE_IDENTITY_INVALID')
  return Object.freeze({ name: value.name, version: value.version, dependencies: value.dependencies ?? {} })
}

function directoryStateWithNested(parent, nestedName, nested) {
  const prefix = `node_modules/${nestedName}/`
  const files = { ...parent.files }
  for (const [path, state] of Object.entries(nested.files)) files[`${prefix}${path}`] = state
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')))
  return { type: 'directory', digest: sha256(Buffer.from(canonical(sorted))), files: sorted }
}

function exactSubset(source, installed, { allowSafeExtras = true } = {}) {
  if (source.type !== 'directory' || installed.type !== 'directory') return false
  for (const [path, state] of Object.entries(source.files)) {
    const actual = installed.files[path]
    if (!actual || actual.sha256 !== state.sha256 || actual.bytes !== state.bytes) return false
  }
  const extras = Object.keys(installed.files).filter(path => !Object.hasOwn(source.files, path))
  return (!extras.length || allowSafeExtras) && extras.every(path => SAFE_EXTRA_FILE.test(path))
}

async function verifiedSubsetDependency({ name, source, target, sourceState, installedState }) {
  if (installedState.type !== 'directory') return false
  const sourceIdentity = await packageIdentity(source), installedIdentity = await packageIdentity(target)
  return sourceIdentity.name === name && installedIdentity.name === name && sourceIdentity.version === installedIdentity.version &&
    exactSubset(sourceState, installedState)
}

async function verifyAppliedReceipt({ candidate, markerName, expectedId, expectedVersion, expectedManifestSha256, expectedPackages }) {
  const marker = await readJson(join(candidate.root, markerName), 'CERTIFICATION_MARKER_INVALID')
  if (marker?.schemaVersion !== 1 || marker?.artifact?.id !== expectedId || marker?.artifact?.version !== expectedVersion || typeof marker.receipt !== 'string') {
    throw new OfficialUiInstallerError('CERTIFICATION_MARKER_INVALID', markerName)
  }
  const receiptPath = resolve(candidate.root, marker.receipt)
  const rel = relative(candidate.root, receiptPath)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OfficialUiInstallerError('CERTIFICATION_RECEIPT_OUTSIDE_CANDIDATE')
  const receipt = await readJson(receiptPath, 'CERTIFICATION_RECEIPT_INVALID')
  if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'applied' || receipt.artifact?.id !== expectedId || receipt.artifact?.version !== expectedVersion || receipt.artifactManifestSha256 !== expectedManifestSha256) {
    throw new OfficialUiInstallerError('CERTIFICATION_RECEIPT_INVALID', markerName)
  }
  const actual = [...(receipt.packageNames ?? [])].sort()
  if (canonical(actual) !== canonical([...expectedPackages].sort())) throw new OfficialUiInstallerError('CERTIFICATION_PACKAGE_ALLOWLIST_MISMATCH', markerName)
  return Object.freeze({ marker, receipt, receiptPath })
}

export async function verifyCandidateCertification({ candidateRoot, ui, policy, releaseLockPath = DEFAULT_RELEASE_LOCK }) {
  const candidate = await loadCandidate(candidateRoot)
  await verifyOfficialDesktop({ installRoot: candidate.installRoot, releaseLockPath })
  const uiPackages = artifactPackages(ui)
  const uiEvidence = await verifyAppliedReceipt({ candidate, markerName: 'ui-ready.json', expectedId: ui.manifest.artifact.id, expectedVersion: ui.manifest.artifact.version, expectedManifestSha256: ui.manifestSha256, expectedPackages: uiPackages })
  const policyEvidence = await verifyAppliedReceipt({ candidate, markerName: 'policy-ready.json', expectedId: policy.manifest.artifact.id, expectedVersion: policy.manifest.artifact.version, expectedManifestSha256: policy.manifestSha256, expectedPackages: policy.packageNames })
  const smokePath = join(candidate.root, 'smoke/launch-report.json')
  const smoke = await readJson(smokePath, 'CERTIFICATION_SMOKE_INVALID')
  if (smoke?.schemaVersion !== 1 || smoke.status !== 'passed-visible-startup' || smoke.visible !== true || typeof smoke.startedAt !== 'string' || typeof smoke.stoppedAt !== 'string') {
    throw new OfficialUiInstallerError('CERTIFICATION_VISIBLE_SMOKE_REQUIRED')
  }
  return Object.freeze({ candidate, smokePath, smoke, uiEvidence, policyEvidence })
}

function planSignature(plan) {
  return createHash('sha256').update(canonical({
    target: plan.target,
    artifacts: plan.artifacts,
    certification: plan.certification,
    artifactPackageNames: plan.artifactPackageNames,
    packageNames: plan.packageNames,
    dependencyResolution: plan.dependencyResolution,
    previousPromotion: plan.previousPromotion,
    operations: plan.operations.map(row => ({ type: row.type, package: row.package, targetRelative: row.targetRelative, before: row.before, after: row.after })),
  })).digest('hex')
}

export async function readLiveUpdateReceipt({ previousReceiptPath, paths, target, packageNames }) {
  const receiptFile = requireAbsolute(previousReceiptPath, 'LIVE_PREVIOUS_RECEIPT_PATH_REQUIRED')
  if (await pathKind(receiptFile) !== 'file') throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_INVALID')
  const receipt = await readJson(receiptFile, 'LIVE_PREVIOUS_RECEIPT_INVALID')
  if (!verifyReceiptIntegrity(receipt) || receipt.schemaVersion !== 1 || receipt.status !== 'applied' || !Array.isArray(receipt.cleanupPending) || receipt.cleanupPending.length) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_INVALID')
  const previousPaths = assertPromotionPaths({ installRoot: paths.install, profileRoot: paths.profile, backupRoot: receipt.backupRoot })
  if (await pathKind(previousPaths.backup) !== 'directory') throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_INVALID')
  if (receiptFile !== join(previousPaths.backup, 'receipt.json') || receipt.installRoot !== paths.install || receipt.profileRoot !== paths.profile || previousPaths.backup === paths.backup || canonical(receipt.target) !== canonical(target)) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_TARGET_MISMATCH')
  if (!Array.isArray(receipt.artifactPackageNames) || new Set(receipt.artifactPackageNames).size !== receipt.artifactPackageNames.length || receipt.artifactPackageNames.some(name => !PACKAGE.test(name) || !packageNames.includes(name))) throw new OfficialUiInstallerError('LIVE_UPDATE_REMOVED_PACKAGE')
  if (!Array.isArray(receipt.packageNames) || new Set(receipt.packageNames).size !== receipt.packageNames.length || receipt.packageNames.some(name => !PACKAGE.test(name) || !receipt.artifactPackageNames.includes(name))) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_PACKAGE_INVALID')
  const expected = new Map(receipt.packageNames.map(name => [`node_modules/${name}`, { package: name, type: name === STORAGE_DOMAIN ? 'copy-directory-with-nested-dependency' : 'copy-directory' }]))
  expected.set('cordis.patch.yml', { package: undefined, type: 'merge-cordis' })
  if (!Array.isArray(receipt.operations) || receipt.operations.length !== expected.size) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_OPERATIONS_INVALID')
  const owned = new Map()
  for (const row of receipt.operations) {
    const contract = expected.get(row.target)
    if (!contract || row.type !== contract.type || row.package !== contract.package) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_OPERATIONS_INVALID')
    expected.delete(row.target)
    if (row.target === 'cordis.patch.yml') continue
    if (row.after?.type !== 'directory' || !sameState(await targetState(join(paths.profile, ...row.target.split('/'))), row.after)) throw new OfficialUiInstallerError('LIVE_UPDATE_PACKAGE_DRIFT', row.package)
    owned.set(row.package, row.after)
  }
  return { receipt, receiptFile, owned, sha256: sha256(await readFile(receiptFile)) }
}

export async function assertLiveUpdateFragments({ oldUiRoot, newUiRoot, oldPolicyRoot, newPolicyRoot, oldUiFragment, newUiFragment }) {
  for (const [oldFile, newFile] of [[join(oldUiRoot, oldUiFragment), join(newUiRoot, newUiFragment)], [join(oldPolicyRoot, 'cordis.policy.fragment.yml'), join(newPolicyRoot, 'cordis.policy.fragment.yml')]]) {
    if (!(await readFile(oldFile)).equals(await readFile(newFile))) throw new OfficialUiInstallerError('LIVE_UPDATE_FRAGMENT_CHANGED')
  }
}

async function verifyLiveUpdate({ previousReceiptPath, paths, target, packages, ui, uiManifest, policy, allowOwnedFragmentMigration }) {
  const previous = await readLiveUpdateReceipt({ previousReceiptPath, paths, target, packageNames: packages.map(row => row.name) })
  const identities = previous.receipt.artifacts
  if (identities?.ui?.id !== 'airules-dsh-ui-overlay' || identities?.policy?.id !== 'airules-official-policy-overlay' || ![identities.ui.version, identities.policy.version].every(version => typeof version === 'string' && /^[a-z0-9.-]+$/u.test(version))) throw new OfficialUiInstallerError('LIVE_PREVIOUS_ARTIFACT_INVALID')
  const oldUi = await verifyUiArtifact(join(REPO_ROOT, 'dist', `airules-ui-overlay-${identities.ui.version}`))
  const oldPolicy = await verifyPolicyArtifact(join(REPO_ROOT, 'dist', `airules-official-policy-${identities.policy.version}`))
  if (oldUi.manifestSha256 !== identities.ui.manifestSha256 || oldPolicy.manifestSha256 !== identities.policy.manifestSha256 || oldUi.manifest.artifact.version !== identities.ui.version || oldPolicy.manifest.artifact.version !== identities.policy.version) throw new OfficialUiInstallerError('LIVE_PREVIOUS_ARTIFACT_MISMATCH')
  const oldUiManifest = await readJson(join(oldUi.root, 'official-ui-manifest.json'), 'OFFICIAL_UI_MANIFEST_INVALID')
  const oldPackages = [...oldUiManifest.packages.map(row => row.name), ...oldPolicy.packageNames].sort()
  if (canonical(oldPackages) !== canonical([...previous.receipt.artifactPackageNames].sort())) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_PACKAGE_INVALID')
  const noops = previous.receipt.dependencyResolution?.verifiedNoops
  if (!Array.isArray(noops) || new Set(noops.map(row => row.package)).size !== noops.length || noops.some(row => !SHARED_SUBSET_DEPENDENCIES.has(row.package) && row.package !== STORAGE_DOMAIN) || canonical(oldPackages.filter(name => name !== NESTED_ZOD && !noops.some(row => row.package === name))) !== canonical([...previous.receipt.packageNames].sort())) throw new OfficialUiInstallerError('LIVE_PREVIOUS_RECEIPT_PACKAGE_INVALID')
  if (allowOwnedFragmentMigration) {
    previous.migrationPairs = await Promise.all([
      [join(oldUi.root, oldUiManifest.cordisFragment), join(ui.root, uiManifest.cordisFragment)],
      [join(oldPolicy.root, 'cordis.policy.fragment.yml'), join(policy.root, 'cordis.policy.fragment.yml')],
    ].map(async ([oldFile, newFile]) => ({ oldFragment: await readFile(oldFile, 'utf8'), newFragment: await readFile(newFile, 'utf8') })))
  } else await assertLiveUpdateFragments({ oldUiRoot: oldUi.root, newUiRoot: ui.root, oldPolicyRoot: oldPolicy.root, newPolicyRoot: policy.root, oldUiFragment: oldUiManifest.cordisFragment, newUiFragment: uiManifest.cordisFragment })
  return previous
}

export async function buildLivePromotionPlan({ installRoot, profileRoot, backupRoot, candidateRoot, uiArtifactRoot = DEFAULT_UI_ARTIFACT, policyArtifactRoot = DEFAULT_POLICY_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK, allowExistingBackup = false, previousReceiptPath, allowOwnedFragmentMigration = false }) {
  if (typeof allowOwnedFragmentMigration !== 'boolean' || (allowOwnedFragmentMigration && !previousReceiptPath)) throw new OfficialUiInstallerError('LIVE_MIGRATION_PREVIOUS_RECEIPT_REQUIRED')
  const paths = assertPromotionPaths({ installRoot, profileRoot, backupRoot })
  if (await pathKind(paths.profile) !== 'directory' || await pathKind(join(paths.profile, 'node_modules')) !== 'directory') throw new OfficialUiInstallerError('LIVE_PROFILE_LAYOUT_INVALID')
  const backupState = await pathKind(paths.backup)
  if (backupState !== 'missing' && !(allowExistingBackup && backupState === 'directory')) throw new OfficialUiInstallerError('LIVE_BACKUP_ALREADY_EXISTS')
  const ui = await verifyUiArtifact(uiArtifactRoot), policy = await verifyPolicyArtifact(policyArtifactRoot)
  const verified = await verifyOfficialDesktop({ installRoot: paths.install, releaseLockPath })
  const target = { kind: 'official-desktop', hostVersion: verified.lock.hostVersion, appAsarSha256: verified.lock.files['resources/app.asar']?.sha256 }
  for (const artifact of [ui.manifest.target, policy.manifest.target]) {
    const versions = artifact?.hostVersions ?? [artifact?.hostVersion]
    const hashes = artifact?.appAsarSha256 ? [artifact.appAsarSha256] : [target.appAsarSha256]
    if (!versions.includes(target.hostVersion) || !hashes.includes(target.appAsarSha256)) throw new OfficialUiInstallerError('LIVE_ARTIFACT_TARGET_MISMATCH')
  }
  const certification = await verifyCandidateCertification({ candidateRoot, ui, policy, releaseLockPath })
  const uiManifest = await readJson(join(ui.root, 'official-ui-manifest.json'), 'OFFICIAL_UI_MANIFEST_INVALID')
  const packages = [...uiManifest.packages.map(row => ({ ...row, layer: 'ui', root: ui.root })), ...policy.packageNames.map(name => ({ name, source: `payload/packages/${name}`, layer: 'policy', root: policy.root }))]
  const seen = new Set(), operations = [], collisions = [], verifiedNoops = []
  for (const row of packages) {
    if (!PACKAGE.test(row.name) || seen.has(row.name)) throw new OfficialUiInstallerError('LIVE_PACKAGE_ALLOWLIST_INVALID', row.name)
    seen.add(row.name)
  }
  const previous = previousReceiptPath ? await verifyLiveUpdate({ previousReceiptPath, paths, target, packages, ui, uiManifest, policy, allowOwnedFragmentMigration }) : null
  const storageRow = packages.find(row => row.name === STORAGE_DOMAIN), zodRow = packages.find(row => row.name === NESTED_ZOD)
  if (!storageRow || !zodRow) throw new OfficialUiInstallerError('LIVE_NESTED_DEPENDENCY_CONTRACT_MISSING')
  const storageSource = join(storageRow.root, ...storageRow.source.split('/')), zodSource = join(zodRow.root, ...zodRow.source.split('/'))
  const storageIdentity = await packageIdentity(storageSource), zodIdentity = await packageIdentity(zodSource)
  if (storageIdentity.dependencies?.zod !== zodIdentity.version || zodIdentity.version !== '4.4.3') throw new OfficialUiInstallerError('LIVE_NESTED_ZOD_VERSION_MISMATCH')
  const storageAfterBase = await directoryState(storageSource), zodAfter = await directoryState(zodSource)
  const storageAfter = directoryStateWithNested(storageAfterBase, NESTED_ZOD, zodAfter)
  for (const row of packages) {
    if (row.name === NESTED_ZOD) continue
    const source = join(row.root, ...row.source.split('/')), targetPath = join(paths.profile, 'node_modules', ...row.name.split('/'))
    const before = await targetState(targetPath), after = row.name === STORAGE_DOMAIN ? storageAfter : await directoryState(source)
    if (before.type !== 'missing') {
      const compatible = SHARED_SUBSET_DEPENDENCIES.has(row.name)
        ? await verifiedSubsetDependency({ name: row.name, source, target: targetPath, sourceState: after, installedState: before })
        : row.name === STORAGE_DOMAIN && await verifiedSubsetDependency({ name: row.name, source, target: targetPath, sourceState: after, installedState: before })
      if (compatible) {
        const identity = await packageIdentity(source)
        verifiedNoops.push(Object.freeze({ package: row.name, version: identity.version, sourceDigest: after.digest, installedDigest: before.digest, mode: row.name === STORAGE_DOMAIN ? 'composite-subset' : 'same-version-subset' }))
        continue
      }
      if (!previous?.owned.has(row.name) || !sameState(before, previous.owned.get(row.name))) collisions.push({ type: 'package', package: row.name, target: `node_modules/${row.name}` })
    }
    operations.push(Object.freeze({ type: row.name === STORAGE_DOMAIN ? 'copy-directory-with-nested-dependency' : 'copy-directory', layer: row.layer, package: row.name, source, target: targetPath, targetRelative: `node_modules/${row.name}`, before, after,
      nestedDependency: row.name === STORAGE_DOMAIN ? Object.freeze({ name: NESTED_ZOD, version: zodIdentity.version, source: zodSource, targetRelative: `node_modules/${NESTED_ZOD}` }) : undefined }))
  }
  const cordisTarget = join(paths.profile, 'cordis.patch.yml'), beforeCordis = await targetState(cordisTarget)
  if (!['missing', 'file'].includes(beforeCordis.type)) throw new OfficialUiInstallerError('LIVE_CORDIS_TARGET_INVALID')
  const current = beforeCordis.type === 'file' ? await readFile(cordisTarget, 'utf8') : ''
  let merged = null
  if (previous) {
    if (beforeCordis.type !== 'file') throw new OfficialUiInstallerError('LIVE_UPDATE_CORDIS_MISSING')
    try { merged = allowOwnedFragmentMigration ? migrateCordisFragments(current, previous.migrationPairs) : await readFile(cordisTarget) }
    catch (error) { collisions.push({ type: 'cordis', reason: error.code ?? error.message }) }
  } else try {
    const withUi = mergeUiCordis(current, await readFile(join(ui.root, uiManifest.cordisFragment), 'utf8')).text
    merged = mergePolicyCordis(withUi, await readFile(join(policy.root, 'cordis.policy.fragment.yml'), 'utf8')).text
  } catch (error) { collisions.push({ type: 'cordis', reason: error.code ?? error.message }) }
  operations.push(Object.freeze({ type: 'merge-cordis', target: cordisTarget, targetRelative: 'cordis.patch.yml', before: beforeCordis, after: merged === null ? null : { type: 'file', sha256: sha256(Buffer.from(merged)), bytes: Buffer.byteLength(merged) }, content: merged }))
  const plan = {
    schemaVersion: 1,
    status: collisions.length ? 'blocked' : 'ready',
    readOnly: true,
    target,
    installRoot: paths.install,
    profileRoot: paths.profile,
    backupRoot: paths.backup,
    previousPromotion: previous ? { receiptPath: previous.receiptFile, receiptSha256: previous.sha256, preserveCordis: merged !== null && Buffer.from(current).equals(Buffer.from(merged)), ...(allowOwnedFragmentMigration ? { managedFragmentMigration: true } : {}) } : undefined,
    artifacts: { ui: { ...ui.manifest.artifact, manifestSha256: ui.manifestSha256 }, policy: { ...policy.manifest.artifact, manifestSha256: policy.manifestSha256 } },
    certification: { candidateRoot: certification.candidate.root, smokeReport: relative(certification.candidate.root, certification.smokePath).replaceAll('\\', '/'), smokeStatus: certification.smoke.status },
    artifactPackageNames: [...seen].sort(),
    packageNames: operations.filter(row => row.package).map(row => row.package).sort(),
    dependencyResolution: Object.freeze({
      verifiedNoops: Object.freeze(verifiedNoops.sort((a, b) => a.package.localeCompare(b.package, 'en'))),
      nested: Object.freeze([{ name: NESTED_ZOD, version: zodIdentity.version, parent: STORAGE_DOMAIN, target: `node_modules/${STORAGE_DOMAIN}/node_modules/${NESTED_ZOD}` }]),
      preservedTopLevel: Object.freeze([{ name: NESTED_ZOD, reason: 'exact dependency is nested under dsh-storage-domain' }]),
    }),
    operations: Object.freeze(operations),
    collisions: Object.freeze(collisions),
  }
  return Object.freeze({ ...plan, signature: planSignature(plan) })
}

export { DEFAULT_RELEASE_LOCK, directoryStateWithNested, exactSubset, NESTED_ZOD, OfficialUiInstallerError, planSignature, sameState, SHARED_SUBSET_DEPENDENCIES, STORAGE_DOMAIN }
