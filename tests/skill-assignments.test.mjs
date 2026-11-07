import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createAssignmentStore, DEFAULTS, delegatedRole, effectiveAssignments, ROLE_TASKS, ROLES, selectCatalog, taskContext, validateAssignment } from '../src/skills-integration/lib/assignments.js'
import { createCatalogService, registerCatalogRuntime, OWNER, renderCatalog } from '../src/skills-integration/lib/catalog.js'

const all = { taskTypes: [], roles: [], accessModes: [] }
const restricted = { taskTypes: ['testing'], roles: [], accessModes: [] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skill-assignments-')), home = join(root, 'home'), project = join(root, 'project')
  await mkdir(home); await mkdir(project)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, home, project, store: createAssignmentStore(home) }
}
test('reads are side-effect free; known defaults are useful while unknown skills remain unrestricted', async t => {
  const f = await fixture(t), snapshot = await f.store.snapshot(f.project)
  assert.equal(snapshot.common.revision, null); assert.equal(snapshot.project.revision, null)
  assert.deepEqual(await readdir(f.home), []); assert.deepEqual(await readdir(f.project), [])
  assert.ok(snapshot.effective['1c-tj-analysis'].taskTypes.includes('testing'))
  const entries = [{ name: '1c-config-docs' }, { name: 'new-plugin-skill' }]
  assert.deepEqual(selectCatalog(entries, { taskType: 'testing', accessMode: 'workspace-write', role: 'tester' }, snapshot.effective).map(row => row.name), ['new-plugin-skill'])
})
test('common/project overrides, explicit empty axes and reset preserve inherited defaults', async t => {
  const f = await fixture(t)
  await f.store.save(f.project, { scope: 'global', skill: '1c-config-docs', revision: null, change: 'set', assignment: restricted })
  let snapshot = await f.store.snapshot(f.project)
  assert.deepEqual(snapshot.effective['1c-config-docs'], restricted)
  await f.store.save(f.project, { scope: 'project', skill: '1c-config-docs', revision: null, change: 'set', assignment: all })
  snapshot = await f.store.snapshot(f.project)
  assert.deepEqual(snapshot.effective['1c-config-docs'], all)
  await f.store.save(f.project, { scope: 'project', skill: '1c-config-docs', revision: snapshot.project.revision, change: 'reset' })
  snapshot = await f.store.snapshot(f.project)
  assert.deepEqual(snapshot.effective['1c-config-docs'], restricted)
  await f.store.save(f.project, { scope: 'global', skill: '1c-config-docs', revision: snapshot.common.revision, change: 'reset' })
  assert.deepEqual((await f.store.snapshot(f.project)).effective['1c-config-docs'], DEFAULTS['1c-config-docs'])
  assert.equal((await readdir(join(f.home, 'skill-assignments/backups'))).length, 4)
})
test('CAS rejects stale snapshots, corruption is not overwritten and linked paths are rejected', async t => {
  const f = await fixture(t)
  await f.store.save(f.project, { scope: 'project', skill: 'skill', revision: null, change: 'set', assignment: restricted })
  await assert.rejects(f.store.save(f.project, { scope: 'project', skill: 'skill', revision: null, change: 'reset' }), /STALE_ASSIGNMENTS/u)
  const file = join(f.project, '.dsh/skill-assignments.json')
  await writeFile(file, '{bad')
  await assert.rejects(f.store.save(f.project, { scope: 'project', skill: 'skill', revision: null, change: 'set', assignment: all }), /ASSIGNMENTS_INVALID/u)
  assert.equal(await readFile(file, 'utf8'), '{bad')
  const other = join(f.root, 'other'), linkedHome = join(f.root, 'linked-home'); await mkdir(other); await mkdir(linkedHome)
  await symlink(other, join(linkedHome, 'skill-assignments'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createAssignmentStore(linkedHome).snapshot(null), /PATH_REJECTED/u)
})
test('assignment schema rejects invented permissions, malformed roles and unknown task types', () => {
  for (const value of [{ ...all, roles: ['reviewer'] }, { ...all, accessModes: ['ask'] }, { ...all, taskTypes: ['full'] }, { ...all, taskTypes: ['testing', 'testing'] }, { ...all, permission: 'full' }]) assert.throws(() => validateAssignment(value), /ASSIGNMENTS_INVALID/u)
})

test('specialized canonical skills have task/role discovery defaults without loading bodies or granting execution', () => {
  const names=['1c-repository-manage','1c-ai-merge','v8unpack-cf','1c-element'],entries=names.map(name=>({name,description:'lazy canonical method'}))
  for(const name of names){assert.doesNotThrow(()=>validateAssignment(DEFAULTS[name]));assert.deepEqual(DEFAULTS[name].accessModes,[])}
  const selected=(taskType,role)=>selectCatalog(entries,{taskType,role,accessMode:'read-only'},DEFAULTS).map(row=>row.name)
  assert.deepEqual(selected('documentation','doc-writer'),[])
  assert.deepEqual(selected('operations','developer'),['1c-repository-manage'])
  assert.deepEqual(selected('planning','planner'),['1c-ai-merge'])
  assert.deepEqual(selected('testing','tester'),['v8unpack-cf','1c-element'])
  assert.deepEqual(selected('verification','tester'),['1c-repository-manage','1c-ai-merge','v8unpack-cf'])
  assert.ok(entries.every(entry=>!Object.hasOwn(entry,'body')))
})

test('valid skill constructor is unrestricted until explicitly assigned, without inherited Object fields', () => {
  const entries = [{ name: 'constructor', description: 'Valid custom skill' }]
  const context = { taskType: 'implementation', role: 'developer', accessMode: 'workspace-write' }
  assert.deepEqual(selectCatalog(entries, context, effectiveAssignments({}, {})), entries)
  const rules = effectiveAssignments({ constructor: restricted }, {})
  assert.deepEqual(selectCatalog(entries, context, rules), [])
  assert.equal(taskContext({ role: 'constructor', accessMode: 'read-only' }).taskType, 'all')
})

test('actual assignment editor renders a constructor-named skill without treating prototype fields as assignments', async () => {
  let factory
  const fakeReact = {
    createElement(type, props, ...children) { return { type: typeof type === 'function' ? type.name : type, props, children } },
    useState(value) { return [value, () => {}] }, useEffect() {}, Fragment: 'fragment',
  }
  const source = (await readFile(new URL('../src/skills-integration/lib/client.js', import.meta.url), 'utf8'))
    .replace('  function Skills() {', '  globalThis.testPanel = AssignmentPanel;\n  function Skills() {')
  const context = { window: { __ModuleLoader__: { load(record) { factory = record.factory } } } }
  runInNewContext(source, context)
  factory(name => { assert.equal(name, 'react'); return fakeReact })
  const data = { rows: [{ name: 'constructor' }], projectRoot: 'project', writable: true, globalWritable: true, assignments: {
    common: { overrides: {}, revision: null }, project: { overrides: {}, revision: null }, defaults: {}, effective: {}, context: null,
    definitions: { taskTypes: { testing: 'Тестирование' }, roles: ['tester'], accessModes: { 'workspace-write': 'Запись' } },
  } }
  const tree = context.testPanel({ data, busy: false, onAction() {} })
  assert.ok(JSON.stringify(tree).includes('Без ограничений'))
  assert.ok(JSON.stringify(tree).includes('constructor'))
})
test('role/task/access filters are independent and do not mutate the full registry input', () => {
  const entries = [{ name: 'selected' }, { name: 'other' }]
  const rules = { selected: { taskTypes: ['testing'], roles: ['tester'], accessModes: ['read-only'] } }
  assert.equal(selectCatalog(entries, { taskType: 'testing', role: 'tester', accessMode: 'read-only' }, rules).length, 2)
  assert.deepEqual(selectCatalog(entries, { taskType: 'implementation', role: 'developer', accessMode: 'workspace-write' }, rules), [{ name: 'other' }])
  assert.equal(selectCatalog(entries, { taskType: 'all', role: null, accessMode: 'read-only' }, rules).length, 2)
  assert.equal(entries.length, 2)
})
test('all 13 explicit roles map deterministically; native plan affects auto only; no request classifier exists', () => {
  assert.equal(ROLES.length, 13)
  for (const role of ROLES) assert.equal(taskContext({ role, accessMode: 'workspace-write' }).taskType, ROLE_TASKS[role])
  assert.equal(taskContext({ accessMode: 'workspace-write' }).taskType, 'all')
  assert.equal(taskContext({ role: 'tester', plan: true, accessMode: 'read-only' }).taskType, 'planning')
  assert.equal(taskContext({ selected: 'documentation', plan: true, accessMode: 'read-only' }).taskType, 'documentation')
  assert.equal(taskContext({ selected: 'all', plan: true, accessMode: 'read-only' }).taskType, 'all')
  assert.equal(ROLE_TASKS['arch-reviewer'], 'architecture'); assert.notEqual(ROLE_TASKS['code-reviewer'], ROLE_TASKS.tester)
})
test('role identity is only the first own native managed descriptor, never inherited/prompt/later metadata', () => {
  const event = label => ({ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label } })
  const events = [event('airules-role:developer'), { type: 'user/message', data: { text: 'airules-role:tester' } }, event('airules-role:doc-writer'), event('airules-role:tester')]
  const session = { header: { parentSession: 'parent' }, inheritedEventCount: 2, seq: events.length, eventAt: index => events[index] }
  assert.equal(delegatedRole(session), 'doc-writer')
  assert.equal(delegatedRole({ ...session, inheritedEventCount: 4 }), null)
  assert.equal(delegatedRole({ ...session, header: {} }), null)
})
test('task selection persists independently per child session and uses CAS', async t => {
  const f = await fixture(t)
  await f.store.setContext('parent', { taskType: 'documentation', revision: null })
  assert.equal((await f.store.context('parent')).selected, 'documentation')
  assert.equal((await f.store.context('child')).selected, 'auto')
  await assert.rejects(f.store.setContext('parent', { taskType: 'testing', revision: null }), /STALE_ASSIGNMENTS/u)
})
function mockRuntime(f, { complete = true, preset = '1c-airules' } = {}) {
  const events = [], nodes = [], session = { id: 's', header: { id: 's', cwd: f.project }, seq: 0, surface: { nodes }, eventAt: index => events[index] }
  const agent = { session, ctx: { get: () => undefined } }, skills = [{ name: 'a', description: 'A', invocation: { modelInvocable: true } }, { name: 'b', description: 'B', invocation: { modelInvocable: true } }, { name: 'disabled', description: 'disabled', invocation: { modelInvocable: false } }]
  let listener, scanComplete = complete
  const registry = { snapshot: async () => ({ complete: scanComplete, skills }), get: async name => skills.find(row => row.name === name) }
  const ctx = { get(key) { return { agentPresets: { composedPreset: () => preset, serviceFor: (_agent, name) => name === 'skills' ? registry : undefined }, skills: registry, tools: { get: () => ({}) }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }[key] }, on(event, handler) { listener = handler } }
  const service = createCatalogService(ctx, f.store)
  let id = 0
  registerCatalogRuntime(ctx, service, input => ({ id: `message-${++id}`, ...input }))
  const step = (messages = []) => listener({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages, messageIntents: new Map(messages.map(message => [message.id, {}])) }))
  const publish = message => { events.push({ type: 'user/message', data: message, seq: session.seq }); nodes.push(session.seq++); }
  return { agent, registry, service, step, publish, setComplete(value) { scanComplete = value } }
}
test('runtime rebuilds full snapshot on changed task and after service restart; unchanged accepted catalog is suppressed', async t => {
  const f = await fixture(t)
  await f.store.save(f.project, { scope: 'project', skill: 'a', revision: null, change: 'set', assignment: restricted })
  await f.store.setContext('s', { taskType: 'implementation', revision: null })
  const runtime = mockRuntime(f)
  let decision = await runtime.step([{ id: 'native', source: { kind: 'skill-catalog', entries: [{ name: 'a', description: 'A' }] } }])
  assert.deepEqual(decision.messages[0].source.entries.map(row => row.name), ['b']); runtime.publish(decision.messages[0])
  decision = await runtime.step([{ id: 'native', source: { kind: 'skill-catalog', entries: [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }] } }])
  assert.equal(decision.messages.length, 0); assert.equal(decision.messageIntents.size, 0)
  const context = await f.store.context('s'); await f.store.setContext('s', { taskType: 'testing', revision: context.revision })
  decision = await runtime.step()
  assert.deepEqual(decision.messages[0].source.entries.map(row => row.name), ['a', 'b'])
  assert.equal(decision.messages[0].source.owner, OWNER)
  assert.equal((await runtime.registry.get('a')).name, 'a')
  const restarted = createAssignmentStore(f.home)
  assert.equal((await restarted.context('s')).selected, 'testing')
  assert.ok(renderCatalog([]).includes('Явный вызов доступного навыка'))
})

test('native plan reads the selected preset isolated service, including a queued selection', async t => {
  const f = await fixture(t), session = { id: 'plan', header: {} }, agent = { session, ctx: { get: () => undefined } }
  const plan = { active: false, pending: true }
  const ctx = { get(key) { return { agentPresets: { serviceFor: (_agent, name) => name === 'planMode' ? { get: () => plan } : undefined }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }[key] } }
  const service = createCatalogService(ctx, f.store)
  assert.equal((await service.context(session, agent)).taskType, 'planning')
  assert.equal((await service.context(session, agent)).nativePlan, true)
  await f.store.setContext('plan', { taskType: 'documentation', revision: null })
  assert.equal((await service.context(session, agent)).taskType, 'documentation')
  plan.pending = false; plan.active = true
  assert.equal((await service.context(session, agent)).nativePlan, false)
})
test('incomplete scan preserves existing history and all noncatalog messages without publishing a partial/broad pending list', async t => {
  const f = await fixture(t), runtime = mockRuntime(f, { complete: false })
  const native = { id: 'native', source: { kind: 'skill-catalog', entries: [{ name: 'a', description: 'A' }] } }, other = { id: 'other', source: { kind: 'user' } }
  const decision = await runtime.step([native, other])
  assert.deepEqual(decision.messages, [other]); assert.deepEqual([...decision.messageIntents.keys()], ['other'])
  assert.equal(runtime.service.status('s').deferred, true)
})
test('other presets are untouched; unreadable assignments fall back to native decision and surface a settings error', async t => {
  const f = await fixture(t), ordinary = mockRuntime(f, { preset: 'standard' }), native = { id: 'native', source: { kind: 'skill-catalog', entries: [] } }
  assert.deepEqual((await ordinary.step([native])).messages, [native])
  await mkdir(join(f.project, '.dsh')); await writeFile(join(f.project, '.dsh/skill-assignments.json'), '{bad')
  const runtime = mockRuntime(f)
  assert.deepEqual((await runtime.step([native])).messages, [native]); assert.equal(runtime.service.status('s').settingsError, true)
  assert.equal((await runtime.service.settings({ id: 's', root: f.project, session: runtime.agent.session }, runtime.agent)).settingsError, true)
})
