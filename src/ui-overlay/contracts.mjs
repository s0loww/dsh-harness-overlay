import { isAbsolute } from 'node:path'

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const HASH = /^[a-f0-9]{64}$/u
const PORTABILITY_MODES = new Set(['config-only', 'package-copy', 'vendor-patch', 'data-overlay', 'reimplement', 'not-portable'])
const PORTABILITY_STATUS = new Set(['candidate', 'audited', 'blocked', 'deferred'])
const REQUIRED_FORBIDDEN_DATA = ['credentials', 'tokens', 'session-history', 'mcp-bindings', 'runtime-state']
const RUNTIME_PATH_PARTS = new Set(['.desktop-local', 'credentials', 'sessions'])

export class UiContractError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

function assert(condition, code, detail = '') {
  if (!condition) throw new UiContractError(code, detail)
}

function object(value, code) {
  assert(value && typeof value === 'object' && !Array.isArray(value), code)
  return value
}

function unique(values, code) {
  assert(new Set(values).size === values.length, code)
}

function portablePath(value, code) {
  assert(typeof value === 'string' && value !== '' && !isAbsolute(value) && !/^[A-Za-z]:[\\/]/u.test(value), code, value)
  const parts = value.replaceAll('\\', '/').split('/')
  assert(!parts.includes('..') && !parts.some(part => RUNTIME_PATH_PARTS.has(part.toLowerCase())), code, value)
}

function sourcePackageMap(upstream) {
  const result = new Map()
  const bundle = upstream?.bundle
  if (bundle?.name) result.set(bundle.name, { version: bundle.version, license: bundle.license })
  for (const row of upstream?.pluginCatalog?.plugins ?? []) {
    result.set(row.name, { version: row.version, license: row.license })
  }
  return result
}

function validateCheck(check, componentId) {
  object(check, 'UI_CHECK_INVALID')
  assert(ID.test(check.id ?? ''), 'UI_CHECK_ID_INVALID', componentId)
  assert(['static', 'import', 'route', 'ui-smoke', 'restart-smoke'].includes(check.kind), 'UI_CHECK_KIND_INVALID', check.id)
  assert(typeof check.description === 'string' && check.description.length > 0, 'UI_CHECK_DESCRIPTION_MISSING', check.id)
}

export function validateUiInventory(inventory, upstream) {
  object(inventory, 'UI_INVENTORY_INVALID')
  assert(inventory.schemaVersion === 1, 'UI_INVENTORY_SCHEMA_UNSUPPORTED')
  assert(inventory.source?.releaseId === upstream?.releaseId, 'UI_INVENTORY_RELEASE_MISMATCH')
  assert(inventory.source?.hostVersion === upstream?.pluginCatalog?.hostVersion, 'UI_INVENTORY_HOST_MISMATCH')
  assert(inventory.source?.bundleVersion === upstream?.bundle?.version, 'UI_INVENTORY_BUNDLE_MISMATCH')
  for (const value of Object.values(object(inventory.separation, 'UI_INVENTORY_SEPARATION_MISSING'))) {
    assert(value === 'excluded', 'UI_INVENTORY_LAYER_LEAK')
  }
  assert(Array.isArray(inventory.components) && inventory.components.length > 0, 'UI_COMPONENTS_MISSING')
  unique(inventory.components.map(row => row.id), 'UI_COMPONENT_ID_DUPLICATE')
  unique(inventory.components.map(row => row.deployment?.installOrder), 'UI_COMPONENT_ORDER_DUPLICATE')
  const packages = sourcePackageMap(upstream)
  for (const component of inventory.components) {
    assert(ID.test(component.id ?? ''), 'UI_COMPONENT_ID_INVALID')
    assert(typeof component.label === 'string' && component.label.length > 0, 'UI_COMPONENT_LABEL_MISSING', component.id)
    assert(Array.isArray(component.sourcePackages) && component.sourcePackages.length > 0, 'UI_COMPONENT_SOURCE_MISSING', component.id)
    unique(component.sourcePackages.map(row => row.name), 'UI_COMPONENT_SOURCE_DUPLICATE')
    for (const pkg of component.sourcePackages) {
      const known = packages.get(pkg.name)
      assert(known, 'UI_SOURCE_PACKAGE_UNKNOWN', pkg.name)
      assert(pkg.version === known.version, 'UI_SOURCE_PACKAGE_VERSION_MISMATCH', pkg.name)
      assert(pkg.license === known.license, 'UI_SOURCE_PACKAGE_LICENSE_MISMATCH', pkg.name)
      assert(['confirmed', 'review-required', 'forbidden'].includes(pkg.redistribution), 'UI_SOURCE_REDISTRIBUTION_INVALID', pkg.name)
    }
    assert(PORTABILITY_MODES.has(component.portability?.mode), 'UI_PORTABILITY_MODE_INVALID', component.id)
    assert(PORTABILITY_STATUS.has(component.portability?.status), 'UI_PORTABILITY_STATUS_INVALID', component.id)
    assert(component.targetCompatibility?.unknownTargetPolicy === 'block', 'UI_UNKNOWN_TARGET_NOT_BLOCKED', component.id)
    assert(component.targetCompatibility?.releaseIds?.includes(inventory.source.releaseId), 'UI_COMPONENT_RELEASE_UNPINNED', component.id)
    assert(component.targetCompatibility?.hostVersions?.includes(inventory.source.hostVersion), 'UI_COMPONENT_HOST_UNPINNED', component.id)
    const forbidden = component.statePolicy?.forbiddenData ?? []
    for (const item of REQUIRED_FORBIDDEN_DATA) assert(forbidden.includes(item), 'UI_STATE_POLICY_INCOMPLETE', `${component.id}/${item}`)
    assert(['none', 'external-only'].includes(component.statePolicy?.credentials), 'UI_CREDENTIAL_POLICY_INVALID', component.id)
    if (component.deployment?.required) {
      assert(component.deployment.defaultEnabled === true, 'UI_REQUIRED_COMPONENT_DISABLED', component.id)
      assert(!['blocked', 'deferred'].includes(component.portability.status), 'UI_REQUIRED_COMPONENT_NOT_READY', component.id)
      assert(component.portability.mode !== 'not-portable', 'UI_REQUIRED_COMPONENT_NOT_PORTABLE', component.id)
    }
    if (component.sourcePackages.some(row => row.redistribution === 'forbidden')) {
      assert(component.portability.status === 'blocked' && component.portability.mode === 'not-portable', 'UI_FORBIDDEN_SOURCE_SELECTABLE', component.id)
    }
    assert(Array.isArray(component.healthChecks) && component.healthChecks.length > 0, 'UI_HEALTH_CHECKS_MISSING', component.id)
    assert(Array.isArray(component.smokeChecks) && component.smokeChecks.length > 0, 'UI_SMOKE_CHECKS_MISSING', component.id)
    component.healthChecks.forEach(check => validateCheck(check, component.id))
    component.smokeChecks.forEach(check => validateCheck(check, component.id))
  }
  return inventory
}

export function validateUiOverlayManifest(manifest, inventory) {
  object(manifest, 'UI_OVERLAY_INVALID')
  assert(manifest.schemaVersion === 1, 'UI_OVERLAY_SCHEMA_UNSUPPORTED')
  assert(manifest.artifact?.id === 'airules-dsh-ui-overlay', 'UI_OVERLAY_ID_INVALID')
  assert(manifest.sourceRelease?.releaseId === inventory.source.releaseId, 'UI_OVERLAY_SOURCE_RELEASE_MISMATCH')
  assert(manifest.target?.unknownTargetPolicy === 'block', 'UI_OVERLAY_UNKNOWN_TARGET_NOT_BLOCKED')
  assert(manifest.target?.releaseIds?.includes(inventory.source.releaseId), 'UI_OVERLAY_TARGET_RELEASE_MISSING')
  const targetHost = manifest.target?.hostVersions
  const native022 = Array.isArray(targetHost) && targetHost.length === 1 && targetHost[0] === '0.2.2-rc.1'
  assert(native022 || targetHost?.includes(inventory.source.hostVersion), 'UI_OVERLAY_TARGET_HOST_MISSING')
  if (native022) {
    assert(manifest.target.releaseIds.includes('official-desktop-0.2.2-rc.1'), 'UI_OVERLAY_NATIVE_TARGET_MISSING')
    for (const name of ['general','models','account'].map(suffix=>'@deepseek-ai/dsh-client-ui-settings-'+suffix)) {
      const row=manifest.packageProvenance?.find(row=>row.name===name)
      assert(row?.origin==='official-native-compat' && row.hostVersion==='0.2.2-rc.1' && row.version==='0.2.2-rc.1' && HASH.test(row.sourceDirectorySha256??''), 'UI_OVERLAY_NATIVE_PROVENANCE_INVALID', name)
    }
  }
  assert(HASH.test(manifest.target?.baselineLockSha256 ?? ''), 'UI_OVERLAY_BASELINE_HASH_INVALID')
  for (const value of Object.values(object(manifest.separation, 'UI_OVERLAY_SEPARATION_MISSING'))) {
    assert(value === false, 'UI_OVERLAY_LAYER_LEAK')
  }
  const componentById = new Map(inventory.components.map(row => [row.id, row]))
  assert(Array.isArray(manifest.components) && manifest.components.length > 0, 'UI_OVERLAY_COMPONENTS_MISSING')
  unique(manifest.components.map(row => row.id), 'UI_OVERLAY_COMPONENT_DUPLICATE')
  const selected = new Map()
  let previousOrder = -1
  for (const row of manifest.components) {
    const component = componentById.get(row.id)
    assert(component, 'UI_OVERLAY_COMPONENT_UNKNOWN', row.id)
    assert(!['blocked', 'deferred'].includes(component.portability.status), 'UI_OVERLAY_COMPONENT_NOT_READY', row.id)
    assert(row.required === component.deployment.required, 'UI_OVERLAY_REQUIRED_MISMATCH', row.id)
    assert(row.enabledByDefault === component.deployment.defaultEnabled, 'UI_OVERLAY_DEFAULT_MISMATCH', row.id)
    assert(row.installOrder === component.deployment.installOrder && row.installOrder > previousOrder, 'UI_OVERLAY_ORDER_INVALID', row.id)
    previousOrder = row.installOrder
    selected.set(row.id, component)
  }
  for (const required of inventory.components.filter(row => row.deployment.required)) {
    assert(selected.has(required.id), 'UI_OVERLAY_REQUIRED_COMPONENT_MISSING', required.id)
  }
  object(manifest.files, 'UI_OVERLAY_FILES_INVALID')
  for (const [path, record] of Object.entries(manifest.files)) {
    portablePath(path, 'UI_OVERLAY_FILE_PATH_UNSAFE')
    assert(HASH.test(record?.sha256 ?? '') && Number.isInteger(record?.bytes) && record.bytes >= 0, 'UI_OVERLAY_FILE_RECORD_INVALID', path)
  }
  assert(Array.isArray(manifest.operations), 'UI_OVERLAY_OPERATIONS_INVALID')
  for (const operation of manifest.operations) {
    const component = selected.get(operation.component)
    assert(component, 'UI_OVERLAY_OPERATION_COMPONENT_UNSELECTED', operation.component)
    portablePath(operation.source, 'UI_OVERLAY_OPERATION_SOURCE_UNSAFE')
    portablePath(operation.target, 'UI_OVERLAY_OPERATION_TARGET_UNSAFE')
    assert(manifest.files[operation.source], 'UI_OVERLAY_OPERATION_SOURCE_UNDECLARED', operation.source)
    assert(operation.sha256 === manifest.files[operation.source].sha256, 'UI_OVERLAY_OPERATION_HASH_MISMATCH', operation.source)
    assert(['package-copy', 'config-fragment', 'exact-text-patch', 'data-overlay'].includes(operation.type), 'UI_OVERLAY_OPERATION_TYPE_INVALID')
    if (component.portability.mode === 'package-copy') assert(operation.type === 'package-copy', 'UI_OVERLAY_PORTABILITY_MISMATCH', component.id)
    if (component.portability.mode === 'data-overlay') assert(operation.type === 'data-overlay', 'UI_OVERLAY_PORTABILITY_MISMATCH', component.id)
  }
  return manifest
}
