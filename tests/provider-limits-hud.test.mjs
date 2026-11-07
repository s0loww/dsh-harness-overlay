import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { handlerFor, projectBalance, API, inject } from '../src/ui-plugins/provider-limits-hud/index.js'
import * as hudHost from '../src/ui-plugins/provider-limits-hud/index.js'
import {
  SOURCES,
  compactSummary,
  formatMoney,
  normalizeProviderLimits,
  normalizeTokenLedgerBalance,
} from '../src/ui-plugins/provider-limits-hud/core.mjs'

const ROOT = join(import.meta.dirname, '..', 'src', 'ui-plugins', 'provider-limits-hud')

test('normalizes provider balance and quota responses without connection data', () => {
  const result = normalizeProviderLimits({
    ok: true,
    observedAt: 1762218000000,
    providers: [
      {
        id: 'deepseek-account', name: 'DeepSeek', accounts: [
          { id: 'primary', name: 'Main', usage: { kind: 'balance', status: 'ready', source: 'DeepSeek Account', balances: [{ currency: 'USD', total: '14.28', granted: '10.00', toppedUp: '4.28' }] } },
        ],
      },
      {
        id: 'codex', name: 'Codex', accounts: [
          { id: 'oauth', name: 'Plan', usage: { kind: 'quota', status: 'ready', windows: [{ kind: 'weekly', usedPercent: 37, resetsAt: 1762304400000 }] } },
        ],
      },
    ],
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows[0], {
    id: 'deepseek-account/primary/USD/0', provider: 'DeepSeek', account: 'Main', kind: 'balance', status: 'ready',
    currency: 'USD', total: 14.28, granted: 10, toppedUp: 4.28, bonus: undefined,
    source: 'DeepSeek Account', observedAt: undefined,
  })
  assert.equal(result.rows[1].kind, 'quota')
  assert.equal(result.rows[1].usedPercent, 37)
  assert.equal(compactSummary(result), formatMoney(14.28, 'USD'))
  assert.equal(JSON.stringify(result).includes('token'), false)
  assert.equal(JSON.stringify(result).includes('endpoint'), false)
})

test('normalizes TokenLedger and reports unsupported responses as degraded', () => {
  const ready = normalizeTokenLedgerBalance({ ok: true, supported: true, fetched: true, account: 'route-a', displayName: 'DeepSeek', currency: 'CNY', total: 6, granted: 2, toppedUp: 4 })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.rows[0].total, 6)
  assert.match(compactSummary(ready), /6/u)

  const degraded = normalizeTokenLedgerBalance({ ok: true, supported: false, reason: 'no-provider-directory' })
  assert.equal(degraded.status, 'degraded')
  assert.equal(degraded.rows.length, 0)
  assert.equal(degraded.message, 'no-provider-directory')
})

test('rejects invalid or misleading balance payloads', () => {
  assert.throws(() => normalizeProviderLimits({ ok: true }), /PROVIDER_LIMITS_INVALID/u)
  assert.throws(() => normalizeTokenLedgerBalance({ ok: false }), /TOKENLEDGER_BALANCE_INVALID/u)
  const missing = normalizeTokenLedgerBalance({ ok: true, supported: true, fetched: true, currency: 'USD' })
  assert.equal(missing.status, 'degraded')
  assert.equal(compactSummary(missing), 'нет данных')
})

test('package is a read-only client plugin with explicit degraded sources', async () => {
  const [pkgText, host, client, patch, provenance] = await Promise.all([
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'index.js'), 'utf8'),
    readFile(join(ROOT, 'client.js'), 'utf8'),
    readFile(join(ROOT, 'cordis.patch.yml'), 'utf8'),
    readFile(join(ROOT, 'PROVENANCE.md'), 'utf8'),
  ])
  const pkg = JSON.parse(pkgText)
  assert.equal(pkg.name, 'airules-provider-limits-hud')
  assert.equal(pkg.license, 'MIT')
  assert.deepEqual(SOURCES.map(row => row.path), ['/airules/provider-limits', '/onec/provider-limits', '/api/tokenledger/balance'])
  assert.match(host, /account\.getBalance/u)
  assert.doesNotMatch(client, /localStorage|indexedDB|method:\s*['"]POST/u)
  const patchData = patch.split(/\r?\n/u).filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(patchData, /endpoint|token|secret|mcp/iu)
  assert.match(client, /Источники баланса не подключены/u)
  assert.match(provenance, /does not copy/u)
})

test('native rc.5 wallet contract preserves recharge and granted currencies independently', () => {
  const result = normalizeProviderLimits(projectBalance({ status: 'ready', value: [{ currency: 'USD', balance: '3.94' }], bonusWallets: [{ currency: 'USD', balance: '14.28' }, { currency: 'CNY', balance: '6.00' }], token: 'must-never-be-projected' }))
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].total, 18.22)
  assert.equal(result.rows[0].granted, 14.28)
  assert.equal(result.rows[0].toppedUp, 3.94)
  assert.equal(result.rows[1].total, 6)
  assert.doesNotMatch(JSON.stringify(result), /must-never-be-projected/u)
  assert.equal(normalizeProviderLimits(projectBalance({ status: 'failed' })).rows.length, 0)
  assert.match(projectBalance({ status: 'failed' }).providers[0].accounts[0].usage.message, /API баланса/u)
  assert.match(projectBalance(null).providers[0].accounts[0].usage.message, /сессии/u)
  assert.equal(normalizeProviderLimits(projectBalance({ status: 'ready', value: [{ currency: 'USD', balance: '0' }], bonusWallets: [] })).rows[0].total, 0)
})

test('native route admits authenticated GET only and uses balance without profile or credentials', async () => {
  const calls = []
  const ctx = { connection: { requestRejection: () => undefined }, deepseekAccount: { async getBalance(identity) { calls.push(identity); return { status: 'ready', value: [{ currency: 'USD', balance: '1e1' }], bonusWallets: [] } } } }
  const request = async (method = 'GET') => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
    await handlerFor(ctx)({ method, url: API }, response)
    return response
  }
  assert.deepEqual(inject, ['webServer', 'connection', 'deepseekAccount'])
  assert.equal((await request('POST')).status, 405)
  assert.equal(calls.length, 0)
  ctx.connection.requestRejection = () => 403
  assert.equal((await request()).status, 403)
  assert.equal(calls.length, 0)
  ctx.connection.requestRejection = () => undefined
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body.providers[0].accounts[0].usage.balances[0].total, 10)
  assert.equal(calls[0].version, '0.2.1-rc.5')
  assert.equal(calls[0].locale, 'ru-RU')
  assert.equal(typeof calls[0].timezoneOffsetSeconds, 'number')
  ctx.deepseekAccount.getBalance = () => { throw new Error('secret server details') }
  const failed = await request()
  assert.equal(failed.status, 200)
  assert.doesNotMatch(JSON.stringify(failed.body), /secret server/u)
  assert.equal(failed.body.providers[0].accounts[0].usage.status, 'unavailable')
  delete ctx.deepseekAccount
  const missing = await request()
  assert.equal(missing.body.configured, false)
  assert.match(missing.body.providers[0].accounts[0].usage.message, /Сервис аккаунта/u)
})

test('real Cordis plugin scope can resolve its declared native account service', async t => {
  const { Context, Service } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const root = new Context(), routes = new Map(), calls = []
  class Web extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) }
  }
  class Connection extends Service {
    constructor(ctx) { super(ctx, 'connection') }
    requestRejection() { return undefined }
  }
  class Account extends Service {
    constructor(ctx) { super(ctx, 'deepseekAccount') }
    async getBalance(identity) { calls.push(identity); return { status: 'ready', value: [{ currency: 'USD', balance: '4.25' }], bonusWallets: [{ currency: 'CNY', balance: '6' }] } }
  }
  new Web(root); new Connection(root); new Account(root)
  const fiber = root.plugin(hudHost)
  await fiber.await()
  t.after(() => fiber.dispose())
  assert.equal(typeof routes.get(API), 'function')
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await routes.get(API)({ method: 'GET', url: API }, response)
  assert.equal(response.status, 200)
  assert.equal(response.body.configured, true)
  assert.equal(response.body.providers[0].accounts[0].usage.balances[0].total, 4.25)
  assert.equal(calls.length, 1)
})

test('client registers one footer slot and no settings surface', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  let definition
  const appended = []
  const paths = []
  const document = {
    head: { appendChild(node) { appended.push(node) } },
    querySelector() { return null },
    createElement() { return { dataset: {}, remove() {} } },
    addEventListener() {}, removeEventListener() {},
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document,
    async fetch(path) { paths.push(path); return { ok: true, headers: { get() { return null } }, async json() { return projectBalance({ status: 'ready', value: [{ currency: 'USD', balance: '8.50' }], bonusWallets: [] }) } } },
    AbortController,
    Intl,
    setTimeout,
    clearTimeout,
  })
  assert.equal(definition.id, 'airules-provider-limits-hud')
  const react = {
    createElement() {}, useEffect() {}, useRef() { return { current: null } }, useState(value) { return [value, () => {}] },
  }
  const plugin = definition.factory(id => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  })
  const slots = []
  const effects = []
  plugin.apply({
    effect(dispose) { effects.push(dispose) },
    slots: {
      inject(name, register) { assert.equal(name, 'sidebar.footer.action'); register() },
      register(meta, component) { slots.push({ meta, component }); return () => {} },
    },
  })
  assert.equal(appended.length, 1)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].meta.id, 'airules-provider-limits-hud')
  assert.equal(typeof slots[0].component, 'function')
  assert.equal(Array.from(plugin.ENDPOINTS).join(','), '/airules/provider-limits,/onec/provider-limits,/api/tokenledger/balance')
  // Exercise the shipped browser adapter, not just the matching core normalizer.
  const snapshot = await plugin.readSnapshot(new AbortController().signal)
  assert.deepEqual(paths, ['/airules/provider-limits'])
  assert.equal(snapshot.rows[0].total, 8.5)
  assert.equal(Array.from(plugin.inject).join(','), 'slots,locale')
  assert.equal(effects.length, 1)
})
