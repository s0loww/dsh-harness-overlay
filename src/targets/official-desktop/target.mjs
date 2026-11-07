import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const DEFAULT_RELEASE_LOCK = resolve(MODULE_DIR, '../../../upstream/official-desktop/release.lock.json')
export const DEFAULT_PROFILE_ROOT = join(homedir(), '.dsh', 'profiles', 'desktop')
const SHA256 = /^[a-f0-9]{64}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const FORBIDDEN_PATH_PARTS = new Set(['.desktop-local', '.dsh-1c', 'credentials', 'sessions', '.env'])

export class OfficialDesktopTargetError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficialDesktopTargetError(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OfficialDesktopTargetError(code)
  }
}

function portable(value, label) {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) throw new OfficialDesktopTargetError('UNSAFE_PATH', label)
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || FORBIDDEN_PATH_PARTS.has(part.toLowerCase()))) {
    throw new OfficialDesktopTargetError('UNSAFE_PATH', label)
  }
  return normalized
}

function beneath(root, relativePath, label) {
  const path = resolve(root, portable(relativePath, label))
  const rel = relative(resolve(root), path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OfficialDesktopTargetError('UNSAFE_PATH', label)
  return path
}

async function json(path, code) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new OfficialDesktopTargetError(code, error.message) }
}

async function kind(path) {
  try {
    const info = await lstat(path)
    if (info.isFile()) return 'file'
    if (info.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function readReleaseLock(path = DEFAULT_RELEASE_LOCK) {
  const lock = await json(resolve(path), 'RELEASE_LOCK_INVALID_JSON')
  exactKeys(lock, ['schemaVersion', 'target', 'product', 'hostVersion', 'buildCommit', 'platform', 'profileLayout', 'files'], 'RELEASE_LOCK_INVALID')
  if (lock.schemaVersion !== 1 || lock.target !== 'official-desktop' || !lock.hostVersion || !lock.files) {
    throw new OfficialDesktopTargetError('RELEASE_LOCK_INVALID')
  }
  for (const [relativePath, record] of Object.entries(lock.files)) {
    portable(relativePath, `release file ${relativePath}`)
    exactKeys(record, ['bytes', 'sha256'], 'RELEASE_FILE_RECORD_INVALID')
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !SHA256.test(record.sha256)) {
      throw new OfficialDesktopTargetError('RELEASE_FILE_RECORD_INVALID', relativePath)
    }
  }
  return lock
}

export async function snapshotOfficialDesktop({ installRoot, releaseLockPath = DEFAULT_RELEASE_LOCK }) {
  const root = resolve(String(installRoot ?? ''))
  if (!installRoot || await kind(root) !== 'directory') throw new OfficialDesktopTargetError('INSTALL_ROOT_INVALID')
  const lock = await readReleaseLock(releaseLockPath)
  const files = {}
  for (const relativePath of Object.keys(lock.files).sort()) {
    const path = beneath(root, relativePath, 'release file')
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') throw new OfficialDesktopTargetError('BASELINE_FILE_MISSING', relativePath)
      throw error
    })
    if (!info.isFile()) throw new OfficialDesktopTargetError('BASELINE_FILE_NOT_FILE', relativePath)
    files[relativePath] = { bytes: info.size, sha256: await hashFile(path) }
  }
  return Object.freeze({
    schemaVersion: 1,
    target: lock.target,
    product: lock.product,
    hostVersion: lock.hostVersion,
    buildCommit: lock.buildCommit,
    platform: lock.platform,
    files,
  })
}

export async function verifyOfficialDesktop(options) {
  const lock = await readReleaseLock(options?.releaseLockPath)
  const snapshot = await snapshotOfficialDesktop(options)
  for (const [relativePath, expected] of Object.entries(lock.files)) {
    const actual = snapshot.files[relativePath]
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new OfficialDesktopTargetError('BASELINE_HASH_MISMATCH', relativePath)
    }
  }
  return Object.freeze({ lock, snapshot })
}

function validateManifest(manifest, lock) {
  exactKeys(manifest, ['schemaVersion', 'artifact', 'target', 'packages', 'cordisFragment', 'internalPatches'], 'ARTIFACT_MANIFEST_INVALID')
  if (manifest.schemaVersion !== 1) throw new OfficialDesktopTargetError('ARTIFACT_SCHEMA_UNSUPPORTED')
  exactKeys(manifest.artifact, ['id', 'version'], 'ARTIFACT_ID_INVALID')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.artifact.id) || typeof manifest.artifact.version !== 'string' || !manifest.artifact.version) {
    throw new OfficialDesktopTargetError('ARTIFACT_ID_INVALID')
  }
  exactKeys(manifest.target, ['kind', 'hostVersion', 'appAsarSha256'], 'ARTIFACT_TARGET_INVALID')
  const appHash = lock.files['resources/app.asar']?.sha256
  if (manifest.target.kind !== 'official-desktop' || manifest.target.hostVersion !== lock.hostVersion || manifest.target.appAsarSha256 !== appHash) {
    throw new OfficialDesktopTargetError('ARTIFACT_TARGET_MISMATCH')
  }
  if (!Array.isArray(manifest.packages) || !Array.isArray(manifest.internalPatches)) throw new OfficialDesktopTargetError('ARTIFACT_MANIFEST_INVALID')
  const names = new Set()
  for (const item of manifest.packages) {
    exactKeys(item, ['name', 'source'], 'PACKAGE_RECORD_INVALID')
    if (!PACKAGE_NAME.test(item.name) || names.has(item.name)) throw new OfficialDesktopTargetError('PACKAGE_RECORD_INVALID', item.name)
    names.add(item.name)
    portable(item.source, `package ${item.name}`)
  }
  portable(manifest.cordisFragment, 'cordis fragment')
  const patches = new Set()
  for (const patch of manifest.internalPatches) {
    exactKeys(patch, ['id', 'appAsarSha256', 'descriptor'], 'INTERNAL_PATCH_INVALID')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(patch.id) || patches.has(patch.id) || patch.appAsarSha256 !== appHash) {
      throw new OfficialDesktopTargetError('INTERNAL_PATCH_BASELINE_MISMATCH', patch.id)
    }
    patches.add(patch.id)
    portable(patch.descriptor, `internal patch ${patch.id}`)
  }
  return manifest
}

export async function buildOfficialDesktopPlan({ installRoot, profileRoot = DEFAULT_PROFILE_ROOT, artifactRoot, manifestPath = 'official-ui-manifest.json', releaseLockPath = DEFAULT_RELEASE_LOCK }) {
  const verified = await verifyOfficialDesktop({ installRoot, releaseLockPath })
  const artifact = resolve(String(artifactRoot ?? ''))
  if (!artifactRoot || await kind(artifact) !== 'directory') throw new OfficialDesktopTargetError('ARTIFACT_ROOT_INVALID')
  const manifest = validateManifest(await json(beneath(artifact, manifestPath, 'artifact manifest'), 'ARTIFACT_MANIFEST_INVALID_JSON'), verified.lock)
  const profile = resolve(String(profileRoot ?? ''))
  if (!profileRoot || await kind(profile) !== 'directory') throw new OfficialDesktopTargetError('PROFILE_ROOT_INVALID')
  const modules = join(profile, 'node_modules')
  if (await kind(modules) !== 'directory') throw new OfficialDesktopTargetError('PROFILE_NODE_MODULES_MISSING')
  const cordisTarget = join(profile, 'cordis.patch.yml')
  const cordisTargetKind = await kind(cordisTarget)
  if (!['file', 'missing'].includes(cordisTargetKind)) throw new OfficialDesktopTargetError('PROFILE_CORDIS_INVALID')

  const operations = []
  for (const item of manifest.packages) {
    const source = beneath(artifact, item.source, `package ${item.name}`)
    if (await kind(source) !== 'directory') throw new OfficialDesktopTargetError('PACKAGE_SOURCE_MISSING', item.name)
    operations.push(Object.freeze({ type: 'copy-directory', package: item.name, source, target: join(modules, ...item.name.split('/')) }))
  }
  const fragment = beneath(artifact, manifest.cordisFragment, 'cordis fragment')
  if (await kind(fragment) !== 'file') throw new OfficialDesktopTargetError('CORDIS_FRAGMENT_MISSING')
  operations.push(Object.freeze({ type: 'merge-cordis-fragment', source: fragment, target: cordisTarget, targetKind: cordisTargetKind }))

  const internalPatches = manifest.internalPatches.map(patch => Object.freeze({ ...patch, descriptor: beneath(artifact, patch.descriptor, `internal patch ${patch.id}`) }))
  for (const patch of internalPatches) if (await kind(patch.descriptor) !== 'file') throw new OfficialDesktopTargetError('INTERNAL_PATCH_DESCRIPTOR_MISSING', patch.id)
  return Object.freeze({
    status: internalPatches.length ? 'review-required' : 'ready',
    readOnly: true,
    target: Object.freeze({ kind: 'official-desktop', hostVersion: verified.lock.hostVersion, appAsarSha256: verified.lock.files['resources/app.asar'].sha256 }),
    artifact: Object.freeze({ ...manifest.artifact }),
    profileRoot: profile,
    operations: Object.freeze(operations),
    internalPatches: Object.freeze(internalPatches),
    blockers: Object.freeze(internalPatches.length ? ['INTERNAL_APP_ASAR_PATCH_REQUIRES_SEPARATE_INSTALLER'] : []),
  })
}
