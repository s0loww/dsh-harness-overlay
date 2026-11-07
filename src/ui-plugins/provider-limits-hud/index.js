export const name = 'airules-provider-limits-hud'
export const inject = ['webServer', 'connection', 'deepseekAccount']
export const API = '/airules/provider-limits'

const amount = value => {
  if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

// Official rc.5 getBalance projects normal_wallets to value and bonus_wallets
// to bonusWallets. Never call getProfile first: it is an independent endpoint.
export function projectBalance(result) {
  const balances = new Map()
  if (result?.status === 'ready') {
    for (const [field, target] of [['value', 'toppedUp'], ['bonusWallets', 'granted']]) {
      for (const wallet of Array.isArray(result[field]) ? result[field] : []) {
        const value = amount(wallet?.balance)
        if (!['USD', 'CNY'].includes(wallet?.currency) || value === undefined) continue
        const row = balances.get(wallet.currency) ?? { currency: wallet.currency, total: 0, toppedUp: 0, granted: 0 }
        row[target] += value
        row.total += value
        balances.set(wallet.currency, row)
      }
    }
  }
  const message = result === undefined ? 'Сервис аккаунта DeepSeek не подключён в этой установке DSH.' : result === null
    ? 'Нет доступной авторизованной сессии DeepSeek. Проверьте вход в настройках аккаунта.'
    : 'DeepSeek не вернул баланс. Доступность модели не гарантирует доступность API баланса; попробуйте обновить позже.'
  return { ok: true, configured: result !== undefined, observedAt: Date.now(), providers: [{ id: 'deepseek-account', name: 'DeepSeek', accounts: [{ id: 'native', name: 'Аккаунт DSH', usage: { kind: 'balance', status: balances.size ? 'ready' : 'unavailable', source: 'DSH DeepSeek Account', balances: [...balances.values()], ...(!balances.size ? { message } : {}) } }] }] }
}

export function handlerFor(ctx) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
    if (!ctx.connection || ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
    if (request.method !== 'GET') return send(405, { ok: false, error: 'READ_ONLY_API' })
    // Identity mirrors the pinned official runtime, without accepting credentials
    // or arbitrary remote URLs from the browser.
    let account
    try { account = ctx.get?.('deepseekAccount') ?? ctx.deepseekAccount } catch {}
    if (typeof account?.getBalance !== 'function') return send(200, projectBalance(undefined))
    try { return send(200, projectBalance(await account.getBalance({ version: '0.2.1-rc.5', locale: 'ru-RU', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }))) }
    catch { return send(200, projectBalance({ status: 'failed' })) }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handlerFor(ctx) }))
}
