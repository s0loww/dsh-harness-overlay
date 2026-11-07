import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/workflow-integration/lib/client.js', import.meta.url), 'utf8')
const json = value => JSON.parse(JSON.stringify(value))
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const flatten = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(flatten)] : []
const text = tree => tree && typeof tree === 'object' ? tree.children.map(text).join(' ') : tree == null || tree === false ? '' : String(tree)
const button = (tree, label) => flatten(tree).find(node => node.type === 'button' && text(node) === label)
const select = (tree, label) => flatten(tree).find(node => node.type === 'label' && node.children[0] === label)?.children.find(node => node?.type === 'select')
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
const response = body => ({ ok: true, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }

function harness(fetchImpl = async () => response(status())) {
  let plugin, cursor = 0
  const hooks = [], effects = [], calls = []
  const react = { Fragment: 'fragment', createElement: h,
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value }]
    },
    useRef(value) { const index = cursor++; hooks[index] ||= { current: value }; return hooks[index] },
    useCallback(callback, deps) {
      const index = cursor++
      if (!hooks[index] || !sameDeps(hooks[index].deps, deps)) hooks[index] = { deps, callback }
      return hooks[index].callback
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!hooks[index] || !sameDeps(hooks[index].deps, deps)) {
        const old = hooks[index]
        hooks[index] = { deps, cleanup: old?.cleanup }
        effects.push(() => { old?.cleanup?.(); hooks[index].cleanup = callback() })
      }
    },
    useSyncExternalStore(_subscribe, get) { return get() },
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(id => { assert.equal(id, 'react'); return react }) } } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetchImpl(url, options) }, AbortController, setTimeout, clearTimeout })
  return { plugin, calls,
    render(component = plugin.WorkflowPanel, props = { sessionId: 'session-1' }) { cursor = 0; const tree = component(props); for (const effect of effects.splice(0)) effect(); return tree },
    dispose() { for (const hook of hooks) hook?.cleanup?.() },
  }
}

function status(overrides = {}) {
  return { ok: true, project: { id: 'project-a', root: 'private-root-not-for-ui' }, configured: true, writable: true, csrfToken: 'csrf-test',
    workflows: [{ id: 'check', label: 'Проверка проекта', steps: [{ id: 'syntax', status: 'configured', required: true }, { id: 'ui', status: 'not-configured', required: false }] }],
    runnerBindings: [{ id: 'syntax', kind: 'local', status: 'configured', message: 'private-binding-details', operations: [{ id: 'inspect', label: 'Анализ', enabled: true, effects: ['readsSource', 'startsProcess'] }] }],
    execution: { nativeSandbox: true, deployImplemented: true, deployMode: 'fixture-only', deployEnabled: false, fixtureEnabled: true, runViaAgentTool: true }, runs: [], ...overrides }
}

test('registers universal native settings section and follows the active project session', () => {
  const f = harness(), registrations = []
  f.plugin.apply({ get(name) { assert.equal(name, 'sessions'); return { list: { subscribe() {}, getSnapshot: () => ({ byId: {
    a: { id: 'a', title: 'First', retainedBy: {} }, b: { id: 'b', title: 'Python project', retainedBy: { mainView: 1 } },
  }, current: 'a' }) } } }, slots: { inject(name, callback) { assert.equal(name, 'settings.section'); callback() }, register(metadata, component) { registrations.push({ metadata, component }) } } })
  assert.equal(registrations[0].metadata.id, 'airules-workflows')
  assert.equal(registrations[0].metadata.label(), 'Проверки и деплой')
  const tree = f.render(f.plugin.WorkflowsSettings)
  assert.equal(flatten(tree).find(node => node.type === f.plugin.WorkflowPanel).props.sessionId, 'b')
  assert.doesNotMatch(source, /agentPreset\s*===|1c-airules\s*\)/u)
  assert.equal(f.calls.length, 0)
  f.dispose()
})

test('status is GET-only, exposes unavailable steps, and never renders raw host paths or binding messages', async () => {
  const f = harness(); f.render(); await flush()
  const tree = f.render(), content = text(tree)
  assert.match(f.calls[0].url, /^\/airules\/workflows\?action=status&sessionId=session-1$/u)
  assert.equal(f.calls[0].options.method, 'GET')
  assert.equal(f.calls[0].options.credentials, 'same-origin')
  assert.match(content, /ui: Не настроено · необязательная/u)
  assert.match(content, /фасад не обязателен/u)
  assert.doesNotMatch(content, /private-root-not-for-ui|private-binding-details/u)
  assert.equal(button(tree, 'Деплой отключён'), undefined)
  assert.match(content, /Исполнитель реализован/u)
  assert.match(content, /Реальный деплой выключен настройкой сборки/u)
  assert.equal(button(tree, 'Сформировать план').props.disabled, false)
  assert.equal(flatten(tree).some(node => node.type === 'button' && /Запустить|Удалить|Применить/u.test(text(node))), false)
  f.dispose()
})

test('planning uses only CSRF-protected POST and shows typed plan fields without executing', async () => {
  const plan = { id: 'plan-1', planDigest: 'f'.repeat(64), source: { digest: 'a'.repeat(64), files: 12 }, steps: [{ id: 'syntax', operation: 'inspect', configured: true, effects: ['readsSource'], resources: [{ id: 'test-resource', environment: 'test', password: 'do-not-render' }] }], raw: 'do-not-render' }
  const f = harness(async (_url, options) => options.method === 'POST' ? response({ ok: true, plan }) : response(status()))
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Сформировать план').props.onClick(); tree = f.render()
  const post = f.calls.find(call => call.options.method === 'POST')
  assert.deepEqual(JSON.parse(post.options.body), { action: 'plan', sessionId: 'session-1', workflowId: 'check' })
  assert.equal(post.options.headers['x-dsh-csrf'], 'csrf-test')
  assert.equal(f.calls.length, 2)
  const node = flatten(tree).find(item => item.type === f.plugin.PlanView)
  const content = text(f.plugin.PlanView(node.props))
  assert.match(content, /Файлов исходников: 12/u); assert.match(content, /Цель: test-resource · тестовый контур/u)
  assert.doesNotMatch(content, /do-not-render/u)
  const prompt = flatten(f.plugin.PlanView(node.props)).find(item => item.type === 'textarea').props.value
  assert.match(prompt, /airules_workflow_run/u)
  assert.match(prompt, /плана plan-1 с planDigest f{64}/u)
  assert.match(prompt, /Реальный деплой, изменение базы/u)
  assert.equal(button(tree, 'Деплой отключён'), undefined)
  f.dispose()
})

test('unavailable required steps disable plan persistence but optional missing steps do not', async () => {
  for (const missingStatus of ['not-configured', 'unsupported', 'unavailable', 'needs-review', 'disabled', 'blocked']) {
    const f = harness(async () => response(status({ workflows: [{ id: 'check', label: 'Проверка', steps: [{ id: 'missing', status: missingStatus, required: true }] }] })))
    f.render(); await flush(); const tree = f.render(), action = button(tree, 'Сформировать план')
    assert.equal(action.props.disabled, true); await action.props.onClick(); assert.equal(f.calls.length, 1)
    assert.match(text(tree), /План недоступен: обязательный шаг «missing»/u)
    f.dispose()
  }
})

test('read-only or unconfigured projects cannot persist plans, including direct handler invocation', async () => {
  for (const overrides of [{ writable: false }, { configured: false }, { csrfToken: '' }]) {
    const f = harness(async () => response(status(overrides)))
    f.render(); await flush(); const tree = f.render()
    assert.equal(button(tree, 'Сформировать план').props.disabled, true)
    await button(tree, 'Сформировать план').props.onClick()
    assert.equal(f.calls.length, 1)
    if (overrides.writable === false) assert.match(text(tree), /Только чтение/u)
    f.dispose()
  }
})

test('run listing and result fetch are read-only; uncertain and partial states stay visible', async () => {
  const result = { runId: 'run-1', verdict: 'INDETERMINATE', mutationState: 'partial', recoveryState: 'required', observation: 'owner-not-attached',
    reason: 'server-secret', raw: 'server-secret', steps: [{ id: 'gate', status: 'blocked', reason: 'server-secret' }] }
  const f = harness(async url => url.includes('action=runs') ? response({ ok: true, runs: [{ runId: 'run-1', verdict: 'INDETERMINATE' }] })
    : url.includes('action=result') ? response({ ok: true, result }) : response(status()))
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Обновить прогоны').props.onClick(); tree = f.render()
  await button(tree, 'Показать результат').props.onClick(); tree = f.render()
  assert.match(f.calls.at(-1).url, /action=result&sessionId=session-1&runId=run-1/u)
  assert.ok(f.calls.every(call => call.options.method === 'GET'))
  const node = flatten(tree).find(item => item.type === f.plugin.ResultView)
  const content = text(f.plugin.ResultView(node.props))
  assert.match(content, /Результат не определён/u); assert.match(content, /применены частично/u); assert.match(content, /Требуется восстановление/u)
  assert.match(content, /Владелец запуска не подключён/u); assert.doesNotMatch(content, /server-secret/u)
  f.dispose()
})

test('server errors and transport exceptions render static Russian text only', async () => {
  for (const nativeError of [false, true]) {
    const f = harness(async () => { if (nativeError) throw new Error('password=server-secret'); return { ok: false, json: async () => ({ ok: false, message: 'password=server-secret', error: 'private/path' }) } })
    f.render(); await flush(); const tree = f.render()
    assert.match(text(tree), /Не удалось загрузить сведения/u)
    assert.doesNotMatch(text(tree), /server-secret|private\/path/u)
    f.dispose()
  }
  assert.doesNotMatch(source, /innerHTML|localStorage|indexedDB/u)
})

test('responses from a previous session cannot leak into the newly selected project', async () => {
  const old = deferred()
  const f = harness(async url => url.includes('sessionId=old') ? old.promise : response(status({ project: { id: 'new-project' } })))
  f.render(f.plugin.WorkflowPanel, { sessionId: 'old' })
  f.render(f.plugin.WorkflowPanel, { sessionId: 'new' }); await flush()
  old.resolve(response(status({ project: { id: 'old-private-project' } }))); await flush()
  const tree = f.render(f.plugin.WorkflowPanel, { sessionId: 'new' })
  assert.match(text(tree), /new-project/u); assert.doesNotMatch(text(tree), /old-private-project/u)
  f.dispose()
})

test('no session makes no API calls and leaves deployment disabled', async () => {
  const f = harness()
  const tree = f.render(f.plugin.WorkflowPanel, { sessionId: null }); await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(button(tree, 'Обновить сведения').props.disabled, true)
  assert.equal(button(tree, 'Деплой отключён'), undefined)
  assert.match(text(tree), /1\. Выберите проект/u)
  f.dispose()
})

test('empty project provides concrete discovery and configuration path instead of an unexplained disabled deploy switch', async () => {
  const f = harness(async () => response(status({ configured: false, workflows: [], runnerBindings: [] })))
  f.render(); await flush(); const tree = f.render(), content = text(tree)
  assert.match(content, /Подключите проверки проекта/u)
  assert.match(content, /\.airules\/workflows\.json/u)
  assert.equal(button(tree, 'Найти инструменты проекта').props.disabled, false)
  assert.match(content, /Сначала подключите сценарий проекта/u)
  assert.equal(button(tree, 'Сформировать план').props.disabled, true)
  assert.equal(f.calls.length, 1)
  f.dispose()
})

test('scenario selection is active without a session or bindings and offers useful built-in templates', async () => {
  for (const sessionId of [null, 'session-1']) {
    const selected = []
    const f = harness(async url => url.includes('action=setup')
      ? response({ ok: true, csrfToken: 'setup-csrf', candidates: [{ id: 'deploy-fixture', kind: 'deploy-fixture' }] })
      : response(status({ configured: false, workflows: [], runnerBindings: [] })))
    f.render(f.plugin.WorkflowPanel, { sessionId, onTemplateChange: value => selected.push(value) }); await flush()
    let tree = f.render(f.plugin.WorkflowPanel, { sessionId, onTemplateChange: value => selected.push(value) })
    const picker = select(tree, 'Сценарий')
    assert.ok(picker)
    assert.notEqual(picker.props.disabled, true)
    assert.deepEqual(flatten(picker).filter(node => node.type === 'option' && node.props.value.startsWith('template:')).map(node => node.props.value),
      ['template:checks', 'template:deploy', 'template:fixture'])
    picker.props.onChange({ target: { value: 'template:fixture' } }); await flush()
    tree = f.render(f.plugin.WorkflowPanel, { sessionId, onTemplateChange: value => selected.push(value) })
    assert.equal(select(tree, 'Сценарий').props.value, 'template:fixture')
    assert.deepEqual(selected, ['template:fixture'])
    if (sessionId) {
      assert.equal(select(tree, 'Инструмент проекта').props.value, 'deploy-fixture')
      assert.ok(f.calls.some(call => call.url.includes('action=setup')))
    } else {
      assert.match(text(tree), /Шаблон выбран.*выберите проектный сеанс/u)
      assert.equal(f.calls.length, 0)
    }
    assert.ok(f.calls.every(call => call.options.method === 'GET'))
    f.dispose()
  }
})

test('previously selected template opens its wizard after choosing a project session', async () => {
  const f = harness(async url => url.includes('action=setup')
    ? response({ ok: true, csrfToken: 'setup-csrf', candidates: [{ id: 'agent-1c', kind: 'agent-1c', sourcePaths: ['src'] }, { id: 'deploy-fixture', kind: 'deploy-fixture' }] })
    : response(status({ configured: false, workflows: [] })))
  const props = { sessionId: 'session-1', initialTemplate: 'template:deploy' }
  f.render(f.plugin.WorkflowPanel, props); await flush(); const tree = f.render(f.plugin.WorkflowPanel, props)
  assert.equal(select(tree, 'Сценарий').props.value, 'template:deploy')
  assert.equal(select(tree, 'Тип сценария').props.value, 'deploy')
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(call => call.options.method === 'GET'))
  f.dispose()
})

test('unavailable saved scenarios remain selectable with concrete blockers', async () => {
  const f = harness(async () => response(status({ workflows: [
    { id: 'ready', label: 'Проверки', steps: [] },
    { id: 'waiting', label: 'Обновление базы', steps: [{ id: 'apply', status: 'disabled', reason: 'ACTUAL_DEPLOY_DISABLED', required: true }] },
  ] })))
  f.render(); await flush(); let tree = f.render()
  select(tree, 'Сценарий').props.onChange({ target: { value: 'waiting' } }); await flush(); tree = f.render()
  assert.equal(select(tree, 'Сценарий').props.value, 'waiting')
  assert.notEqual(select(tree, 'Сценарий').props.disabled, true)
  assert.match(text(tree), /Реальный деплой выключен настройкой сборки/u)
  assert.equal(button(tree, 'Сформировать план').props.disabled, true)
  assert.equal(f.calls.length, 1)
  f.dispose()
})

test('history from status is shown immediately and recovery never offers a bare unlock', async () => {
  const f = harness(async () => response(status({ runs: [{ runId: 'retained-1', verdict: 'INDETERMINATE' }] })))
  f.render(); await flush(); const tree = f.render()
  assert.match(text(tree), /retained-1/u)
  assert.equal(f.calls.length, 1)
  const recovery = f.plugin.ResultView({ result: { runId: 'retained-1', verdict: 'INDETERMINATE', recoveryState: 'required', retainedLocks: true,
    reason: 'PRIVATE_UNKNOWN_REASON', steps: [{ id: 'apply', status: 'indeterminate', diagnostics: { exitCode: 2, secret: 'PRIVATE_DIAGNOSTICS' } }] } })
  assert.match(text(recovery), /Блокировка снимается только после подтверждённой сверки/u)
  assert.match(text(recovery), /Код завершения: 2/u)
  assert.doesNotMatch(text(recovery), /PRIVATE_UNKNOWN_REASON|PRIVATE_DIAGNOSTICS/u)
  const prompt = flatten(recovery).find(node => node.type === 'textarea').props.value
  assert.match(prompt, /блокировки вручную не удаляй/u)
  assert.equal(flatten(recovery).some(node => node.type === 'button'), false)
  f.dispose()
})

test('recovery receipts preserve the original verdict and render only typed proof fields', () => {
  const f = harness()
  const tree = f.plugin.ResultView({ result: { runId: 'run-restored', verdict: 'INDETERMINATE', originalVerdict: 'INDETERMINATE',
    mutationState: 'unknown', recoveryState: 'completed', retainedLocks: false,
    recoveries: [{ recoveryId: 'receipt-1', targetId: 'onec-test', outcome: 'restored', receiptDigest: 'b'.repeat(64), privatePath: 'PRIVATE_RECEIPT' },
      { recoveryId: 'bad', targetId: '/PRIVATE_PATH', outcome: 'restored', receiptDigest: 'bad' }] } })
  assert.match(text(tree), /Итог исходного прогона сохранён/u)
  assert.match(text(tree), /onec-test: восстановлено/u)
  assert.match(text(tree), /Восстановление подтверждено/u)
  assert.doesNotMatch(text(tree), /PRIVATE_RECEIPT|PRIVATE_PATH/u)
  assert.equal(flatten(tree).some(node => node.props['aria-label'] === 'Восстановление после сбоя'), false)
  f.dispose()
})

test('recovery prompt targets only the named reviewed fixture provider and never offers unconditional unlock', () => {
  const f = harness()
  const tree = f.plugin.ResultView({ result: { runId: 'fixture-failed', verdict: 'INDETERMINATE', recoveryState: 'required', retainedLocks: true,
    recoveryOptions: [{ id: 'fixture-deploy-stub', kind: 'fixture', available: true, private: 'PRIVATE_PROVIDER' },
      { id: '/PRIVATE_PATH', kind: 'mcp', available: true }] } })
  assert.match(text(tree), /fixture-deploy-stub \(заглушка\)/u)
  assert.doesNotMatch(text(tree), /PRIVATE_PROVIDER|PRIVATE_PATH/u)
  const prompt = flatten(tree).find(node => node.type === 'textarea').props.value
  assert.match(prompt, /airules_workflow_recover/u)
  assert.match(prompt, /providerId fixture-deploy-stub/u)
  assert.match(prompt, /только тестовый маркер/u)
  assert.match(prompt, /ничего в реальной базе не меняй/u)
  f.dispose()
})

test('discovery and preview prepare configuration without writes, execution or automatic overwrite', async () => {
  const configuration = { schemaVersion: 1, projectId: 'fixture', workflows: { check: {} } }
  const f = harness(async (url, options) => url.includes('action=setup')
    ? response({ ok: true, bindingPath: '.airules/workflows.json', existingBinding: true,
      candidates: [{ id: 'agent-1c', kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1', sourceKind: 'extension',
        extensionName: 'Fixture', exactBuild: '8.3.27.1989', sourcePaths: ['src'] }] })
    : options.method === 'POST' ? response({ ok: true, configuration, existingBinding: true, notes: ['Проверки подготовлены; запуск не выполнялся.'] }) : response(status()))
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  assert.match(f.calls.at(-1).url, /action=setup&sessionId=session-1/u)
  assert.equal(f.calls.at(-1).options.method, 'GET')
  assert.match(text(tree), /Вид исходников/u)
  const sourceInput = flatten(tree).find(item => item.type === 'input' && item.props.value === 'src')
  sourceInput.props.onChange({ target: { value: 'changed-src' } }); tree = f.render()
  await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
  const post = f.calls.at(-1)
  assert.equal(post.options.method, 'POST')
  assert.equal(post.options.headers['x-dsh-csrf'], 'csrf-test')
  assert.deepEqual(JSON.parse(post.options.body), { action: 'previewSetup', sessionId: 'session-1', setup: {
    candidateId: 'agent-1c', sourceKind: 'extension', extensionName: 'Fixture', exactBuild: '8.3.27.1989', sourcePath: 'changed-src',
  } })
  assert.match(text(tree), /уже существует/u)
  const areas = flatten(tree).filter(item => item.type === 'textarea')
  assert.ok(areas.some(item => item.props.value === JSON.stringify(configuration, null, 2) && item.props.readOnly))
  assert.ok(areas.some(item => /не перезаписывай их без согласования/u.test(item.props.value)))
  assert.equal(f.calls.length, 3)
  assert.equal(button(tree, 'Сохранить сценарий в проект').props.disabled, true)
  assert.equal(flatten(tree).some(item => item.type === 'button' && /Запустить|Применить/u.test(text(item))), false)
  f.dispose()
})

test('saving a prepared scenario uses CSRF, writable scope and binding revision, then selects the saved workflow without executing', async () => {
  let saved = false
  const f = harness(async (url, options) => {
    if (url.includes('action=setup')) return response({ ok: true, csrfToken: 'setup-csrf', candidates: [{ id: 'deploy-fixture', kind: 'deploy-fixture' }] })
    if (options.method === 'POST') {
      const payload = JSON.parse(options.body)
      if (payload.action === 'previewSetup') return response({ ok: true, configuration: { schemaVersion: 1 }, revision: null, notes: [] })
      assert.equal(payload.action, 'saveSetup')
      assert.deepEqual(payload, { action: 'saveSetup', sessionId: 'session-1', setup: { candidateId: 'deploy-fixture' }, revision: null })
      assert.equal(options.headers['x-dsh-csrf'], 'setup-csrf')
      assert.equal(Object.hasOwn(payload, 'configuration'), false)
      saved = true
      return response({ ok: true, saved: true, workflowId: 'saved-stub', bindingPath: '.airules/workflows.json' })
    }
    return response(status({ configured: saved, workflows: saved ? [{ id: 'saved-stub', label: 'Моя заглушка', steps: [{ id: 'apply', adapterId: 'stub', operation: 'deploy-apply', status: 'configured', required: true }] }] : [],
      runnerBindings: saved ? [{ id: 'stub', kind: 'deploy-fixture', status: 'configured', operations: [] }] : [] }))
  })
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
  assert.equal(button(tree, 'Сохранить сценарий в проект').props.disabled, false)
  await button(tree, 'Сохранить сценарий в проект').props.onClick(); tree = f.render()
  assert.equal(select(tree, 'Сценарий').props.value, 'saved-stub')
  assert.equal(button(tree, 'Сформировать план').props.disabled, false)
  assert.match(text(tree), /Сценарий сохранён\. Можно сформировать план\. Процессы не запускались/u)
  assert.equal(f.calls.length, 5)
  assert.ok(f.calls.every(call => !call.url.includes('action=run')))
  f.dispose()
})

test('save action refuses missing revision or read-only scope even if the disabled handler is invoked', async () => {
  for (const overrides of [{ writable: false, revision: null }, { writable: true, revision: undefined }]) {
    const f = harness(async (url, options) => url.includes('action=setup')
      ? response({ ok: true, candidates: [{ id: 'deploy-fixture', kind: 'deploy-fixture' }] })
      : options.method === 'POST' ? response({ ok: true, configuration: { schemaVersion: 1 }, ...(overrides.revision === null ? { revision: null } : {}), notes: [] })
        : response(status({ writable: overrides.writable })))
    f.render(); await flush(); let tree = f.render()
    await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
    await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
    const save = button(tree, 'Сохранить сценарий в проект')
    assert.equal(save.props.disabled, true)
    const count = f.calls.length
    await save.props.onClick()
    assert.equal(f.calls.length, count)
    if (!overrides.writable) assert.match(text(tree), /Для сохранения сценария выберите права на запись/u)
    f.dispose()
  }
})

test('stale binding errors explain that the current configuration was preserved', async () => {
  const f = harness(async (url, options) => {
    if (url.includes('action=setup')) return response({ ok: true, candidates: [{ id: 'deploy-fixture', kind: 'deploy-fixture' }] })
    if (options.method === 'POST') {
      if (JSON.parse(options.body).action === 'previewSetup') return response({ ok: true, configuration: {}, revision: 'a'.repeat(64), notes: [] })
      return { ok: false, json: async () => ({ ok: false, error: 'STALE_BINDING', message: 'PRIVATE_FS_ERROR' }) }
    }
    return response(status())
  })
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
  await button(tree, 'Сохранить сценарий в проект').props.onClick(); tree = f.render()
  assert.match(text(tree), /существующий файл не перезаписан/u)
  assert.doesNotMatch(text(tree), /PRIVATE_FS_ERROR/u)
  assert.equal(select(tree, 'Сценарий').props.value, 'check')
  f.dispose()
})

test('discovery with no runner or metadata-only TestEnv explains next action and has no save/run controls', async () => {
  for (const candidate of [null, { id: 'test-env', kind: 'test-env', runnerPath: 'scripts/RunUnitTests.ps1', sourcePaths: [] }]) {
    const f = harness(async (url, options) => url.includes('action=setup') ? response({ ok: true, candidates: candidate ? [candidate] : [] })
      : options.method === 'POST' ? response({ ok: true, configuration: null, notes: ['TestEnv доступен для просмотра; unit изменяет базу и пока не подключён.'] })
        : response(status({ configured: false, workflows: [], runnerBindings: [] })))
    f.render(); await flush(); let tree = f.render()
    await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
    if (!candidate) { assert.match(text(tree), /Совместимые runners не найдены/u); assert.equal(button(tree, 'Подготовить конфигурацию'), undefined) }
    else {
      await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
      assert.match(text(tree), /TestEnv доступен для просмотра/u)
      assert.equal(flatten(tree).some(item => item.type === 'textarea' && /schemaVersion/u.test(item.props.value)), false)
    }
    f.dispose()
  }
})

test('known setup errors are actionable while unknown host errors remain private', async () => {
  const f = harness(async () => ({ ok: false, json: async () => ({ ok: false, error: 'EXACT_BUILD_REQUIRED', message: 'private-error-details' }) }))
  f.render(); await flush(); const tree = f.render()
  assert.match(text(tree), /Укажите точный build установленной платформы/u)
  assert.doesNotMatch(text(tree), /private-error-details/u)
  f.dispose()
})

test('setup remains available when a broken existing binding prevents status and uses its own CSRF token', async () => {
  const f = harness(async (url, options) => url.includes('action=setup') ? response({ ok: true, csrfToken: 'setup-csrf', existingBinding: true,
    candidates: [{ id: 'agent-1c', kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1', sourceKind: 'extension',
      extensionName: 'Fixture', exactBuild: '8.3.27.1989', sourcePaths: ['src'] }] })
    : options.method === 'POST' ? response({ ok: true, configuration: { schemaVersion: 1 }, existingBinding: true, notes: [] })
      : { ok: false, json: async () => ({ ok: false, error: 'WORKFLOW_BINDING_INVALID' }) })
  f.render(); await flush(); let tree = f.render()
  assert.match(text(tree), /содержит неподдерживаемые настройки/u)
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  assert.equal(button(tree, 'Подготовить конфигурацию').props.disabled, false)
  await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
  assert.equal(f.calls.at(-1).options.headers['x-dsh-csrf'], 'setup-csrf')
  assert.match(text(tree), /уже существует/u)
  f.dispose()
})

test('changing source kind to configuration clears an obsolete extension name before preview', async () => {
  const f = harness(async (url, options) => url.includes('action=setup') ? response({ ok: true, csrfToken: 'setup-csrf',
    candidates: [{ id: 'agent-1c', kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1', sourceKind: 'extension',
      extensionName: 'Fixture', exactBuild: '8.3.27.1989', sourcePaths: ['src'] }] })
    : options.method === 'POST' ? response({ ok: true, configuration: null, notes: [] }) : response(status()))
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  const selector = flatten(tree).find(item => item.type === 'select' && item.props.value === 'extension')
  selector.props.onChange({ target: { value: 'configuration' } }); tree = f.render()
  await button(tree, 'Подготовить конфигурацию').props.onClick()
  const body = JSON.parse(f.calls.at(-1).options.body)
  assert.equal(body.setup.sourceKind, 'configuration')
  assert.equal(body.setup.extensionName, '')
  f.dispose()
})

test('fixture wizard omits all 1C facts and sends only the built-in fixture candidate', async () => {
  const configuration = { schemaVersion: 1, runners: { 'deploy-stub': { schemaVersion: 1, kind: 'deploy-fixture', outcome: 'pass' } } }
  const f = harness(async (url, options) => url.includes('action=setup') ? response({ ok: true, csrfToken: 'fixture-csrf', candidates: [
    { id: 'agent-1c', kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1', sourceKind: 'extension', extensionName: 'PriorName', exactBuild: '8.3.27.1989', sourcePaths: ['src'] },
    { id: 'deploy-fixture', kind: 'deploy-fixture', sourcePaths: [], missingFields: [] },
  ] }) : options.method === 'POST' ? response({ ok: true, configuration, notes: ['Это имитация без 1С и баз.'] }) : response(status()))
  f.render(); await flush(); let tree = f.render()
  await button(tree, 'Найти инструменты проекта').props.onClick(); tree = f.render()
  const chooser = flatten(tree).find(item => item.type === 'select' && item.props.value === 'agent-1c')
  chooser.props.onChange({ target: { value: 'deploy-fixture' } }); tree = f.render()
  assert.match(text(tree), /Заглушка деплоя — без 1С и баз/u)
  assert.match(text(tree), /Для заглушки не нужны платформа/u)
  assert.equal(flatten(tree).some(item => item.type === 'input'), false)
  assert.doesNotMatch(text(tree), /Точный build платформы 1С|Имя расширения/u)
  await button(tree, 'Подготовить конфигурацию').props.onClick(); tree = f.render()
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { action: 'previewSetup', sessionId: 'session-1', setup: { candidateId: 'deploy-fixture' } })
  assert.equal(f.calls.at(-1).options.headers['x-dsh-csrf'], 'fixture-csrf')
  assert.equal(f.calls.length, 3)
  assert.equal(flatten(tree).some(item => item.type === 'button' && /Запустить|Применить/u.test(text(item))), false)
  f.dispose()
})

test('fixture plan prompts only stub execution and never promises actual deployment', async () => {
  const plan = { id: 'fixture-plan', workflowId: 'deploy-fixture', planDigest: 'c'.repeat(64), steps: [{ id: 'apply', operation: 'deploy-apply', effects: ['writesTargetData'], resources: [{ id: 'fixture-a', environment: 'test' }] }] }
  const f = harness(async (_url, options) => options.method === 'POST' ? response({ ok: true, plan }) : response(status({
    workflows: [{ id: 'deploy-fixture', label: 'Проверка исполнителя на заглушке', steps: [{ id: 'apply', operation: 'deploy-apply', adapterId: 'deploy-stub', status: 'configured', required: true }] }],
    runnerBindings: [{ id: 'deploy-stub', kind: 'deploy-fixture', status: 'configured', operations: [{ id: 'deploy-apply', enabled: true, effects: ['writesTargetData'] }] }],
  })))
  f.render(); await flush(); let tree = f.render()
  assert.match(text(tree), /Встроенная заглушка деплоя/u)
  await button(tree, 'Сформировать план').props.onClick(); tree = f.render()
  const view = flatten(tree).find(item => item.type === f.plugin.PlanView)
  assert.equal(view.props.fixtureOnly, true)
  const rendered = f.plugin.PlanView(view.props), prompt = flatten(rendered).find(item => item.type === 'textarea').props.value
  assert.match(text(rendered), /имитация обновления/u)
  assert.match(prompt, /Выполни только встроенную заглушку деплоя/u)
  assert.match(prompt, /Реальный деплой, изменение базы и запуск тестовой среды не выполнять/u)
  assert.equal(f.calls.length, 2)
  f.dispose()
})

test('deployment status distinguishes fixture, disabled and explicitly enabled real mode', async () => {
  for (const [execution, expected, absent] of [
    [{ deployImplemented: true, deployMode: 'fixture-only', deployEnabled: false, fixtureEnabled: true }, 'проверка на заглушке', 'реальный режим разрешён'],
    [{ deployImplemented: true, deployMode: 'disabled', deployEnabled: false, fixtureEnabled: false }, 'выполнение выключено', 'реальный режим разрешён'],
    [{ deployImplemented: true, deployMode: 'enabled', deployEnabled: true, fixtureEnabled: true }, 'реальный режим разрешён', 'Реальный деплой выключен настройкой сборки'],
  ]) {
    const f = harness(async () => response(status({ execution })))
    f.render(); await flush(); const tree = f.render(), content = text(tree)
    assert.ok(content.includes(expected)); assert.ok(!content.includes(absent))
    assert.doesNotMatch(content, /ещё не реализовано/u)
    assert.equal(flatten(tree).some(item => item.type === 'button' && /Включить|Запустить|Применить/u.test(text(item))), false)
    f.dispose()
  }
})

test('executor mode is saved through native CSRF configuration only and reloads fresh status after a transient plugin restart', async () => {
  let mode = 'fixture-only', saved = false, reloads = 0
  const f = harness(async (_url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body)
      if (body.action === 'setMode') {
        assert.deepEqual(body, { action: 'setMode', sessionId: 'session-1', mode: 'enabled' })
        assert.equal(options.headers['x-dsh-csrf'], 'csrf-test')
        mode = body.mode; saved = true
        return response({ ok: true, mode, changed: true })
      }
      assert.equal(body.action, 'plan')
      assert.equal(options.headers['x-dsh-csrf'], 'fresh-mode-csrf')
      return response({ ok: true, plan: { id: 'fresh-plan', steps: [] } })
    }
    if (saved && ++reloads === 1) return { ok: false, json: async () => ({ ok: false, error: 'PLUGIN_RELOADING' }) }
    return response(status({ csrfToken: saved ? 'fresh-mode-csrf' : 'csrf-test', execution: {
      deployMode: mode, deployImplemented: true, deployEnabled: mode === 'enabled', fixtureEnabled: true,
    } }))
  })
  f.render(); await flush(); let tree = f.render()
  assert.equal(select(tree, 'Режим исполнителя').props.value, 'fixture-only')
  assert.equal(button(tree, 'Сохранить режим').props.disabled, true)
  select(tree, 'Режим исполнителя').props.onChange({ target: { value: 'enabled' } }); tree = f.render()
  assert.equal(button(tree, 'Сохранить режим').props.disabled, false)
  await button(tree, 'Сохранить режим').props.onClick(); tree = f.render()
  assert.equal(select(tree, 'Режим исполнителя').props.value, 'enabled')
  assert.equal(button(tree, 'Сохранить режим').props.disabled, true)
  assert.match(text(tree), /Режим исполнителя сохранён\. Процессы, проверки и деплой не запускались/u)
  assert.equal(reloads, 2)
  await button(tree, 'Сформировать план').props.onClick()
  assert.ok(f.calls.every(call => !/action=(?:run|deploy|apply)/u.test(call.url)))
  f.dispose()
})

test('mode changes are rejected locally for read-only sessions and unchanged values', async () => {
  for (const writable of [false, true]) {
    const f = harness(async () => response(status({ writable })))
    f.render(); await flush(); let tree = f.render()
    if (!writable) {
      assert.equal(select(tree, 'Режим исполнителя').props.disabled, true)
      select(tree, 'Режим исполнителя').props.onChange({ target: { value: 'enabled' } }); tree = f.render()
      assert.match(text(tree), /Для изменения режима нужны права на запись/u)
    }
    assert.equal(button(tree, 'Сохранить режим').props.disabled, true)
    await button(tree, 'Сохранить режим').props.onClick()
    assert.equal(f.calls.length, 1)
    f.dispose()
  }
})

test('busy executor and unavailable native configuration return actionable safe mode errors', async () => {
  for (const [error, expected] of [['MODE_CHANGE_BUSY', /пока выполняется прогон или восстановление/u],
    ['MODE_CONFIGURATION_UNAVAILABLE', /Штатная настройка режима сейчас недоступна/u]]) {
    const f = harness(async (_url, options) => options.method === 'POST'
      ? { ok: false, json: async () => ({ ok: false, error, message: 'PRIVATE_MODE_DETAIL' }) } : response(status()))
    f.render(); await flush(); let tree = f.render()
    select(tree, 'Режим исполнителя').props.onChange({ target: { value: 'enabled' } }); tree = f.render()
    await button(tree, 'Сохранить режим').props.onClick(); tree = f.render()
    assert.match(text(tree), expected)
    assert.doesNotMatch(text(tree), /PRIVATE_MODE_DETAIL/u)
    assert.equal(f.calls.length, 2)
    f.dispose()
  }
})

test('mode reload retries are bounded when the restarted plugin remains unavailable', async () => {
  let saved = false, reloads = 0
  const f = harness(async (_url, options) => {
    if (options.method === 'POST') { saved = true; return response({ ok: true, mode: 'enabled', changed: true }) }
    if (saved) { reloads++; return { ok: false, json: async () => ({ ok: false, error: 'PLUGIN_RELOADING' }) } }
    return response(status())
  })
  f.render(); await flush(); let tree = f.render()
  select(tree, 'Режим исполнителя').props.onChange({ target: { value: 'enabled' } }); tree = f.render()
  await button(tree, 'Сохранить режим').props.onClick(); tree = f.render()
  assert.equal(reloads, 3)
  assert.equal(f.calls.length, 5)
  assert.match(text(tree), /DSH ещё обновляет плагин/u)
  assert.equal(button(tree, 'Обновить сведения').props.disabled, false)
  f.dispose()
})

test('a mode restart response cannot overwrite a newly selected project or continue old-session retries', async () => {
  const delayed = deferred()
  let saved = false
  const f = harness(async (url, options) => {
    if (options.method === 'POST') { saved = true; return response({ ok: true, mode: 'enabled', changed: true }) }
    if (url.includes('sessionId=old') && saved) return delayed.promise
    return response(status({ project: { id: url.includes('sessionId=new') ? 'new-project' : 'old-project' } }))
  })
  const old = { sessionId: 'old' }
  f.render(f.plugin.WorkflowPanel, old); await flush(); let tree = f.render(f.plugin.WorkflowPanel, old)
  select(tree, 'Режим исполнителя').props.onChange({ target: { value: 'enabled' } }); tree = f.render(f.plugin.WorkflowPanel, old)
  const pendingSave = button(tree, 'Сохранить режим').props.onClick(); await flush()
  f.render(f.plugin.WorkflowPanel, { sessionId: 'new' }); await flush()
  delayed.resolve(response(status({ project: { id: 'old-private-project' }, execution: { deployMode: 'enabled' } })))
  await pendingSave
  tree = f.render(f.plugin.WorkflowPanel, { sessionId: 'new' })
  assert.match(text(tree), /new-project/u)
  assert.doesNotMatch(text(tree), /old-private-project/u)
  assert.equal(f.calls.filter(call => call.url.includes('sessionId=old')).length, 2)
  f.dispose()
})

test('real deployment blocker explains the machine gate instead of claiming the executor is missing', async () => {
  const f = harness(async () => response(status({ workflows: [{ id: 'deploy', steps: [{ id: 'apply', required: true, status: 'disabled', reason: 'ACTUAL_DEPLOY_DISABLED' }] }] })))
  f.render(); await flush(); const tree = f.render()
  assert.equal(button(tree, 'Сформировать план').props.disabled, true)
  assert.match(text(tree), /Реальный деплой выключен настройкой сборки/u)
  assert.match(text(tree), /права сеанса не включают доступ к базе/u)
  f.dispose()
})

test('reviewed real deployment may be planned in fixture-only mode without offering execution', async () => {
  const f = harness(async (_url, options) => options.method === 'POST'
    ? response({ ok: true, plan: { id: 'ready-real', planDigest: 'c'.repeat(64), steps: [{ id: 'apply', operation: 'deploy-apply', configured: true, effects: ['writesTargetData'] }] } })
    : response(status({ workflows: [{ id: 'real', steps: [{ id: 'apply', operation: 'deploy-apply', required: true, status: 'disabled', reason: 'ACTUAL_DEPLOY_DISABLED' }] }] })))
  f.render(); await flush(); let tree = f.render()
  assert.equal(button(tree, 'Сформировать план').props.disabled, false)
  assert.match(text(tree), /Можно сформировать план без запуска/u)
  await button(tree, 'Сформировать план').props.onClick(); tree = f.render()
  const view = flatten(tree).find(node => node.type === f.plugin.PlanView)
  const rendered = f.plugin.PlanView(view.props)
  assert.match(text(rendered), /План подготовлен; реальное исполнение выключено/u)
  const prompt = flatten(rendered).find(node => node.type === 'textarea').props.value
  assert.doesNotMatch(prompt, /airules_workflow_run/u)
  assert.match(prompt, /не запускай реальный деплой/u)
  assert.equal(f.calls.length, 2)
  f.dispose()
})
