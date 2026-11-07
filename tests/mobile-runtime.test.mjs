import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMobileAccessHandler } from '../src/mobile-access/lib/control.js'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'airules-mobile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'plugin')
  cpSync(resolve('src/mobile-access'), pkg, { recursive: true })
  const stub = join(pkg, 'node_modules/dsh-relay')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: 'dsh-relay', type: 'module', exports: { './desktop': './desktop.js' } }))
  writeFileSync(join(stub, 'desktop.js'), 'export const Config=x=>x, RelayStore={}, Authenticator=class{}, HarnessSession={}, startListener=()=>{},loadCertificate=()=>{},certificateSans=()=>{},localAddresses=()=>[],relayAuthorities=x=>x,pairingPayload=x=>x,createQrDataUrl=()=>{}')
  const module = await import(pathToFileURL(join(pkg, 'lib/controller.js')))
  const calls = [], state = { certificate: undefined }
  let password = false, pairing
  const relayApi = {
    Config: x => x,
    RelayStore: { open: async () => ({ state, update: async work => work(state), close: async () => calls.push('store-close') }) },
    Authenticator: class {
      devices = []
      get hasPassword() { return password }
      pairing = { clear: () => { pairing = undefined }, peek: () => pairing, issue: (size, ttl, now) => (pairing = { code: 'fixture-code', expiresAt: now + ttl }) }
      async setPassword() { password = true; calls.push('password-set') }
      async signOutEverywhere() { calls.push('revoke-all') }
      async revoke() { calls.push('revoke-one'); return true }
      dispose() { calls.push('auth-dispose') }
    },
    HarnessSession: { load: async () => ({ fixture: true }) },
    startListener: async options => { calls.push({ listener: options }); return { close: async () => calls.push('listener-close') } },
    loadCertificate: async () => ({ record: { fingerprint: 'fixture-fingerprint' } }),
    certificateSans: () => [], relayAuthorities: x => x, pairingPayload: x => x,
    createQrDataUrl: async () => 'data:image/png;base64,fixture',
  }
  const options = { home: root, context: { webServer: { host: '127.0.0.1', port: 9191 } },
    protectDirectory: async path => mkdirSync(path, { recursive: true }), addresses: () => ['127.0.0.1', '192.168.0.4'], relayApi }
  const controller = module.createMobileAccessController(options)
  t.after(() => controller.dispose())
  return { root, module, calls, controller, options }
}

test('mobile access initializes disabled and refuses start without password', async t => {
  const f = await fixture(t)
  const snapshot = await f.controller.initialize()
  assert.equal(snapshot.running, false)
  assert.equal(snapshot.autoStart, false)
  assert.equal(snapshot.hasPassword, false)
  assert.equal(snapshot.port, 3443)
  assert.equal(f.calls.some(x => x.listener), false)
  await assert.rejects(f.controller.start(), /пароль/)
  await assert.rejects(f.controller.setPassword('short'), /от 10 до 1024/)
  assert.equal(f.calls.some(x => x.listener), false)
})

test('mobile start passes HTTPS/auth-only config and blocks every airules admin transport', async t => {
  const f = await fixture(t)
  await f.controller.setPassword('fixture-password')
  assert.equal(f.controller.snapshot().running, false)
  await f.controller.start()
  const listener = f.calls.find(x => x.listener).listener
  assert.equal(listener.bind, '0.0.0.0')
  assert.equal(listener.runtime.requireCredentials, true)
  assert.equal(listener.runtime.config.compat.plainPort, 0)
  assert.equal(listener.runtime.config.compat.addressGrants, false)
  assert.equal(listener.runtime.config.mdns, false)
  assert.equal(listener.runtime.config.privilegedMethods, 'loopback-only')
  assert.equal(listener.runtime.target.host, '127.0.0.1')
  assert.equal(listener.runtime.target.port, 9191)
  assert.ok(listener.runtime.deniedPaths.includes('/airules'))
  for (const path of ['/airules/telegram-control', '/airules/acp-control', '/airules/mobile-access', '/airules-subscriptions-auth', '/mcp-manager']) {
    assert.ok(listener.runtime.deniedPaths.some(prefix => path === prefix || path.startsWith(prefix + '/')))
  }
  const snapshot = f.controller.snapshot()
  assert.deepEqual(snapshot.urls, ['https://192.168.0.4:3443'])
  assert.equal(JSON.stringify(snapshot).includes('fixture-password'), false)
  await f.controller.createPairing()
  assert.equal(f.controller.snapshot().pairing.code, 'fixture-code')
  await f.controller.stop()
  assert.equal(f.controller.snapshot().running, false)
  assert.equal(f.controller.snapshot().hasPassword, true)
  assert.equal(f.controller.snapshot().pairing, undefined)
})

test('password replacement revokes prior sessions and restart preserves explicit autostart', async t => {
  const f = await fixture(t)
  await f.controller.initialize()
  await assert.rejects(f.controller.setPort(80), /от 1024 до 65535/)
  await f.controller.setPassword('fixture-password')
  await f.controller.setAutoStart(true)
  assert.equal(f.controller.snapshot().running, false)
  await f.controller.start()
  await f.controller.setPassword('fixture-password-replaced')
  assert.equal(f.calls.filter(x => x === 'revoke-all').length, 2)
  assert.ok(f.calls.includes('listener-close'))
  assert.equal(f.calls.filter(x => x.listener).length, 2)
  assert.equal(f.controller.snapshot().running, true)
  await f.controller.stop()
  assert.equal(f.controller.snapshot().autoStart, true)
  assert.equal(f.controller.snapshot().hasPassword, true)
})

test('mobile control requires local native admission/CSRF and never reflects password errors', async () => {
  const calls = []
  const controller = { snapshot: () => ({ running: false, status: 'stopped' }), setPassword: async password => { calls.push('setPassword'); throw new Error(password) }, start: async () => calls.push('start') }
  const handler = createMobileAccessHandler(controller, { connection: { requestRejection: () => undefined }, token: 'test-csrf' })
  const call = async (use, method, body, token) => {
    const request = { method, headers: { 'x-dsh-csrf': token }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const response = { writeHead(code) { this.code = code }, end(text) { this.text = text; this.body = JSON.parse(text) } }
    await use(request, response); return response
  }
  assert.equal((await call(createMobileAccessHandler(controller), 'GET')).code, 403)
  assert.equal((await call(handler, 'GET')).body.csrfToken, 'test-csrf')
  assert.equal((await call(handler, 'POST', { action: 'start' })).code, 403)
  assert.deepEqual(calls, [])
  const failure = await call(handler, 'POST', { action: 'setPassword', password: 'fixture-secret-password' }, 'test-csrf')
  assert.equal(failure.code, 400)
  assert.equal(failure.text.includes('fixture-secret-password'), false)
})
