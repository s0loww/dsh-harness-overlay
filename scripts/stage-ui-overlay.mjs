#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateUiInventory, validateUiOverlayManifest } from '../src/ui-overlay/contracts.mjs'
import { localizeSleepSendClient, sleepSendLocalization } from '../src/ui-overlay/sleep-send-localization.mjs'
import { patchSettingsShell } from '../src/settings-shell/patch.mjs'
import { patchNativeModelsClient, patchNativeAccountClient } from '../src/providers-settings/patch-native.mjs'
import { directoryState } from '../installer/fs-state.mjs'
import { patchEffortSliderClient, patchEffortSliderPackage } from '../src/effort-compat/patch-slider.mjs'
import { adaptComposerHistoryPackage } from '../src/composer-history-compat/patch.mjs'
import { adaptTurnNavigatorPackage } from '../src/turn-nav-compat/patch.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_INVENTORY = join(REPO, 'src/ui-overlay/ui-component-inventory.json')
const DEFAULT_SET = join(REPO, 'src/ui-overlay/ui-package-set.json')
const DEFAULT_UPSTREAM = join(REPO, 'upstream/component-inventory.json')
const DEFAULT_OFFICIAL_LOCK = join(REPO, 'upstream/official-desktop/release.lock.json')
const ARTIFACT_ID = 'airules-dsh-ui-overlay'
const ARTIFACT_DIRECTORY_PREFIX = 'airules-ui-overlay'
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'])
const FORBIDDEN_NAMES = new Set(['.env', 'credentials.json', 'mcp-servers.json', 'tokenledger.sqlite'])
const execFile = promisify(execFileCallback)

export class UiStageError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
const canonical = value => `${JSON.stringify(value, null, 2)}\n`
const slash = value => value.replaceAll('\\', '/')

function safeRelative(value, code = 'UI_STAGE_PATH_UNSAFE') {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) throw new UiStageError(code, value)
  const parts = slash(value).split('/')
  if (parts.includes('..') || parts.some(part => ['.desktop-local', '.dsh-1c', 'sessions', 'credentials'].includes(part.toLowerCase()))) {
    throw new UiStageError(code, value)
  }
  return parts.join('/')
}

function packagePath(root, name) {
  return join(root, ...name.split('/'))
}

async function exists(path) {
  try { await stat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function readJson(path) {
  return json(await readFile(path))
}

export function assertCleanClientPayload(row, actualHash, content = '') {
  const clientPath = row.cleanClient?.path
  if (typeof clientPath !== 'string' || !/^[0-9a-f]{64}$/u.test(row.cleanClient?.sha256 ?? '')) {
    throw new UiStageError('UI_STAGE_CLEAN_CLIENT_LOCK_INVALID', row.name)
  }
  if (actualHash !== row.cleanClient.sha256) throw new UiStageError('UI_STAGE_CLEAN_CLIENT_HASH_MISMATCH', row.name)
  if (String(content).includes('projectPresetUi') || String(content).includes('dsh-1c-bundle')) {
    throw new UiStageError('UI_STAGE_BUNDLE_CLIENT_REJECTED', row.name)
  }
  return safeRelative(clientPath)
}

function assertArchiveEntry(value, packageName) {
  const normalized = slash(value).replace(/^\.\//u, '')
  if (!normalized.startsWith('package/') || normalized.includes('/../') || normalized.endsWith('/..') || /^[A-Za-z]:/u.test(normalized)) {
    throw new UiStageError('UI_STAGE_REGISTRY_ARCHIVE_UNSAFE', `${packageName}:${value}`)
  }
}

async function materializeRegistryPackage(row, root) {
  if (typeof row.registryIntegrity !== 'string' || !row.registryIntegrity.startsWith('sha512-')) {
    throw new UiStageError('UI_STAGE_REGISTRY_INTEGRITY_INVALID', row.name)
  }
  const packageRoot = join(root, row.name.replaceAll('/', '__'))
  await mkdir(packageRoot, { recursive: true })
  let packed
  try {
    const executable = process.platform === 'win32' ? process.execPath : 'npm'
    const npmPrefix = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : []
    const { stdout } = await execFile(executable, [
      ...npmPrefix, 'pack', `${row.name}@${row.version}`, '--pack-destination', packageRoot, '--json', '--ignore-scripts',
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    packed = JSON.parse(stdout)[0]
  } catch (error) {
    throw new UiStageError('UI_STAGE_REGISTRY_PACK_FAILED', `${row.name}: ${error.message}`)
  }
  if (!packed?.filename) throw new UiStageError('UI_STAGE_REGISTRY_PACK_INVALID', row.name)
  const archive = join(packageRoot, basename(packed.filename))
  const bytes = await readFile(archive)
  const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (actualIntegrity !== row.registryIntegrity) throw new UiStageError('UI_STAGE_REGISTRY_INTEGRITY_MISMATCH', row.name)
  let listing
  try {
    listing = (await execFile('tar', ['-tf', archive], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout
  } catch (error) {
    throw new UiStageError('UI_STAGE_REGISTRY_ARCHIVE_INVALID', `${row.name}: ${error.message}`)
  }
  for (const entry of listing.split(/\r?\n/u).filter(Boolean)) assertArchiveEntry(entry, row.name)
  try {
    await execFile('tar', ['-xf', archive, '-C', packageRoot], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw new UiStageError('UI_STAGE_REGISTRY_EXTRACT_FAILED', `${row.name}: ${error.message}`)
  }
  const source = join(packageRoot, 'package')
  const client = await readFile(join(source, safeRelative(row.cleanClient?.path ?? '')))
  assertCleanClientPayload(row, hash(client), client.toString('utf8'))
  return source
}

async function materializeRegistrySources(packageSet, root) {
  const result = new Map()
  for (const row of packageSet.publicPackages.filter(item => item.registryIntegrity)) {
    result.set(row.name, await materializeRegistryPackage(row, root))
  }
  return result
}

async function filesBelow(root, relativeRoot = '') {
  const result = []
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = join(directory, entry.name)
      const rel = slash(join(prefix, entry.name))
      if (entry.isSymbolicLink()) throw new UiStageError('UI_STAGE_SYMLINK_FORBIDDEN', rel)
      if (entry.isDirectory()) await walk(absolute, rel)
      else if (entry.isFile()) result.push(rel)
      else throw new UiStageError('UI_STAGE_SPECIAL_FILE_FORBIDDEN', rel)
    }
  }
  await walk(join(root, relativeRoot), relativeRoot)
  return result.sort()
}

async function declaredFiles(root, pkg) {
  // node_modules is already the published package payload. Copy its complete
  // immutable file set (minus nested dependencies, which are resolved as their
  // own packages) instead of re-evaluating npm `files` globs.
  const selected = new Set(await filesBelow(root))
  if (!selected.has('package.json')) throw new UiStageError('UI_STAGE_PACKAGE_JSON_MISSING', pkg.name)
  return [...selected].sort()
}

function assertPortableFile(relativePath) {
  safeRelative(relativePath)
  const lower = basename(relativePath).toLowerCase()
  if (FORBIDDEN_NAMES.has(lower) || /(?:^|[._-])(?:credential|secret|session)(?:[._-]|$)/u.test(lower)) {
    throw new UiStageError('UI_STAGE_RUNTIME_STATE_FORBIDDEN', relativePath)
  }
}

async function copyPackage(source, destination, pkg) {
  const files = await declaredFiles(source, pkg)
  for (const rel of files) {
    assertPortableFile(rel)
    const target = join(destination, rel)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(source, rel), target, { force: false, errorOnExist: true })
  }
  return files
}

async function adaptPackageLocalization(entry, target) {
  if(entry.name==='dsh-turn-navigator')return {compatibility:await adaptTurnNavigatorPackage(target)}
  if(entry.name==='dsh-composer-history')return {compatibility:await adaptComposerHistoryPackage(target)}
  if (entry.name === 'dsh-effort-slider') {
    const clientPath = join(target, 'lib/client.js')
    const before = await readFile(clientPath, 'utf8'), after = patchEffortSliderClient(before)
    await writeFile(clientPath, after, 'utf8')
    const packagePath = join(target, 'package.json')
    await writeFile(packagePath, canonical(patchEffortSliderPackage(await readJson(packagePath))), 'utf8')
    return { compatibility: { target: 'official-desktop-0.2.1-rc.5', sourcePath: 'lib/client.js', sourceSha256: hash(Buffer.from(before)), outputSha256: hash(Buffer.from(after)), contract: 'native-effort-menu-restored' } }
  }
  if (entry.name !== 'dsh-sleep-send') return undefined
  const relativeClient = safeRelative(entry.expected?.cleanClient?.path ?? '')
  const clientPath = join(target, relativeClient)
  const source = await readFile(clientPath, 'utf8')
  const sourceSha256 = hash(Buffer.from(source, 'utf8'))
  const localized = localizeSleepSendClient(source)
  const outputSha256 = hash(Buffer.from(localized, 'utf8'))
  await writeFile(clientPath, localized, { encoding: 'utf8', flag: 'w' })
  return Object.freeze({
    ...sleepSendLocalization,
    sourcePath: relativeClient,
    sourceSha256,
    outputSha256,
  })
}

async function verifyPackage(source, expected = {}) {
  const pkg = await readJson(join(source, 'package.json'))
  if (expected.name && pkg.name !== expected.name) throw new UiStageError('UI_STAGE_PACKAGE_NAME_MISMATCH', expected.name)
  if (expected.version && pkg.version !== expected.version) throw new UiStageError('UI_STAGE_PACKAGE_VERSION_MISMATCH', pkg.name)
  if (!ALLOWED_LICENSES.has(pkg.license)) throw new UiStageError('UI_STAGE_PACKAGE_LICENSE_NOT_ALLOWED', `${pkg.name}/${pkg.license}`)
  const notices = (await readdir(source)).filter(name => /^(?:LICENSE|LICENCE|COPYING)/iu.test(name))
  if (!notices.length) throw new UiStageError('UI_STAGE_PACKAGE_LICENSE_FILE_MISSING', pkg.name)
  return pkg
}

function directPackageMap(packageSet) {
  const result = new Map()
  for (const row of packageSet.publicPackages) {
    if (result.has(row.name)) throw new UiStageError('UI_STAGE_PACKAGE_DUPLICATE', row.name)
    result.set(row.name, row)
  }
  return result
}

async function dependencyClosure(sourceNodeModules, packageSet, inventory, registrySources = new Map()) {
  const knownComponents = new Map(inventory.components.map(row => [row.id, row]))
  const direct = directPackageMap(packageSet)
  const queue = packageSet.publicPackages.map(row => ({ name: row.name, component: row.component, expected: row }))
  const resolved = new Map()
  while (queue.length) {
    const item = queue.shift()
    const prior = resolved.get(item.name)
    if (prior) {
      if (prior.component !== item.component && direct.has(item.name)) throw new UiStageError('UI_STAGE_PACKAGE_COMPONENT_CONFLICT', item.name)
      continue
    }
    if (!knownComponents.has(item.component)) throw new UiStageError('UI_STAGE_COMPONENT_UNKNOWN', item.component)
    const source = registrySources.get(item.name) ?? packagePath(sourceNodeModules, item.name)
    if (!await exists(source)) throw new UiStageError('UI_STAGE_PACKAGE_MISSING', item.name)
    const pkg = await verifyPackage(source, { name: item.name, version: item.expected?.version })
    if (item.expected) {
      const component = knownComponents.get(item.component)
      const declared = component.sourcePackages.find(row => row.name === item.name)
      if (!declared || declared.version !== pkg.version || declared.license !== pkg.license || declared.redistribution !== 'confirmed') {
        throw new UiStageError('UI_STAGE_PACKAGE_NOT_AUDITED', item.name)
      }
    }
    const provenance = registrySources.has(item.name)
      ? { origin: 'npm-registry', spec: `${item.name}@${pkg.version}`, integrity: item.expected.registryIntegrity, cleanClient: item.expected.cleanClient }
      : { origin: 'source-bundle', package: item.name, version: pkg.version }
    resolved.set(item.name, { ...item, source, pkg, direct: Boolean(item.expected), provenance })
    for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) {
      queue.push({ name: dependency, component: item.component, expected: direct.get(dependency) })
    }
  }
  return resolved
}

function mountFragment(packageSet) {
  const rows = [
    '# Generated UI-only profile fragment.',
    '# Contains no MCP server definitions, endpoints, credentials, policy or rulepack bindings.',
    '- insert:',
  ]
  for (const row of [...packageSet.publicPackages, ...packageSet.localPackages].filter(row => row.mount)) {
    rows.push(`    - id: ${row.rowId}`, `      name: ${row.name}`)
    if (row.name === 'dsh-tokenledger') {
      rows.push('      config:', "        database: !!js dshHomePath('tokenledger.sqlite')", '        sweepIntervalMs: 60000', '        sweepOnStart: true')
    }
  }
  return `${rows.join('\n')}\n`
}

async function managedFiles(stage) {
  const result = {}
  for (const rel of await filesBelow(stage)) {
    if (rel === 'ui-overlay-manifest.json') continue
    const bytes = await readFile(join(stage, rel))
    result[rel] = { sha256: hash(bytes), bytes: bytes.length }
  }
  return result
}

function operationType(component) {
  return component.portability.mode === 'data-overlay' ? 'data-overlay' : 'package-copy'
}

export async function stageUiOverlay({
  sourceBundle,
  output,
  artifactVersion,
  inventoryPath = DEFAULT_INVENTORY,
  packageSetPath = DEFAULT_SET,
  upstreamPath = DEFAULT_UPSTREAM,
  officialLockPath = DEFAULT_OFFICIAL_LOCK,
  repoRoot = REPO,
}) {
  if (!sourceBundle) throw new UiStageError('UI_STAGE_SOURCE_BUNDLE_REQUIRED')
  if (typeof artifactVersion !== 'string' || !/^[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?$/u.test(artifactVersion)) {
    throw new UiStageError('UI_STAGE_ARTIFACT_VERSION_REQUIRED')
  }
  const bundle = resolve(sourceBundle)
  const expectedDirectory = `${ARTIFACT_DIRECTORY_PREFIX}-${artifactVersion}`
  const destination = output ? resolve(output) : join(resolve(repoRoot), 'dist', expectedDirectory)
  if (basename(destination) !== expectedDirectory) {
    throw new UiStageError('UI_STAGE_OUTPUT_VERSION_MISMATCH', `${basename(destination)} != ${expectedDirectory}`)
  }
  if (await exists(destination)) throw new UiStageError('UI_STAGE_OUTPUT_EXISTS', destination)
  const [inventory, packageSet, upstream, officialLock, officialLockBytes] = await Promise.all([
    readJson(inventoryPath), readJson(packageSetPath), readJson(upstreamPath), readJson(officialLockPath), readFile(officialLockPath),
  ])
  validateUiInventory(inventory, upstream)
  if (packageSet.schemaVersion !== 1 || packageSet.artifact?.id !== ARTIFACT_ID || 'version' in packageSet.artifact) throw new UiStageError('UI_STAGE_PACKAGE_SET_INVALID')
  if (officialLock.target !== 'official-desktop' || officialLock.hostVersion !== inventory.source.hostVersion) throw new UiStageError('UI_STAGE_OFFICIAL_LOCK_MISMATCH')
  const sourceNodeModules = join(bundle, 'node_modules')
  await mkdir(dirname(destination), { recursive: true })
  const sourceStage = await mkdtemp(join(dirname(destination), '.ui-source-'))
  const stage = await mkdtemp(join(dirname(destination), '.ui-overlay-'))
  try {
    const registrySources = await materializeRegistrySources(packageSet, sourceStage)
    const closure = await dependencyClosure(sourceNodeModules, packageSet, inventory, registrySources)
    const componentById = new Map(inventory.components.map(row => [row.id, row]))
    const selectedIds = new Set([...packageSet.publicPackages, ...packageSet.localPackages].map(row => row.component))
    for (const component of inventory.components.filter(row => row.deployment.required)) selectedIds.add(component.id)
    const components = [...selectedIds].map(id => componentById.get(id)).filter(Boolean)
      .sort((a, b) => a.deployment.installOrder - b.deployment.installOrder)
      .map(row => ({ id: row.id, required: row.deployment.required, enabledByDefault: row.deployment.defaultEnabled, installOrder: row.deployment.installOrder }))
    const packageRecords = []
    for (const entry of [...closure.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const target = packagePath(join(stage, 'payload/packages'), entry.name)
      await mkdir(target, { recursive: true })
      await copyPackage(entry.source, target, entry.pkg)
      const localization = await adaptPackageLocalization(entry, target)
      const provenance = localization?.compatibility ? { ...entry.provenance, compatibility: localization.compatibility }
        : localization ? { ...entry.provenance, localization } : entry.provenance
      packageRecords.push({ name: entry.name, component: entry.component, source: target, pkg: entry.pkg, dependency: !entry.direct, provenance })
    }
    for (const row of packageSet.localPackages) {
      const source = resolve(repoRoot, safeRelative(row.path))
      const pkg = await verifyPackage(source, { name: row.name })
      let nativeCompatibility
      if (row.nativeCompatibility) {
        const locks = await readJson(join(REPO, 'upstream', 'native-ui-compat.lock.json'))
        if (pkg.version !== '0.2.1-rc.5' || (await directoryState(source)).digest !== locks[row.name]) throw new UiStageError('UI_NATIVE_COMPAT_SOURCE_DRIFT', row.name)
        if (!['@deepseek-ai/dsh-client-ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-models', '@deepseek-ai/dsh-client-ui-settings-account'].includes(row.name)) throw new UiStageError('UI_NATIVE_COMPAT_UNKNOWN', row.name)
        nativeCompatibility = true
      }
      const target = packagePath(join(stage, 'payload/packages'), row.name)
      await mkdir(target, { recursive: true })
      await copyPackage(source, target, pkg)
      if (nativeCompatibility) {
        const client = join(target, 'lib/client.js')
        const before = await readFile(client, 'utf8')
        const after = row.name.endsWith('-general') ? patchSettingsShell(before)
          : row.name.endsWith('-account') ? patchNativeAccountClient(before) : patchNativeModelsClient(before)
        await writeFile(client, after, 'utf8')
      }
      packageRecords.push({ name: row.name, component: row.component, source: target, pkg, dependency: false, provenance: { origin: 'private-overlay', path: safeRelative(row.path) } })
    }
    const fragmentPath = join(stage, 'cordis.ui.fragment.yml')
    await writeFile(fragmentPath, mountFragment(packageSet), { encoding: 'utf8', flag: 'wx' })
    const officialManifest = {
      schemaVersion: 1,
      artifact: { id: ARTIFACT_ID, version: artifactVersion },
      target: {
        kind: 'official-desktop',
        hostVersion: officialLock.hostVersion,
        appAsarSha256: officialLock.files['resources/app.asar'].sha256,
      },
      packages: packageRecords.map(record => ({
        name: record.name,
        source: slash(relative(stage, record.source)),
      })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
      cordisFragment: 'cordis.ui.fragment.yml',
      internalPatches: [],
    }
    await writeFile(join(stage, 'official-ui-manifest.json'), canonical(officialManifest), { encoding: 'utf8', flag: 'wx' })
    const files = await managedFiles(stage)
    const operations = packageRecords.map(record => {
      const source = slash(relative(stage, join(record.source, 'package.json')))
      const component = componentById.get(record.component)
      return {
        component: record.component,
        type: operationType(component),
        source,
        target: `node_modules/${record.name}`,
        sha256: files[source].sha256,
      }
    })
    operations.push({
      component: 'balance-cost-hud',
      type: 'config-fragment',
      source: 'cordis.ui.fragment.yml',
      target: 'cordis.patch.yml',
      sha256: files['cordis.ui.fragment.yml'].sha256,
    })
    const manifest = {
      schemaVersion: 1,
      artifact: { id: ARTIFACT_ID, version: artifactVersion },
      sourceRelease: { product: inventory.source.product, releaseId: inventory.source.releaseId },
      target: {
        releaseIds: [inventory.source.releaseId, `official-desktop-${officialLock.hostVersion}`],
        hostVersions: [officialLock.hostVersion],
        baselineLockSha256: hash(officialLockBytes),
        unknownTargetPolicy: 'block',
      },
      separation: {
        includesPolicy: false,
        includesRulepack: false,
        includesMcpBindings: false,
        includesCredentials: false,
        includesRuntimeState: false,
      },
      components,
      packageProvenance: packageRecords.map(record => ({
        name: record.name,
        version: record.pkg.version,
        dependency: record.dependency,
        ...record.provenance,
      })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
      operations,
      files,
    }
    validateUiOverlayManifest(manifest, inventory)
    const control = canonical({ manifest, fragment: await readFile(fragmentPath, 'utf8') }).toLowerCase()
    for (const marker of ['api_key', 'apikey', 'authorization:', 'bearer ', 'mcpservers', 'mcp-servers.json']) {
      if (control.includes(marker)) throw new UiStageError('UI_STAGE_CONTROL_PLANE_SECRET_OR_BINDING', marker)
    }
    await writeFile(join(stage, 'ui-overlay-manifest.json'), canonical(manifest), { encoding: 'utf8', flag: 'wx' })
    await rename(stage, destination)
    await rm(sourceStage, { recursive: true, force: true })
    return manifest
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    await rm(sourceStage, { recursive: true, force: true })
    throw error
  }
}

function parseArgs(argv) {
  const result = {}
  const allowed = new Set(['source-bundle', 'output', 'artifact-version'])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new UiStageError('USAGE')
    const name = key.slice(2)
    if (!allowed.has(name) || name in result) throw new UiStageError('USAGE')
    result[name] = value
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = await stageUiOverlay({ sourceBundle: args['source-bundle'], output: args.output, artifactVersion: args['artifact-version'] })
  process.stdout.write(`Staged ${manifest.artifact.id} ${manifest.artifact.version}: ${Object.keys(manifest.files).length} files, ${manifest.operations.length} operations\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
