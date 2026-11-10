import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { createController, validateConfig } from '../src/memory-workspace/lib/control.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airules-memory-control-'))
  t.after(async () => { const rel = relative(resolve(tmpdir()), root); assert.ok(!isAbsolute(rel) && rel.startsWith('airules-memory-control-')); await rm(root, { recursive: true, force: true }) })
  const configPath = join(root, 'config.json'), authPath = join(root, 'auth.json')
  const config = { enabled: true, endpoint: 'http://127.0.0.1:18080', localProcessing: true }
  await writeFile(configPath, JSON.stringify(config)); await writeFile(authPath, JSON.stringify({ apiKey: 'test-private-key' }))
  const messages = [], calls = [], factories = []
  const agent = { status: 'idle', ctx: {}, session: { id: 'one', header: { id: 'one', cwd: root } }, followup: message => { messages.push(message) } }
  const policy = { mode: 'workspace-write', sessionId: 'one', workspaceRoot: root }
  const ctx = { connection: { requestRejection: () => undefined }, agents: { get: id => id === 'one' ? agent : undefined }, agentPresets: { composedPreset: () => '1c-airules' }, sandboxPolicy: { resolve: () => policy }, approval: { request: async () => 'allowed-once' } }
  const service = Object.fromEntries(['status', 'listDocuments', 'recall', 'graph', 'remember', 'process', 'task'].map(name => [name, async (...args) => { calls.push({ name, args }); return { state: 'fixture' } }]))
  const controller = createController(ctx, { configPath, serviceFactory: options => { factories.push(options); return service }, createUserMessage: value => value })
  async function request(method, input = {}, token) {
    let code, body
    const req = Readable.from(method === 'POST' ? [JSON.stringify(input)] : [])
    Object.assign(req, { method, url: `/?${new URLSearchParams(input)}`, headers: { 'content-type': 'application/json', ...(token ? { 'x-airules-csrf': token } : {}) } })
    await controller.handler(req, { writeHead: value => { code = value }, end: value => { body = JSON.parse(value) } })
    return { code, body }
  }
  const view = await request('GET', { action: 'configuration', sessionId: 'one' })
  return { root, config, configPath, authPath, agent, policy, ctx, calls, messages, factories, controller, request, view: view.body, exec: { agent, callId: 'test-call', signal: new AbortController().signal } }
}

test('memory HTTP native admission, GET mutation and CSRF reject without backend or chat effects', async t => {
  const f = await fixture(t)
  for (const action of ['configure', 'remember', 'process', 'recall']) assert.equal((await f.request('GET', { action, sessionId: 'one' })).code, 405)
  assert.equal((await f.request('POST', { action: 'remember', sessionId: 'one', confirm: true })).code, 403)
  f.ctx.connection.requestRejection = () => 'denied'
  assert.equal((await f.request('GET', { action: 'configuration' })).code, 403)
  assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []); assert.deepEqual(f.factories, [])
})

test('memory reads derive project and never accept caller root/dataset or another execution agent', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', { action: 'documents', sessionId: 'foreign' })).code, 400)
  await assert.rejects(f.controller.act({ action: 'documents', sessionId: 'one', dataset: 'foreign' }, f.exec), /MEMORY_INPUT_INVALID/)
  await assert.rejects(f.controller.act({ action: 'documents', sessionId: 'one' }, { ...f.exec, agent: { ...f.agent } }), /MEMORY_ACTIVE_PROJECT_REQUIRED/)
  await f.controller.act({ action: 'documents', sessionId: 'one' }, f.exec)
  assert.equal(f.calls[0].args[0], f.root)
  assert.equal(f.factories[0].apiKey, 'test-private-key')
  assert.equal(JSON.stringify(f.view).includes('test-private-key'), false)
  f.policy.sessionId = 'foreign'
  await assert.rejects(f.controller.act({ action: 'status', sessionId: 'one' }, f.exec), /MEMORY_NATIVE_POLICY_REQUIRED/)
})

test('memory mutation requires writable native scope, explicit confirmation and execution', async t => {
  const f = await fixture(t), input = { action: 'remember', sessionId: 'one', text: 'verified fixture', confirm: true }
  f.policy.mode = 'read-only'
  await assert.rejects(f.controller.act(input, f.exec), /MEMORY_WRITE_REQUIRED/)
  f.policy.mode = 'workspace-write'
  await assert.rejects(f.controller.act({ ...input, confirm: false }, f.exec), /MEMORY_CONFIRM_REQUIRED/)
  await assert.rejects(f.controller.act(input), /MEMORY_NATIVE_EXECUTION_REQUIRED/)
  assert.equal(f.calls.length, 0); assert.equal(f.factories.length, 0)
})

test('native approval precedes every backend construction and request; denied outcome does not submit', async t => {
  const f = await fixture(t)
  let allow
  f.ctx.approval.request = () => new Promise(resolve => { allow = resolve })
  const work = f.controller.act({ action: 'remember', sessionId: 'one', text: 'fixture', confirm: true }, f.exec)
  while (!allow) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, []); assert.deepEqual(f.factories, [])
  allow('denied'); await assert.rejects(work, /MEMORY_APPROVAL_REQUIRED/)
  f.ctx.approval.request = async () => 'allowed-once'
  await f.controller.act({ action: 'remember', sessionId: 'one', text: 'fixture', confirm: true }, f.exec)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'remember')
})

test('scope and configuration changes during native approval reject before backend requests', async t => {
  const f = await fixture(t), input = { action: 'remember', sessionId: 'one', text: 'fixture', confirm: true }
  f.ctx.approval.request = async () => { f.agent.session.header.cwd = join(f.root, 'other'); f.policy.workspaceRoot = f.agent.session.header.cwd; return 'allowed-once' }
  await assert.rejects(f.controller.act(input, f.exec), /MEMORY_SCOPE_CHANGED/)
  f.agent.session.header.cwd = f.root; f.policy.workspaceRoot = f.root
  f.ctx.approval.request = async () => { await writeFile(f.configPath, JSON.stringify({ ...f.config, endpoint: 'http://127.0.0.1:18081' })); return 'allowed-once' }
  await assert.rejects(f.controller.act(input, f.exec), /MEMORY_CONFIG_STALE/)
  assert.deepEqual(f.calls, [])
})

test('memory UI queues user data into native chat without doing the upload or claiming success', async t => {
  const f = await fixture(t)
  const result = await f.request('POST', { action: 'remember', sessionId: 'one', text: 'fixture source=unit', title: 'note', confirm: true, expectedRevision: f.view.revision }, f.view.csrfToken)
  assert.equal(result.code, 200); assert.equal(result.body.submitted, true); assert.equal(result.body.processingStarted, false)
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].source.kind, 'user')
  assert.match(f.messages[0].content[0].text, /fixture source=unit/)
  assert.deepEqual(f.calls, []); assert.deepEqual(f.factories, [])
  f.agent.status = 'running'
  assert.equal((await f.request('POST', { action: 'process', sessionId: 'one', confirm: true, expectedRevision: f.view.revision }, f.view.csrfToken)).body.error, 'MEMORY_CHAT_BUSY')
})

test('machine config uses full native mode and CAS; secret fields/remote URLs rejected', async t => {
  const f = await fixture(t), input = { action: 'configure', sessionId: 'one', expectedRevision: f.view.revision, config: { ...f.config, enabled: false } }
  assert.equal((await f.request('POST', input, f.view.csrfToken)).body.error, 'MEMORY_FULL_ACCESS_REQUIRED')
  f.policy.mode = 'danger-full-access'
  assert.equal((await f.request('POST', input, f.view.csrfToken)).code, 200)
  assert.equal((await f.request('POST', input, f.view.csrfToken)).code, 409)
  assert.equal(JSON.parse(await readFile(f.configPath)).enabled, false)
  assert.throws(() => validateConfig({ ...f.config, apiKey: 'bad' }), /MEMORY_CONFIG_INVALID/)
  assert.throws(() => validateConfig({ ...f.config, endpoint: 'http://example.com' }), /MEMORY_LOOPBACK_REQUIRED/)
})

test('authentication rotation during approval is rejected and private key never appears in HTTP errors', async t => {
  const f = await fixture(t)
  f.ctx.approval.request = async () => { await writeFile(f.authPath, JSON.stringify({ apiKey: 'rotated-private-key' })); return 'allowed-once' }
  await assert.rejects(f.controller.act({ action: 'remember', sessionId: 'one', text: 'fixture', confirm: true }, f.exec), /MEMORY_CONFIG_STALE/)
  await writeFile(f.authPath, '{broken test-private-key')
  const response = await f.request('GET', { action: 'status', sessionId: 'one' })
  assert.equal(JSON.stringify(response).includes('test-private-key'), false)
  assert.deepEqual(f.calls, [])
})

test('controller single-flight rejects another operation and configuration change until approval/request settles', async t => {
  const f = await fixture(t)
  let decide
  f.ctx.approval.request = () => new Promise(resolve => { decide = resolve })
  const pending = f.controller.act({ action: 'remember', sessionId: 'one', text: 'verified once', confirm: true }, f.exec)
  while (!decide) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.controller.act({ action: 'status', sessionId: 'one' }, f.exec), /MEMORY_OPERATION_BUSY/)
  f.policy.mode = 'danger-full-access'
  const configure = await f.request('POST', { action: 'configure', sessionId: 'one', expectedRevision: f.view.revision, config: { ...f.config, endpoint: 'http://127.0.0.1:18081' } }, f.view.csrfToken)
  assert.equal(configure.body.error, 'MEMORY_OPERATION_BUSY')
  assert.equal(JSON.parse(await readFile(f.configPath)).endpoint, f.config.endpoint)
  decide('allowed-once'); await pending
  await writeFile(f.authPath, JSON.stringify({ apiKey: 'new-key-after-completion' }))
  await f.controller.act({ action: 'status', sessionId: 'one' }, f.exec)
  assert.equal(f.factories.length, 2)
  assert.equal(f.factories[0].journalPath, f.factories[1].journalPath)
  assert.equal(f.factories[1].apiKey, 'new-key-after-completion')
})

test('native subagent lineage permits retrieval but refuses memory and machine configuration writes', async t => {
  const f = await fixture(t)
  f.agent.session.header.origin = 'subagent'; f.agent.session.header.parentSession = 'parent'
  await f.controller.act({ action: 'documents', sessionId: 'one' }, f.exec)
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.controller.act({ action: 'remember', sessionId: 'one', text: 'candidate', confirm: true }, f.exec), /MEMORY_ORCHESTRATOR_WRITE_REQUIRED/)
  f.policy.mode = 'danger-full-access'
  assert.equal((await f.request('POST', { action: 'configure', sessionId: 'one', expectedRevision: f.view.revision, config: f.config }, f.view.csrfToken)).body.error, 'MEMORY_ORCHESTRATOR_WRITE_REQUIRED')
  assert.equal(f.calls.length, 1)
})
