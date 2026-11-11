import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, PassThrough } from 'node:stream'
import { createSettingsStore, DEFAULTS } from '../src/git-maintenance/lib/settings.js'
import { createNativeMaintenance } from '../src/git-maintenance/lib/native.js'
import { createWorkerJob } from '../src/git-maintenance/lib/updater.js'

const REPO = resolve(import.meta.dirname, '..'), LIB = join(REPO, 'src/git-maintenance/lib')
async function loadController() {
  let source = await readFile(join(LIB, 'index.js'), 'utf8')
  source = source.replace(/import \{launchUpdateWorker\} from '\.\/worker-launch\.js'/u, 'const launchUpdateWorker=()=>{throw Error("UNEXPECTED_WORKER_LAUNCH")}')
    .replace(/from '(\.\/[^']+)'/gu, (_all, path) => `from '${pathToFileURL(resolve(LIB, path)).href}'`)
    .replace("from '@deepseek-ai/dsh-subprocess'", `from '${pathToFileURL(join(REPO, 'var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js')).href}'`)
    .replace("const bundled=fileURLToPath(new URL('../runtime/',import.meta.url))", `const bundled=${JSON.stringify(join(REPO, 'src/git-maintenance/runtime'))}`)
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}
const { createController } = await loadController()

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-host-')), project = join(root, 'project'), home = join(root, 'home'); await mkdir(project); await mkdir(home)
  t.after(async () => { const rel = relative(tmpdir(), root); assert.ok(!isAbsolute(rel) && rel.startsWith('maintenance-host-')); await rm(root, { recursive: true, force: true }) })
  const calls = { execution: [], source: [], plan: [], apply: [], rollback: [], status: [], detail: [], disposed: 0 }
  const agent = {}, current = { mode: 'danger-full-access', active: true, preset: '1c-airules', root: project, projectId: 'p1', sessionId: 'lead1' }
  const scope = () => ({ ...current, agent: current.active ? agent : null, policy: { mode: current.mode, workspaceRoot: current.root }, writable: current.mode !== 'read-only', globalWritable: current.mode === 'danger-full-access' })
  const native = {
    async scope(input) { if (input.projectId !== current.projectId || input.sessionId !== current.sessionId) throw Error('PROJECT_EXECUTOR_MISMATCH'); return scope() },
    async execution(input, reason, options) {
      calls.execution.push({ input, reason, options }); const selected = await native.scope(input)
      if (!selected.active || !selected.globalWritable) throw Error('MAINTENANCE_FULL_ACCESS_REQUIRED')
      const before = JSON.stringify([selected.root, selected.policy, selected.preset]), abort = new AbortController()
      return { scope: selected, signal: abort.signal, async verify() { abort.signal.throwIfAborted(); if (before !== JSON.stringify([current.root, scope().policy, current.preset]) || !current.active) throw Error('MAINTENANCE_SCOPE_CHANGED') }, dispose() { calls.disposed++; abort.abort() } }
    },
    run: async () => { throw Error('UNEXPECTED_PROCESS') }, verifyScope: async () => {}, dispose() {},
  }
  const settings = createSettingsStore(join(home, 'settings.json'))
  const configured = structuredClone(DEFAULTS); configured.airules.localPath = join(root, 'configured-canonical'); await settings.save(configured, 'missing')
  let applyFailure
  const rollout = {
    async status(selected) { calls.status.push(selected); return { projectRoot: selected.root, active: selected.active, managed: false, receipts: [] } },
    async detail(selected, input) { calls.detail.push({ selected, input }); return { path: input.path } },
    async plan(selected, input, execution) { await execution.verify(); calls.plan.push({ selected, input }); return { planId: 'fixture-plan', status: 'ready', projectRoot: selected.root } },
    async apply(selected, input, execution) { await execution.verify(); calls.apply.push({ selected, input }); if (applyFailure) throw applyFailure; return { status: 'applied', receiptId: 'fixture-receipt' } },
    async rollback(selected, input, execution) { await execution.verify(); calls.rollback.push({ selected, input }); return { status: 'rolled-back', receiptId: input.receiptId } },
  }
  const ctx = { connection: { requestRejection: request => request.headers.cookie === 'native-admitted' ? undefined : 'denied' }, dshHomePath: () => home }
  const controller = createController(ctx, { home, native, settings,
    sourceFactory: options => { assert.equal(options.run, native.run); return { async prepare(input, execution) { await execution.verify(); calls.source.push(input); return { root: join(root, 'pinned-source'), commit: 'a'.repeat(40), repository: input.repository, ref: input.ref, source: input.localPath ? 'local' : 'git', inventoryDigest: 'b'.repeat(64) } } } },
    rolloutFactory: options => { assert.equal(options.run, native.run); return rollout },
    installerFactory: async () => { throw Error('UNEXPECTED_INSTALLER') }, updaterFactory: () => { throw Error('UNEXPECTED_UPDATER') }, launchWorker: async () => { throw Error('UNEXPECTED_WORKER') },
    ...overrides,
  })
  async function request({ method = 'GET', body, query = '', admitted = true, token, contentType = 'application/json' } = {}) {
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))], req = Readable.from(raw)
    req.method = method; req.url = '/airules/git-maintenance' + query; req.headers = { ...(admitted ? { cookie: 'native-admitted' } : {}), 'content-type': contentType, ...(token ? { 'x-airules-csrf': token } : {}) }
    let status, headers, bytes
    await controller.handler(req, { writeHead(value, meta) { status = value; headers = meta }, end(value) { bytes = value } })
    return { status, headers, value: JSON.parse(bytes) }
  }
  const pin = { projectId: 'p1', sessionId: 'lead1', expectedProjectRoot: project, expectedExecutorRevision: 'fixture-revision' }
  return { root, home, project, calls, current, native, controller, request, settings, configured, pin, setApplyFailure(value) { applyFailure = value } }
}

test('configuration is readable without an active agent; admitted GET never executes a process, model or mutation', async t => {
  const f = await fixture(t); f.current.active = false
  const result = await f.request()
  assert.equal(result.status, 200); assert.equal(result.value.ok, true); assert.equal(result.value.settings.airules.localPath, f.configured.airules.localPath)
  assert.equal(result.value.defaults.airules.repository, 'https://github.com/s0loww/airules.git'); assert.ok(result.value.csrfToken)
  assert.equal(f.calls.execution.length, 0); assert.equal(f.calls.source.length, 0); assert.equal(f.calls.plan.length, 0)
  assert.equal(result.headers['cache-control'], 'no-store')
  const cold = await f.request({ query: '?action=projectStatus&projectId=p1&sessionId=lead1' })
  assert.equal(cold.status, 200); assert.equal(cold.value.project.active, false); assert.equal(f.calls.execution.length, 0)
})

test('native admission, CSRF, JSON and exact mutation fields are checked before any execution', async t => {
  const f = await fixture(t), config = await f.request(), token = config.value.csrfToken
  assert.equal((await f.request({ admitted: false })).status, 403)
  assert.equal((await f.request({ method: 'POST', body: { ...f.pin, action: 'rulesPlan', sourceMode: 'git' } })).status, 403)
  assert.equal((await f.request({ method: 'DELETE' })).status, 405)
  for (const extra of [{ repository: 'https://evil.invalid' }, { localPath: f.root }, { projectRoot: f.root }, { password: 'synthetic-secret-not-for-response' }]) {
    const result = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'rulesPlan', sourceMode: 'git', ...extra } })
    assert.equal(result.status, 400); assert.equal(result.value.error, 'MAINTENANCE_INPUT_INVALID'); assert.ok(!JSON.stringify(result.value).includes('synthetic-secret'))
  }
  assert.equal((await f.request({ method: 'POST', token, contentType: 'text/plain', body: '{}' })).status, 400)
  assert.equal((await f.request({ method: 'POST', token, body: '{' })).status, 400)
  assert.equal(f.calls.execution.length, 0)
})

test('authenticated GUI commands use the explicit UI capability; direct calls do not acquire it implicitly', async t => {
  const f = await fixture(t), token = (await f.request()).value.csrfToken
  const result = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'rulesPlan', sourceMode: 'git' } })
  assert.equal(result.status, 200); assert.equal(result.value.plan.status, 'ready'); assert.deepEqual(f.calls.execution[0].options, { uiInitiated: true })
  await f.controller.act({ ...f.pin, action: 'rulesPlan', sourceMode: 'local' })
  assert.deepEqual(f.calls.execution[1].options, { uiInitiated: false }); assert.equal(f.calls.disposed, 2)
})

test('configured Git and local sources are pinned for rules preview; project paths never become source paths', async t => {
  const f = await fixture(t)
  await f.controller.act({ ...f.pin, action: 'rulesPlan', sourceMode: 'git', includeSkills: true })
  assert.deepEqual(f.calls.source[0], { kind: 'airules', repository: f.configured.airules.repository, ref: f.configured.airules.ref })
  assert.equal(f.calls.plan[0].selected.root, f.project); assert.equal(f.calls.plan[0].input.source.commit, 'a'.repeat(40)); assert.equal(f.calls.plan[0].input.includeSkills, true)
  await f.controller.act({ ...f.pin, action: 'rulesPlan', sourceMode: 'local' })
  assert.equal(f.calls.source[1].localPath, f.configured.airules.localPath); assert.notEqual(f.calls.source[1].localPath, f.project)
  assert.equal(f.calls.apply.length, 0)
})

test('readonly or foreign project scope stops writes and a partial-operation receipt remains available in HTTP errors', async t => {
  const f = await fixture(t), token = (await f.request()).value.csrfToken
  await f.controller.act({ ...f.pin, action: 'rulesPlan', sourceMode: 'git' }); f.current.mode = 'read-only'
  const denied = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'rulesApply', planId: 'fixture-plan' } })
  assert.equal(denied.status, 400); assert.equal(denied.value.error, 'MAINTENANCE_FULL_ACCESS_REQUIRED'); assert.equal(f.calls.apply.length, 0)
  f.current.mode = 'danger-full-access'
  const foreign = await f.request({ method: 'POST', token, body: { ...f.pin, projectId: 'other', action: 'rulesApply', planId: 'fixture-plan' } })
  assert.equal(foreign.value.error, 'PROJECT_EXECUTOR_MISMATCH'); assert.equal(f.calls.apply.length, 0)
  const error = Error('ROLLOUT_PROJECT_CHANGED'); error.receiptId = 'synthetic-interrupted-receipt'; f.setApplyFailure(error)
  const interrupted = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'rulesApply', planId: 'fixture-plan' } })
  assert.equal(interrupted.status, 409); assert.equal(interrupted.value.receiptId, error.receiptId); assert.equal(interrupted.value.error, error.message)
})

test('settings save uses CAS and rejects invalid executable paths and credential-bearing source URLs without leaking values', async t => {
  const f = await fixture(t), initial = await f.request(), token = initial.value.csrfToken, settings = structuredClone(f.configured)
  settings.airules.ref = 'release/v2'
  const save = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'saveSettings', settings, revision: initial.value.revision } })
  assert.equal(save.status, 200); assert.equal(save.value.settings.airules.ref, 'release/v2')
  const stale = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'saveSettings', settings: f.configured, revision: initial.value.revision } })
  assert.equal(stale.status, 409); assert.equal(stale.value.error, 'MAINTENANCE_SETTINGS_STALE')
  for (const mutate of [value => { value.python = 'cmd.exe /c arbitrary' }, value => { value.airules.localPath = '../outside' }, value => { value.airules.repository = 'https://user:synthetic-secret@github.com/x/y.git' }]) {
    const bad = structuredClone(settings); mutate(bad)
    const result = await f.request({ method: 'POST', token, body: { ...f.pin, action: 'saveSettings', settings: bad, revision: save.value.revision } })
    assert.equal(result.status, 400); assert.ok(!JSON.stringify(result.value).includes('synthetic-secret'))
  }
  assert.equal((await f.settings.read()).settings.airules.ref, 'release/v2')
})

function nativeFixture() {
  const state = { mode: 'danger-full-access', active: true, agent: {}, root: resolve('native-fixture-project'), approvals: 0, confines: 0, spawns: [], requests: [] }
  const selected = () => ({ projectId: 'p1', sessionId: 'lead1', root: state.root, preset: '1c-airules', policy: { mode: state.mode, workspaceRoot: state.root }, agent: state.active ? state.agent : null, active: state.active, globalWritable: state.mode === 'danger-full-access', writable: state.mode !== 'read-only' })
  const ctx = {
    airulesProjects: { async resolveInput(input, options) { state.requests.push({ input, options }); if (input.projectId !== 'p1' || input.sessionId !== 'lead1') throw Error('PROJECT_EXECUTOR_MISMATCH'); if (options.active && !state.active) throw Error('PROJECT_ACTIVE_REQUIRED'); if (options.full && state.mode !== 'danger-full-access') throw Error('PROJECT_FULL_ACCESS_REQUIRED'); if (options.writing && state.mode === 'read-only') throw Error('PROJECT_WRITE_REQUIRED'); return selected() } },
    approval: { async request() { state.approvals++; return 'allowed-once' } },
    sandbox: { async confine(argv) { state.confines++; return { argv: ['native-sandbox', ...argv] } } },
    subprocess: { async resolveExecutable(value) { return resolve(value === 'git' ? 'git.exe' : value) }, spawn(options) { state.spawns.push(options); const stdout = new PassThrough(), stderr = new PassThrough(); let stopped = false; const handle = { stdout, stderr, done: Promise.resolve({ exitCode: 0 }), async waitForExit() { return true }, async terminate() { stopped = true }, get stopped() { return stopped } }; queueMicrotask(() => { stdout.write('native fixture output'); stderr.write('synthetic-secret-error-that-is-not-returned'); stdout.end(); stderr.end() }); return handle } },
  }
  return { state, ctx, selected, native: createNativeMaintenance(ctx, { scrubbedParentEnv: () => ({ PATH: process.env.PATH ?? '' }) }), pin: { projectId: 'p1', sessionId: 'lead1' } }
}

test('native execution requires pinned full active scope, skips outside-turn approval only for explicit GUI actions', async () => {
  const f = nativeFixture(); f.state.active = false
  await assert.rejects(f.native.execution(f.pin, 'fixture'), /PROJECT_ACTIVE_REQUIRED/)
  f.state.active = true; f.state.mode = 'read-only'; await assert.rejects(f.native.execution(f.pin, 'fixture'), /PROJECT_FULL_ACCESS_REQUIRED|PROJECT_WRITE_REQUIRED/)
  f.state.mode = 'danger-full-access'
  const direct = await f.native.execution(f.pin, 'fixture'); assert.equal(f.state.approvals, 1); direct.dispose()
  const ui = await f.native.execution(f.pin, 'fixture', { uiInitiated: true }); assert.equal(f.state.approvals, 1)
  f.state.mode = 'read-only'; await assert.rejects(ui.verify(), /PROJECT_WRITE_REQUIRED|MAINTENANCE_SCOPE_CHANGED/); ui.dispose(); f.native.dispose()
})

test('native process route uses executable resolution, scrubbed environment and confinement, preserves execution identity and redacts stderr', async () => {
  const f = nativeFixture(), execution = await f.native.execution(f.pin, 'fixture', { uiInitiated: true })
  const output = await f.native.run(['git', '--version'], { cwd: f.state.root, execution, env: { GIT_CONFIG_NOSYSTEM: '1' } })
  assert.equal(output.code, 0); assert.equal(output.stdout, 'native fixture output'); assert.equal(output.stderr, ''); assert.equal(f.state.spawns.length, 1)
  assert.equal(f.state.spawns[0].env.GIT_TERMINAL_PROMPT, '0'); assert.equal(f.state.spawns[0].env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(f.state.spawns[0].stdio.stdin, 'ignore')
  await assert.rejects(f.native.run(['git', '--version'], { cwd: f.state.root }), /MAINTENANCE_NATIVE_EXECUTION_REQUIRED/)
  await assert.rejects(f.native.run(['git', '--version'], { cwd: f.state.root, execution, env: { UNRELATED_SECRET: 'synthetic' } }), /MAINTENANCE_ENV_INVALID/)
  execution.dispose(); f.state.mode = 'workspace-write'
  const confined = { scope: f.selected(), signal: new AbortController().signal, verify: async () => {} }
  await f.native.run(['git', '--version'], { cwd: f.state.root, execution: confined }); assert.equal(f.state.confines, 1); assert.equal(f.state.spawns.at(-1).argv[0], 'native-sandbox')
  f.native.dispose()
})

test('revoking scope while resolving the executable prevents native process creation', async () => {
  const f = nativeFixture(), execution = await f.native.execution(f.pin, 'fixture', { uiInitiated: true })
  f.ctx.subprocess.resolveExecutable = async value => { f.state.mode = 'read-only'; return resolve(value) }
  await assert.rejects(f.native.run(['git', '--version'], { cwd: f.state.root, execution }), /PROJECT_WRITE_REQUIRED|MAINTENANCE_SCOPE_CHANGED/)
  assert.equal(f.state.spawns.length, 0); execution.dispose(); f.native.dispose()
})

test('authenticated cancellation reads only its private job token and remains available after scope revocation', async t => {
  const privateToken = randomBytes(32).toString('base64url'), transactionId = randomUUID(), calls = []
  const service = { async cancelPending(value) { calls.push(value); assert.deepEqual(value, { transactionId, token: privateToken }); return { transactionId, state: 'cancelled' } }, async status() { return { transactions: [{ transactionId, state: 'cancelled' }] } } }
  const f = await fixture(t, { installerFactory: async () => ({}), updaterFactory: () => service })
  await createWorkerJob({ root: join(f.home, 'updates'), engineRoot: join(f.root, 'engine'), transactionId, token: privateToken })
  const csrf = (await f.request()).value.csrfToken; f.current.mode = 'read-only'; f.current.active = false
  assert.equal((await f.request({ method: 'POST', body: { action: 'cancelUpdate', transactionId } })).status, 403)
  assert.equal((await f.request({ method: 'POST', token: csrf, admitted: false, body: { action: 'cancelUpdate', transactionId } })).status, 403)
  await assert.rejects(f.controller.act({ action: 'cancelUpdate', transactionId }), /UPDATE_CANCEL_UI_REQUIRED/)
  const cancelled = await f.request({ method: 'POST', token: csrf, body: { action: 'cancelUpdate', transactionId } })
  assert.equal(cancelled.status, 200); assert.equal(cancelled.value.cancelled.state, 'cancelled'); assert.ok(!JSON.stringify(cancelled).includes(privateToken)); assert.equal(calls.length, 1); assert.equal(f.calls.execution.length, 0)
  const traversal = await f.request({ method: 'POST', token: csrf, body: { action: 'cancelUpdate', transactionId: '../../outside' } }); assert.equal(traversal.value.error, 'UPDATE_ID_INVALID'); assert.equal(calls.length, 1)
})

test('failed or revoked worker launch cancels the exact queued transaction before reporting failure', async t => {
  for (const mode of ['launch-failed', 'revoked-before-launch', 'revoked-after-ready']) {
    const privateToken = randomBytes(32).toString('base64url'), transactionId = randomUUID(), cancelled = [], launched = []
    let f
    const service = { async queue() { if (mode === 'revoked-before-launch') f.current.mode = 'read-only'; return { transactionId, token: privateToken, state: 'waiting-for-desktop-exit' } }, async cancelPending(value) { cancelled.push(value); return { transactionId, state: 'cancelled' } } }
    f = await fixture(t, { installerFactory: async () => ({}), updaterFactory: () => service, launchWorker: async () => { launched.push(true); if (mode === 'launch-failed') throw Error('UPDATE_WORKER_START_FAILED'); f.current.mode = 'read-only'; return { started: true } } })
    const configured = structuredClone(f.configured); configured.harness.engineRoot = join(f.root, 'engine'); await f.settings.save(configured, (await f.settings.read()).revision)
    const csrf = (await f.request()).value.csrfToken, response = await f.request({ method: 'POST', token: csrf, body: { ...f.pin, action: 'queueUpdate', planId: 'reviewed-plan' } })
    assert.equal(response.status, mode === 'launch-failed' ? 400 : 409); assert.deepEqual(cancelled, [{ transactionId, token: privateToken }]); assert.equal(launched.length, mode === 'revoked-before-launch' ? 0 : 1); assert.ok(!JSON.stringify(response).includes(privateToken)); assert.equal(response.value.queued, undefined)
  }
})

test('read-only UI can cancel a waiting transaction without invoking project execution or leaking a token', async () => {
  const code = await readFile(join(LIB, 'client.js'), 'utf8'), transactionId = randomUUID(), requests = [], registered = new Map()
  const values = [ 'p1', { csrfToken: 'native-csrf' }, structuredClone(DEFAULTS), false, '', '', null, '', 'git', false, false, null, null, null, null, false, [{ transactionId, state: 'waiting-for-desktop-exit', version: 'fixture' }], null ]
  let cursor = 0, loaded
  const React = { Fragment: Symbol('fragment'), useRef: value => ({ current: value }), useEffect() {}, useState(value) { const at = cursor++; if (!(at in values)) values[at] = typeof value === 'function' ? value() : value; return [values[at], next => { values[at] = typeof next === 'function' ? next(values[at]) : next }] }, createElement(type, props, ...children) { return typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children } } }
  const projects = { useProject: () => ({ projectId: 'p1', active: false, globalWritable: false, loading: true }), ProjectPicker: () => null, projectFetch() { throw Error('PROJECT_EXECUTION_MUST_NOT_BE_USED_FOR_CANCEL') } }
  runInNewContext(code, { window: { __ModuleLoader__: { load(value) { loaded = value.factory(name => name === 'react' ? React : projects) } } }, URLSearchParams, fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, async json() { return { ok: true, cancelled: { transactionId, state: 'cancelled' }, updates: { transactions: [{ transactionId, state: 'cancelled' }] } } } } } })
  loaded.apply({ slots: { inject(_name, fn) { fn() }, register(meta, component) { registered.set(meta.id, component) } } })
  const tree = registered.get('airules-harness-update')(), visit = node => !node ? [] : Array.isArray(node) ? node.flatMap(visit) : typeof node === 'object' ? [node, ...visit(node.children)] : []
  const button = visit(tree).find(node => node.type === 'button' && node.children.includes('Отменить ожидающую операцию'))
  assert.ok(button); assert.equal(button.props.disabled, false); await button.props.onClick()
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/airules/git-maintenance'); assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'cancelUpdate', transactionId }); assert.equal(requests[0].options.headers['x-airules-csrf'], 'native-csrf'); assert.equal(values[16][0].state, 'cancelled')
})
