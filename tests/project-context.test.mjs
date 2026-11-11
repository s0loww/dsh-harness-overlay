import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createServer, IncomingMessage } from 'node:http'
import { Context, Service } from '../var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SandboxPolicyService } from '../var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js'
import { createProjectContext, projectRows, selectionStore } from '../src/project-context/lib/core.js'
import { handlerFor, apply, inject } from '../src/project-context/lib/index.js'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'project-context-')), root = join(base, 'one'), other = join(base, 'two'); await mkdir(root); await mkdir(other)
  t.after(async () => { const child = relative(resolve(tmpdir()), base); assert.ok(!isAbsolute(child) && child.startsWith('project-context-')); await rm(base, { recursive: true, force: true }) })
  const sessions = new Map(), agents = new Map(), rows = [{ id: 'p1', title: 'One', path: root, sessionIds: ['ro', 'full'] }, { id: 'p2', title: 'Two', path: other, sessionIds: ['other'] }]
  const native = new Context(); t.after(() => native.fiber.dispose())
  native.provide('sessionProjections', { register: async () => ({ stateOf: session => session.mode }) })
  const mounted = native.plugin({ inject: ['sessionProjections'], async apply(scope) { const policy = new SandboxPolicyService(scope, { mode: 'read-only', workspaceRoot: root }); await policy[Service.init]() } }); await mounted.await(); assert.equal(mounted.state, 2)
  const add = (id, cwd, mode, preset = '1c-airules', origin) => { const session = { id, header: { id, cwd, agentPreset: preset, ...(origin ? { origin } : {}) }, mode }; const agent = { session, ctx: { preset } }; sessions.set(id, session); agents.set(id, agent); return agent }
  add('ro', root, 'read-only'); add('full', root, 'danger-full-access'); add('other', other, 'workspace-write')
  let creates = 0
  const ctx = { workspaceRegistry: { list: () => rows }, agents: { get: id => agents.get(id), create() { creates++; throw Error('must not create') }, resume() { creates++; throw Error('must not resume') } }, sessions: { get: id => sessions.get(id) }, agentPresets: { composedPreset: scope => scope.preset }, sandboxPolicy: native.sandboxPolicy, sessionProjections: { stateOf: (session, key) => key === 'agentPreset' ? session.header.agentPreset : undefined, restore: () => ({ checkpoint: { sandboxMode: { val: null }, agentPreset: { val: '1c-airules' } } }) }, sessionPersistence: { stat: async id => ({ header: { id }, eventCount: 2, sizeBytes: 100 }), open: async id => ({ header: { id, cwd: root, agentPreset: '1c-airules' }, read: async () => ({ events: [] }), close: async () => {} }) }, connection: { requestRejection: request => request.headers.cookie === 'native-fixture' && request instanceof IncomingMessage ? undefined : 'admission' } }
  const store = selectionStore(join(base, 'prefs', 'selection.json')), service = createProjectContext(ctx, { store })
  return { base, root, other, rows, ctx, store, service, sessions, agents, add, get creates() { return creates } }
}

test('native registered roots own project identity; aliases deduplicate without arbitrary filesystem roots', async t => {
  const f = await fixture(t); f.rows.push({ id: 'alias', title: 'Duplicate', path: join(f.root, '.'), sessionIds: ['extra'] }, { id: 'relative', title: 'Bad', path: 'relative', sessionIds: [] })
  const rows = projectRows(f.ctx.workspaceRegistry); assert.equal(rows.length, 2); assert.deepEqual(rows[0].workspaceIds, ['p1', 'alias']); assert.ok(rows[0].sessionIds.includes('extra'))
  assert.equal((await f.service.resolve('alias')).projectId, 'p1')
  await assert.rejects(f.service.resolve(f.root), /PROJECT_NOT_FOUND/)
})

test('global project choice is CAS guarded and persists independently of any session', async t => {
  const f = await fixture(t), before = await f.service.selection({ activeSessionId: 'other' }); assert.equal(before.projectId, 'p2')
  await f.service.select('p1', before.selectionRevision)
  assert.equal((await f.service.selection({ activeSessionId: 'other' })).projectId, 'p1')
  await assert.rejects(f.service.select('p2', before.selectionRevision), /PROJECT_SELECTION_STALE/)
  assert.equal((await createProjectContext(f.ctx, { store: f.store }).selection()).projectId, 'p1')
  assert.equal(f.creates, 0)
})

test('executor selection never falls through read-only authority to a more privileged chat', async t => {
  const f = await fixture(t)
  assert.equal((await f.service.resolve('p1')).sessionId, 'ro')
  await assert.rejects(f.service.resolve('p1', { writing: true }), /PROJECT_WRITE_REQUIRED/)
  await assert.rejects(f.service.resolve('p1', { full: true }), /PROJECT_FULL_ACCESS_REQUIRED/)
  assert.equal((await f.service.resolve('p1', { activeSessionId: 'full' })).sessionId, 'full')
  await assert.rejects(f.service.resolveInput({ projectId: 'p1', sessionId: 'ro' }, { full: true }), /PROJECT_FULL_ACCESS_REQUIRED/)
  assert.equal((await f.service.resolveInput({ projectId: 'p1', sessionId: 'full' }, { full: true })).root, f.root)
})

test('project/session mismatch, moved roots, subagents and unsupported presets fail before delegation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.resolveInput({ projectId: 'p1', sessionId: 'other' }), /PROJECT_EXECUTOR_MISMATCH/)
  f.sessions.get('ro').header.cwd = f.other
  await assert.rejects(f.service.resolveInput({ projectId: 'p1', sessionId: 'ro' }), /PROJECT_SCOPE_CHANGED/)
  f.sessions.get('ro').header.cwd = f.root; f.sessions.get('ro').header.origin = 'subagent'
  await assert.rejects(f.service.resolveInput({ projectId: 'p1', sessionId: 'ro' }), /PROJECT_EXECUTOR_UNAVAILABLE/)
  delete f.sessions.get('ro').header.origin
  await assert.rejects(f.service.resolveInput({ projectId: 'p1', sessionId: 'ro' }, { presets: ['python-airules'] }), /PROJECT_PRESET_UNSUPPORTED/)
})

test('bounded cold authority supports pure settings reads without create/resume/model work', async t => {
  const f = await fixture(t); f.agents.clear(); f.sessions.clear()
  const scope = await f.service.resolve('p1'); assert.equal(scope.active, false); assert.equal(scope.writable, false); assert.equal(scope.policy.sessionId, 'ro')
  await assert.rejects(f.service.resolve('p1', { active: true }), /PROJECT_EXECUTOR_UNAVAILABLE/)
  assert.equal(f.creates, 0)
  const input = { projectId: 'p1', action: 'read' }; assert.deepEqual(await f.service.bindInput(input), { sessionId: 'ro', action: 'read' }); assert.deepEqual(input, { projectId: 'p1', action: 'read' })
})

async function server(t, handler) { const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); return 'http://127.0.0.1:' + server.address().port }
test('real HTTP wrapper preserves native request prototype/admission and delegates project-bound GET/POST to existing handlers', async t => {
  const f = await fixture(t); let calls = 0
  const url = await server(t, f.service.bindHandler(async (request, response) => {
    calls++; assert.ok(request instanceof IncomingMessage); assert.equal(f.ctx.connection.requestRejection(request), undefined)
    const value = request.method === 'GET' ? Object.fromEntries(new URL(request.url, 'http://localhost').searchParams) : JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    assert.equal(Object.hasOwn(value, 'projectId'), false)
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
  }))
  assert.equal((await fetch(url + '/?projectId=p1')).status, 403); assert.equal(calls, 0)
  const get = await fetch(url + '/?projectId=p1&kind=status', { headers: { cookie: 'native-fixture' } }); assert.deepEqual(await get.json(), { sessionId: 'ro', kind: 'status' })
  const post = await fetch(url, { method: 'POST', headers: { cookie: 'native-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p1', sessionId: 'full', action: 'save' }) }); assert.deepEqual(await post.json(), { sessionId: 'full', action: 'save' })
  const legacy = await fetch(url, { method: 'POST', headers: { cookie: 'native-fixture', 'content-type': 'application/json' }, body: '{ "sessionId":"other", "unchanged":true }' }); assert.deepEqual(await legacy.json(), { sessionId: 'other', unchanged: true })
  const mismatch = await fetch(url + '/?projectId=p1&sessionId=other', { headers: { cookie: 'native-fixture' } }); assert.equal(mismatch.status, 400); assert.equal((await mismatch.json()).error, 'PROJECT_EXECUTOR_MISMATCH'); assert.equal(calls, 3)
})

test('project selector endpoint has native admission, CSRF and CAS without requiring a chat', async t => {
  const f = await fixture(t), url = await server(t, handlerFor(f.ctx, f.service))
  assert.equal((await fetch(url)).status, 403)
  const initial = await (await fetch(url, { headers: { cookie: 'native-fixture' } })).json()
  const request = (token, revision) => fetch(url, { method: 'POST', headers: { cookie: 'native-fixture', 'content-type': 'application/json', ...(token ? { 'x-airules-csrf': token } : {}) }, body: JSON.stringify({ action: 'select', projectId: 'p2', expectedRevision: revision }) })
  assert.equal((await request(null, initial.selectionRevision)).status, 403)
  assert.equal((await request(initial.csrfToken, initial.selectionRevision)).status, 200)
  assert.equal((await request(initial.csrfToken, initial.selectionRevision)).status, 409)
})

test('readonly executor is pinned through project requests and the private lease detects awaited policy/root changes', async t => {
  const f = await fixture(t); let effects = 0
  const readOnly = await f.service.resolve('p1', { sessionId: 'ro' })
  const revision = (await f.service.selection({ projectId: 'p1', activeSessionId: 'ro' })).execution.revision
  const url = await server(t, f.service.bindHandler(async (request, response) => {
    const value = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    try {
      const scope = await f.service.resolveInput(value)
      if (value.action === 'mutate-during-await') f.sessions.get('ro').mode = 'danger-full-access'
      await request[Symbol.for('airules.project-request')].assertScope(scope)
      if (!scope.writable) throw Error('PROJECT_WRITE_REQUIRED')
      effects++; response.writeHead(200); response.end('{}')
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })) }
  }))
  const send = value => fetch(url, { method: 'POST', headers: { cookie: 'native-fixture', 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const input = { projectId: 'p1', sessionId: readOnly.id, expectedProjectRoot: f.root, expectedExecutorRevision: revision, action: 'save' }
  assert.equal((await (await send(input)).json()).error, 'PROJECT_WRITE_REQUIRED'); assert.equal(effects, 0)
  const unpinned = { ...input }; delete unpinned.sessionId
  assert.equal((await (await send(unpinned)).json()).error, 'PROJECT_EXECUTOR_PIN_REQUIRED')
  assert.equal((await (await send({ ...input, action: 'mutate-during-await' })).json()).error, 'PROJECT_SCOPE_CHANGED'); assert.equal(effects, 0)
  assert.equal((await (await send(input)).json()).error, 'PROJECT_EXECUTOR_STALE'); assert.equal(effects, 0)
})

test('explicit global-action allowance and unresolved configuration keep preferences available without granting project authority', async t => {
  const f = await fixture(t); f.rows.push({ id: 'empty', path: join(f.base, 'empty'), title: 'No chat', sessionIds: [] }); const seen = []
  const url = await server(t, f.service.bindHandler(async (request, response) => { const value = request.method === 'GET' ? Object.fromEntries(new URL(request.url, 'http://localhost').searchParams) : JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8')); seen.push(value); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }, { allowUnresolvedConfiguration: true, allowGlobalActions: ['processingSave'] }))
  const initial = await fetch(url + '/?projectId=empty&action=configuration', { headers: { cookie: 'native-fixture' } }); assert.equal(initial.status, 200); assert.deepEqual(await initial.json(), { sessionId: '', action: 'configuration' })
  const read = await fetch(url + '/?projectId=empty&action=documents', { headers: { cookie: 'native-fixture' } }); assert.equal(read.status, 400); assert.equal((await read.json()).error, 'PROJECT_EXECUTOR_UNAVAILABLE')
  const save = await fetch(url, { method: 'POST', headers: { cookie: 'native-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'processingSave', projectId: 'empty', profile: { synthetic: true } }) }); assert.equal(save.status, 200); assert.deepEqual(await save.json(), { action: 'processingSave', profile: { synthetic: true } })
  const fake = await fetch(url + '/?projectId=foreign&action=configuration', { headers: { cookie: 'native-fixture' } }); assert.equal(fake.status, 400); assert.equal((await fake.json()).error, 'PROJECT_NOT_FOUND'); assert.equal(seen.length, 2)
})

test('actual SDK022 Cordis host mount provides the shared service and native HTTP registration', async t => {
  const f = await fixture(t), native = new Context(); t.after(() => native.fiber.dispose()); let registration
  for (const key of inject) native.provide(key, key === 'dshHomePath' ? value => join(f.base, value) : key === 'webServer' ? { register(value) { registration = value; return () => {} } } : f.ctx[key])
  const mounted = native.plugin({ inject, apply }); await mounted.await(); assert.equal(mounted.state, 2); assert.equal(typeof native.airulesProjects.bindHandler, 'function'); assert.equal(registration.path, '/airules/projects')
})

test('bounded fallback does not discard an explicit or active read-only executor after many archived chats', async t => {
  const f=await fixture(t);f.rows[0].sessionIds=['full',...Array.from({length:130},(_,i)=>'archived-'+i),'ro'];
  assert.equal((await f.service.selection({projectId:'p1',activeSessionId:'ro'})).execution.sessionId,'ro');
  await assert.rejects(f.service.resolve('p1',{activeSessionId:'ro',writing:true}),/PROJECT_WRITE_REQUIRED/);
  assert.equal((await f.service.resolveInput({projectId:'p1',sessionId:'ro'})).sessionId,'ro');
})
