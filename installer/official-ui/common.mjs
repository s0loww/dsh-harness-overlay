import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOfficialDesktopPlan, DEFAULT_RELEASE_LOCK } from '../../src/targets/official-desktop/target.mjs'
import { canonical, directoryState, pathKind, sameState, sha256, targetState } from '../fs-state.mjs'
import { analyzeUiCordis, mergeUiCordis } from './ui-cordis.mjs'

const MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const REPO_ROOT = resolve(MODULE_DIR, '../..')
export const DEFAULT_ARTIFACT = resolve(REPO_ROOT, 'dist/airules-ui-overlay-0.1.0-dev2')
export const LIVE_INSTALL = resolve('C:/Users/S0lo/AppData/Local/Programs/DeepSeek Harness')
export const LIVE_HOME = resolve(join(homedir(), '.dsh'))
const HASH = /^[a-f0-9]{64}$/u
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const FORBIDDEN = new Set(['.desktop-local', '.dsh-1c', 'credentials', 'sessions', '.env'])

export class OfficialUiInstallerError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

function portable(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new OfficialUiInstallerError('UNSAFE_PATH', label)
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || FORBIDDEN.has(part.toLowerCase()))) {
    throw new OfficialUiInstallerError('UNSAFE_PATH', label)
  }
  return normalized
}

export function beneath(root, value, label) {
  const path = resolve(root, portable(value, label))
  const rel = relative(resolve(root), path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OfficialUiInstallerError('UNSAFE_PATH', label)
  return path
}

function overlap(left, right) {
  const a = resolve(left).toLowerCase(), b = resolve(right).toLowerCase()
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}

async function readJson(path, code) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new OfficialUiInstallerError(code, error.message) }
}

async function scan(root) {
  const result = {}
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const rel = relative(root, path).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw new OfficialUiInstallerError('ARTIFACT_SYMLINK_FORBIDDEN', rel)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        result[rel] = { sha256: sha256(bytes), bytes: bytes.byteLength }
      } else throw new OfficialUiInstallerError('ARTIFACT_SPECIAL_FILE_FORBIDDEN', rel)
    }
  }
  await walk(root)
  return result
}

export async function loadCandidate(candidateRoot) {
  const root = resolve(String(candidateRoot ?? ''))
  if (!candidateRoot || overlap(root, LIVE_INSTALL) || overlap(root, LIVE_HOME)) throw new OfficialUiInstallerError('LIVE_PATH_FORBIDDEN')
  if (await pathKind(root) !== 'directory') throw new OfficialUiInstallerError('CANDIDATE_ROOT_INVALID')
  const manifest = await readJson(join(root, 'candidate-manifest.json'), 'CANDIDATE_MANIFEST_INVALID')
  const expected = { install: 'install', dshHome: 'home', profile: 'home/profiles/desktop', electronUserData: 'electron-user-data', uiReadyMarker: 'ui-ready.json' }
  if (manifest?.schemaVersion !== 1 || manifest?.status !== 'created-not-launched' || !manifest.candidate) {
    throw new OfficialUiInstallerError('CANDIDATE_MANIFEST_INVALID')
  }
  for (const [key, value] of Object.entries(expected)) if (manifest.candidate[key] !== value) throw new OfficialUiInstallerError('CANDIDATE_LAYOUT_INVALID', key)
  if (manifest.isolation?.copiesLiveProfile !== false) throw new OfficialUiInstallerError('CANDIDATE_ISOLATION_INVALID')
  const installRoot = beneath(root, expected.install, 'candidate install')
  const profileRoot = beneath(root, expected.profile, 'candidate profile')
  const modulesRoot = join(profileRoot, 'node_modules')
  if (await pathKind(installRoot) !== 'directory' || await pathKind(profileRoot) !== 'directory' || await pathKind(modulesRoot) !== 'directory') {
    throw new OfficialUiInstallerError('CANDIDATE_LAYOUT_MISSING')
  }
  return Object.freeze({ root, manifest, installRoot, profileRoot, modulesRoot, marker: beneath(root, expected.uiReadyMarker, 'ui marker') })
}

export async function verifyUiArtifact(artifactRoot) {
  const root = resolve(String(artifactRoot ?? ''))
  if (!artifactRoot || await pathKind(root) !== 'directory') throw new OfficialUiInstallerError('UI_ARTIFACT_INVALID')
  const manifest = await readJson(join(root, 'ui-overlay-manifest.json'), 'UI_MANIFEST_INVALID')
  if (manifest?.schemaVersion !== 1 || manifest?.artifact?.id !== 'airules-dsh-ui-overlay' || !manifest.artifact.version) {
    throw new OfficialUiInstallerError('UI_MANIFEST_INVALID')
  }
  if (!manifest.separation || Object.values(manifest.separation).some(Boolean)) throw new OfficialUiInstallerError('UI_LAYER_LEAK')
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new OfficialUiInstallerError('UI_FILE_MAP_INVALID')
  const actual = await scan(root)
  delete actual['ui-overlay-manifest.json']
  const declared = Object.keys(manifest.files).sort(), found = Object.keys(actual).sort()
  if (canonical(declared) !== canonical(found)) throw new OfficialUiInstallerError('UI_FILE_SET_MISMATCH')
  for (const path of declared) {
    portable(path, `artifact file ${path}`)
    const record = manifest.files[path]
    if (!record || !HASH.test(record.sha256 ?? '') || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !sameState({ type: 'file', ...actual[path] }, { type: 'file', ...record })) {
      throw new OfficialUiInstallerError('UI_FILE_HASH_MISMATCH', path)
    }
  }
  return Object.freeze({ root, manifest, manifestSha256: sha256(await readFile(join(root, 'ui-overlay-manifest.json'))) })
}

function relativeTarget(candidate, target) {
  const rel = relative(candidate.root, target).replaceAll('\\', '/')
  beneath(candidate.root, rel, 'target')
  return rel
}

function packageTarget(candidate, name) {
  if (!PACKAGE.test(name)) throw new OfficialUiInstallerError('PACKAGE_NAME_INVALID', name)
  return join(candidate.modulesRoot, ...name.split('/'))
}

export function planSignature(plan) {
  return createHash('sha256').update(canonical({
    artifact: plan.artifact,
    target: plan.target,
    artifactManifestSha256: plan.artifactManifestSha256,
    operations: plan.operations.map(item => ({ type: item.type, package: item.package, target: item.targetRelative, before: item.before, after: item.after })),
  })).digest('hex')
}

export async function buildOfficialUiInstallPlan({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK, replaceCollisions = false }) {
  const candidate = await loadCandidate(candidateRoot)
  const artifact = await verifyUiArtifact(artifactRoot)
  const official = await buildOfficialDesktopPlan({
    installRoot: candidate.installRoot,
    profileRoot: candidate.profileRoot,
    artifactRoot: artifact.root,
    releaseLockPath,
  })
  if (official.status !== 'ready' || official.internalPatches.length) throw new OfficialUiInstallerError('INTERNAL_PATCH_NOT_ALLOWED')
  const officialManifest = await readJson(join(artifact.root, 'official-ui-manifest.json'), 'OFFICIAL_UI_MANIFEST_INVALID')
  const uiPackages = artifact.manifest.operations.filter(item => ['package-copy', 'data-overlay'].includes(item.type))
  const operationPackages = new Map(uiPackages.map(item => [item.target.replace(/^node_modules\//u, ''), item]))
  if (operationPackages.size !== officialManifest.packages.length || official.operations.filter(item => item.type === 'copy-directory').length !== officialManifest.packages.length) {
    throw new OfficialUiInstallerError('PACKAGE_CONTRACT_MISMATCH')
  }
  const operations = [], collisions = []
  for (const item of official.operations.filter(item => item.type === 'copy-directory')) {
    const contract = operationPackages.get(item.package)
    if (!contract || contract.source !== `${item.source.slice(artifact.root.length + 1).replaceAll('\\', '/')}/package.json`) {
      throw new OfficialUiInstallerError('PACKAGE_CONTRACT_MISMATCH', item.package)
    }
    const expectedTarget = packageTarget(candidate, item.package)
    if (resolve(item.target) !== resolve(expectedTarget)) throw new OfficialUiInstallerError('PACKAGE_TARGET_MISMATCH', item.package)
    const before = await targetState(expectedTarget)
    const after = await directoryState(item.source)
    if (before.type !== 'missing') collisions.push({ type: 'package', target: relativeTarget(candidate, expectedTarget), package: item.package })
    operations.push(Object.freeze({ type: 'copy-directory', package: item.package, source: item.source, target: expectedTarget, targetRelative: relativeTarget(candidate, expectedTarget), before, after }))
  }
  const fragmentPath = join(artifact.root, officialManifest.cordisFragment)
  const fragment = await readFile(fragmentPath, 'utf8')
  const cordisTarget = join(candidate.profileRoot, 'cordis.patch.yml')
  const beforeCordis = await targetState(cordisTarget)
  if (!['missing', 'file'].includes(beforeCordis.type)) throw new OfficialUiInstallerError('CORDIS_TARGET_INVALID')
  const current = beforeCordis.type === 'file' ? await readFile(cordisTarget, 'utf8') : ''
  const analysis = analyzeUiCordis(current, fragment)
  if (analysis.collision) collisions.push({ type: 'cordis', target: relativeTarget(candidate, cordisTarget), reason: analysis.reason })
  let merged
  try { merged = mergeUiCordis(current, fragment, { replaceCollision: replaceCollisions }) }
  catch (error) {
    if (!analysis.collision || replaceCollisions) throw error
    merged = { ...analysis, text: null }
  }
  const cordisAfter = merged.text === null ? null : { type: 'file', sha256: sha256(Buffer.from(merged.text)), bytes: Buffer.byteLength(merged.text) }
  operations.push(Object.freeze({ type: 'merge-cordis-fragment', source: fragmentPath, target: cordisTarget, targetRelative: relativeTarget(candidate, cordisTarget), before: beforeCordis, after: cordisAfter, action: analysis.action }))

  const markerBefore = await targetState(candidate.marker)
  if (markerBefore.type !== 'missing') collisions.push({ type: 'marker', target: relativeTarget(candidate, candidate.marker) })
  const receiptRelative = `.airules-ui-backups/${official.artifact.id}-${official.artifact.version}/receipt.json`
  const markerText = canonical({ schemaVersion: 1, status: 'ui-ready', artifact: official.artifact, receipt: receiptRelative })
  operations.push(Object.freeze({ type: 'ready-marker', target: candidate.marker, targetRelative: relativeTarget(candidate, candidate.marker), before: markerBefore, after: { type: 'file', sha256: sha256(Buffer.from(markerText)), bytes: Buffer.byteLength(markerText) }, content: markerText }))

  const blocked = collisions.length && !replaceCollisions
  const plan = {
    status: blocked ? 'blocked' : 'ready',
    readOnly: true,
    candidateRoot: candidate.root,
    artifactRoot: artifact.root,
    artifact: official.artifact,
    target: official.target,
    artifactManifestSha256: artifact.manifestSha256,
    backupRootRelative: `.airules-ui-backups/${official.artifact.id}-${official.artifact.version}`,
    replaceCollisions: Boolean(replaceCollisions),
    operations: Object.freeze(operations),
    collisions: Object.freeze(collisions),
    candidate,
  }
  return Object.freeze({ ...plan, signature: planSignature(plan) })
}
