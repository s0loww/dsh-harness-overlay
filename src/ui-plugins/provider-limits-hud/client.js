window.__ModuleLoader__.load({
  id: 'airules-provider-limits-hud',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const NAME = 'airules-provider-limits-hud'
    const STYLE_ID = `${NAME}/style`
    const ENDPOINTS = ['/airules/provider-limits', '/onec/provider-limits', '/api/tokenledger/balance']

    const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    const number = value => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && /^-?\d{1,24}(?:\.\d{1,12})?$/.test(value)) return Number(value)
    }
    const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined
    const money = (value, code) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || !currency(code)) return '—'
      try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: code, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value) }
      catch { return `${value.toFixed(value < 1 ? 4 : 2)} ${code}` }
    }

    function providerLimits(payload) {
      if (!payload || payload.ok !== true || !Array.isArray(payload.providers)) throw new Error('invalid provider-limits response')
      const rows = [], notes = []
      for (const provider of payload.providers) {
        const providerId = clean(provider?.id), providerName = clean(provider?.name) || providerId
        if (!providerId) continue
        for (const account of Array.isArray(provider.accounts) ? provider.accounts : []) {
          const accountId = clean(account?.id), accountName = clean(account?.name) || accountId
          if (!accountId) continue
          const usage = account?.usage ?? {}
          if (usage.kind === 'balance') {
            for (const balance of Array.isArray(usage.balances) ? usage.balances : []) {
              const code = currency(balance?.currency), total = number(balance?.total)
              if (code && total !== undefined) rows.push({ id: `${providerId}/${accountId}/${code}`, provider: providerName, account: accountName, kind: 'balance', currency: code, total, granted: number(balance.granted), toppedUp: number(balance.toppedUp), source: clean(usage.source) })
            }
          } else if (usage.kind === 'quota') {
            for (const [index, window] of (Array.isArray(usage.windows) ? usage.windows : []).entries()) rows.push({ id: `${providerId}/${accountId}/quota/${index}`, provider: providerName, account: accountName, kind: 'quota', label: clean(window?.label || window?.kind) || 'Лимит', usedPercent: number(window?.usedPercent), resetsAt: number(window?.resetsAt) })
          }
          if (!rows.some(row => row.id.startsWith(`${providerId}/${accountId}/`)) && clean(usage.message)) notes.push({ id: `${providerId}/${accountId}`, provider: providerName, account: accountName, message: clean(usage.message) })
        }
      }
      return { source: 'provider-limits', status: rows.length ? 'ready' : 'degraded', rows, notes, message: rows.length ? '' : 'Провайдеры не вернули доступные значения.' }
    }

    function tokenLedger(payload) {
      if (!payload || payload.ok !== true) throw new Error('invalid tokenledger response')
      if (payload.supported !== true || payload.fetched !== true) return { source: 'tokenledger', status: 'degraded', rows: [], notes: [], message: clean(payload.reason) || 'Источник баланса недоступен.' }
      const code = currency(payload.currency), total = number(payload.total ?? payload.remaining)
      if (payload.unlimited !== true && (!code || total === undefined)) return { source: 'tokenledger', status: 'degraded', rows: [], notes: [], message: 'Источник не сообщил денежный баланс.' }
      return { source: 'tokenledger', status: 'ready', rows: [{ id: `tokenledger/${clean(payload.account) || 'default'}`, provider: clean(payload.displayName) || 'TokenLedger', account: clean(payload.account) || 'Основной аккаунт', kind: 'balance', currency: code, total, granted: number(payload.granted), toppedUp: number(payload.toppedUp), used: number(payload.used), unlimited: payload.unlimited === true, plan: clean(payload.plan) }], notes: [], message: '' }
    }

    async function json(path, signal) {
      const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > 262144) throw new Error('response too large')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function readSnapshot(signal) {
      const failures = []
      let nativeResult
      try {
        nativeResult = providerLimits(await json(ENDPOINTS[0], signal))
        if (nativeResult.rows.length) return nativeResult
      } catch (error) { failures.push(error?.message || String(error)) }
      try {
        const result = providerLimits(await json(ENDPOINTS[1], signal))
        if (result.rows.length) return result
        failures.push(result.message)
      } catch (error) { failures.push(error?.message || String(error)) }
      try {
        const result = tokenLedger(await json(ENDPOINTS[2], signal))
        if (result.rows.length) return result
        failures.push(result.message)
      } catch (error) { failures.push(error?.message || String(error)) }
      if (nativeResult) return { ...nativeResult, message: nativeResult.notes.map(note => note.message).join(' ') || nativeResult.message }
      return { source: 'none', status: 'unavailable', rows: [], notes: [], message: 'Источники баланса не подключены.', diagnostics: failures.map(clean).filter(Boolean) }
    }

    const css = `
      div:has(> [data-slot='sidebar.footer.action']){flex-wrap:wrap}
      .airulesLimitRoot{flex:0 0 100%;min-width:0;position:relative}
      .airulesLimitButton{box-sizing:border-box;width:100%;height:42px;display:flex;align-items:center;gap:8px;padding:0 9px;color:var(--dsw-alias-label-primary);background:transparent;border:0;border-radius:10px;font:inherit;cursor:pointer}
      .airulesLimitButton:hover,.airulesLimitButton[data-open]{background:var(--dsw-alias-interactive-bg-hover)}
      .airulesLimitIcon{font-weight:700;width:18px;text-align:center}
      .airulesLimitLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .airulesLimitSummary{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .airulesLimitRail{flex:0 0 36px}.airulesLimitRail .airulesLimitButton{width:36px;height:36px;border-radius:50%;justify-content:center;padding:0}.airulesLimitRail .airulesLimitLabel,.airulesLimitRail .airulesLimitSummary{display:none}
      .airulesLimitPanel{z-index:40;position:fixed;bottom:96px;left:12px;width:400px;max-width:calc(100vw - 24px);max-height:68vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);padding:12px;box-sizing:border-box}
      .airulesLimitHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}.airulesLimitTitle{font-size:13px;font-weight:600}.airulesLimitRefresh{margin-left:auto;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;cursor:pointer}
      .airulesLimitRow{border-top:1px solid var(--dsw-alias-border-l1);padding:9px 2px}.airulesLimitRow:first-of-type{border-top:0}.airulesLimitWho{color:var(--dsw-alias-label-tertiary);font-size:11px}.airulesLimitValue{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}.airulesLimitMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px}.airulesLimitEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.airulesLimitError{color:var(--dsw-alias-state-warn-primary);font-size:11px;margin-top:6px}
    `

    function useSnapshot(open, nonce) {
      const [state, setState] = useState({ status: 'idle', rows: [] })
      useEffect(() => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 16000)
        setState(previous => ({ ...previous, status: 'loading' }))
        readSnapshot(controller.signal).then(value => { if (!controller.signal.aborted) setState(value) }, () => { if (!controller.signal.aborted) setState({ source: 'none', status: 'unavailable', rows: [], notes: [], message: 'Не удалось получить баланс.' }) }).finally(() => clearTimeout(timeout))
        return () => { clearTimeout(timeout); controller.abort() }
      }, [open, nonce])
      return state
    }

    function Row({ row }) {
      if (row.kind === 'quota') {
        const percent = typeof row.usedPercent === 'number' ? Math.max(0, Math.min(100, row.usedPercent)) : undefined
        return h('div', { className: 'airulesLimitRow' },
          h('div', { className: 'airulesLimitWho' }, `${row.provider} · ${row.account}`),
          h('div', { className: 'airulesLimitValue' }, percent === undefined ? 'Лимит' : `${percent.toFixed(0)}% использовано`),
          h('div', { className: 'airulesLimitMeta' }, row.label || 'Общая квота'))
      }
      const details = []
      if (typeof row.granted === 'number') details.push(`предоставлено ${money(row.granted, row.currency)}`)
      if (typeof row.toppedUp === 'number') details.push(`пополнено ${money(row.toppedUp, row.currency)}`)
      if (typeof row.used === 'number') details.push(`израсходовано ${money(row.used, row.currency)}`)
      return h('div', { className: 'airulesLimitRow' },
        h('div', { className: 'airulesLimitWho' }, `${row.provider} · ${row.account}`),
        h('div', { className: 'airulesLimitValue' }, row.unlimited ? 'Без ограничений' : money(row.total, row.currency)),
        details.length ? h('div', { className: 'airulesLimitMeta' }, details.join(' · ')) : null)
    }

    function summary(state) {
      const row = state.rows?.[0]
      if (!row) return state.status === 'loading' ? '…' : 'нет данных'
      if (row.kind === 'quota') return typeof row.usedPercent === 'number' ? `${row.usedPercent.toFixed(0)}%` : 'лимит'
      return row.unlimited ? 'без лимита' : state.rows.filter(item => item.kind === 'balance').map(item => money(item.total, item.currency)).join(' + ')
    }

    function Hud({ wide }) {
      const [open, setOpen] = useState(false)
      const [nonce, setNonce] = useState(0)
      const state = useSnapshot(open, nonce)
      const root = useRef(null)
      useEffect(() => {
        if (!open) return
        const key = event => { if (event.key === 'Escape') setOpen(false) }
        const down = event => { if (root.current && !root.current.contains(event.target)) setOpen(false) }
        window.addEventListener('keydown', key)
        document.addEventListener('pointerdown', down, true)
        return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down, true) }
      }, [open])
      return h('div', { ref: root, className: `airulesLimitRoot${wide === false ? ' airulesLimitRail' : ''}` },
        h('button', { type: 'button', className: 'airulesLimitButton', 'data-open': open ? '' : undefined, 'aria-label': 'Баланс и лимиты', onClick: () => setOpen(value => !value) },
          h('span', { className: 'airulesLimitIcon', 'aria-hidden': 'true' }, '₽'),
          h('span', { className: 'airulesLimitLabel' }, 'Баланс и лимиты'),
          h('span', { className: 'airulesLimitSummary' }, summary(state))),
        open ? h('section', { className: 'airulesLimitPanel', role: 'dialog', 'aria-label': 'Баланс и лимиты провайдеров' },
          h('div', { className: 'airulesLimitHead' },
            h('span', { className: 'airulesLimitTitle' }, 'Баланс и лимиты'),
            h('button', { type: 'button', className: 'airulesLimitRefresh', disabled: state.status === 'loading', onClick: () => setNonce(value => value + 1) }, state.status === 'loading' ? 'Загрузка…' : 'Обновить')),
          state.rows?.length ? state.rows.map(row => h(Row, { row, key: row.id })) : h('p', { className: 'airulesLimitEmpty' }, state.message || 'Нет данных.'),
          state.notes?.slice(0, 4).map(note => h('div', { className: 'airulesLimitMeta', key: note.id }, `${note.provider} · ${note.account}: ${note.message}`)),
          state.status === 'unavailable' ? h('p', { className: 'airulesLimitError' }, 'Проверьте вход в аккаунт DSH и доступность API баланса. Ключи в HUD не вводятся и не сохраняются.') : null) : null)
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      let style = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (!style) {
        style = document.createElement('style')
        style.dataset.plugin = NAME
        style.dataset.pluginCss = STYLE_ID
        style.textContent = css
        document.head.appendChild(style)
      }
      ctx.effect(() => () => style.remove(), `${NAME}: style`)
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'airules-provider-limits-hud', order: -70, label: 'Баланс и лимиты' }, Hud))
    }

    module.exports = { name: NAME, inject, apply, ENDPOINTS, providerLimits, tokenLedger, readSnapshot }
    return module.exports
  },
})
