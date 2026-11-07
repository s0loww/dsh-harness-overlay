import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedPlatforms, registeredInfobases, projectSources, parseInfobases, proposedSettings, environmentStatus, machinePaths } from '../src/project-settings/lib/environment.js'
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'onec-environment-')), root = join(base, 'project'), home = join(base, 'home'), program = join(base, 'program'), roaming = join(base, 'roaming'), tools = join(base, 'tools')
  for (const path of [root, home, program, roaming, tools]) mkdirSync(path)
  const catalog = join(roaming, 'ibases.v8i')
  const paths = { programRoots: [program], catalogs: [{ path: catalog, label: 'Тестовый список' }], toolDirectories: [tools], localTools: [] }
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { base, root, home, program, roaming, tools, catalog, paths }
}
function put(path, content = 'not an executable') { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content) }
test('bounded platform discovery orders real version directories, refuses links and does not launch executables', async t => {
  const f = fixture(t)
  for (const version of ['8.3.9.100', '8.3.25.1000']) put(join(f.program, '1cv8', version, 'bin', '1cv8.exe'))
  put(join(f.program, '1cv8', 'common', 'bin', '1cv8.exe'))
  mkdirSync(join(f.program, '1cv8', '8.3.99.9999'))
  const outside = join(f.base, 'outside'); put(join(outside, 'bin', '1cv8.exe'))
  symlinkSync(outside, join(f.program, '1cv8', '8.3.100.100'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await installedPlatforms(f.paths)
  assert.deepEqual(result.platforms.map(item => item.version), ['8.3.25.1000', '8.3.9.100'])
  assert.equal(result.truncated, false)
  assert.equal(readFileSync(result.platforms[0].executable, 'utf8'), 'not an executable')
})
test('registered catalogs decode UTF-16 and return only allowlisted nonsecret connection fields', t => {
  const f = fixture(t)
  const source = '[Файловая база]\r\nConnect=File="D:\\Base;test";Usr="Admin";Pwd="catalog-password";Token="catalog-token";\r\nAdditionalParameters=/Plaunch-secret\r\n[Серверная]\r\nConnect=Srvr="server:1541";Ref="base";Usr="user";Pwd="server-password";\r\n[Неподдерживаемая]\r\nConnect=URL="https://invalid/";Token="hidden";\r\n'
  writeFileSync(f.catalog, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]))
  const result = registeredInfobases(f.paths)
  assert.deepEqual(result.bases.map(item => [item.name, item.kind, item.path]), [['Файловая база', 'file', 'D:\\Base;test'], ['Серверная', 'server', 'Srvr="server:1541";Ref="base";']])
  for (const secret of ['catalog-password', 'catalog-token', 'launch-secret', 'server-password', 'Admin']) assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(parseInfobases('[base]\nConnect=Srvr="bad";').length, 0)
})
test('source and tools status stay project bounded and proposals never select an arbitrary platform/base', async t => {
  const f = fixture(t)
  put(join(f.root, 'src', 'Configuration', 'Configuration.mdo'), '<md:Configuration xmlns:md="urn:md"><name>Тест</name><compatibilityMode>VERSION_8_3_25</compatibilityMode></md:Configuration>')
  put(join(f.tools, 'git.exe'))
  const outside = join(f.base, 'external'); put(join(outside, 'Configuration.xml'), '<Configuration><Name>External</Name></Configuration>')
  const source = await projectSources(f.root, outside)
  assert.equal(source.sources.length, 1); assert.equal(source.sources[0].format, 'EDT'); assert.equal(source.sources[0].name, 'Тест')
  const status = await environmentStatus(f.root, f.paths)
  assert.deepEqual(status.proposal.values, { EXPORT_PATH: 'src/Configuration', USE_EDT: 'true' })
  assert.equal(status.tools.find(item => item.id === 'git').installed, true)
  const ambiguous = proposedSettings({ ...status, platforms: { platforms: [{ path: 'p1', version: '8.3.1' }, { path: 'p2', version: '8.3.2' }] } })
  assert.equal(ambiguous.ambiguousPlatforms, true); assert.equal(ambiguous.values.PLATFORM_PATH, undefined); assert.equal(ambiguous.values.INFOBASE_NAME, undefined)
  assert.deepEqual(proposedSettings(status, { EXPORT_PATH: 'chosen', USE_EDT: 'false' }).values, {})
  assert.deepEqual(readdirSync(f.home), []); assert.deepEqual(readdirSync(f.root), ['src'])
  assert.deepEqual(machinePaths({}, 'linux').programRoots, [])
})
test('environment route uses real native cold projection, remains read-only and ignores client root', async t => {
  const f = fixture(t), pkg = join(f.base, 'package')
  cpSync(resolve('src/project-settings'), pkg, { recursive: true })
  mkdirSync(join(pkg, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(resolve('var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-home-paths'), join(pkg, 'node_modules', '@deepseek-ai', 'dsh-home-paths'), process.platform === 'win32' ? 'junction' : 'dir')
  const plugin = await import(pathToFileURL(join(pkg, 'lib/index.js')))
  const { Context } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { SessionProjectionRegistry } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js')
  const { SandboxPolicyService } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js')
  const context = new Context(), routes = new Map()
  new SessionProjectionRegistry(context); new SandboxPolicyService(context, { mode: 'read-only', workspaceRoot: f.root })
  context.provide('sessions', { get: () => undefined })
  context.provide('sessionPersistence', { stat: async id => ({ header: { id, cwd: f.root, agentPreset: '1c-airules' }, eventCount: 0 }), open: async id => ({ header: { id, cwd: f.root, agentPreset: '1c-airules' }, read: async () => ({ events: [] }), close: async () => {} }) })
  context.provide('connection', { requestRejection: () => undefined })
  context.provide('webServer', { register(route) { routes.set(route.path, route); return () => {} } })
  const fiber = context.plugin({ name: 'environment-native-contract', inject: plugin.inject, apply(ctx) { const handler = plugin.handlerFor(ctx, f.home, f.paths); for (const path of [plugin.API, plugin.ENVIRONMENT_API]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler })) } })
  await fiber.await(); t.after(() => fiber.dispose())
  assert.ok(routes.has(plugin.ENVIRONMENT_API))
  put(join(f.root, 'Configuration.xml'), '<Configuration><Name>ActualProject</Name></Configuration>')
  async function request(method, url) { let status, body; await routes.get(plugin.ENVIRONMENT_API).handler({ method, url }, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } }); return { status, body } }
  const result = await request('GET', `${plugin.ENVIRONMENT_API}?sessionId=real&root=${encodeURIComponent(f.base)}`)
  assert.equal(result.status, 200); assert.equal(result.body.sources.sources[0].name, 'ActualProject'); assert.equal(result.body.projectRoot, f.root)
  assert.equal((await request('POST', plugin.ENVIRONMENT_API)).status, 405)
  assert.deepEqual(readdirSync(f.root), ['Configuration.xml']); assert.deepEqual(readdirSync(f.home), [])
})
