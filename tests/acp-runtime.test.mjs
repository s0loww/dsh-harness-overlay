import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createDesktopAcpController, ACP_READY } from '../src/acp/lib/controller.js'
import { createAcpControlHandler } from '../src/acp/lib/control.js'
import { installOutboundPolicy, outboundAllowed, resolveBundledAcpAgents } from '../src/acp/lib/outbound.js'

function root(t) {
  const directory = mkdtempSync(join(tmpdir(), 'airules-acp-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('ACP controller starts disabled, authenticates one local pipe and cleans only its endpoint', async t => {
  const home = root(t)
  let mounted = 0, disposed = 0
  const controller = createDesktopAcpController({ home, clientPath: '/test/connect.mjs', write: writeFileSync,
    mount: () => { mounted++; return () => { disposed++ } } })
  t.after(() => controller.dispose())
  assert.equal((await controller.initialize()).status, 'stopped')
  assert.deepEqual(controller.snapshot().connection.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(existsSync(join(home, 'airules-acp-endpoint.json')), false)
  const started = await controller.start()
  assert.equal(started.status, 'running')
  assert.equal(started.autoStart, false)
  assert.equal('token' in started, false)
  const endpoint = JSON.parse(readFileSync(join(home, 'airules-acp-endpoint.json'), 'utf8'))
  const denied = connect(endpoint.pipe); denied.on('error', () => {})
  await once(denied, 'connect'); denied.write('{"token":"wrong"}\n'); await once(denied, 'close')
  assert.equal(mounted, 0)
  const socket = connect(endpoint.pipe)
  socket.on('error', () => {})
  await once(socket, 'connect')
  const acknowledged = once(socket, 'data')
  socket.write(JSON.stringify({ token: endpoint.token }) + '\n')
  assert.equal(String((await acknowledged)[0]), ACP_READY)
  assert.equal(controller.snapshot().activeConnections, 1)
  assert.equal(mounted, 1)
  const closed = once(socket, 'close')
  await controller.stop(); await closed
  assert.equal(disposed, 1)
  assert.equal(existsSync(join(home, 'airules-acp-endpoint.json')), false)
  assert.equal(controller.snapshot().status, 'stopped')
})

test('ACP explicit autostart preference is independent of start and stop', async t => {
  const home = root(t)
  const controller = createDesktopAcpController({ home, clientPath: '/test/connect.mjs', mount: () => () => {}, write: writeFileSync })
  t.after(() => controller.dispose())
  await controller.setAutoStart(true)
  assert.equal(controller.snapshot().status, 'stopped')
  await assert.rejects(controller.setAutoStart('true'), /ACP_AUTOSTART_INVALID/)
  const restored = createDesktopAcpController({ home, clientPath: '/test/connect.mjs', mount: () => () => {}, write: writeFileSync })
  t.after(() => restored.dispose())
  assert.equal((await restored.initialize()).status, 'running')
  await restored.stop()
  assert.equal(restored.snapshot().autoStart, true)
})

test('ACP control requires native admission and CSRF before any mutation', async () => {
  const actions = []
  const controller = { snapshot: () => ({ status: 'stopped', autoStart: false }), start: async () => actions.push('start'), stop: async () => actions.push('stop'), setAutoStart: async value => actions.push(value) }
  const accepted = { requestRejection: () => undefined }
  const handler = createAcpControlHandler(controller, { connection: accepted, token: 'test-token' })
  const call = async (use, method, payload, token) => {
    const request = { method, headers: { 'x-dsh-csrf': token }, async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)) } }
    const response = { writeHead(code) { this.status = code }, end(text) { this.value = JSON.parse(text) } }
    await use(request, response); return response
  }
  assert.equal((await call(createAcpControlHandler(controller), 'GET')).status, 403)
  const current = await call(handler, 'GET')
  assert.equal(current.value.csrfToken, 'test-token')
  assert.equal((await call(handler, 'POST', { action: 'start' })).status, 403)
  assert.deepEqual(actions, [])
  assert.equal((await call(handler, 'POST', { action: 'start' }, current.value.csrfToken)).status, 200)
  assert.deepEqual(actions, ['start'])
  assert.equal((await call(handler, 'POST', { action: 'unknown' }, current.value.csrfToken)).status, 400)
})

test('ACP outgoing command requires an installed absolute non-shell executable and clears paid API keys', t => {
  const directory = root(t), file = join(directory, 'adapter.exe')
  writeFileSync(file, 'fixture')
  const agents = resolveBundledAcpAgents({ codex: { name: 'Codex', command: file, args: ['--test'], env: { OPENAI_API_KEY: 'fixture-value', CUSTOM: 'value' } } })
  assert.equal(agents.codex.command, file)
  assert.deepEqual(agents.codex.args, ['--test'])
  assert.equal(agents.codex.env.OPENAI_API_KEY, '')
  assert.equal(agents.codex.env.CUSTOM, 'value')
  assert.throws(() => resolveBundledAcpAgents({ a: { command: 'npx' } }), /ABSOLUTE_REQUIRED/)
  assert.throws(() => resolveBundledAcpAgents({ a: { command: join(directory, 'missing.exe') } }), /EXECUTABLE_REJECTED/)
  const shell = join(directory, 'cmd.exe'); writeFileSync(shell, 'fixture')
  assert.throws(() => resolveBundledAcpAgents({ a: { command: shell } }), /EXECUTABLE_REJECTED/)
  assert.throws(() => resolveBundledAcpAgents({ a: { command: file, args: ['x\0y'] } }), /ARGUMENTS_INVALID/)
})

test('outgoing ACP preserves native access: only BUILD, 1c-airules and explicit full access can dispatch', async () => {
  let planning = false, mode = 'danger-full-access'
  const handlers = new Map()
  const ctx = { get(name) { if (name === 'planMode') return { get: () => ({ active: planning }) }; if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) } }, on: (event, handler) => handlers.set(event, handler) }
  const agent = { session: { header: { agentPreset: '1c-airules' } }, ctx }
  assert.equal(outboundAllowed(agent), true)
  planning = true; assert.equal(outboundAllowed(agent), false)
  planning = false; mode = 'workspace-write'; assert.equal(outboundAllowed(agent), false)
  mode = 'danger-full-access'; agent.session.header.agentPreset = 'standard'; assert.equal(outboundAllowed(agent), false)
  agent.session.header.agentPreset = '1c-airules'
  installOutboundPolicy(ctx)
  assert.equal(handlers.get('dsh-acp/permission-policy')({ agent, signal: { aborted: true } }, () => 'allow-once'), 'cancelled')
  planning = true
  assert.equal(handlers.get('dsh-acp/permission-policy')({ agent }, () => 'allow-once'), 'deny-once')
  await assert.rejects(handlers.get('agent/request')({ agent }, async () => ({ provider: 'acp-codex' })), /ACP_BUILD_NATIVE_ACCESS_REQUIRED/)
  assert.deepEqual(await handlers.get('agent/request')({ agent }, async () => ({ provider: 'deepseek' })), { provider: 'deepseek' })
})
