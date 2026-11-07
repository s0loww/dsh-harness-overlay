import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateUiInventory, validateUiOverlayManifest } from '../src/ui-overlay/contracts.mjs'

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const clone = value => structuredClone(value)

async function fixtures() {
  const [inventory, manifest, upstream, inventorySchema, manifestSchema] = await Promise.all([
    readJson('../src/ui-overlay/ui-component-inventory.json'),
    readJson('../src/ui-overlay/examples/ui-overlay-manifest.example.json'),
    readJson('../upstream/component-inventory.json'),
    readJson('../src/ui-overlay/schemas/ui-component-inventory.schema.json'),
    readJson('../src/ui-overlay/schemas/ui-overlay-manifest.schema.json'),
  ])
  return { inventory, manifest, upstream, inventorySchema, manifestSchema }
}

test('UI inventory is pinned to safe upstream package metadata', async () => {
  const { inventory, upstream } = await fixtures()
  assert.equal(validateUiInventory(inventory, upstream), inventory)
  assert.equal(inventory.source.releaseId, '20261103-134539')
  assert.deepEqual(inventory.separation, {
    policy: 'excluded',
    rulepack: 'excluded',
    mcpBindings: 'excluded',
    credentials: 'excluded',
    runtimeState: 'excluded',
  })
  assert.deepEqual(
    inventory.components.filter(row => row.deployment.required).map(row => row.id),
    ['balance-cost-hud', 'settings-shell', 'russian-localization'],
  )
  assert.equal(inventory.components.find(row => row.id === 'companion').portability.status, 'deferred')
})

test('schema documents expose strict separation and portability contracts', async () => {
  const { inventorySchema, manifestSchema } = await fixtures()
  assert.equal(inventorySchema.additionalProperties, false)
  assert.equal(manifestSchema.additionalProperties, false)
  assert.equal(inventorySchema.properties.separation.properties.mcpBindings.const, 'excluded')
  assert.equal(manifestSchema.properties.separation.properties.includesMcpBindings.const, false)
  assert.ok(inventorySchema.$defs.component.properties.portability.properties.mode.enum.includes('vendor-patch'))
  assert.equal(manifestSchema.properties.target.properties.unknownTargetPolicy.const, 'block')
})

test('contract-only UI overlay manifest selects every required component in order', async () => {
  const { inventory, manifest, upstream } = await fixtures()
  validateUiInventory(inventory, upstream)
  assert.equal(validateUiOverlayManifest(manifest, inventory), manifest)
  assert.deepEqual(manifest.components.map(row => row.installOrder), [10, 20, 30])
  assert.deepEqual(manifest.operations, [])
  assert.deepEqual(manifest.files, {})
})

test('inventory rejects package drift and required components that are not ready', async () => {
  const { inventory, upstream } = await fixtures()
  const drift = clone(inventory)
  drift.components[0].sourcePackages[0].version = '999.0.0'
  assert.throws(() => validateUiInventory(drift, upstream), /UI_SOURCE_PACKAGE_VERSION_MISMATCH/u)

  const deferred = clone(inventory)
  deferred.components.find(row => row.id === 'settings-shell').portability.status = 'deferred'
  assert.throws(() => validateUiInventory(deferred, upstream), /UI_REQUIRED_COMPONENT_NOT_READY/u)
})

test('manifest rejects layer leaks, missing required UI and unsafe payload paths', async () => {
  const { inventory, manifest, upstream } = await fixtures()
  validateUiInventory(inventory, upstream)

  const leaked = clone(manifest)
  leaked.separation.includesMcpBindings = true
  assert.throws(() => validateUiOverlayManifest(leaked, inventory), /UI_OVERLAY_LAYER_LEAK/u)

  const missing = clone(manifest)
  missing.components = missing.components.filter(row => row.id !== 'balance-cost-hud')
  assert.throws(() => validateUiOverlayManifest(missing, inventory), /UI_OVERLAY_REQUIRED_COMPONENT_MISSING/u)

  const unsafe = clone(manifest)
  unsafe.files['payload/settings.bin'] = { sha256: 'a'.repeat(64), bytes: 1 }
  unsafe.operations.push({
    component: 'settings-shell',
    type: 'package-copy',
    source: 'payload/settings.bin',
    target: '../outside/settings.bin',
    sha256: 'a'.repeat(64),
  })
  assert.throws(() => validateUiOverlayManifest(unsafe, inventory), /UI_OVERLAY_OPERATION_TARGET_UNSAFE/u)
})

test('unselected and deferred components cannot enter an artifact operation', async () => {
  const { inventory, manifest, upstream } = await fixtures()
  validateUiInventory(inventory, upstream)
  const bad = clone(manifest)
  bad.files['payload/companion.bin'] = { sha256: 'b'.repeat(64), bytes: 2 }
  bad.operations.push({
    component: 'companion',
    type: 'exact-text-patch',
    source: 'payload/companion.bin',
    target: 'dsh-bundle/client/companion.js',
    sha256: 'b'.repeat(64),
  })
  assert.throws(() => validateUiOverlayManifest(bad, inventory), /UI_OVERLAY_OPERATION_COMPONENT_UNSELECTED/u)
})
