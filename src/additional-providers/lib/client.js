window.__ModuleLoader__.load({ id: 'airules-dsh-additional-providers', factory: require => {
  const React = require('react'), h = React.createElement
  function Providers() {
    const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
    const csrf = React.useRef('')
    const refresh = React.useCallback(async action => {
      setBusy(true)
      try {
        const response = await fetch('/airules/additional-providers', { method: action ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', headers: { accept: 'application/json', ...(action ? { 'content-type': 'application/json', 'x-dsh-csrf': csrf.current } : {}) }, ...(action ? { body: JSON.stringify({ action }) } : {}), signal: AbortSignal.timeout(15000) })
        const body = await response.json(); if (!response.ok || !body.ok) throw new Error('FAILED')
        csrf.current = body.csrfToken; setState(body); setError('')
      } catch { setState(null); setError('Не удалось получить состояние. Обновите статус.') } finally { setBusy(false) }
    }, [])
    React.useEffect(() => { void refresh() }, [refresh])
    React.useEffect(() => { if (state?.phase !== 'pending') return; const timer = setInterval(() => { void refresh() }, 2500); return () => clearInterval(timer) }, [state?.phase, refresh])
    return h('section', { style: { display: 'grid', gap: 12, padding: 16 }, 'aria-label': 'Дополнительные провайдеры' },
      h('h3', null, 'Дополнительные провайдеры · Kimi Code'),
      h('p', null, 'Отдельный вход в подписку Kimi. Аккаунты из CLI и других установок не импортируются.'),
      h('p', { role: 'status' }, !state ? 'Статус неизвестен' : state.connected === true ? 'Подписка подключена' : state.phase === 'pending' ? 'Ожидаем подтверждения…' : 'Вход не выполнен'),
      error || state?.error ? h('p', { role: 'alert' }, error || 'Вход не завершён. Повторите подключение.') : null,
      state?.notice ? h('div', null, h('a', { href: state.notice.url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть подтверждение Kimi'), h('p', null, 'Код: ', h('code', null, state.notice.code))) : null,
      h('div', null,
        h('button', { disabled: busy || !state || state.connected || state.phase === 'pending', onClick: () => refresh('login') }, 'Подключить Kimi'),
        h('button', { disabled: busy || state?.phase !== 'pending', onClick: () => refresh('cancel') }, 'Отменить вход'),
        h('button', { disabled: busy || state?.connected !== true, onClick: () => refresh('logout') }, 'Отключить'),
        h('button', { disabled: busy, onClick: () => refresh() }, 'Обновить статус')),
      h('p', null, 'После подключения выберите «Kimi Code · отдельная подписка» в списке моделей. Один аккаунт; ротация и статистика квот пока не перенесены.'))
  }
  return { KimiSettings: Providers, inject: ['slots'], apply(ctx) { ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-kimi', order: 91, label: () => 'Kimi Code' }, Providers)) } }
} })
