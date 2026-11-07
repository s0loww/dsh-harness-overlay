import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { patchEffortSliderClient, patchEffortSliderPackage } from '../src/effort-compat/patch-slider.mjs'

const supplier = new URL('file:///E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules/dsh-effort-slider/')
function factory(source, modules, globals = {}) {
  let definition
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value } } }, ...globals })
  return definition.factory(id => { if (!(id in modules)) throw new Error(`Unexpected require ${id}`); return modules[id] })
}
function store(initial) {
  let snapshot = initial
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  return { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, set(next) { snapshot = next; notify() }, update(fn) { snapshot = { ...snapshot }; fn(snapshot); notify() } }
}
async function slider(react = {}) {
  const source = await readFile(new URL('lib/client.js', supplier), 'utf8')
  return { source, patched: patchEffortSliderClient(source, { mode: 'shared-directory' }), plugin: factory(patchEffortSliderClient(source, { mode: 'shared-directory' }), { react, 'react-dom/client': {}, 'react/jsx-runtime': {} }) }
}

test('pinned slider adaptation uses native directory dependency and rejects source drift', async () => {
  const { source, patched, plugin } = await slider()
  assert.throws(() => patchEffortSliderClient(source + '\n'), /HASH_MISMATCH/)
  assert.deepEqual(Array.from(plugin.inject), ['modelDirectories', 'sessions', 'theme'])
  assert.doesNotMatch(patched, /connection\.api\.sessions\.selectModel\(\{|response\.result/)
  assert.match(patched, /selectSharedEffort\(connection\.directoryFor\(sessionId\)/)
  assert.match(patched, /setSelectionError\("Не удалось изменить/)
  const pkg = JSON.parse(await readFile(new URL('package.json', supplier), 'utf8'))
  assert.ok(patchEffortSliderPackage(pkg, { mode: 'shared-directory' }).dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-model-selection'))
})

test('shipping default restores the native effort menu without any global click interception or session lookup', async () => {
  const { source } = await slider()
  const listeners = [], styles = []
  const document = { addEventListener(...args) { listeners.push(args) }, querySelector() { return null }, createElement() { return { dataset: {} } }, head: { appendChild(style) { styles.push(style) } } }
  const plugin = factory(patchEffortSliderClient(source), { react: {}, 'react-dom/client': {}, 'react/jsx-runtime': {} }, { document })
  assert.deepEqual(Array.from(plugin.inject), [])
  // The no-op receives a trap context: even a service lookup/effect would fail.
  plugin.apply(new Proxy({}, { get() { throw new Error('legacy enhancement must stay disabled') } }))
  assert.equal(listeners.length, 0)
  assert.equal(styles.length, 0)
  const event = { defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
  for (const [, handler] of listeners) handler(event)
  let nativeEffortPaneOpened = false
  if (!event.stopped) nativeEffortPaneOpened = true
  assert.equal(event.defaultPrevented, false)
  assert.equal(nativeEffortPaneOpened, true)
  const oldHandler = source.slice(source.indexOf('const onDocClick = (event) =>'))
  assert.ok(oldHandler.indexOf('event.stopPropagation();') < oldHandler.indexOf('ctx.get("sessions").list.getSnapshot().current'), 'legacy capture swallowed the click before checking session identity')
  const pkg = JSON.parse(await readFile(new URL('package.json', supplier), 'utf8'))
  assert.equal(patchEffortSliderPackage(pkg), pkg)
  assert.match(patchEffortSliderClient(source), /keep the official session-bound reasoning menu/)
})

test('Low to High changes actual pinned native shared selection, preserves chat and avoids repeated writes', async () => {
  const { plugin } = await slider()
  const nativeSource = await readFile(new URL('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js', import.meta.url), 'utf8')
  const { ModelDirectory } = factory(nativeSource, { react: {}, 'react-dom': {}, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': {}, '@deepseek-ai/cordis': { Service: class {} }, '@deepseek-ai/dsh-client-store': { createSnapshotStore: store } })
  const low = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' }
  const projected = store({ next: low })
  const reasoning = { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
  const catalog = { store: store({ status: 'ready', value: { default: low, groups: [{ id: 'codex', models: [{ id: low.model, reasoning }] }] } }), reasoningFor: () => reasoning, async load() {} }
  const calls = []
  const wire = { async selectModel(request) { calls.push(request); projected.set({ next: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }); return { ok: true, value: { selected: projected.getSnapshot().next } } } }
  const directory = new ModelDirectory(wire, 'actual-chat-id', () => true, catalog, projected, () => false)
  assert.equal(directory.store.getSnapshot().current.reasoningEffort, 'low')
  const high = { ...low, reasoningEffort: 'high' }
  const selected = await plugin.airulesEffortCompatibility.selectSharedEffort(directory, high)
  assert.equal(selected.ok, true)
  assert.equal(directory.store.getSnapshot().current.reasoningEffort, 'high')
  assert.equal(calls[0].sessionId, 'actual-chat-id')
  assert.equal(calls[0].model, 'gpt-6.1-sol')
  await plugin.airulesEffortCompatibility.selectSharedEffort(directory, high)
  assert.equal(calls.length, 1)
  directory.dispose()
})

test('pending identical effort is deduplicated and native failures remain available for retry', async () => {
  const { plugin } = await slider()
  const target = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
  let calls = 0
  const state = { status: 'selecting', pending: target, current: { ...target, reasoningEffort: 'low' } }
  const directory = { store: { getSnapshot: () => state }, async select() { calls++; return { ok: false, error: { code: 'session/writer-held' } } } }
  await plugin.airulesEffortCompatibility.selectSharedEffort(directory, target)
  assert.equal(calls, 0)
  state.pending = null; state.status = 'error'
  const failed = await plugin.airulesEffortCompatibility.selectSharedEffort(directory, target)
  assert.equal(failed.ok, false)
  assert.equal(calls, 1)
})
