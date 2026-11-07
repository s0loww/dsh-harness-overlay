import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { readSettings, saveSettings, renderUpdates } from '../src/project-settings/lib/core.js'
import { projectSession } from '../src/project-settings/lib/session.js'
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'project-settings-')), root = join(base, 'project'), home = join(base, 'home')
  mkdirSync(root); mkdirSync(home); t.after(() => rmSync(base, { force: true, recursive: true }))
  return { root, home, base, path: join(root, '.dev.env') }
}
test('GET is side-effect free and exposes neither secret fields nor inline credentials nor unknown values', t => {
  const f = fixture(t)
  const missing = readSettings(f.root)
  assert.equal(missing.exists, false); assert.deepEqual(readdirSync(f.root), [])
  writeFileSync(f.path, '# заметка\r\nIB_PASSWORD=top-secret\r\nIB_UNLOCK_CODE=unlock-secret\r\nCOMPANY=Тест\r\nAPI_TOKEN=foreign-secret\r\nINFOBASE_PATH=Srvr=x;Pwd=inline-secret;Ref=b;\r\n')
  const data = readSettings(f.root), encoded = JSON.stringify(data)
  assert.equal(data.secrets.IB_PASSWORD, true)
  assert.equal(data.values.COMPANY, 'Тест')
  assert.deepEqual(data.redactedKeys, ['INFOBASE_PATH'])
  for (const secret of ['top-secret', 'unlock-secret', 'foreign-secret', 'inline-secret']) assert.equal(encoded.includes(secret), false)
  assert.deepEqual(readdirSync(f.home), [])
})
test('CAS save preserves unrelated bytes and comments, backs up original outside repo and replaces all duplicate rows', t => {
  const f = fixture(t)
  const source = '\uFEFF# заметка\r\nCOMPANY=старое\r\nUNKNOWN = unchanged\r\n\r\nCOMPANY=дубль\r\nIB_PASSWORD=secret\r\n'
  writeFileSync(f.path, source)
  const current = readSettings(f.root)
  const result = saveSettings(f.root, { revision: current.revision, updates: { COMPANY: 'Новое', DEVELOPER: 'Автор' } }, f.home)
  assert.equal(result.changed, true)
  assert.equal(readFileSync(f.path, 'utf8'), '\uFEFF# заметка\r\nCOMPANY=Новое\r\nUNKNOWN = unchanged\r\n\r\nCOMPANY=Новое\r\nIB_PASSWORD=secret\r\nDEVELOPER=Автор\r\n')
  const container = join(f.home, 'project-settings-backups'), project = join(container, readdirSync(container)[0]), backup = join(project, readdirSync(project)[0])
  assert.equal(readFileSync(backup, 'utf8'), source)
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(f.root), ['.dev.env'])
  assert.throws(() => saveSettings(f.root, { revision: current.revision, updates: { COMPANY: 'stale' } }, f.home), /STALE_SETTINGS/u)
  assert.equal(readSettings(f.root).values.COMPANY, 'Новое')
})
test('failed validation, stale revision and symlink refuse writes; explicit secret clearing and missing-file creation work', t => {
  const f = fixture(t), initial = readSettings(f.root)
  for (const updates of [{ ONEC_MCP_CODE_URL: 'http://x' }, { COMPANY: 'x\nIB_PASSWORD=bad' }, { INFOBASE_KIND: 'invalid' }, { INFOBASE_PATH: 'Pwd=bad' }]) assert.throws(() => saveSettings(f.root, { revision: initial.revision, updates }, f.home))
  assert.equal(existsSync(f.path), false)
  saveSettings(f.root, { revision: initial.revision, updates: { IB_PASSWORD: 'new-secret', INFOBASE_KIND: 'file' } }, f.home)
  assert.deepEqual(readdirSync(f.home), [])
  saveSettings(f.root, { revision: readSettings(f.root).revision, updates: { IB_PASSWORD: '' } }, f.home)
  assert.equal(readSettings(f.root).secrets.IB_PASSWORD, false)
  const external = join(f.base, 'external.env'); writeFileSync(external, 'COMPANY=external')
  rmSync(f.path); symlinkSync(external, f.path)
  assert.throws(() => readSettings(f.root), /FILE_REJECTED/u)
  assert.equal(readFileSync(external, 'utf8'), 'COMPANY=external')
})
test('render preserves LF files and untouched rows without manufacturing defaults', () => {
  assert.equal(renderUpdates('# a\nCOMPANY = old\nTOKEN=unknown', { COMPANY: 'new' }), '# a\nCOMPANY = new\nTOKEN=unknown')
  assert.equal(renderUpdates('', { IB_PASSWORD: 'x#$%"a' }), 'IB_PASSWORD=x#$%"a\n')
})
async function runtime(t) {
  const f = fixture(t), pkg = join(f.base, 'package')
  cpSync(resolve('src/project-settings'), pkg, { recursive: true })
  mkdirSync(join(pkg, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(resolve('var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-home-paths'), join(pkg, 'node_modules', '@deepseek-ai', 'dsh-home-paths'), process.platform === 'win32' ? 'junction' : 'dir')
  return { ...f, module: await import(pathToFileURL(join(pkg, 'lib/index.js'))) }
}
async function nativeContext(t, f, mode = 'workspace-write') {
  const { Context } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { SessionProjectionRegistry } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js')
  const { SandboxPolicyService } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js')
  const context = new Context(), events = [{ seq: 0, type: 'sandbox/mode', data: { mode } }]
  new SessionProjectionRegistry(context)
  new SandboxPolicyService(context, { mode: 'read-only', workspaceRoot: f.root })
  context.provide('sessions', { get: () => undefined })
  let closed = 0
  context.provide('sessionPersistence', {
    stat: async id => ({ header: { id, cwd: f.root, agentPreset: '1c-airules' }, eventCount: events.length }),
    open: async (id, access) => { assert.equal(access, 'read'); return { header: { id, cwd: f.root, agentPreset: '1c-airules' }, read: async () => ({ events }), close: async () => { closed++ } } },
  })
  context.provide('connection', { requestRejection: () => undefined })
  let route
  context.provide('webServer', { register(value) { route = value; return () => {} } })
  const fiber = context.plugin({ name: f.module.name, inject: f.module.inject, apply: f.module.apply })
  await fiber.await(); t.after(() => fiber.dispose())
  return { context, events, route, closed: () => closed }
}
async function request(handler, method, url, payload, csrf) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  req.method = method; req.url = url; req.headers = { 'content-type': 'application/json', 'x-dsh-csrf': csrf }
  let status, body
  await handler(req, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
  return { status, body }
}
test('real native Cordis and sandbox cold projection resolve read/write without agent attachment', async t => {
  const f = await runtime(t), native = await nativeContext(t, f)
  const get = await request(native.route.handler, 'GET', '/airules/project-settings?sessionId=cold')
  assert.equal(get.status, 200); assert.equal(get.body.writable, true)
  assert.deepEqual(readdirSync(f.root), [])
  // Avoid any production-home backup use: this route test creates a new file.
  const saved = await request(native.route.handler, 'POST', '/airules/project-settings', { sessionId: 'cold', revision: get.body.revision, updates: { COMPANY: 'Native', IB_PASSWORD: 'native-secret' } }, get.body.csrfToken)
  assert.equal(saved.status, 200); assert.equal(saved.body.values.COMPANY, 'Native'); assert.equal(JSON.stringify(saved).includes('native-secret'), false)
  native.events.push({ seq: 1, type: 'sandbox/mode', data: { mode: 'read-only' } })
  const denied = await request(native.route.handler, 'POST', '/', { sessionId: 'cold', revision: saved.body.revision, updates: { COMPANY: 'Denied' } }, get.body.csrfToken)
  assert.equal(denied.body.error, 'WORKSPACE_WRITE_REQUIRED')
  const readonly = await request(native.route.handler, 'GET', '/?sessionId=cold')
  assert.equal(readonly.status, 200); assert.equal(readonly.body.writable, false)
  assert.ok(native.closed() >= 4)
})
test('HTTP requires native auth, CSRF and a real session; truncated cold history cannot assume write access', async t => {
  const f = await runtime(t), native = await nativeContext(t, f)
  const get = await request(native.route.handler, 'GET', '/?sessionId=cold')
  assert.equal((await request(native.route.handler, 'POST', '/', { sessionId: 'cold', revision: get.body.revision, updates: {} })).status, 403)
  assert.equal((await request(native.route.handler, 'GET', '/?root=C:/')).status, 400)
  const isolated = f.module.handlerFor({ connection: { requestRejection: () => 403 } }, f.home)
  assert.equal((await request(isolated, 'GET', '/?sessionId=x')).status, 403)
  native.events.push(...Array.from({ length: 20001 }, (_, i) => ({ seq: i + 1, type: 'sandbox/mode', data: { mode: 'workspace-write' } })))
  assert.equal((await request(native.route.handler, 'GET', '/?sessionId=cold')).status, 400)
})
