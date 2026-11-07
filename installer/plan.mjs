import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { analyzeCordis, mergeCordis } from './cordis.mjs'
import { loadReleasePatch, prepareReleasePatch, ReleasePatchError } from './release-patch.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_BASELINE = join(REPO, 'upstream', 'release.lock.json')
const MANIFEST_NAME = 'overlay-manifest.json'
const EXPECTED_INSTALL = Object.freeze({
  providerSource: 'payload/packages/airules-dsh-provider',
  providerTarget: 'profiles/node_modules/airules-dsh-provider',
  rulepackSource: 'payload/packages/airules-dsh-rulepack',
  rulepackTarget: 'profiles/node_modules/airules-dsh-rulepack',
  cordisFragment: 'cordis.patch.fragment.yml',
})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export class PlanError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'PlanError'
    this.code = code
  }
}

async function jsonFile(path, code) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new PlanError(code, error.code === 'ENOENT' ? 'file not found' : error.message)
  }
  try {
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
    return { value, bytes }
  } catch (error) {
    throw new PlanError(code, `invalid JSON (${error.message})`)
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function portablePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) {
    throw new PlanError('UNSAFE_OVERLAY_PATH', label)
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new PlanError('UNSAFE_OVERLAY_PATH', label)
  }
  return value
}

function beneath(root, portable, label) {
  const target = resolve(root, ...portablePath(portable, label).split('/'))
  const rel = relative(resolve(root), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new PlanError('UNSAFE_OVERLAY_PATH', label)
  return target
}

async function regularFiles(root) {
  const result = []
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new PlanError('OVERLAY_PAYLOAD_MISSING', relative(root, directory).replaceAll('\\', '/') || '.')
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new PlanError('OVERLAY_SYMLINK_FORBIDDEN', relative(root, path).replaceAll('\\', '/'))
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) result.push(path)
      else throw new PlanError('OVERLAY_SPECIAL_FILE_FORBIDDEN', relative(root, path).replaceAll('\\', '/'))
    }
  }
  await walk(root)
  return result
}

function requireInstallContract(install) {
  if (!install || typeof install !== 'object' || Array.isArray(install)) {
    throw new PlanError('OVERLAY_INSTALL_CONTRACT_INVALID')
  }
  for (const [key, expected] of Object.entries(EXPECTED_INSTALL)) {
    if (install[key] !== expected) throw new PlanError('OVERLAY_INSTALL_CONTRACT_INVALID', key)
    portablePath(install[key], `install.${key}`)
  }
}

async function verifyBaseline(installRoot, baseline, baselineBytes, acceptedSourceHashes = {}) {
  if (!baseline.releaseId || !baseline.product || !baseline.sourceFiles || typeof baseline.sourceFiles !== 'object') {
    throw new PlanError('BASELINE_LOCK_INVALID')
  }

  const releasePath = join(installRoot, 'RELEASE-MANIFEST.json')
  const { value: release } = await jsonFile(releasePath, 'RELEASE_MANIFEST_INVALID')
  if (release.releaseId !== baseline.releaseId || release.product !== baseline.product) {
    throw new PlanError('UNKNOWN_RELEASE', `expected ${baseline.product} ${baseline.releaseId}`)
  }
  for (const key of ['hostVersion', 'bundleVersion']) {
    if (baseline[key] !== undefined && release[key] !== baseline[key]) {
      throw new PlanError('UNKNOWN_RELEASE', `${key} mismatch`)
    }
  }

  let verified = 0
  for (const rel of Object.keys(baseline.sourceFiles).sort()) {
    const path = beneath(installRoot, rel, `baseline.sourceFiles.${rel}`)
    let bytes
    try {
      bytes = await readFile(path)
    } catch (error) {
      throw new PlanError('BASELINE_SOURCE_MISSING', rel)
    }
    const actual = sha256(bytes)
    const accepted = new Set([baseline.sourceFiles[rel], ...(acceptedSourceHashes[rel] ?? [])])
    if (!accepted.has(actual)) throw new PlanError('BASELINE_SOURCE_HASH_MISMATCH', rel)
    verified += 1
  }
  return { release, verified, lockSha256: sha256(baselineBytes) }
}

export async function verifyInstalledBaseline({ installRoot, baselinePath = DEFAULT_BASELINE, acceptedSourceHashes = {} }) {
  const root = resolve(installRoot)
  const { value: baseline, bytes } = await jsonFile(resolve(baselinePath), 'BASELINE_LOCK_INVALID')
  const check = await verifyBaseline(root, baseline, bytes, acceptedSourceHashes)
  return { baseline, check }
}

async function verifyOverlay(overlayRoot, baseline, baselineLockSha256) {
  const { value: manifest } = await jsonFile(join(overlayRoot, MANIFEST_NAME), 'OVERLAY_MANIFEST_INVALID')
  if (![1, 2].includes(manifest.schemaVersion) || !manifest.overlay?.id || !manifest.overlay?.version) {
    throw new PlanError('OVERLAY_MANIFEST_INVALID', 'unsupported schema or missing identity')
  }
  if (manifest.target?.releaseId !== baseline.releaseId || manifest.target?.product !== baseline.product) {
    throw new PlanError('OVERLAY_RELEASE_MISMATCH', `expected ${baseline.product} ${baseline.releaseId}`)
  }
  for (const key of ['hostVersion', 'bundleVersion']) {
    if (baseline[key] !== undefined && manifest.target?.[key] !== baseline[key]) {
      throw new PlanError('OVERLAY_RELEASE_MISMATCH', `${key} mismatch`)
    }
  }
  if (manifest.target.releaseLockSha256 !== baselineLockSha256) {
    throw new PlanError('OVERLAY_RELEASE_LOCK_MISMATCH')
  }
  requireInstallContract(manifest.install)
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new PlanError('OVERLAY_MANIFEST_INVALID', 'files map missing')
  }

  const actual = (await regularFiles(overlayRoot))
    .map(path => relative(overlayRoot, path).replaceAll('\\', '/'))
    .filter(path => path !== MANIFEST_NAME)
    .sort()
  const declared = Object.keys(manifest.files).sort()
  for (const rel of declared) portablePath(rel, `files.${rel}`)
  if (actual.length !== declared.length || actual.some((path, index) => path !== declared[index])) {
    throw new PlanError('OVERLAY_FILE_SET_MISMATCH')
  }

  let totalBytes = 0
  for (const rel of declared) {
    const record = manifest.files[rel]
    if (!record || !/^[a-f0-9]{64}$/u.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new PlanError('OVERLAY_MANIFEST_INVALID', `invalid file record: ${rel}`)
    }
    const bytes = await readFile(beneath(overlayRoot, rel, `files.${rel}`))
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new PlanError('OVERLAY_PAYLOAD_HASH_MISMATCH', rel)
    }
    totalBytes += bytes.byteLength
  }

  const sources = [manifest.install.providerSource, manifest.install.rulepackSource]
  for (const source of sources) {
    const prefix = `${source}/`
    if (!declared.some(path => path.startsWith(prefix))) throw new PlanError('OVERLAY_PAYLOAD_MISSING', source)
  }
  if (!declared.includes(manifest.install.cordisFragment)) {
    throw new PlanError('OVERLAY_PAYLOAD_MISSING', manifest.install.cordisFragment)
  }
  try {
    const releasePatch = await loadReleasePatch({ overlayRoot, manifest, baseline })
    if (releasePatch && !declared.includes(manifest.releasePatch.source)) {
      throw new PlanError('OVERLAY_PAYLOAD_MISSING', manifest.releasePatch.source)
    }
  } catch (error) {
    if (error instanceof PlanError) throw error
    if (error instanceof ReleasePatchError) {
      throw new PlanError(error.code, error.message.replace(new RegExp(`^${error.code}:?\\s*`, 'u'), ''))
    }
    throw error
  }
  return { manifest, fileCount: declared.length, totalBytes }
}

function backupPath(installRoot, manifest, targetPortable) {
  const safeId = `${manifest.overlay.id}-${manifest.overlay.version}`.replace(/[^a-zA-Z0-9._-]/gu, '_')
  return join(installRoot, '.airules-backups', safeId, ...targetPortable.split('/'))
}

async function copyOperation({ installRoot, overlayRoot, manifest, sourceKey, targetKey }) {
  const sourcePortable = manifest.install[sourceKey]
  const targetPortable = `.dsh-1c/home/${manifest.install[targetKey]}`
  const source = beneath(overlayRoot, sourcePortable, `install.${sourceKey}`)
  const target = beneath(installRoot, targetPortable, `install.${targetKey}`)
  const collision = await exists(target)
  const prefix = `${sourcePortable}/`
  const records = Object.fromEntries(Object.entries(manifest.files).filter(([path]) => path.startsWith(prefix)).map(([path, record]) => [
    path.slice(prefix.length),
    record,
  ]).sort(([a], [b]) => a.localeCompare(b, 'en')))
  return {
    kind: 'copy-directory',
    package: targetKey === 'providerTarget' ? 'provider' : 'rulepack',
    source,
    target,
    fileCount: Object.keys(records).length,
    bytes: Object.values(records).reduce((sum, record) => sum + record.bytes, 0),
    contentSha256: sha256(Buffer.from(`${JSON.stringify(records, null, 2)}\n`)),
    collision,
    backupTarget: collision ? backupPath(installRoot, manifest, targetPortable) : null,
  }
}

async function cordisOperation({ installRoot, overlayRoot, manifest }) {
  const source = beneath(overlayRoot, manifest.install.cordisFragment, 'install.cordisFragment')
  const fragment = await readFile(source, 'utf8')
  const targetPortable = 'dsh-1c-bundle/cordis.patch.yml'
  const target = beneath(installRoot, targetPortable, 'cordis target')
  let targetExists = false
  let analysis = { action: 'merge', collision: false, reason: null }
  let resultSha256 = null
  let resultBytes = null
  try {
    const text = await readFile(target, 'utf8')
    targetExists = true
    analysis = analyzeCordis(text, fragment)
    if (analysis.action !== 'noop' && analysis.action !== 'refuse') {
      const merged = mergeCordis(text, fragment, { replaceCollision: analysis.action === 'replace' })
      const bytes = Buffer.from(merged.text, 'utf8')
      resultSha256 = sha256(bytes)
      resultBytes = bytes.byteLength
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    analysis = { action: 'refuse', collision: true, reason: 'CORDIS_TARGET_MISSING' }
  }
  return {
    kind: 'merge-cordis-fragment',
    source,
    target,
    action: analysis.action,
    fragmentSha256: sha256(Buffer.from(fragment, 'utf8')),
    resultSha256,
    resultBytes,
    collision: analysis.collision,
    collisionReason: analysis.reason,
    backupTarget: targetExists && analysis.action !== 'noop' ? backupPath(installRoot, manifest, targetPortable) : null,
  }
}

export async function buildInstallPlan({ installRoot, overlay, baselinePath = DEFAULT_BASELINE }) {
  if (!installRoot || !overlay) throw new PlanError('ARGUMENT_REQUIRED', 'installRoot and overlay')
  const root = resolve(installRoot)
  const overlayRoot = resolve(overlay)
  const { value: baseline, bytes: baselineBytes } = await jsonFile(resolve(baselinePath), 'BASELINE_LOCK_INVALID')
  const baselineCheck = await verifyBaseline(root, baseline, baselineBytes)
  const overlayCheck = await verifyOverlay(overlayRoot, baseline, baselineCheck.lockSha256)
  const manifest = overlayCheck.manifest

  let patchOperations = []
  try {
    patchOperations = await prepareReleasePatch({ installRoot: root, overlayRoot, manifest, baseline })
  } catch (error) {
    if (error instanceof ReleasePatchError) {
      throw new PlanError(error.code, error.message.replace(new RegExp(`^${error.code}:?\\s*`, 'u'), ''))
    }
    throw error
  }

  const operations = [
    ...patchOperations.map(operation => ({
      ...operation,
      backupTarget: backupPath(root, manifest, operation.targetRelative),
    })),
    await copyOperation({ installRoot: root, overlayRoot, manifest, sourceKey: 'providerSource', targetKey: 'providerTarget' }),
    await copyOperation({ installRoot: root, overlayRoot, manifest, sourceKey: 'rulepackSource', targetKey: 'rulepackTarget' }),
    await cordisOperation({ installRoot: root, overlayRoot, manifest }),
  ]
  const collisions = operations.filter(operation => operation.collision).map(operation => ({
    kind: operation.kind,
    target: operation.target,
    reason: operation.collisionReason ?? 'TARGET_ALREADY_EXISTS',
  }))
  const backupTargets = operations.filter(operation => operation.backupTarget).map(operation => operation.backupTarget)

  return {
    schemaVersion: manifest.schemaVersion,
    mode: 'read-only-plan',
    status: collisions.length ? 'blocked' : 'ready',
    release: {
      product: baseline.product,
      releaseId: baseline.releaseId,
      hostVersion: baseline.hostVersion,
      bundleVersion: baseline.bundleVersion,
    },
    overlay: {
      id: manifest.overlay.id,
      version: manifest.overlay.version,
      fileCount: overlayCheck.fileCount,
      bytes: overlayCheck.totalBytes,
    },
    releasePatch: manifest.schemaVersion === 2 ? {
      required: true,
      engine: manifest.releasePatch.engine,
      id: manifest.releasePatch.id,
      source: manifest.releasePatch.source,
      files: patchOperations.map(operation => ({
        target: operation.targetRelative,
        sourceSha256: operation.sourceSha256,
        resultSha256: operation.resultSha256,
        replacements: operation.replacements,
      })),
    } : null,
    checks: {
      releaseGuard: 'passed',
      baselineSourceHashes: { status: 'passed', verified: baselineCheck.verified },
      overlayManifest: 'passed',
      overlayPayloadHashes: { status: 'passed', verified: overlayCheck.fileCount },
      releasePatch: manifest.schemaVersion === 2 ? {
        status: 'passed',
        files: patchOperations.length,
        replacements: patchOperations.reduce((sum, operation) => sum + operation.replacements, 0),
      } : { status: 'not-required', files: 0, replacements: 0 },
    },
    operations,
    collisions,
    backupTargets,
  }
}

function parseArgs(argv) {
  const result = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') {
      result.json = true
      continue
    }
    if (!['--install-root', '--overlay'].includes(key) || argv[index + 1] === undefined) {
      throw new PlanError('USAGE', 'node installer/plan.mjs --install-root <DSH root> --overlay <artifact> [--json]')
    }
    result[key.slice(2)] = argv[index + 1]
    index += 1
  }
  if (!result['install-root'] || !result.overlay) {
    throw new PlanError('USAGE', 'node installer/plan.mjs --install-root <DSH root> --overlay <artifact> [--json]')
  }
  return result
}

function textPlan(plan) {
  const lines = [
    `Install plan: ${plan.status.toUpperCase()} (read-only)`,
    `Release: ${plan.release.product} ${plan.release.releaseId}`,
    `Overlay: ${plan.overlay.id} ${plan.overlay.version} (${plan.overlay.fileCount} files)`,
    `Baseline hashes: PASS (${plan.checks.baselineSourceHashes.verified})`,
    `Overlay hashes: PASS (${plan.checks.overlayPayloadHashes.verified})`,
    `Release patch: ${plan.checks.releasePatch.status.toUpperCase()} (${plan.checks.releasePatch.files} files)`,
  ]
  for (const operation of plan.operations) {
    lines.push(`- ${operation.kind}: ${operation.target}${operation.collision ? ' [COLLISION]' : ''}`)
  }
  if (plan.backupTargets.length) {
    lines.push('Backup targets:')
    for (const target of plan.backupTargets) lines.push(`- ${target}`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = await buildInstallPlan({ installRoot: args['install-root'], overlay: args.overlay })
  process.stdout.write(args.json ? `${JSON.stringify(plan, null, 2)}\n` : textPlan(plan))
  if (plan.status !== 'ready') process.exitCode = 2
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => {
  const code = error instanceof PlanError ? error.code : 'PLAN_FAILED'
  console.error(`${code}: ${error.message.replace(new RegExp(`^${code}:?\\s*`, 'u'), '')}`)
  process.exitCode = 1
})
