export const SOURCES = Object.freeze([
  Object.freeze({ id: 'native-account', path: '/airules/provider-limits' }),
  Object.freeze({ id: 'provider-limits', path: '/onec/provider-limits' }),
  Object.freeze({ id: 'tokenledger', path: '/api/tokenledger/balance' }),
])

const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 240) : ''
const finite = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d{1,24}(?:\.\d{1,12})?$/u.test(value)) return Number(value)
  return undefined
}
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/u.test(value) ? value : undefined
const timestamp = value => {
  const result = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(result) && result > 0 ? result : undefined
}

function balanceRows(provider, account, usage) {
  return (Array.isArray(usage?.balances) ? usage.balances : []).flatMap((row, index) => {
    const code = currency(row?.currency)
    const total = finite(row?.total)
    if (!code || total === undefined) return []
    return [{
      id: `${provider.id}/${account.id}/${code}/${index}`,
      provider: provider.name || provider.id,
      account: account.name || account.id,
      kind: 'balance',
      status: text(usage.status) || 'ready',
      currency: code,
      total,
      granted: finite(row.granted),
      toppedUp: finite(row.toppedUp),
      bonus: finite(row.bonus),
      source: text(usage.source),
      observedAt: timestamp(usage.observedAt),
    }]
  })
}

function quotaRows(provider, account, usage) {
  return (Array.isArray(usage?.windows) ? usage.windows : []).map((row, index) => ({
    id: `${provider.id}/${account.id}/quota/${index}`,
    provider: provider.name || provider.id,
    account: account.name || account.id,
    kind: 'quota',
    status: text(usage.status) || 'ready',
    label: text(row?.label || row?.kind) || 'Лимит',
    usedPercent: finite(row?.usedPercent),
    resetsAt: timestamp(row?.resetsAt),
    source: text(usage.source),
    observedAt: timestamp(usage.observedAt),
  }))
}

export function normalizeProviderLimits(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.providers)) {
    throw new Error('PROVIDER_LIMITS_INVALID')
  }
  const rows = []
  const notes = []
  for (const rawProvider of payload.providers) {
    const provider = { id: text(rawProvider?.id), name: text(rawProvider?.name) }
    if (!provider.id) continue
    for (const rawAccount of Array.isArray(rawProvider.accounts) ? rawProvider.accounts : []) {
      const account = { id: text(rawAccount?.id), name: text(rawAccount?.name) }
      if (!account.id) continue
      const usage = rawAccount?.usage ?? {}
      const found = usage.kind === 'balance' ? balanceRows(provider, account, usage)
        : usage.kind === 'quota' ? quotaRows(provider, account, usage) : []
      rows.push(...found)
      if (!found.length && text(usage.message)) notes.push({
        id: `${provider.id}/${account.id}`,
        provider: provider.name || provider.id,
        account: account.name || account.id,
        message: text(usage.message),
      })
    }
  }
  return Object.freeze({
    source: 'provider-limits',
    status: rows.length ? 'ready' : 'degraded',
    observedAt: timestamp(payload.observedAt),
    rows: Object.freeze(rows.map(Object.freeze)),
    notes: Object.freeze(notes.map(Object.freeze)),
    message: rows.length ? '' : 'Провайдеры не вернули доступные значения баланса или квоты.',
  })
}

export function normalizeTokenLedgerBalance(payload) {
  if (!payload || payload.ok !== true) throw new Error('TOKENLEDGER_BALANCE_INVALID')
  if (payload.supported !== true || payload.fetched !== true) return Object.freeze({
    source: 'tokenledger', status: 'degraded', rows: Object.freeze([]), notes: Object.freeze([]),
    message: text(payload.reason) || 'Источник баланса недоступен.',
  })
  const code = currency(payload.currency)
  const total = finite(payload.total ?? payload.remaining)
  const row = {
    id: `tokenledger/${text(payload.account) || 'default'}`,
    provider: text(payload.displayName) || 'TokenLedger',
    account: text(payload.account) || 'Основной аккаунт',
    kind: 'balance', status: 'ready', currency: code,
    total, granted: finite(payload.granted), toppedUp: finite(payload.toppedUp),
    used: finite(payload.used), unlimited: payload.unlimited === true,
    plan: text(payload.plan), expiresAt: timestamp(payload.expiresAt),
  }
  if (!row.unlimited && (!row.currency || row.total === undefined)) return Object.freeze({
    source: 'tokenledger', status: 'degraded', rows: Object.freeze([]), notes: Object.freeze([]),
    message: 'Источник ответил, но не сообщил денежный баланс.',
  })
  return Object.freeze({ source: 'tokenledger', status: 'ready', rows: Object.freeze([Object.freeze(row)]), notes: Object.freeze([]), message: '' })
}

export function formatMoney(value, code, locale = 'ru-RU') {
  if (typeof value !== 'number' || !Number.isFinite(value) || !currency(code)) return '—'
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: code, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value) }
  catch { return `${value.toFixed(value < 1 ? 4 : 2)} ${code}` }
}

export function compactSummary(result) {
  const row = result?.rows?.find(item => item.kind === 'balance')
  if (!row) {
    const quota = result?.rows?.find(item => item.kind === 'quota' && typeof item.usedPercent === 'number')
    return quota ? `${Math.max(0, Math.min(100, quota.usedPercent)).toFixed(0)}%` : 'нет данных'
  }
  return row.unlimited ? 'без лимита' : formatMoney(row.total, row.currency)
}
