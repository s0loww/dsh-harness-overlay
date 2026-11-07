import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectFile, inventory, LIMITS, parseXml } from '../src/onec-panels/lib/core.js'
import { handlerFor, sessionRoot } from '../src/onec-panels/lib/index.js'
import * as plugin from '../src/onec-panels/lib/index.js'

async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'onec-panel-')); t.after(() => rm(root, { recursive: true, force: true })); return root }
const metadata = '<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>'
const form = '<f:Form xmlns:f="urn:form"><f:ChildItems><f:InputField name="Товар" id="10"><f:Events><f:Event name="OnChange">ТоварПриИзменении</f:Event></f:Events></f:InputField><f:UsualGroup name="Группа" id="11"><f:ChildItems><f:Button name="Записать" id="12"/></f:ChildItems></f:UsualGroup></f:ChildItems></f:Form>'
test('local XML/EDT inventory finds metadata, module paths and namespaced form elements/events', async t => {
  const root = await workspace(t)
  await mkdir(join(root, 'Catalogs', 'Товары', 'Forms', 'Основная', 'Ext'), { recursive: true })
  await writeFile(join(root, 'Catalogs', 'Товары.xml'), metadata)
  await writeFile(join(root, 'Catalogs', 'Товары', 'Forms', 'Основная', 'Ext', 'Form.xml'), form)
  await writeFile(join(root, 'Catalogs', 'Товары', 'ObjectModule.bsl'), 'Процедура Тест() КонецПроцедуры')
  const tree = await inventory(root)
  assert.equal(tree.files.length, 2)
  assert.deepEqual(tree.files.find(file => file.objects.length).objects, [{ type: 'Catalog', name: 'Товары' }])
  assert.deepEqual(tree.modules, ['Catalogs/Товары/ObjectModule.bsl'])
  const detail = await inspectFile(root, 'Catalogs/Товары/Forms/Основная/Ext/Form.xml')
  assert.deepEqual(detail.elements.map(item => item.name), ['Товар', 'Группа', 'Записать'])
  assert.deepEqual(detail.events, [{ name: 'OnChange', handler: 'ТоварПриИзменении' }])
})
test('rejects traversal, absolute paths, wrong file type, symlink and XML entity declarations', async t => {
  const root = await workspace(t), outside = await workspace(t)
  await writeFile(join(outside, 'external.xml'), metadata)
  for (const path of ['../external.xml', '/external.xml', 'C:/external.xml', 'x/../../x.xml', 'x\\external.xml', '.env']) await assert.rejects(inspectFile(root, path))
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectFile(root, 'escape/external.xml'), /SYMLINK_REJECTED/u)
  assert.equal((await inventory(root)).files.length, 0)
  for (const xml of ['<!DOCTYPE x SYSTEM "https://example.test/external"><x/>', '<!DOCTYPE x [<!ENTITY a "file:///secret">]><x>&a;</x>', '<x><y></x>']) assert.throws(() => parseXml(Buffer.from(xml)))
})
test('bounds reads and accepts UTF-16 exports without entity expansion', async t => {
  const root = await workspace(t)
  await writeFile(join(root, 'big.xml'), Buffer.alloc(LIMITS.bytes + 1, 32))
  await assert.rejects(inspectFile(root, 'big.xml'), /FILE_LIMIT/u)
  await writeFile(join(root, 'Configuration.mdo'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(metadata, 'utf16le')]))
  assert.equal((await inspectFile(root, 'Configuration.mdo')).objects[0].name, 'Товары')
  await writeFile(join(root, 'EDT.mdo'), '<md:Catalog xmlns:md="urn:md"><name>ТоварыEDT</name></md:Catalog>')
  assert.deepEqual((await inspectFile(root, 'EDT.mdo')).objects, [{ type: 'Catalog', name: 'ТоварыEDT' }])
})
function context(root, overrides = {}) {
  return { connection: { requestRejection: () => undefined }, sessions: { get: () => undefined }, sessionPersistence: { stat: async id => ({ header: { id, cwd: root, agentPreset: '1c-airules' } }), open: async id => ({ header: { id, cwd: root, agentPreset: '1c-airules' }, read: async () => ({ events: [] }), close: async () => {} }) }, sessionProjections: { restore: () => ({ checkpoint: { sandboxMode: { val: null } } }) }, sandboxPolicy: { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }, ...overrides }
}
test('native cold-session root and sandbox read permission are required', async t => {
  const root = await workspace(t)
  assert.equal(await sessionRoot(context(root), 'cold'), root)
  await assert.rejects(sessionRoot(context(root, { sandboxPolicy: undefined }), 'cold'), /WORKSPACE_READ_REQUIRED/u)
  await assert.rejects(sessionRoot(context(root, { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(root, 'other') }) } }), 'cold'))
  await assert.rejects(sessionRoot(context(root, { sessionPersistence: { stat: async () => ({ header: { id: 'other', cwd: root, agentPreset: '1c-airules' } }) } }), 'cold'))
})
async function request(ctx, method, url) { let status, body; await handlerFor(ctx)({ method, url }, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } }); return { status, body } }
test('HTTP read API fails closed without native auth and never accepts writes or caller root', async t => {
  const root = await workspace(t)
  assert.equal((await request(context(root, { connection: undefined }), 'GET', '/?sessionId=x')).status, 403)
  assert.equal((await request(context(root, { connection: { requestRejection: () => 'denied' } }), 'GET', '/?sessionId=x')).status, 403)
  assert.equal((await request(context(root), 'POST', '/?sessionId=x')).status, 405)
  assert.equal((await request(context(root), 'GET', '/?root=C:/')).status, 400)
  const result = await request(context(root), 'GET', '/?sessionId=x&root=C:/')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.files, [])
})
test('pinned Cordis context admits declared session and policy services on a real plugin route', async t => {
  const { Context } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { SessionProjectionRegistry } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js')
  const { SandboxPolicyService } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js')
  const root = await workspace(t), ctx = new Context(), services = context(root)
  delete services.sessionProjections; delete services.sandboxPolicy
  new SessionProjectionRegistry(ctx)
  new SandboxPolicyService(ctx, { mode: 'read-only', workspaceRoot: root })
  let route
  ctx.provide('jobs', {list:()=>[]})
  ctx.provide('tools', {})
  ctx.provide('dshHomePath', (...parts)=>join(root,...parts))
  for (const [key, value] of Object.entries(services)) ctx.provide(key, value)
  ctx.provide('webServer', { register(value) { if(value.path==='/airules/onec-panels')route = value; return () => {} } })
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  await fiber.await(); t.after(() => fiber.dispose())
  assert.ok(route, 'route registered through native injection')
  let code, body
  await route.handler({ method: 'GET', url: '/airules/onec-panels?sessionId=native' }, { writeHead(value) { code = value }, end(value) { body = JSON.parse(value) } })
  assert.equal(code, 200); assert.equal(body.ok, true)
})
