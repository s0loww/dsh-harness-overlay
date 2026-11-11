import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { Context } from '../var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

test('actual Cordis client mount shares project choice and preserves project identity when its active chat changes', async t => {
  let plugin, cursor = 0, effects = [], state = new Map(), calls = []
  const snapshot = { byId: { ro: { id: 'ro', retainedBy: { mainView: 1 } }, full: { id: 'full', retainedBy: {} } } }
  const workspaces = { items: [{ workspaceId: 'p1', path: 'C:/fixture/one', sessionIds: ['ro', 'full'] }, { workspaceId: 'p2', path: 'C:/fixture/two', sessionIds: ['other'] }] }
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useSyncExternalStore: (_subscribe, get) => get(), useState(initial) { const index = cursor++; if (!state.has(index)) state.set(index, initial); return [state.get(index), value => state.set(index, typeof value === 'function' ? value(state.get(index)) : value)] }, useRef(initial) { const index = cursor++; if (!state.has(index)) state.set(index, { current: initial }); return state.get(index) }, useCallback: callback => callback, useEffect: callback => { effects.push(callback) } }
  let selection = null, revision = 'r0'
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (!url.startsWith('/airules/projects')) return { ok: true, json: async () => ({ ok: true }) }
    const parsed = new URL(url, 'http://localhost')
    if (options?.method === 'POST') { const input = JSON.parse(options.body); assert.equal(input.expectedRevision, revision); selection = input.projectId; revision = 'r1' }
    const projectId = parsed.searchParams.get('projectId') ?? selection ?? 'p1'
    return { ok: true, json: async () => ({ ok: true, csrfToken: 'fixture-csrf', projectId, projectRoot: projectId === 'p1' ? 'C:/fixture/one' : 'C:/fixture/two', title: projectId, explicitProjectId: selection, selectionRevision: revision, projects: workspaces.items.map(row => ({ projectId: row.workspaceId, projectRoot: row.path, title: row.workspaceId })), execution: { sessionId: parsed.searchParams.get('activeSessionId') ?? 'ro', active: true, writable: true, globalWritable: false, preset: '1c-airules' }, executorError: null }) }
  }
  const bytes = await readFile('src/project-context/lib/client.js', 'utf8')
  runInNewContext(bytes, { window: { __ModuleLoader__: { load({ factory }) { plugin = factory(name => { assert.equal(name, 'react'); return React }) } } }, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  ctx.provide('sessions', { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } }); ctx.provide('workspaces', { list: { subscribe: () => () => {}, getSnapshot: () => workspaces } })
  const mounted = ctx.plugin(plugin); await mounted.await(); assert.equal(mounted.state, 2)
  const render = () => { cursor = 0; effects = []; return plugin.useProject({ presets: ['1c-airules'] }) }
  render(); for (const effect of effects) effect(); await new Promise(resolve => setImmediate(resolve))
  let project = render(); assert.equal(project.projectId, 'p1'); assert.equal(project.sessionId, 'ro')
  snapshot.byId.ro.retainedBy.mainView = 0; snapshot.byId.full.retainedBy.mainView = 1
  render(); for (const effect of effects) effect(); await new Promise(resolve => setImmediate(resolve))
  project = render(); assert.equal(project.projectId, 'p1'); assert.equal(project.sessionId, 'full')
  assert.throws(() => plugin.projectFetch('/airules/documents?sessionId=p1&kind=show'), /PROJECT_EXECUTOR_PIN_REQUIRED/)
  const pendingCalls=calls.length
  assert.throws(()=>plugin.fetchFor({...project,loading:true})('/airules/documents',{method:'POST',body:JSON.stringify({sessionId:'p1',action:'index'})}),/PROJECT_EXECUTOR_PIN_REQUIRED/)
  assert.equal(calls.length,pendingCalls)
  const boundFetch = plugin.fetchFor(project)
  await boundFetch('/airules/documents?sessionId=p1&kind=show')
  const query = Object.fromEntries(new URL(calls.at(-1).url, 'http://localhost').searchParams)
  assert.deepEqual(query, { kind: 'show', projectId: 'p1', expectedProjectRoot: 'C:/fixture/one', sessionId: 'full' })
  await boundFetch('/airules/documents', { method: 'POST', body: JSON.stringify({ sessionId: 'p1', action: 'read', path: 'docs/a.txt' }) })
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { projectId: 'p1', sessionId: 'full', expectedProjectRoot: 'C:/fixture/one', action: 'read', path: 'docs/a.txt' })
  await plugin.projectFetch('/airules/documents?sessionId=ro'); assert.equal(calls.at(-1).url, '/airules/documents?sessionId=ro')
  await plugin.projectFetch('https://example.invalid/?sessionId=p1'); assert.equal(calls.at(-1).url, 'https://example.invalid/?sessionId=p1')
  const before = calls.length, tree = plugin.ProjectPicker({ project, beforeChange: () => false })
  const select = tree.children.find(row => row?.type === 'label').children.find(row => row?.type === 'select')
  await select.props.onChange({ target: { value: 'p2' } }); assert.equal(calls.length, before)
  await project.selectProject('p2'); assert.equal(JSON.parse(calls.at(-1).options.body).projectId, 'p2')
  project = render(); for (const effect of effects) effect(); await new Promise(resolve => setImmediate(resolve)); project = render(); assert.equal(project.projectId, 'p2')
})
