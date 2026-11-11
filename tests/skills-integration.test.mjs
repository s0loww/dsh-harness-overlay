import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createSkill, draftSkill, parseSkill, safePath, scanFiles, skillRoots, toggleFile } from '../src/skills-integration/lib/core.js'
import { createAssignmentStore } from '../src/skills-integration/lib/assignments.js'
import { createCatalogService } from '../src/skills-integration/lib/catalog.js'
import { parse } from '../var/asar-extract-rc5/dsh/node_modules/yaml/dist/index.js'
const native = resolve('var/asar-extract-rc5/dsh/node_modules')
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'skills-')), home = join(base, 'home'), agentsHome = join(base, 'agents'), projectRoot = join(base, 'project'), backupRoot = join(base, 'backups')
  for (const path of [home, agentsHome, projectRoot]) mkdirSync(path)
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return { base, home, agentsHome, projectRoot, backupRoot, roots: skillRoots({ home, agentsHome, projectRoot }) }
}
async function runtime(t) {
  const f = fixture(t), pkg = join(f.base, 'package')
  cpSync(resolve('src/skills-integration'), pkg, { recursive: true })
  mkdirSync(join(pkg, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const [name, target] of [['@deepseek-ai/dsh-home-paths', join(native, '@deepseek-ai/dsh-home-paths')], ['@deepseek-ai/dsh-llm', join(native, '@deepseek-ai/dsh-llm')], ['yaml', join(native, 'yaml')]]) symlinkSync(target, join(pkg, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  return { ...f, module: await import(pathToFileURL(join(pkg, 'lib/index.js'))) }
}
test('native roots match DSH discovery; listing creates no files; malformed and oversized files are excluded', async t => {
  const f = fixture(t)
  assert.deepEqual((await scanFiles(f.roots, parse)).rows, [])
  assert.deepEqual(readdirSync(f.projectRoot), [])
  const root = f.roots.find(root => root.source === 'project-dsh')
  await createSkill(root, { name: 'hello', description: 'Когда нужен тест', content: '# Инструкция' }, parse)
  writeFileSync(join(root.root, 'bad.md'), 'no frontmatter')
  writeFileSync(join(root.root, 'large.md'), 'x'.repeat(600 * 1024))
  const { rows } = await scanFiles(f.roots, parse)
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'hello'); assert.equal(rows[0].scope, 'project')
  assert.throws(() => draftSkill({ name: '../bad', description: 'x', content: 'x' }), /SKILL_INVALID/)
  assert.throws(() => parseSkill('---\nname: good\n---\nx', parse), /SKILL_INVALID/)
})
test('disable keeps original bytes and native non-invocable winner; enable restores exact bytes and resources', async t => {
  const f = fixture(t), root = f.roots[0]
  const made = await createSkill(root, { name: 'my-skill', description: 'test', content: 'Do work\n\nReference scripts/run.ps1' }, parse)
  const before = readFileSync(made.file, 'utf8')
  mkdirSync(join(root.root, 'my-skill', 'scripts')); writeFileSync(join(root.root, 'my-skill', 'scripts', 'run.ps1'), 'Write-Output stub')
  let row = (await scanFiles(f.roots, parse)).rows[0]
  await toggleFile(row, false, row.revision, f.backupRoot)
  const disabled = parseSkill(readFileSync(made.file, 'utf8'), parse)
  assert.equal(disabled.modelInvocable, false); assert.equal(disabled.userInvocable, false)
  assert.equal(readFileSync(`${made.file}.disabled`, 'utf8'), before)
  const rows = (await scanFiles(f.roots, parse)).rows
  assert.equal(rows.length, 1); row = rows[0]; assert.equal(row.enabled, false)
  await toggleFile(row, true, row.revision, f.backupRoot)
  assert.equal(readFileSync(made.file, 'utf8'), before); assert.equal(existsSync(`${made.file}.disabled`), false)
  assert.equal(readFileSync(join(root.root, 'my-skill', 'scripts', 'run.ps1'), 'utf8'), 'Write-Output stub')
  assert.equal(readdirSync(f.backupRoot).length, 2)
})
test('stale edits, origin changes, conflicting disabled destination and symlinks refuse mutation', async t => {
  const f = fixture(t), root = f.roots[0]
  const made = await createSkill(root, { name: 'skill', description: 'x', content: 'x' }, parse)
  let row = (await scanFiles(f.roots, parse)).rows[0]
  await assert.rejects(toggleFile(row, false, 'wrong', f.backupRoot), /STALE_SKILL/)
  writeFileSync(`${made.file}.disabled`, 'unrelated')
  await assert.rejects(toggleFile(row, false, row.revision, f.backupRoot), { code: 'EEXIST' })
  assert.equal(readFileSync(made.file, 'utf8'), row.raw)
  rmSync(`${made.file}.disabled`)
  await toggleFile(row, false, row.revision, f.backupRoot)
  row = (await scanFiles(f.roots, parse)).rows[0]
  writeFileSync(`${made.file}.disabled`, 'changed externally')
  await assert.rejects(toggleFile(row, true, row.revision, f.backupRoot), /STALE_SKILL/)
  const external = join(f.base, 'external'); mkdirSync(external)
  symlinkSync(external, join(f.projectRoot, '.dsh'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(scanFiles(f.roots, parse), /PATH_REJECTED/)
  await assert.rejects(safePath(root.root, join(f.base, 'outside')), /PATH_REJECTED/)
})
test('legacy disabled directory and flat markdown skills can be restored without changing contents', async t => {
  const f = fixture(t), root = f.roots[0]
  mkdirSync(root.root); const file = join(root.root, 'legacy.md.disabled'), raw = draftSkill({ name: 'legacy', description: 'legacy', content: 'untouched' })
  writeFileSync(file, raw)
  const row = (await scanFiles(f.roots, parse)).rows[0]; assert.equal(row.enabled, false)
  await toggleFile(row, true, row.revision, f.backupRoot)
  assert.equal(readFileSync(file.slice(0, -9), 'utf8'), raw)
})
test('manager lists duplicate names per scope, blocks readonly writes and returns original disabled instructions', async t => {
  const f = await runtime(t), manager = f.module.createManager(f), registry = { list: async () => [], get: async () => null }
  for (const root of [f.roots[0], f.roots[2]]) await createSkill(root, { name: 'same-name', description: root.scope, content: `actual ${root.scope} instruction` }, parse)
  const writable = { root: f.projectRoot, writable: true, globalWritable: false }
  let data = await manager.inventory(writable, registry)
  assert.equal(data.rows.length, 2)
  const global = data.rows.find(row => row.scope === 'global'), project = data.rows.find(row => row.scope === 'project')
  await assert.rejects(manager.mutate({ action: 'toggle', items: [global], enabled: false }, writable, registry), /WRITE_REQUIRED/)
  await manager.mutate({ action: 'toggle', items: [project], enabled: false }, writable, registry)
  data = await manager.inventory(writable, registry)
  const disabled = data.rows.find(row => row.scope === 'project')
  const content = await manager.content({ id: disabled.id }, writable, registry)
  assert.match(content.content, /actual project instruction/); assert.equal(content.enabled, false)
  assert.equal(data.rows.find(row => row.scope === 'global').enabled, true)
  await assert.rejects(manager.mutate({ action: 'add', scope: 'project', name: 'same-name', description: 'dup', content: 'dup' }, writable, registry), /SKILL_EXISTS/)
  await assert.rejects(manager.mutate({ action: 'toggle', items: [disabled, disabled], enabled: true }, writable, registry), /REQUEST_INVALID/)
})
test('manual native invocation policy remains authoritative and accepts the same boolean spellings as DSH', async t => {
  const f = await runtime(t), manager = f.module.createManager(f), registry = { list: async () => [] }
  const raw = '---\nname: manual-policy\ndescription: preserve policy\ndisable-model-invocation: "yes"\nuser-invocable: "off"\n---\nUser instruction\n'
  mkdirSync(f.roots[0].root, { recursive: true }); writeFileSync(join(f.roots[0].root, 'manual.md'), raw)
  const scope = { root: f.projectRoot, writable: true, globalWritable: true }, row = (await manager.inventory(scope, registry)).rows[0]
  assert.equal(row.nativePolicyDisabled, true); assert.equal(row.enabled, false); assert.equal(row.writable, false)
  await assert.rejects(manager.mutate({ action: 'toggle', items: [row], enabled: true }, scope, registry), /WRITE_REQUIRED/)
  assert.equal(readFileSync(row.path, 'utf8'), raw)
  assert.throws(() => parseSkill(raw.replace('"yes"', '"maybe"'), parse), /SKILL_INVALID/)
  assert.throws(() => parseSkill(raw.replace('disable-model-invocation', 'disableModelInvocation'), parse), /SKILL_INVALID/)
})
test('packaged disable and enable change the actual native registry and native skill tool; runtime skills remain readonly', async t => {
  const f = await runtime(t)
  const { Context } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { SkillRegistry } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js')
  const { FileSystemSkillProvider } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js')
  const toolModule = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js')
  const ctx = new Context(), registry = new SkillRegistry(ctx)
  let provider
  const bundled = join(f.base, 'bundled'), bundleRoot = { root: bundled }
  await createSkill(bundleRoot, { name: 'packaged', description: 'package', content: 'original packaged instructions' }, parse)
  registry.registerProvider(control => provider = new FileSystemSkillProvider(ctx, control, { dshHome: f.home, agentsHome: f.agentsHome, bundledSkillDir: bundled, watch: false }))
  t.after(() => provider.dispose())
  registry.register({ name: 'runtime-only', description: 'runtime', content: 'runtime instructions', source: 'runtime' })
  const manager = f.module.createManager(f), scope = { root: f.projectRoot, writable: true, globalWritable: true }
  let tool
  toolModule.apply({ skills: registry, tools: { register(value) { tool = value } }, on() {}, workingDirectory: { ensure: async () => f.projectRoot } })
  let data = await manager.inventory(scope, registry)
  assert.equal(data.rows.find(row => row.name === 'runtime-only').writable, false)
  let row = data.rows.find(row => row.name === 'packaged')
  assert.equal((await tool.execute({ name: 'packaged' }, {})).content, 'original packaged instructions')
  await manager.mutate({ action: 'toggle', items: [row], enabled: false }, scope, registry); registry.invalidateCache()
  assert.deepEqual((await registry.get('packaged', { cwd: f.projectRoot })).invocation, { modelInvocable: false, userInvocable: false })
  await assert.rejects(tool.execute({ name: 'packaged' }, {}), /not available for model invocation/)
  data = await manager.inventory(scope, registry); row = data.rows.find(row => row.name === 'packaged')
  await manager.mutate({ action: 'toggle', items: [row], enabled: true }, scope, registry); registry.invalidateCache()
  assert.equal((await tool.execute({ name: 'packaged' }, {})).content, 'original packaged instructions')
  assert.equal(readFileSync(join(bundled, 'packaged', 'SKILL.md'), 'utf8').includes('original packaged instructions'), true)
})
test('native session access supports all presets; global changes require full access', async t => {
  const f = await runtime(t)
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const ctx = { sessions: { get: () => ({ header: { id: 'session', cwd: f.projectRoot, agentPreset: 'python-airules' } }) }, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: f.projectRoot }) } }
    const scope = await f.module.sessionScope(ctx, 'session')
    assert.equal(scope.writable, mode !== 'read-only'); assert.equal(scope.globalWritable, mode === 'danger-full-access')
  }
  assert.equal((await f.module.sessionScope({}, '')).writable, false)
})
test('HTTP control requires native connection and CSRF; GET does not mutate and unsupported methods fail', async t => {
  const f = await runtime(t), manager = f.module.createManager(f), registry = { list: async () => [], invalidateCache() {} }
  const ctx = { connection: { requestRejection: () => undefined }, skills: registry }
  const handler = f.module.handlerFor(ctx, manager)
  async function request(method, body, headers = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); Object.assign(req, { method, url: '/airules/skills', headers })
    let status, text; await handler(req, { writeHead(value) { status = value }, end(value) { text = value } }); return { status, ...JSON.parse(text) }
  }
  const read = await request('GET'); assert.equal(read.status, 200); assert.equal(read.rows.length, 0); assert.equal(typeof read.csrfToken, 'string')
  assert.deepEqual(readdirSync(f.home), [])
  assert.equal((await request('POST', { action: 'add' })).status, 403)
  assert.equal((await request('DELETE')).status, 405)
  ctx.connection.requestRejection = () => 'rejected'
  assert.equal((await request('GET')).status, 403)
})
test('project task context HTTP shares state across chats and enforces native write scope, lead and CAS', async t => {
  const f = await runtime(t), manager = f.module.createManager(f), registry = { list: async () => [], invalidateCache() {} }
  const sessions = new Map(['a', 'b'].map(id => [id, { id, header: { id, cwd: f.projectRoot } }]))
  let mode = 'read-only'
  const ctx = { connection: { requestRejection: () => undefined }, skills: registry, sessions: { get: id => sessions.get(id) }, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: f.projectRoot }) } }
  const assignments = createCatalogService(ctx, createAssignmentStore(f.home)), handler = f.module.handlerFor(ctx, manager, assignments)
  async function request(method, body, token, id = 'a') {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); Object.assign(req, { method, url: '/airules/skills?sessionId=' + id, headers: { 'content-type': 'application/json', 'x-dsh-csrf': token ?? '' } })
    let status, text; await handler(req, { writeHead(value) { status = value }, end(value) { text = value } }); return { status, ...JSON.parse(text) }
  }
  const initial = await request('GET'), body = { action: 'task-context', sessionId: 'a', taskType: 'documentation', revision: null }
  assert.equal((await request('POST', body, initial.csrfToken)).error, 'WRITE_REQUIRED')
  const file = join(f.projectRoot, '.dsh/skill-context.json'); assert.equal(existsSync(file), false)
  mode = 'workspace-write'; const saved = await request('POST', body, initial.csrfToken); assert.equal(saved.status, 200); assert.equal(saved.assignments.context.source, 'project')
  const second = await request('GET', null, null, 'b'); assert.equal(second.assignments.context.taskType, 'documentation'); assert.equal(second.assignments.context.revision, saved.assignments.context.revision)
  assert.equal((await request('POST', body, initial.csrfToken)).status, 409)
  sessions.get('a').header.origin = 'subagent'
  assert.equal((await request('POST', { ...body, revision: saved.assignments.context.revision }, initial.csrfToken)).error, 'WRITE_REQUIRED'); delete sessions.get('a').header.origin
  const bytes = readFileSync(file)
  let resolves = 0; ctx.sandboxPolicy.resolve = () => ({ mode: ++resolves > 1 ? 'read-only' : 'workspace-write', workspaceRoot: f.projectRoot })
  assert.equal((await request('POST', { ...body, taskType: 'testing', revision: saved.assignments.context.revision }, initial.csrfToken)).error, 'PROJECT_SCOPE_CHANGED')
  assert.deepEqual(readFileSync(file), bytes)
})
