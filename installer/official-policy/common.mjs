import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RELEASE_LOCK, verifyOfficialDesktop } from '../../src/targets/official-desktop/target.mjs'
import { canonical, directoryState, sameState, sha256, targetState } from '../fs-state.mjs'
import { beneath, loadCandidate, OfficialUiInstallerError } from '../official-ui/common.mjs'
import { analyzePolicyCordis, mergePolicyCordis } from './policy-cordis.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const DEFAULT_ARTIFACT = resolve(ROOT, 'dist/airules-official-policy-0.12.0-dev7')
const HASH = /^[a-f0-9]{64}$/u
const WORKFLOW_RUNTIME_ROOTS = Object.freeze(['core/tools/workflow', 'overlays/1c/tools/workflow-onec', 'overlays/1c/tools/workflow-runners'])
const WORKFLOW_PACKAGE = 'airules-dsh-workflows'
const WORKFLOW_PREFIX = `payload/packages/${WORKFLOW_PACKAGE}/`
const WORKFLOW_OPERATIONS = Object.freeze(['doctor', 'analyze'])
const workflowCanonical = value => Array.isArray(value) ? `[${value.map(workflowCanonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${workflowCanonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const workflowDigest = value => sha256(Buffer.from(workflowCanonical(value)))
const workflowPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const workflowHash = value => typeof value === 'string' && HASH.test(value)
function workflowInvalid(code = 'POLICY_WORKFLOW_PROVENANCE_INVALID') { throw new OfficialUiInstallerError(code) }
function workflowKeys(value, keys) {
  if (!workflowPlain(value) || workflowCanonical(Object.keys(value).sort()) !== workflowCanonical([...keys].sort())) workflowInvalid()
}
function workflowPath(path) {
  if (typeof path !== 'string' || !path || /[\\:\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some(part => ['', '.', '..'].includes(part))) workflowInvalid()
  return path
}
function workflowExcluded(path) {
  return path.split('/').some(part => ['test', 'tests', '__tests__', 'node_modules', '.git'].includes(part)
    || /^\.env(?:\.|$)/iu.test(part) || /\.env$/iu.test(part))
}
function workflowFileRow(row) {
  workflowKeys(row, ['bytes', 'sha256'])
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 16 * 1024 * 1024 || !workflowHash(row.sha256)) workflowInvalid()
}

function validateWorkflowIntegration(feature) {
  workflowKeys(feature, ['package', 'nativeSandbox', 'deployEnabled', 'policyOwner', 'provenance', 'reviewedRunners'])
  if (feature.package !== WORKFLOW_PACKAGE || feature.nativeSandbox !== true || feature.deployEnabled !== false
    || feature.policyOwner !== 'project_rules') workflowInvalid('POLICY_INTEGRATION_INVALID')
  workflowKeys(feature.provenance, ['source', 'layout', 'roots'])
  if (feature.provenance.source !== 'project_rules' || feature.provenance.layout !== 'canonical-relative'
    || !Array.isArray(feature.provenance.roots) || feature.provenance.roots.length !== WORKFLOW_RUNTIME_ROOTS.length) workflowInvalid()
  for (const [index, row] of feature.provenance.roots.entries()) {
    workflowKeys(row, ['source', 'target', 'files', 'inventoryDigest', 'inventory'])
    if (row.source !== WORKFLOW_RUNTIME_ROOTS[index] || row.target !== `runtime/${row.source}`
      || !workflowPlain(row.inventory) || !workflowHash(row.inventoryDigest)) workflowInvalid()
    const paths = Object.keys(row.inventory)
    if (!paths.length || paths.length > 4096 || row.files !== paths.length || !row.inventory['index.mjs']) workflowInvalid()
    for (const path of paths) {
      workflowPath(path)
      if (workflowExcluded(path)) workflowInvalid()
      workflowFileRow(row.inventory[path])
    }
    if (workflowDigest(row.inventory) !== row.inventoryDigest) workflowInvalid()
  }
  const reviewed = feature.reviewedRunners
  workflowKeys(reviewed, ['kind', 'files', 'digest', 'operations'])
  if (reviewed.kind !== 'agent-1c' || !Number.isSafeInteger(reviewed.files) || reviewed.files < 3 || reviewed.files > 4096
    || !workflowHash(reviewed.digest) || workflowCanonical(reviewed.operations) !== workflowCanonical(WORKFLOW_OPERATIONS)) workflowInvalid()
}

async function verifyWorkflowPayload(root, manifest) {
  const feature = manifest.integrations?.workflows
  if (!feature) return
  // Shape was checked by policyPackageNames; compare each canonical inventory with payload hashes.
  const expectedRuntime = new Set([`${WORKFLOW_PREFIX}runtime/reviewed-runners.json`])
  for (const row of feature.provenance.roots) {
    for (const [path, metadata] of Object.entries(row.inventory)) {
      const target = `${WORKFLOW_PREFIX}${row.target}/${path}`
      expectedRuntime.add(target)
      const payloadRow = manifest.files[target]
      if (!payloadRow || payloadRow.sha256 !== metadata.sha256 || payloadRow.bytes !== metadata.bytes) workflowInvalid('POLICY_WORKFLOW_INVENTORY_MISMATCH')
    }
  }
  const actualRuntime = Object.keys(manifest.files).filter(path => path.startsWith(`${WORKFLOW_PREFIX}runtime/`))
  if (actualRuntime.length !== expectedRuntime.size || actualRuntime.some(path => !expectedRuntime.has(path))) workflowInvalid('POLICY_WORKFLOW_INVENTORY_MISMATCH')
  let reviewed
  try { reviewed = JSON.parse(await readFile(join(root, `${WORKFLOW_PREFIX}runtime/reviewed-runners.json`), 'utf8')) }
  catch { workflowInvalid('POLICY_WORKFLOW_REVIEW_INVALID') }
  workflowKeys(reviewed, ['schemaVersion', 'policyOwner', 'reviewedDigests', 'codeClosure', 'operations', 'deployEnabled'])
  if (reviewed.schemaVersion !== 1 || reviewed.policyOwner !== 'project_rules' || reviewed.deployEnabled !== false
    || workflowCanonical(reviewed.reviewedDigests) !== workflowCanonical([feature.reviewedRunners.digest])
    || workflowCanonical(reviewed.operations) !== workflowCanonical(WORKFLOW_OPERATIONS)) workflowInvalid('POLICY_WORKFLOW_REVIEW_INVALID')
  workflowKeys(reviewed.codeClosure, ['kind', 'files'])
  const closure = reviewed.codeClosure
  if (closure.kind !== 'agent-1c' || !Array.isArray(closure.files) || closure.files.length !== feature.reviewedRunners.files) workflowInvalid('POLICY_WORKFLOW_REVIEW_INVALID')
  const paths = []
  for (const row of closure.files) {
    workflowKeys(row, ['path', 'digest', 'bytes'])
    const path = workflowPath(row.path)
    if (!path.startsWith('tools/agent-1c/') || (!/\.(?:ps1|psm1)$/iu.test(path) && path !== 'tools/agent-1c/toolchain.lock.json')
      || !workflowHash(row.digest) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 16 * 1024 * 1024) workflowInvalid('POLICY_WORKFLOW_REVIEW_INVALID')
    paths.push(path)
  }
  if (new Set(paths).size !== paths.length || workflowCanonical(paths) !== workflowCanonical([...paths].sort())
    || ['tools/agent-1c/agent-1c.ps1', 'tools/agent-1c/lib/1c-guard.ps1', 'tools/agent-1c/toolchain.lock.json'].some(path => !paths.includes(path))
    || workflowDigest(closure) !== feature.reviewedRunners.digest) workflowInvalid('POLICY_WORKFLOW_REVIEW_INVALID')
}
const PACKAGES = Object.freeze([
  'airules-dsh-provider',
  'airules-dsh-rulepack',
  'airules-official-preset',
  'airules-official-onec-mechanics',
  'dsh-bsl-editor',
  'dsh-lsp-actions',
  'schemastery',
])

export function policyPackageNames(manifest) {
  if (manifest.integrations === undefined) return [...PACKAGES]
  const integrations = manifest.integrations
  if (!integrations || typeof integrations !== 'object' || Array.isArray(integrations)
    || Object.keys(integrations).some(key => !['openspec', 'telegram', 'acp', 'subscriptions', 'mobile', 'mcpManager', 'additionalProviders', 'onecPanels', 'projectSettings', 'modelOrchestration', 'domainPresets', 'workflows', 'agentImport', 'skillsManager', 'generalTools', 'documentWorkbench', 'onecCapabilities'].includes(key))
    || Object.keys(integrations).length === 0) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
  const packages = [...PACKAGES]
  const feature = integrations.openspec
  if (feature !== undefined && (feature?.package !== 'dsh-openspec-workflow'
    || feature.cliVersion !== '1.12.0' || feature.policyOwner !== 'project_rules' || feature.atlassian !== false
    || !HASH.test(feature.dependencyLockSha256 ?? '') || !Number.isInteger(feature.privateRuntimePackages) || feature.privateRuntimePackages < 3)) {
    throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
  }
  if (feature) packages.push('dsh-openspec-workflow')
  const telegram = integrations.telegram
  if (telegram !== undefined) {
    if (canonical(telegram) !== canonical({ package: 'airules-dsh-telegram', defaultEnabled: false, autostart: false, secretStorage: 'windows-dpapi-current-user', transport: 'single-owner-long-polling' })) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push('airules-dsh-telegram')
  }
  const acp = integrations.acp
  if (acp !== undefined) {
    const { adapterVersion, sdkVersion, dependencyLockSha256, privateRuntimePackages, adaptation, ...base } = acp ?? {}
    if (canonical(base) !== canonical({ package: 'airules-dsh-acp', defaultEnabled: false, inbound: 'local-named-pipe', outbound: 'native-external-agent' })
      || adapterVersion !== '0.2.1-rc.3.1' || sdkVersion !== '1.5.1' || !HASH.test(dependencyLockSha256 ?? '')
      || !Number.isInteger(privateRuntimePackages) || privateRuntimePackages < 2
      || !adaptation || Object.keys(adaptation).sort().join(',') !== 'sourceSha256,stagedSha256'
      || !HASH.test(adaptation.sourceSha256 ?? '') || !HASH.test(adaptation.stagedSha256 ?? '')) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push('airules-dsh-acp')
    packages.push('@zaimokuza/dsh-acp-adapter')
  }
  for (const [key, name, fixed] of [
    ['subscriptions', 'airules-dsh-subscriptions', { defaultEnabled: false, state: 'isolated', credentials: 'excluded' }],
    ['mobile', 'airules-dsh-mobile-access', { defaultEnabled: false, autostart: false, listener: 'explicit-start-https', firewallChanges: false }],
  ]) {
    if (integrations[key] === undefined) continue
    const { dependencyLockSha256, privateRuntimePackages, ...base } = integrations[key] ?? {}
    if (canonical(base) !== canonical({ package: name, ...fixed }) || !HASH.test(dependencyLockSha256 ?? '')
      || !Number.isInteger(privateRuntimePackages) || privateRuntimePackages < 1) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push(name)
  }
  const manager = integrations.mcpManager
  if (manager !== undefined) {
    if (canonical(manager) !== canonical({ package: 'airules-dsh-mcp-manager', bindings: 'machine-or-project-external', defaultServers: 0, authority: 'native-loopback-csrf' })) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push('airules-dsh-mcp-manager')
  }
  for (const [key, name, fields] of [
    ['additionalProviders', 'airules-dsh-additional-providers', { authentication: 'explicit-user-action', bootstrap: false }],
    ['onecPanels', 'airules-dsh-onec-panels', { readOnly: true, root: 'selected-session' }],
    ['projectSettings', 'airules-dsh-project-settings', { bindings: 'project-local', deploy: false, mcp: false }],
    ['modelOrchestration', 'airules-dsh-model-orchestration', { enabledByUser: true, bindings: 'role-and-pool', globalInterception: false }],
    ['domainPresets', 'airules-dsh-domain-presets', { presets: ['python-airules', 'sysadmin-airules'], mcp: false, policyOwner: 'project_rules' }],
  ]) {
    if (integrations[key] === undefined) continue
    const legacyDomain = key === 'domainPresets' && canonical(integrations[key]) === canonical({ package: name, presets: ['python-airules', 'sysadmin-airules'], mcp: false })
    if (!legacyDomain && canonical(integrations[key]) !== canonical({ package: name, ...fields })) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push(name)
  }
  if (integrations.workflows !== undefined) {
    validateWorkflowIntegration(integrations.workflows)
    packages.push(WORKFLOW_PACKAGE)
  }
  for (const [key, name, fields] of [
    ['agentImport', 'airules-dsh-agent-import', { scopes: ['project', 'global'], chats: false, mcp: false, credentials: false }],
    ['skillsManager', 'airules-dsh-skills', { storage: 'native', scopes: ['project', 'global'], bundledAssets: false }],
    ['generalTools', 'airules-dsh-general-tools', { defaultStyle: 'off', style: 'opt-in-lite', renderer: 'native-sandbox' }],
    ['documentWorkbench', 'airules-dsh-document-workbench', { cache: 'project-scoped', conversion: 'local', cloud: false }],
    ['onecCapabilities', 'airules-dsh-onec-capability-workflows', { scope: '1c-airules', discovery: 'native-schemas', liveCalls: false }],
  ]) {
    if (integrations[key] === undefined) continue
    if (canonical(integrations[key]) !== canonical({ package: name, ...fields })) throw new OfficialUiInstallerError('POLICY_INTEGRATION_INVALID')
    packages.push(name)
  }
  return packages
}

async function scan(root) {
  const result = {}
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(dir, entry.name), rel = relative(root, path).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw new OfficialUiInstallerError('POLICY_ARTIFACT_SYMLINK', rel)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { const bytes = await readFile(path); result[rel] = { sha256: sha256(bytes), bytes: bytes.byteLength } }
      else throw new OfficialUiInstallerError('POLICY_ARTIFACT_SPECIAL_FILE', rel)
    }
  }
  await walk(root)
  return result
}

export async function verifyPolicyArtifact(artifactRoot) {
  const root = resolve(String(artifactRoot ?? ''))
  const manifestPath = join(root, 'official-policy-manifest.json')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { throw new OfficialUiInstallerError('POLICY_MANIFEST_INVALID') }
  if (manifest?.schemaVersion !== 1 || manifest?.artifact?.id !== 'airules-official-policy-overlay' || !manifest.artifact.version || manifest.target?.kind !== 'official-desktop') throw new OfficialUiInstallerError('POLICY_MANIFEST_INVALID')
  if (!manifest.separation || Object.values(manifest.separation).some(value => value !== 'excluded')) throw new OfficialUiInstallerError('POLICY_LAYER_LEAK')
  if (manifest.preset?.id !== '1c-airules' || manifest.preset?.extensionPoint !== '@deepseek-ai/dsh-agent-preset') throw new OfficialUiInstallerError('POLICY_PRESET_INVALID')
  const actual = await scan(root); delete actual['official-policy-manifest.json']
  const declared = Object.keys(manifest.files ?? {}).sort(), found = Object.keys(actual).sort()
  if (canonical(declared) !== canonical(found)) throw new OfficialUiInstallerError('POLICY_FILE_SET_MISMATCH')
  for (const path of declared) {
    const row = manifest.files[path]
    if (!row || !HASH.test(row.sha256 ?? '') || row.bytes !== actual[path]?.bytes || row.sha256 !== actual[path]?.sha256) throw new OfficialUiInstallerError('POLICY_FILE_HASH_MISMATCH', path)
  }
  const packageNames = policyPackageNames(manifest)
  await verifyWorkflowPayload(root, manifest)
  const expected = [...packageNames.map(name => ({ kind: 'package-copy', source: `payload/packages/${name}`, target: `node_modules/${name}` })), { kind: 'cordis-merge', source: 'cordis.policy.fragment.yml', target: 'cordis.patch.yml' }]
  if (canonical(manifest.operations) !== canonical(expected)) throw new OfficialUiInstallerError('POLICY_OPERATIONS_INVALID')
  return { root, manifest, packageNames, manifestSha256: sha256(await readFile(manifestPath)) }
}

export function planSignature(plan) {
  return createHash('sha256').update(canonical({ artifact: plan.artifact, target: plan.target, manifest: plan.artifactManifestSha256,
    replaceCollisions: plan.replaceCollisions,
    operations: plan.operations.map(row => ({ type: row.type, package: row.package, target: row.targetRelative, before: row.before, after: row.after })) })).digest('hex')
}

async function policyMarkerOwnership(marker, state, artifactId) {
  if (state.type !== 'file') return false
  try {
    const value = JSON.parse(await readFile(marker, 'utf8'))
    return value?.schemaVersion === 1 && value?.status === 'policy-ready' && value?.artifact?.id === artifactId &&
      typeof value?.artifact?.version === 'string' && /^\.airules-policy-backups\/[a-z0-9._-]+\/receipt\.json$/u.test(value?.receipt ?? '')
  } catch { return false }
}

async function policyPackageOwnership(target, state, name) {
  if (state.type !== 'directory') return false
  for (const [file, pick] of [
    ['package.json', value => value?.name],
    ['manifest.json', value => value?.package?.id],
  ]) {
    try { if (pick(JSON.parse(await readFile(join(target, file), 'utf8'))) === name) return true } catch {}
  }
  return false
}

export async function buildOfficialPolicyPlan({ candidateRoot, artifactRoot = DEFAULT_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK, replaceCollisions = false }) {
  const candidate = await loadCandidate(candidateRoot)
  const artifact = await verifyPolicyArtifact(artifactRoot)
  const verified = await verifyOfficialDesktop({ installRoot: candidate.installRoot, releaseLockPath })
  const expectedTarget = { kind: 'official-desktop', hostVersion: verified.lock.hostVersion, appAsarSha256: verified.lock.files['resources/app.asar']?.sha256 }
  if (artifact.manifest.target.kind !== expectedTarget.kind || artifact.manifest.target.hostVersion !== expectedTarget.hostVersion || artifact.manifest.target.appAsarSha256 !== expectedTarget.appAsarSha256) throw new OfficialUiInstallerError('POLICY_TARGET_NOT_READY')
  const operations = [], collisions = [], blockers = []
  const marker = join(candidate.root, 'policy-ready.json'), markerBefore = await targetState(marker)
  const markerOwned = await policyMarkerOwnership(marker, markerBefore, artifact.manifest.artifact.id)
  for (const name of artifact.packageNames) {
    const source = join(artifact.root, `payload/packages/${name}`), target = join(candidate.modulesRoot, name)
    const before = await targetState(target), after = await directoryState(source)
    if (before.type !== 'missing') {
      const owned = markerOwned && await policyPackageOwnership(target, before, name)
      const collision = { type: 'package', package: name, target: relative(candidate.root, target).replaceAll('\\', '/'), owned, replaceable: owned, authorized: owned && replaceCollisions }
      collisions.push(collision); if (!collision.authorized) blockers.push(collision)
    }
    operations.push({ type: 'copy-directory', package: name, source, target, targetRelative: relative(candidate.root, target).replaceAll('\\', '/'), before, after })
  }
  const fragmentPath = join(artifact.root, 'cordis.policy.fragment.yml')
  const cordisTarget = join(candidate.profileRoot, 'cordis.patch.yml')
  const before = await targetState(cordisTarget), current = before.type === 'file' ? await readFile(cordisTarget, 'utf8') : ''
  const fragment = await readFile(fragmentPath, 'utf8'), analysis = analyzePolicyCordis(current, fragment)
  if (analysis.collision) {
    const replaceable = markerOwned && analysis.replaceable === true
    const collision = { type: 'cordis', reason: analysis.reason, replaceable, authorized: replaceable && replaceCollisions }
    collisions.push(collision); if (!collision.authorized) blockers.push(collision)
  }
  const merged = analysis.collision && !(markerOwned && analysis.replaceable && replaceCollisions) ? null : mergePolicyCordis(current, fragment, { replaceCollisions }).text
  operations.push({ type: 'merge-cordis-fragment', source: fragmentPath, target: cordisTarget, targetRelative: relative(candidate.root, cordisTarget).replaceAll('\\', '/'), before,
    after: merged === null ? null : { type: 'file', sha256: sha256(Buffer.from(merged)), bytes: Buffer.byteLength(merged) }, action: analysis.action })
  if (markerBefore.type !== 'missing') {
    const collision = { type: 'marker', owned: markerOwned, replaceable: markerOwned, authorized: markerOwned && replaceCollisions }
    collisions.push(collision); if (!collision.authorized) blockers.push(collision)
  }
  const receiptRelative = `.airules-policy-backups/${artifact.manifest.artifact.id}-${artifact.manifest.artifact.version}/receipt.json`
  const markerText = canonical({ schemaVersion: 1, status: 'policy-ready', artifact: artifact.manifest.artifact, receipt: receiptRelative })
  operations.push({ type: 'ready-marker', target: marker, targetRelative: 'policy-ready.json', before: markerBefore, after: { type: 'file', sha256: sha256(Buffer.from(markerText)), bytes: Buffer.byteLength(markerText) }, content: markerText })
  const plan = { status: blockers.length ? 'blocked' : 'ready', readOnly: true, replaceCollisions, candidateRoot: candidate.root, artifactRoot: artifact.root, artifact: artifact.manifest.artifact, target: expectedTarget,
    artifactManifestSha256: artifact.manifestSha256, backupRootRelative: `.airules-policy-backups/${artifact.manifest.artifact.id}-${artifact.manifest.artifact.version}`, operations, collisions, blockers, candidate }
  return Object.freeze({ ...plan, operations: Object.freeze(operations), collisions: Object.freeze(collisions), blockers: Object.freeze(blockers), signature: planSignature(plan) })
}

export { beneath, DEFAULT_RELEASE_LOCK, loadCandidate, OfficialUiInstallerError }
export const POLICY_PACKAGES = PACKAGES
