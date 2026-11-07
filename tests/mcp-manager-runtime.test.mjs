import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../src/mcp-manager/lib/index.js'
import { createSecureManagerHandler, MANAGER_ROOT } from '../src/mcp-manager/lib/security.js'

async function call(handler, { url = `${MANAGER_ROOT}/api/health`, method = 'GET', input, token, address = '127.0.0.1', host = '127.0.0.1:54321' } = {}) {
  const request = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  Object.assign(request, { url, method, headers: { host, 'x-dsh-csrf': token }, socket: { remoteAddress: address } })
  const response = { headers: {}, setHeader(key, value) { this.headers[String(key).toLowerCase()] = value }, writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers) }, end(text) { this.text = String(text ?? ''); if (this.headers['content-type']?.includes('application/json')) this.body = JSON.parse(this.text) } }
  await handler(request, response)
  return response
}

test('real adapted manager starts with empty independent machine store and secures all writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'airules-manager-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const cleanup = [], routes = new Map(); let toolGuard, plugins = 0
  t.after(async () => { for (const dispose of cleanup.toReversed()) await dispose?.(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(directory, { recursive: true, force: true }) })
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { schemas: () => [], guard: value => { toolGuard = value } },
    webServer: { host: 'localhost', port: 54321, register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    connection: { requestRejection: req => req.headers['x-native-denied'] ? 403 : undefined },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return dispose },
    plugin() { plugins++; throw new Error('external connections forbidden in this fixture') },
    extend(properties) { return Object.assign(Object.create(this), properties) },
  }
  apply(ctx)
  assert.equal(plugins, 0)
  assert.equal(existsSync(join(directory, 'mcp-servers.json')), false)
  assert.equal(existsSync(join(directory, 'airules-mcp-servers.json')), false)
  const handler = routes.get(MANAGER_ROOT)
  const health = await call(handler)
  assert.equal(health.body.ok, true)
  assert.ok(health.body.csrfToken)
  const url = `${MANAGER_ROOT}/api/servers`
  assert.deepEqual((await call(handler, { url })).body.servers, [])
  const input = { serverName: 'fixture', transport: 'streamable-http', url: 'https://invalid.example/mcp', enabled: false, headers: { Authorization: 'fixture-credential' } }
  assert.equal((await call(handler, { url, method: 'POST', input })).statusCode, 403)
  assert.equal(existsSync(join(directory, 'airules-mcp-servers.json')), false)
  const added = await call(handler, { url, method: 'POST', input, token: health.body.csrfToken })
  assert.equal(added.statusCode, 201)
  assert.equal(plugins, 0)
  const stored = JSON.parse(readFileSync(join(directory, 'airules-mcp-servers.json'), 'utf8'))
  assert.equal(stored.servers[0].enabled, false)
  assert.equal(stored.servers[0].headers.Authorization, 'fixture-credential')
  assert.equal(toolGuard({ name: 'unrelated', agent: {} }), undefined)
  assert.equal(toolGuard({ name: 'mcp__project_only__read', agent: {} }), undefined)
  assert.match(toolGuard({ name: 'mcp__fixture__read', agent: {} }), /native BUILD/)
  const agent = { session: { header: { agentPreset: '1c-airules', cwd: directory } }, ctx: { get: name => name === 'planMode' ? { get: () => ({ active: false }) } : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: directory }) } : undefined } }
  assert.equal(toolGuard({ name: 'mcp__fixture__read', agent }), undefined)
  delete agent.session.header.cwd
  assert.match(toolGuard({ name: 'mcp__fixture__read', agent }), /native BUILD/)
  agent.session.header.cwd = directory
  agent.ctx.get = name => name === 'planMode' ? { get: () => null } : undefined
  assert.match(toolGuard({ name: 'mcp__fixture__read', agent }), /native BUILD/)
  agent.ctx.get = name => name === 'planMode' ? { get: () => ({ active: true }) } : undefined
  assert.match(toolGuard({ name: 'mcp__fixture__read', agent }), /native BUILD/)
  const bad = await call(handler, { url, method: 'POST', input: { serverName: 'invalid', transport: 'streamable-http', url: 'fixture-secret-url' }, token: health.body.csrfToken })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.body.error, 'MCP_OPERATION_FAILED')
  assert.equal(bad.text.includes('fixture-secret-url'), false)
})

test('native admission is required even for configuration reads', async () => {
  let called = false
  const handler = createSecureManagerHandler(() => { called = true }, { connection: { requestRejection: () => 403 } })
  assert.equal((await call(handler)).statusCode, 403)
  assert.equal(called, false)
})

test('OAuth callback admits only exact fresh local state once and never reflects raw errors', async () => {
  const state = 'a'.repeat(32), expired = 'b'.repeat(32)
  let exchanges = 0
  const handler = createSecureManagerHandler((request, response) => {
    exchanges++; response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end("<html>fixture-oauth-secret <script>postMessage({type: 'mcp-oauth-error',error:'fixture-oauth-secret'},'*')</script></html>")
  }, { connection: { requestRejection: () => 403 }, allowOAuthState: value => value === state })
  const path = value => `${MANAGER_ROOT}/api/oauth/callback?state=${value}&code=fixture-code`
  assert.equal((await call(handler, { url: path('missing') })).statusCode, 403)
  assert.equal((await call(handler, { url: path(expired) })).statusCode, 403)
  assert.equal((await call(handler, { url: path(state), address: '192.168.0.9' })).statusCode, 403)
  const result = await call(handler, { url: path(state) })
  assert.equal(exchanges, 1)
  assert.equal(result.text.includes('fixture-oauth-secret'), false)
  assert.equal((await call(handler, { url: path(state) })).statusCode, 403)
  assert.equal(exchanges, 1)
})

test('successful OAuth completion preserves only safe server identity for edit refresh', async () => {
  const state = 'c'.repeat(32)
  const handler = createSecureManagerHandler((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<script>window.opener.postMessage({ type: 'mcp-oauth-success', serverName: "fixture" }, '*')</script>fixture-private-response`)
  }, { connection: { requestRejection: () => 403 }, allowOAuthState: value => value === state })
  const result = await call(handler, { url: `${MANAGER_ROOT}/api/oauth/callback?state=${state}` })
  assert.match(result.text, /"serverName":"fixture"/)
  assert.equal(result.text.includes('fixture-private-response'), false)
})
