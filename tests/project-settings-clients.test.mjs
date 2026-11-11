import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(flatten)]
const text = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : (node.children ?? []).map(text).join(' ')
const button = (tree, label) => flatten(tree).find(row => row.type === 'button' && (text(row) === label || row.props['aria-label'] === label))
const field = (tree, label) => { const node = flatten(tree).find(row => row.type === 'label' && row.children[0] === label); return node?.children.find(row => row && typeof row === 'object' && ['input', 'select', 'textarea'].includes(row.type)) ?? (node?.props.htmlFor ? flatten(tree).find(row => row.props.id === node.props.htmlFor) : undefined) }
const child = (tree, name) => flatten(tree).find(row => typeof row.type === 'function' && row.type.name === name)
const tick = () => new Promise(resolve => setImmediate(resolve))

async function harness(directory) {
  let module, current, project = { projectId: 'p1', projectRoot: 'C:/fixture/one', sessionId: 'sA', executorRevision: 'policy-a', writable: true, globalWritable: true, active: true, projects: [], loading: false }, snapshot = { byId: { sA: { id: 'sA', title: 'Chat A', retainedBy: { mainView: 1 } }, sB: { id: 'sB', title: 'Chat B', retainedBy: {} } } }
  const slots = new Map(), calls = [], violations = [], instances = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => value === b[index])
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const i = current.cursor++; if (!(i in current.state)) current.state[i] = typeof initial === 'function' ? initial() : initial; const owner = current; return [owner.state[i], value => { owner.state[i] = typeof value === 'function' ? value(owner.state[i]) : value }] },
    useRef(initial) { const i = current.cursor++; return current.refs[i] ??= { current: initial } },
    useCallback(fn, deps) { const i = current.cursor++; if (!same(current.memo[i]?.deps, deps)) current.memo[i] = { deps, fn }; return current.memo[i].fn },
    useMemo(fn, deps) { const i = current.cursor++; if (!same(current.memo[i]?.deps, deps)) current.memo[i] = { deps, value: fn() }; return current.memo[i].value },
    useEffect(fn, deps) { const i = current.cursor++, owner = current; if (!same(owner.memo[i]?.deps, deps)) { const previous = owner.memo[i]; owner.memo[i] = { deps }; owner.effects.push(() => { previous?.cleanup?.(); owner.memo[i].cleanup = fn() }) } },
    useSyncExternalStore(_subscribe, get) { return get() } }
  const answer = (pathname, input) => {
    const base = { ok: true, csrfToken: 'fixture-csrf', projectRoot: input.projectId === 'p2' ? 'C:/fixture/two' : 'C:/fixture/one', writable: true, globalWritable: true, revision: 'fixture-revision' }
    if (pathname === '/airules/documents') return { ...base, documents: [], totalLines: 0, lines: [] }
    if (pathname === '/airules/general-tools') return { ...base, supported: true, mode: input.mode ?? 'off' }
    if (pathname === '/airules/skills') return { ...base, rows: ['global', 'project'].map(scope => ({ id: scope + '-fixture', name: 'fixture', scope, writable: true, enabled: true, description: 'Synthetic fixture' })), directories: [], assignments: { definitions: { taskTypes: { analysis: 'Анализ' }, roles: ['lead'], accessModes: { write: 'Запись' } }, context: { selectedTaskType: 'auto', taskType: 'all', accessMode: 'write', revision: 'ctx' }, common: { revision: 'common', overrides: {} }, project: { revision: 'project', overrides: {} }, defaults: { fixture: { taskTypes: [], roles: [], accessModes: [] } } } }
    if (pathname === '/airules/project-settings/environment') return { ...base, platforms: { platforms: [] }, catalogs: { bases: [], catalogs: [] }, proposal: { fields: [], warnings: [] } }
    if (pathname === '/airules/project-settings') return { ...base, fields: [{ key: 'INFOBASE_NAME', label: 'Имя базы', group: 'База', secret: false }], values: { INFOBASE_NAME: 'Fixture' }, secrets: {}, redactedKeys: [] }
    if (pathname === '/airules/onec-specialized') return { ...base, binding: { text: '{}', version: 'fixture' }, status: { domains: [] }, workspace: { writable: true } }
    if (pathname === '/airules/agent-import') return { ...base, entries: [], skipped: [], target: 'fixture', imported: 0 }
    if (pathname === '/airules/workflows') return { ...base, workflows: [{ id: 'fixture', label: 'Fixture workflow' }], runnerBindings: [], runs: [], execution: { deployMode: 'disabled', deployEnabled: false, fixtureEnabled: true }, candidates: [], warnings: [], steps: [] }
    if (pathname === '/airules/memory') return { ...base, config: { enabled: true, endpoint: 'http://127.0.0.1:18080', localProcessing: true }, scope: { projectRoot: base.projectRoot, writable: true, globalWritable: true }, policy: { global: { schemaVersion: 1, mode: 'cognee', writeTarget: 'auto' }, project: { schemaVersion: 1, mode: 'inherit', writeTarget: 'inherit' }, effective: { mode: 'cognee', writeTarget: 'auto', source: 'global' }, policyRevision: 'memory-policy', globalRevision: 'g', projectRevision: 'p' }, processing: { profile: { allowed: true, embeddings: { provider: 'fastembed', model: 'fixture', dimensions: 384 }, extraction: { provider: 'gliner', model: 'fixture' } }, revision: 'processing', bindingAvailable: true, applied: { state: 'observed', matchesDesired: true } }, capabilities: { documents: true } }
    return base
  }
  const rawFetch = async (url, options) => { const parsed = new URL(url, 'http://localhost'), input = options?.body ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams); if (['p1', 'p2'].includes(input.sessionId)) violations.push('Raw project owner leaked as native session to ' + parsed.pathname); calls.push({ pathname: parsed.pathname, input, method: options?.method ?? 'GET' }); const value = answer(parsed.pathname, input); return { ok: true, status: 200, json: async () => value } }
  function ProjectPicker() { return null }
  const projectApi = { useProject: () => project, ProjectPicker, projectFetch(url, options, pin) {
    const parsed = new URL(url, 'http://localhost'), body = options?.body ? JSON.parse(options.body) : null, id = body?.sessionId ?? parsed.searchParams.get('sessionId')
    if (url.startsWith('/airules/') && ['p1', 'p2'].includes(id)) {
      if (!pin || pin.projectId !== id || !pin.sessionId || !pin.executorRevision) { violations.push('Missing project/executor pin: ' + parsed.pathname); throw Error('PROJECT_EXECUTOR_PIN_REQUIRED') }
      const stamp = { projectId: id, sessionId: pin.sessionId, expectedProjectRoot: pin.projectRoot, expectedExecutorRevision: pin.executorRevision }
      if (body) options = { ...options, body: JSON.stringify({ ...body, ...stamp }) }
      else { parsed.searchParams.delete('sessionId'); for (const [key, value] of Object.entries(stamp)) parsed.searchParams.set(key, value); url = parsed.pathname + parsed.search }
    }
    return rawFetch(url, options)
  }, fetchFor: pin => (url, options) => projectApi.projectFetch(url, options, pin) }
  const source = await readFile(`src/${directory}/lib/client.js`, 'utf8')
  runInNewContext(source, { window: { confirm: () => true, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, __ModuleLoader__: { load(value) { module = value.factory(name => name === 'react' ? React : name === 'airules-dsh-project-context' ? projectApi : (() => { throw Error('Unknown module ' + name) })()) } } }, fetch: rawFetch, URL, URLSearchParams, AbortController, Event, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, navigator: { clipboard: { writeText: async () => {} } }, document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } } })
  const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } }
  module.apply({ sessions, get: name => name === 'sessions' ? sessions : null, slots: { inject: (_name, fn) => fn(), register: (meta, component) => { slots.set(meta.id, component); return () => {} } }, effect: fn => fn() })
  function mount(name, props = {}) {
    const component = typeof name === 'function' ? name : module[name] ?? slots.get(name); assert.equal(typeof component, 'function', name)
    const instance = { component, props, cursor: 0, state: [], refs: [], memo: [], effects: [], render(nextProps) { if (nextProps) this.props = nextProps; current = this; this.cursor = 0; try { this.tree = this.component(this.props); return this.tree } finally { current = null } }, flush() { this.effects.splice(0).forEach(fn => fn()) }, async ready(nextProps) { if (nextProps) this.props = nextProps; for (let i = 0; i < 3; i++) { this.render(); this.flush(); await tick() } return this.render() } }; instances.push(instance); return instance
  }
  return { module, mount, calls, violations, projectApi, changeChat(rights = {}) { snapshot.byId.sA.retainedBy.mainView = 0; snapshot.byId.sB.retainedBy.mainView = 1; project = { ...project, sessionId: 'sB', executorRevision: 'policy-b', ...rights } }, setRights(rights) { project = { ...project, ...rights } }, changeProject() { project = { ...project, projectId: 'p2', projectRoot: 'C:/fixture/two', sessionId: 'sC', executorRevision: 'policy-c' } }, get project() { return project }, assertPicker(tree) { assert.ok(flatten(tree).some(row => row.type === ProjectPicker)); assert.equal(flatten(tree).filter(row => row.type === 'select').flatMap(row => flatten(row).filter(node => node.type === 'option').map(node => node.props.value)).some(value => ['sA', 'sB', 'sC'].includes(value)), false) } }
}

for (const [directory, slot, endpoint] of [
  ['document-workbench', 'airules-documents', '/airules/documents'], ['general-tools', 'airules-general-tools', '/airules/general-tools'], ['skills-integration', 'airules-skills', '/airules/skills'], ['project-settings', 'airules-onec-project', '/airules/project-settings'], ['memory-workspace', 'airules-memory', '/airules/memory'], ['onec-specialized', 'airules-onec-specialized', '/airules/onec-specialized'], ['agent-import', 'airules-agent-import', '/airules/agent-import'],
]) test(`${directory} uses a project picker and sends pinned project requests instead of exposing chat selection`, async () => {
  const ui = await harness(directory), view = ui.mount(slot), tree = await view.ready(); ui.assertPicker(tree)
  assert.ok(ui.calls.some(call => call.pathname === endpoint && call.input.projectId === 'p1' && call.input.sessionId === 'sA'))
  assert.deepEqual(ui.violations, [])
})

test('Documents keeps path/range drafts across chats of one project, clears them for another project and refreshes its executor pin', async () => {
  const ui = await harness('document-workbench'), view = ui.mount('airules-documents'); let tree = await view.ready()
  field(tree, 'Относительный путь к документу или папке').props.onChange({ target: { value: 'docs/book.xlsx' } }); tree = view.render()
  field(tree, 'Точное имя листа (пусто — видимые листы)').props.onChange({ target: { value: 'Свод' } }); tree = view.render()
  field(tree, 'Диапазон A1 (необязательно, требует имя листа)').props.onChange({ target: { value: 'A1:D20' } }); tree = view.render()
  field(tree, 'Новый путь результата (родительская папка должна существовать)').props.onChange({ target: { value: 'artifacts/new' } })
  ui.changeChat(); tree = await view.ready(); assert.equal(field(tree, 'Относительный путь к документу или папке').props.value, 'docs/book.xlsx'); assert.equal(field(tree, 'Диапазон A1 (необязательно, требует имя листа)').props.value, 'A1:D20')
  await button(tree, 'Выполнить обработку').props.onClick(); await tick()
  const sent = ui.calls.findLast(call => call.method === 'POST'); assert.equal(sent.input.projectId, 'p1'); assert.equal(sent.input.sessionId, 'sB'); assert.equal(sent.input.expectedExecutorRevision, 'policy-b'); assert.equal(sent.input.range, 'A1:D20')
  ui.changeProject(); tree = await view.ready(); assert.equal(field(tree, 'Относительный путь к документу или папке').props.value, ''); assert.equal(field(tree, 'Новый путь результата (родительская папка должна существовать)').props.value, '')
  field(tree, 'Относительный путь к документу или папке').props.onChange({ target: { value: 'other.xlsx' } }); tree = view.render(); assert.equal(field(tree, 'Точное имя листа (пусто — видимые листы)').props.value, ''); assert.equal(field(tree, 'Диапазон A1 (необязательно, требует имя листа)').props.value, '')
  assert.deepEqual(ui.violations, [])
})

test('General, Skills, Memory, Specialized and Import action callbacks use the current executor after a same-project chat switch', async () => {
  for (const [directory, slot, label] of [['general-tools', 'airules-general-tools', 'Сохранить стиль'], ['memory-workspace', 'airules-memory', 'Проверить связь'], ['onec-specialized', 'airules-onec-specialized', 'Сохранить настройки проекта'], ['agent-import', 'airules-agent-import', 'Предпросмотр импорта']]) {
    const ui = await harness(directory), view = ui.mount(slot); let tree = await view.ready()
    if (directory === 'general-tools') { field(tree, 'Режим').props.onChange({ target: { value: 'lite' } }); tree = view.render() }
    ui.changeChat(); tree = await view.ready(); assert.ok(button(tree, label), directory + ' action'); await button(tree, label).props.onClick(); await tick()
    const sent = ui.calls.findLast(call => call.method === 'POST'); assert.ok(sent, directory + ' POST'); assert.equal(sent.input.projectId, 'p1', directory); assert.equal(sent.input.sessionId, 'sB', directory); assert.deepEqual(ui.violations, [], directory)
  }
  const ui = await harness('skills-integration'), view = ui.mount('airules-skills'); let tree = await view.ready()
  button(tree, 'Добавить навык').props.onClick(); tree = view.render(); field(tree, 'Имя').props.onChange({ target: { value: 'fixture-draft' } }); tree = view.render(); field(tree, 'Когда использовать').props.onChange({ target: { value: 'Fixture only' } }); tree = view.render(); field(tree, 'Инструкции').props.onChange({ target: { value: 'Synthetic instructions' } })
  ui.changeChat(); tree = await view.ready(); assert.equal(field(tree, 'Имя').props.value, 'fixture-draft'); await flatten(tree).find(row => row.type === 'form').props.onSubmit({ preventDefault() {} }); await tick(); assert.equal(ui.calls.findLast(call => call.method === 'POST').input.sessionId, 'sB'); assert.deepEqual(ui.violations, [])
})

test('Skills clears a new-skill draft when changing project; assignment editor ownership is keyed by project', async () => {
  const ui = await harness('skills-integration'), view = ui.mount('airules-skills'); let tree = await view.ready()
  assert.equal(child(tree, 'AssignmentPanel').props.key, 'p1')
  button(tree, 'Добавить навык').props.onClick(); tree = view.render(); field(tree, 'Имя').props.onChange({ target: { value: 'must-not-leak' } }); ui.changeProject(); tree = await view.ready()
  assert.equal(flatten(tree).some(row => row.type === 'form'), false); assert.equal(child(tree, 'AssignmentPanel').props.key, 'p2')
  button(tree, 'Добавить навык').props.onClick(); tree = view.render(); assert.equal(field(tree, 'Имя').props.value, '')
})

test('Project Settings drafts survive chat changes, save with current pin, and Environment child receives project context', async () => {
  const ui = await harness('project-settings'), view = ui.mount('airules-onec-project'); let tree = await view.ready()
  field(tree, 'Имя базы').props.onChange({ target: { value: 'Shared project draft' } }); ui.changeChat(); tree = await view.ready(); assert.equal(field(tree, 'Имя базы').props.value, 'Shared project draft')
  await button(tree, 'Сохранить (1)').props.onClick(); await tick(); assert.equal(ui.calls.findLast(call => call.method === 'POST').input.sessionId, 'sB')
  const environment = ui.mount('airules-onec-environment'); tree = await environment.ready(); ui.assertPicker(tree); const node = child(tree, 'Discovery'); assert.equal(node.props.sessionId, 'p1'); assert.equal(node.props.projectContext.sessionId, 'sB')
  const discovery = ui.mount(node.type, node.props); tree = await discovery.ready(); await button(tree, 'Обнаружить среду проекта').props.onClick(); await tick(); const request = ui.calls.findLast(call => call.pathname.endsWith('/environment')); assert.equal(request.input.projectId, 'p1'); assert.equal(request.input.sessionId, 'sB'); assert.deepEqual(ui.violations, [])
})

test('Workflow project selection keys its child by project, forwards execution context and resets scenario template on project change', async () => {
  const ui = await harness('workflow-integration'), owner = ui.mount('WorkflowsSettings'); let tree = await owner.ready(); ui.assertPicker(tree)
  let panel = child(tree, 'WorkflowPanel'); assert.equal(panel.props.key, 'p1'); assert.equal(panel.props.projectContext.sessionId, 'sA')
  const runner = ui.mount(panel.type, panel.props); await runner.ready(); assert.ok(ui.calls.some(call => call.pathname === '/airules/workflows' && call.input.projectId === 'p1' && call.input.sessionId === 'sA'))
  panel.props.onTemplateChange('template:fixture'); tree = owner.render(); assert.equal(child(tree, 'WorkflowPanel').props.initialTemplate, 'template:fixture')
  ui.changeChat(); tree = await owner.ready(); panel = child(tree, 'WorkflowPanel'); assert.equal(panel.props.key, 'p1'); assert.equal(panel.props.initialTemplate, 'template:fixture'); assert.equal(panel.props.projectContext.sessionId, 'sB')
  tree = await runner.ready(panel.props); await button(tree, 'Обновить сведения').props.onClick(); await tick(); assert.ok(ui.calls.some(call => call.pathname === '/airules/workflows' && call.input.projectId === 'p1' && call.input.sessionId === 'sB'))
  ui.changeProject(); tree = owner.render(); panel = child(tree, 'WorkflowPanel'); assert.equal(panel.props.initialTemplate, '', 'a new project must not receive the previous scenario even before effects run')
  tree = await owner.ready(); panel = child(tree, 'WorkflowPanel'); assert.equal(panel.props.key, 'p2'); assert.equal(panel.props.initialTemplate, ''); assert.equal(panel.props.projectContext.sessionId, 'sC'); assert.deepEqual(ui.violations, [])
})

test('Memory Memoria catalogue child carries project context, including a refreshed executor in the same project', async () => {
  const ui = await harness('memory-workspace'), owner = ui.mount('airules-memory'); let tree = await owner.ready(), node = child(tree, 'PolicyPanel')
  assert.equal(node.props.projectContext.sessionId, 'sA')
  const editor = ui.mount(node.type, node.props); tree = await editor.ready(); button(tree, 'Обновить каталог Memoria').props.onClick(); await tick()
  assert.equal(ui.calls.findLast(call => call.input.action === 'memoraCatalog').input.sessionId, 'sA')
  ui.changeChat(); tree = await owner.ready(); node = child(tree, 'PolicyPanel'); tree = await editor.ready(node.props); button(tree, 'Обновить каталог Memoria').props.onClick(); await tick()
  const sent = ui.calls.findLast(call => call.input.action === 'memoraCatalog'); assert.equal(sent.input.projectId, 'p1'); assert.equal(sent.input.sessionId, 'sB'); assert.equal(sent.input.expectedExecutorRevision, 'policy-b'); assert.deepEqual(ui.violations, [])
})

test('project changes hide the previous project forms before effects, so old drafts and actions never appear under a new owner', async () => {
  for (const [directory, slot, draftLabel, value] of [['document-workbench', 'airules-documents', 'Относительный путь к документу или папке', 'docs/must-not-leak.docx'], ['general-tools', 'airules-general-tools', 'Режим', 'lite'], ['project-settings', 'airules-onec-project', 'Имя базы', 'Must not leak']]) {
    const ui = await harness(directory), view = ui.mount(slot); let tree = await view.ready(); field(tree, draftLabel).props.onChange({ target: { value } }); tree = view.render(); assert.equal(field(tree, draftLabel).props.value, value)
    ui.changeProject(); tree = view.render(); ui.assertPicker(tree); assert.equal(field(tree, draftLabel), undefined, directory); assert.equal(flatten(tree).some(row => row.type === 'button'), false, directory); assert.match(text(tree), /Загрузка/)
    tree = await view.ready(); assert.notEqual(field(tree, draftLabel).props.value, value, directory)
  }
  const ui = await harness('skills-integration'), view = ui.mount('airules-skills'); let tree = await view.ready(); button(tree, 'Добавить навык').props.onClick(); tree = view.render(); field(tree, 'Имя').props.onChange({ target: { value: 'old-project-skill' } }); ui.changeProject(); tree = view.render(); ui.assertPicker(tree); assert.equal(field(tree, 'Имя'), undefined); assert.equal(child(tree, 'AssignmentPanel'), undefined); assert.equal(flatten(tree).some(row => row.type === 'button'), false)
})

test('same-project readonly executor clamps document and Office actions without discarding the path draft; inactive runtime stays readable only', async () => {
  const ui = await harness('document-workbench'), view = ui.mount('airules-documents'); let tree = await view.ready(); field(tree, 'Относительный путь к документу или папке').props.onChange({ target: { value: 'docs/book.xlsx' } }); tree = view.render(); field(tree, 'Новый путь результата (родительская папка должна существовать)').props.onChange({ target: { value: 'artifacts/new' } })
  ui.changeChat({ writable: false, globalWritable: false }); tree = await view.ready(); assert.equal(field(tree, 'Относительный путь к документу или папке').props.value, 'docs/book.xlsx'); assert.equal(button(tree, 'Индексировать').props.disabled, true); assert.equal(button(tree, 'Выполнить обработку').props.disabled, true); assert.equal(button(tree, 'Читать первые 50 строк').props.disabled, false)
  const before = ui.calls.length; await button(tree, 'Выполнить обработку').props.onClick(); await tick(); assert.equal(ui.calls.length, before)
  ui.setRights({ writable: true, active: false }); tree = await view.ready(); assert.equal(button(tree, 'Индексировать').props.disabled, true); assert.equal(button(tree, 'Проверить встроенный runtime').props.disabled, true); assert.equal(button(tree, 'Читать первые 50 строк').props.disabled, false); assert.match(text(tree), /нет активного исполнителя проекта/)
})

test('same-project readonly metadata clamps General, Project Settings and skill-assignment writes while preserving edits', async () => {
  for (const [directory, slot, label, value, save] of [['general-tools', 'airules-general-tools', 'Режим', 'lite', 'Сохранить стиль'], ['project-settings', 'airules-onec-project', 'Имя базы', 'Keep this draft', 'Сохранить (1)']]) {
    const ui = await harness(directory), view = ui.mount(slot); let tree = await view.ready(); field(tree, label).props.onChange({ target: { value } }); ui.changeChat({ writable: false, globalWritable: false }); tree = await view.ready(); assert.equal(field(tree, label).props.value, value, directory); assert.equal(field(tree, label).props.disabled, true, directory); assert.equal(button(tree, save).props.disabled, true, directory); const before = ui.calls.length; await button(tree, save).props.onClick(); await tick(); assert.equal(ui.calls.length, before, directory)
  }
  const ui = await harness('skills-integration'), view = ui.mount('airules-skills'); let tree = await view.ready(); button(tree, 'Добавить навык').props.onClick(); tree = view.render(); field(tree, 'Имя').props.onChange({ target: { value: 'keep-draft' } }); ui.changeChat({ writable: false, globalWritable: false }); tree = await view.ready(); assert.equal(field(tree, 'Имя').props.value, 'keep-draft'); assert.equal(button(tree, 'Создать навык').props.disabled, true); assert.equal(button(tree, 'Добавить навык').props.disabled, true)
  const assignment = child(tree, 'AssignmentPanel'); assert.equal(assignment.props.data.writable, false); assert.equal(assignment.props.data.globalWritable, false); const editor = ui.mount(assignment.type, assignment.props); tree = await editor.ready(); assert.equal(field(tree, 'Тип задачи проекта по умолчанию').props.disabled, true); assert.equal(button(tree, 'Применить тип задачи').props.disabled, true)
})
