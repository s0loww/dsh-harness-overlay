import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createController, isolatedCredentialStore, noEnvironment, PROVIDER } from '../src/additional-providers/lib/controller.js'
import { aliasProvider } from '../src/additional-providers/lib/provider.js'
import { createHandler } from '../src/additional-providers/lib/control.js'
import { LocalCredentialProvider } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function fixture() {
  const records = new Map(), reads = [], logins = []
  const credentials = {
    async readRecord(key) { reads.push(key); return records.get(key) },
    describeRecord(key) { reads.push(key); return LocalCredentialProvider.prototype.describeRecord.call({ records }, key) },
    async modifyRecord(key, update) { const value = await update(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
  }
  const modelsFactory = options => ({ clearProviders() {}, setProvider() {}, async login(id, type, interaction) {
    logins.push({ id, type, interaction, options })
    await new Promise(resolve => { logins.at(-1).complete = resolve })
    await options.credentials.modify(id, () => ({ type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 100 }))
  } })
  const controller = createController({ credentials, key: 'isolated', modelsFactory, provider: { id: PROVIDER } })
  return { records, reads, credentials, controller, logins }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('boot/status use no network, login or foreign credentials', async () => {
  const f = fixture(); f.records.set('native', { kind: 'grant', payload: { access: 'foreign' } })
  assert.deepEqual(await f.controller.snapshot(), { provider: PROVIDER, connected: false, phase: 'idle' })
  assert.deepEqual(f.reads, ['isolated']); assert.equal(f.logins.length, 0)
  assert.deepEqual(await f.controller.store.list(), [])
  assert.equal(typeof LocalCredentialProvider.prototype.modifyRecord, 'function')
  assert.equal(typeof LocalCredentialProvider.prototype.deleteRecord, 'function')
  assert.equal(LocalCredentialProvider.prototype.updateRecord, undefined)
  assert.equal(await noEnvironment.env('KIMI_API_KEY'), undefined); assert.equal(await noEnvironment.fileExists('auth.json'), false)
})
test('explicit login uses isolated grant, device URL and redacted snapshot', async () => {
  const f = fixture(); await f.controller.action({ action: 'login' }); await tick()
  const login = f.logins[0]; assert.equal(login.id, PROVIDER); assert.equal(login.type, 'oauth')
  login.interaction.notify({ type: 'device_code', verificationUri: 'https://auth.kimi.com/device?code=AB', userCode: 'AB' })
  assert.equal((await f.controller.snapshot()).notice.code, 'AB')
  login.complete(); await tick()
  assert.equal((await f.controller.snapshot()).connected, true)
  assert.doesNotMatch(JSON.stringify(await f.controller.snapshot()), /private-access|private-refresh/)
  await f.controller.action({ action: 'logout' }); assert.equal(f.records.has('isolated'), false)
})
test('cancel prevents late OAuth completion from recreating credentials', async () => {
  const f = fixture(); await f.controller.action({ action: 'login' }); await tick()
  await f.controller.action({ action: 'cancel' }); assert.equal(f.logins[0].interaction.signal.aborted, true)
  f.logins[0].complete(); await tick(); assert.equal(f.records.has('isolated'), false)
  assert.equal((await f.controller.snapshot()).phase, 'idle')
})
test('untrusted login URL is never exposed, errors do not disclose provider text', async () => {
  const f = fixture(); await f.controller.action({ action: 'login' }); await tick()
  f.logins[0].interaction.notify({ type: 'device_code', verificationUri: 'https://evil.invalid/?token=secret', userCode: 'X' })
  assert.equal((await f.controller.snapshot()).notice, undefined)
  assert.equal(f.logins[0].interaction.signal.aborted, true)
  f.logins[0].complete(); await tick(); assert.equal(f.records.size, 0)
})
test('credential seam rejects foreign routes and preserves grant refresh', async () => {
  const f = fixture(), store = isolatedCredentialStore(f.credentials, 'isolated')
  assert.equal(await store.read('kimi-coding'), undefined)
  await assert.rejects(store.modify('kimi-coding', () => ({})), /SCOPE/)
  await store.modify(PROVIDER, () => ({ type: 'oauth', access: 'one' }))
  const refreshed = await store.modify(PROVIDER, old => ({ ...old, access: 'two' }))
  assert.equal(refreshed.access, 'two'); assert.equal(refreshed.kind, undefined)
  assert.equal((await store.modify(PROVIDER, () => undefined)).access, 'two')
  assert.equal((await store.read(PROVIDER)).access, 'two')
})
test('provider alias maps full catalog without mutating native routes', () => {
  const model = { id: 'kimi', provider: 'kimi-coding' }, native = { id: 'kimi-coding', getModels: () => [model], getAllModels: () => [model] }
  const alias = aliasProvider(native)
  assert.equal(alias.id, PROVIDER); assert.equal(alias.getModels()[0].provider, PROVIDER); assert.equal(alias.getAllModels()[0].provider, PROVIDER)
  assert.equal(model.provider, 'kimi-coding')
})
test('background refresh cannot reconnect an account after logout', async () => {
  const f = fixture(); f.records.set('isolated', { kind: 'grant', payload: { type: 'oauth', access: 'old' } })
  await f.controller.action({ action: 'logout' })
  await assert.rejects(f.controller.store.modify(PROVIDER, () => ({ type: 'oauth', access: 'late' })), /DISCONNECTED/)
  assert.equal(f.records.size, 0)
})
test('control route requires native admission, CSRF and bounded bodies', async () => {
  const f = fixture(), handler = createHandler(f.controller, { token: 'csrf', connection: { requestRejection: request => request.admitted ? undefined : 'deny' } })
  async function call(method, body, csrf, admitted = true) {
    const request = Readable.from(body ? [body] : []); Object.assign(request, { method, headers: { 'x-dsh-csrf': csrf }, admitted })
    let status, output
    await handler(request, { writeHead(code) { status = code }, end(value) { output = JSON.parse(value) } })
    return { status, output }
  }
  assert.equal((await call('GET', '', '', false)).status, 403)
  assert.equal((await call('POST', '{"action":"login"}', '')).status, 403)
  assert.equal((await call('POST', 'x'.repeat(4097), 'csrf')).status, 400)
  assert.equal((await call('POST', '{"action":"unknown"}', 'csrf')).status, 400)
  assert.equal(f.logins.length, 0)
  assert.equal((await call('GET')).output.csrfToken, 'csrf')
})
test('Kimi UI unknown state never offers disconnect or claims connected', () => {
  let exported
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useRef: value => ({ current: value }),
    useCallback: value => value, useEffect() {},
  }
  runInNewContext(readFileSync(new URL('../src/additional-providers/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { exported = module.factory(() => React) } } },
  })
  const tree = exported.KimiSettings(), nodes = []
  let section
  exported.apply({ slots: { inject(name, callback) { assert.equal(name, 'settings.section'); callback() }, register(descriptor) { section = descriptor } } })
  assert.equal(section.id, 'airules-kimi')
  function visit(node) { if (!node || typeof node !== 'object') return; nodes.push(node); node.children?.forEach(visit) }
  visit(tree)
  assert.equal(nodes.find(node => node.props?.role === 'status').children[0], 'Статус неизвестен')
  assert.equal(nodes.find(node => node.type === 'button' && node.children[0] === 'Отключить').props.disabled, true)
})
