import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { patchNativeModelsClient, patchNativeAccountClient } from '../src/providers-settings/patch-native.mjs'

const source = await readFile(new URL('../src/providers-settings/client.js', import.meta.url), 'utf8')
const pinnedPath = new URL('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js', import.meta.url)
const slotsSdk = new URL('file:///E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules/@deepseek-ai/dsh-client-ui-slots/')
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
function load(text, requires = {}, globals = {}) {
  let definition
  const context = { window: { __ModuleLoader__: { load(value) { definition = value } } }, ...globals }
  vm.runInNewContext(text, context)
  return { context, definition, plugin: definition.factory(id => { if (!(id in requires)) throw new Error(`Unexpected dependency ${id}`); return requires[id] }) }
}

test('patch is guarded by actual pinned rc.5 hash and exports existing native workflow functions', async () => {
  const sdkPackage = JSON.parse(await readFile(new URL('package.json', slotsSdk), 'utf8'))
  assert.equal(sdkPackage.version, '0.2.1-rc.5')
  const { SlotCore } = await import(new URL('lib/index.js', slotsSdk))
  const ledger = new SlotCore()
  ledger.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'settings.onboarding': { kind: 'list', scope: 'root' } } }, () => null)
  const pinned = await readFile(pinnedPath, 'utf8')
  assert.throws(() => patchNativeModelsClient(pinned + '\n'), /HASH_MISMATCH/)
  const patched = patchNativeModelsClient(pinned)
  assert.throws(() => patchNativeModelsClient(patched), /HASH_MISMATCH/)
  const storeFactory = snapshot => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, update(fn) { fn(snapshot) } })
  const { plugin } = load(patched, { react: {}, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) }, '@deepseek-ai/dsh-client-ui-primitives': {}, '@deepseek-ai/dsh-client-store': { createSnapshotStore: storeFactory } })
  const api = plugin.airulesProviders
  assert.deepEqual(Object.keys(api).sort(), ['CustomProviderCard', 'protocolChoices', 'providerUsable', 'reasoningLevelChoices', 'removeProviderProfile', 'renderProviderEditor', 'targetOf', 'getSnapshot', 'subscribe'].sort())
  assert.equal(api.getSnapshot(), undefined)
  let ready = 0
  const stop = api.subscribe(() => ready++)
  const effects = []
  plugin.apply({ settingsSchema: {}, configForms: { describe: () => ({}), get: () => ({}) }, locale: { bind: () => key => key }, effect(fn) { effects.push(fn) }, slots: { inject(name, callback) { callback() }, register: (meta, component) => ledger.register(meta, component) } })
  const modelEntry = ledger.entries('settings.section').find(entry => entry.options.id === 'models')
  assert.ok(modelEntry)
  assert.equal(modelEntry.id, undefined, 'real ledger nests the settings id under options')
  assert.equal(ledger.entries('settings.section').find(entry => entry.id === 'models'), undefined, 'old lookup must reproduce the actual regression')
  assert.equal(modelEntry.inject().controller, api.getSnapshot().controller)
  assert.equal(ready, 1)
  assert.equal(api.getSnapshot().controller.store.getSnapshot().status, 'idle')
  assert.equal(api.getSnapshot().hooks.snapshot, api.getSnapshot().controller.store)
  assert.equal(typeof api.getSnapshot().operations.storeCredential, 'function')
  assert.equal(api.getSnapshot(), api.getSnapshot(), 'uSES snapshot identity must be stable')
  const disposeBridge = effects.find(fn => fn.toString().includes('airulesProvidersFace'))()
  disposeBridge()
  assert.equal(api.getSnapshot(), undefined)
  assert.equal(ready, 2)
  stop()
  const row = { entry: { provider: 'gateway-test', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway-test'], active: true }, apiKeyEnv: 'GATEWAY_TEST_API_KEY', credential: { configured: true, writable: true } }
  const target = api.targetOf(row)
  assert.equal(target.credentialRef, 'GATEWAY_TEST_API_KEY')
  const operations = {}, schema = {}, namespace = {}
  const editor = api.renderProviderEditor({ target, row, operations, schema, namespace, readOnly: true })
  assert.equal(editor.props.operations, operations)
  assert.equal(editor.props.credential, row.credential)
  assert.equal(editor.props.namespace, namespace)
  assert.equal(editor.props.readOnly, true)
  assert.equal(api.providerUsable(row), true)
  const writes = []
  await api.removeProviderProfile({ async removeCredential(ref) { writes.push(['credential', ref]) }, async writeSettings(ns, patch) { writes.push(['settings', ns, patch]); return { kind: 'written' } } }, { async load() { writes.push(['reload']) } }, target)
  assert.equal(writes[0][0], 'credential')
  assert.equal(writes[1][1], 'llm-pi-ai')
  assert.equal(writes[1][2][0].op, 'unset')
  assert.equal(writes[2][0], 'reload')
})

function harness(stateValues = [], nativeOverride) {
  let index = 0
  const effects = [], subscription = function SubscriptionProviderPanel() {}, kimi = function KimiSettings() {}
  const react = { createElement: h, Fragment: 'fragment', useState(value) { const position = index++; return [stateValues[position] ?? value, () => {}] }, useEffect(fn) { effects.push(fn) }, useSyncExternalStore(subscribe, get) { return get() } }
  const native = nativeOverride || { renderProviderEditor() {}, getSnapshot() {}, subscribe() { return () => {} } }
  const accountNative = { getSnapshot() {}, subscribe() { return () => {} } }
  const globals = { document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } } }
  const loaded = load(source, { react, '@deepseek-ai/dsh-client-ui-settings-models': { airulesProviders: native }, '@deepseek-ai/dsh-client-ui-settings-account': { airulesProvidersAccount: accountNative }, 'airules-dsh-subscriptions': { SubscriptionProviderPanel: subscription }, 'airules-dsh-additional-providers': { KimiSettings: kimi } }, globals)
  return { ...loaded, subscription, kimi, effects, native }
}
function flatten(node) { return !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(flatten)] }

test('one unified section declares the native account slot', () => {
  const { plugin } = harness()
  const registrations = []
  plugin.apply({ effect(fn) { fn() }, slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn() }, register(meta, component) { registrations.push({ meta, component }) } } })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].meta.id, 'airules-providers-settings')
  assert.equal(registrations[0].meta.children['settings.models.sign-in'].scope, 'root')
  assert.equal(registrations[0].component, plugin.ProvidersPage)
  assert.equal(plugin.matches({ id: 'gateway', name: 'Gateway', models: [{ id: 'python-special' }] }, 'PYTHON'), true)
  assert.equal(plugin.matches({ id: 'gateway', name: 'Gateway' }, 'doesnotexist'), false)
})

test('subscription cards embed actual account/model and Kimi controls; group and search filter providers', () => {
  const rpc = { call() {} }
  const ctx = { slots: { getVersion(key) { assert.equal(key, 'settings.section'); return 1 }, entries() { return [] } }, connection: { rpc } }
  const first = harness(['', 'subscriptions', []])
  const tree = first.plugin.ProvidersPage({ ctx, renderSlot: () => 'native-account-login' })
  const nodes = flatten(tree)
  const subscriptions = nodes.filter(node => node.type === first.subscription)
  assert.equal(subscriptions.length, 3)
  assert.deepEqual(subscriptions.map(node => node.props.providerId), ['codex', 'grok', 'copilot'])
  assert.equal(subscriptions.every(node => node.props.rpc === rpc && node.props.embedded), true)
  assert.equal(nodes.filter(node => node.type === first.kimi).length, 1)
  const second = harness(['CoDeX', 'subscriptions', []])
  const filtered = flatten(second.plugin.ProvidersPage({ ctx, renderSlot: () => null }))
  assert.deepEqual(filtered.filter(node => node.type === second.subscription).map(node => node.props.providerId), ['codex'])
  assert.equal(filtered.filter(node => node.type === second.kimi).length, 0)
})

test('native source remains the only API credential/mutation path', () => {
  assert.doesNotMatch(source, /localStorage|indexedDB|apiKeyEnv\s*:|fetch\(/)
  assert.match(source, /native\.renderProviderEditor/)
  assert.match(source, /native\.CustomProviderCard/)
  assert.match(source, /api\.controller\.store/)
  assert.match(source, /ctx\.remote\.session\.modelCatalog\(\)/)
  assert.doesNotMatch(source, /slots\.entries|entry\.inject|entry\.component/)
})

test('native account compatibility exposes original component and observable bridge', async () => {
  const pinned = await readFile(new URL('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js', import.meta.url), 'utf8')
  assert.throws(() => patchNativeAccountClient(pinned + '\n'), /ACCOUNT_HASH_MISMATCH/)
  const patched = patchNativeAccountClient(pinned)
  const { plugin } = load(patched, { react: {}, 'react-dom': {}, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': {}, '@deepseek-ai/dsh-client-store': {} })
  assert.equal(typeof plugin.airulesProvidersAccount.AccountSection, 'function')
  assert.equal(plugin.airulesProvidersAccount.getSnapshot(), undefined)
  assert.equal(typeof plugin.airulesProvidersAccount.subscribe(() => {}), 'function')
  assert.match(patched, /const airulesCurrentFace = operations;/)
})

test('API controller comes from native bridge even when public ledger has no render fields', () => {
  const snapshot = { status: 'ready', rows: [], namespaces: new Map() }
  const face = { controller: { store: { getSnapshot: () => snapshot, subscribe: () => () => {} } } }
  const native = { renderProviderEditor() {}, getSnapshot: () => face, subscribe: () => () => {} }
  const { plugin } = harness(['', 'api', []], native)
  const ctx = { slots: { entries() { return [{ id: 'models', name: 'settings.section' }] } }, connection: { rpc: {} } }
  const tree = plugin.ProvidersPage({ ctx, renderSlot: () => null })
  const list = flatten(tree).find(node => node.type?.name === 'NativeApiList')
  assert.equal(list.props.api, face)
  assert.equal(list.props.api.controller.store.getSnapshot().status, 'ready')
})

test('bridge activation failure shows a retry error instead of permanent loading', () => {
  const { plugin } = harness(['', 'api', [], 0, true])
  const tree = plugin.ProvidersPage({ ctx: { connection: { rpc: {} } }, renderSlot: () => null })
  const error = flatten(tree).find(node => node.props.role === 'alert')
  assert.ok(error)
  assert.match(error.children.join(''), /Каталог API не готов.*Обновить/)
})
