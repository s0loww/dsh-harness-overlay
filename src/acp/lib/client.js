window.__ModuleLoader__.load({
  id: 'airules-dsh-acp',
  factory: require => {
    const React = require('react'), h = React.createElement
    function AcpControl() {
      const [state, setState] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
      const csrf = React.useRef('')
      const request = React.useCallback(async action => {
        setBusy(true)
        try {
          const response = await fetch('/airules/acp-control', {
            method: action ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin',
            headers: { accept: 'application/json', ...(action ? { 'content-type': 'application/json', 'x-dsh-csrf': csrf.current } : {}) },
            ...(action ? { body: JSON.stringify(action) } : {}), signal: AbortSignal.timeout(15000),
          })
          const body = await response.json()
          if (!response.ok || !body.ok) throw new Error(body.error ?? 'ACP_CONTROL_FAILED')
          csrf.current = body.csrfToken; setState(body); setError('')
        } catch { setError('Не удалось получить состояние ACP. Обновите статус.') }
        finally { setBusy(false) }
      }, [])
      React.useEffect(() => { void request() }, [request])
      const running = state?.status === 'running'
      return h('section', { 'aria-label': 'ACP · подключение к Desktop', style: { display: 'grid', gap: 12, padding: 16 } },
        h('h3', null, 'ACP · подключение к Desktop'),
        h('p', null, 'Локальный ACP-клиент может управлять отдельными сессиями этого DSH. По умолчанию подключение выключено.'),
        h('p', { role: 'status' }, 'Статус: ' + ({ running: 'включён', stopped: 'выключен', error: 'ошибка', starting: 'запускается', stopping: 'останавливается' }[state?.status] ?? 'проверяем…')),
        state?.error || error ? h('p', { role: 'alert' }, error || state.error) : null,
        h('div', null,
          h('button', { disabled: busy || !state, onClick: () => request({ action: running ? 'stop' : 'start' }) }, running ? 'Выключить ACP' : 'Включить ACP'),
          h('button', { disabled: busy, onClick: () => request() }, 'Обновить статус')),
        h('label', null, h('input', { type: 'checkbox', checked: state?.autoStart === true, disabled: busy || !state, onChange: event => request({ action: 'setAutoStart', autoStart: event.target.checked }) }), ' Включать при запуске DSH'),
        running ? h('p', null, 'Подключений: ' + state.activeConnections) : null,
        running ? h('details', null, h('summary', null, 'Параметры подключения ACP-клиента'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(state.connection, null, 2))) : null,
        h('p', null, 'Исходящие агенты настраиваются в «Внешние агенты ACP». Укажите полный путь к установленному адаптеру. Вход в CLI выполните отдельно. Запуск требует BUILD и Native Agent Access; разрешения автоматически не повышаются.'))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'airules-acp-control', order: 22 }, AcpControl))
      },
    }
  },
})
