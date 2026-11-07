import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, readdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readStyle, saveStyle, styleSync } from '../src/general-tools/lib/style.js'
import { bundledNode, renderForAgent, runNative } from '../src/general-tools/lib/render.js'
import { sessionScope } from '../src/general-tools/lib/session.js'

const temp = () => mkdtemp(join(tmpdir(), 'airules-general-'))
test('caveman off by default, explicit lite survives reload, does not leak to another session; CAS', async () => {
  const home = await temp()
  assert.deepEqual(await readStyle(home, 'one'), { mode: 'off', revision: null })
  const saved = await saveStyle(home, 'one', { mode: 'lite', revision: null })
  assert.equal(styleSync(home, 'one'), 'lite')
  assert.equal(styleSync(home, 'two'), 'off')
  await assert.rejects(saveStyle(home, 'one', { mode: 'off', revision: null }), /STALE_STYLE/)
  await saveStyle(home, 'one', { mode: 'off', revision: saved.revision })
  assert.equal(styleSync(home, 'one'), 'off')
  await assert.rejects(saveStyle(home, 'one', { mode: 'full' }), /STYLE_INVALID/)
})
test('native bundled node uses child execution authority; no PATH fallback', async () => {
  const exec = { agent: { session: {} }, callId: 'call1', token: Symbol('native') }
  let call
  const ctx = { tools: { get: () => ({}), execute: async arg => { call = arg; return { isError: false, value: { node: process.execPath } } } } }
  assert.equal(await bundledNode(ctx, exec), await bundledNode({}, {}, process.execPath))
  assert.equal(call.parent, exec.token); assert.equal(call.agent, exec.agent)
  assert.equal(call.rootCallId, 'call1'); assert.deepEqual(call.arguments, {})
  await assert.rejects(bundledNode({ tools: { get: () => undefined } }, exec), /BUNDLED_RUNTIME_REQUIRED/)
  await assert.rejects(bundledNode({ tools: { get: () => ({}), execute: async () => ({ isError: true }) } }, exec), /BUNDLED_RUNTIME_REQUIRED/)
})
test('read-only live and archived session scope can edit style metadata without changing execution policy', async () => {
  const root = await temp(), session = { id: 'one', header: { id: 'one', cwd: root } }
  const ctx = { sessions: { get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }, sessionProjections: { stateOf: () => '1c-airules' } }
  assert.equal((await sessionScope(ctx, 'one')).writable, false)
  assert.equal((await sessionScope(ctx, 'one')).preset, '1c-airules')
  ctx.sessions.get = () => undefined
  ctx.sessionPersistence = { stat: async () => ({ header: session.header, eventCount: 1, sizeBytes: 100 }), open: async () => ({ header: session.header, read: async () => ({ events: [] }), close: async () => {} }) }
  ctx.sessionProjections.restore = () => ({ checkpoint: { sandboxMode: { val: 'read-only' }, agentPreset: { val: 'python-airules' } } })
  assert.equal((await sessionScope(ctx, 'one')).preset, 'python-airules')
})
function context(root, mode = 'workspace-write') {
  const session = { id: 'render', header: { id: 'render', cwd: root } }
  const policy = { mode, sessionId: session.id, workspaceRoot: root }
  return { ctx: { sandboxPolicy: { resolve: () => policy } }, exec: { agent: { session } }, policy }
}
test('renderer denies read-only, path escape, non-mmd, custom scripts before any process', async () => {
  const root = await temp(); await writeFile(join(root, 'x.mmd'), 'graph LR\nA-->B')
  const c = context(root); let runs = 0
  const opts = { nodePath: process.execPath, run: async () => { runs++; throw new Error('unexpected') } }
  await assert.rejects(renderForAgent(context(root, 'read-only').ctx, { input: 'x.mmd', outDir: 'out' }, c.exec, opts), /WORKSPACE_WRITE_REQUIRED/)
  for (const args of [{ input: '../x.mmd', outDir: 'out' }, { input: 'x.js', outDir: 'out' }, { input: 'x.mmd', outDir: 'out', script: 'bad.js' }]) await assert.rejects(renderForAgent(c.ctx, args, c.exec, opts), /PATH_REJECTED|RENDER_INPUT_INVALID/)
  assert.equal(runs, 0)
})
test('native runner confines fixed argv, rechecks policy, strips secret env and stops on timeout', async () => {
  const root = await temp(), c = context(root), out = new EventEmitter(), err = new EventEmitter()
  let spawnArgs, confined = false, terminated = false
  c.ctx.sandbox = { confine: async argv => { confined = true; return { argv: ['sandbox', ...argv], enforcement: 'fixture', denialSignatures: [], runnerFailureRules: [] } } }
  c.ctx.subprocess = { spawn: args => { spawnArgs = args; return { stdout: out, stderr: err, done: new Promise(() => {}), terminate: async () => { terminated = true }, waitForExit: async () => true } } }
  await assert.rejects(runNative(c.ctx, { argv: ['node', 'fixed.mjs'], cwd: root, session: c.exec.agent.session, agent: c.exec.agent, policy: c.policy, helpers: { scrubbedParentEnv: () => ({ API_KEY: 'never', NODE_OPTIONS: 'bad', PATH: 'okay' }) }, timeoutMs: 20 }), /RENDER_TIMEOUT/)
  assert.equal(confined, true); assert.equal(terminated, true)
  assert.equal(spawnArgs.env.API_KEY, undefined); assert.equal(spawnArgs.env.NODE_OPTIONS, undefined)
  c.ctx.sandboxPolicy.resolve = () => ({ ...c.policy, mode: 'danger-full-access' })
  await assert.rejects(runNative(c.ctx, { argv: ['node'], cwd: root, session: c.exec.agent.session, agent: c.exec.agent, policy: c.policy, helpers: {} }), /NATIVE_POLICY_CHANGED/)
})
test('real pinned renderer creates a PNG through the same host validator', async () => {
  const root = await temp(); await writeFile(join(root, 'test.mmd'), 'graph LR\n    A[Project input] --> B{Validate}\n    B -->|Pass| C[PNG artifact]\n')
  const c = context(root)
  const run = async (_ctx, { argv, cwd }) => new Promise((accept, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true }); let stdout = ''
    child.stdout.on('data', chunk => stdout += chunk); child.on('error', reject)
    child.stderr.on('data', () => {}); child.on('close', exitCode => accept({ exitCode, stdout }))
  })
  const result = await renderForAgent(c.ctx, { input: 'test.mmd', outDir: 'artifacts' }, c.exec, { nodePath: process.execPath, run })
  assert.equal(result.ok, true); assert.equal(result.visualReview, 'required')
  assert.equal((await readFile(result.artifacts.png)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  await writeFile(new URL('../var/general-tools-png-preview.txt', import.meta.url), result.artifacts.png)
  console.log('PNG preview:', result.artifacts.png)
})
test('shipped renderer source equals canonical source (no install-only hotfix)', async () => {
  const source = 'D:/AI_Projects/project_rules/core/skills/craft-mermaid'
  const target = resolve('src/general-tools/runtime/mermaid')
  async function visit(dir, rel = '') { for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) { if (entry.name === 'node_modules') continue; const p = join(rel, entry.name); if (entry.isDirectory()) await visit(dir, p); else assert.deepEqual(await readFile(join(source, p)), await readFile(join(target, p)), p) } }
  await visit(target)
})

test('real host module service: supported preset opt-in + HTTP admission/CSRF + malformed requests', async () => {
  const root = await temp(), home = await temp()
  await cp(new URL('../src/general-tools/lib/', import.meta.url), root, { recursive: true })
  let source = await readFile(join(root, 'index.js'), 'utf8')
  for (const [name, suffix] of Object.entries({ 'dsh-home-paths': 'lib/index.js', 'dsh-subprocess': 'lib/index.js', 'dsh-sandbox': 'lib/index.js', schemastery: 'lib/index.mjs' })) {
    source = source.replaceAll(`'@deepseek-ai/${name}'`, JSON.stringify(new URL(`../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/${name}/${suffix}`, import.meta.url).href))
  }
  await writeFile(join(root, 'index.js'), source)
  const { pathToFileURL } = await import('node:url'), { Readable } = await import('node:stream')
  const { createGeneralService, handlerFor } = await import(pathToFileURL(join(root, 'index.js')))
  const session = { id: 'style', header: { id: 'style', cwd: home } }
  let preset = '1c-airules', rejected = false
  const ctx = { sessions: { get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: home }) }, sessionProjections: { stateOf: () => preset }, agentPresets: { composedPreset: () => preset }, connection: { requestRejection: () => rejected ? 'deny' : undefined } }
  const service = createGeneralService(ctx, home), agent = { session, ctx: {} }
  assert.equal(service.styleText(agent), '')
  await service.setStyle(session.id, { mode: 'lite', revision: null })
  assert.match(service.styleText(agent), /explicitly enabled/)
  assert.match(createGeneralService(ctx, home).styleText(agent), /explicitly enabled/)
  preset = 'standard'; assert.equal(service.styleText(agent), '')
  await assert.rejects(service.setStyle(session.id, { mode: 'off', revision: null }), /PRESET_UNSUPPORTED/)
  preset = '1c-airules'
  const handler = handlerFor(ctx, service)
  async function request(method, body, headers = {}) {
    const req = Readable.from(body ? [JSON.stringify(body)] : []); Object.assign(req, { method, url: '?sessionId=style', headers })
    let status, data
    await handler(req, { writeHead: s => status = s, end: s => data = JSON.parse(s) })
    return { status, data }
  }
  rejected = true; assert.equal((await request('GET')).status, 403); rejected = false
  const status = await request('GET'); assert.equal(status.status, 200)
  const body = { sessionId: 'style', mode: 'off', revision: status.data.revision }
  assert.equal((await request('POST', body, { 'content-type': 'application/json' })).status, 403)
  const headers = { 'content-type': 'application/json', 'x-dsh-csrf': status.data.csrfToken }
  assert.equal((await request('POST', { ...body, script: 'invalid' }, headers)).status, 400)
  assert.equal((await request('POST', body, headers)).status, 200)
  assert.equal(service.styleText(agent), '')
  assert.equal((await request('POST', body, headers)).status, 409)
})
