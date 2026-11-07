window.__ModuleLoader__.load({ id: 'airules-dsh-general-tools', factory: require => {
  const React = require('react'), h = React.createElement
  let sessions
  function Settings() {
    const snapshot = React.useSyncExternalStore(fn => sessions.list.subscribe(fn), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const [manual, setManual] = React.useState(null), id = manual ?? active
    const [data, setData] = React.useState(null), [mode, setMode] = React.useState('off'), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false)
    const epoch = React.useRef(0)
    React.useEffect(() => setManual(null), [active])
    React.useEffect(() => {
      const current = ++epoch.current; setData(null); setError(''); setNotice(''); setMode('off'); setBusy(false)
      if (id) fetch(`/airules/general-tools?sessionId=${encodeURIComponent(id)}`).then(r => r.json()).then(value => { if (current !== epoch.current) return; if (!value.ok) throw new Error('Не удалось прочитать стиль сеанса.'); setData(value); setMode(value.mode) }).catch(reason => { if (current === epoch.current) setError(reason.message) })
      return () => { epoch.current++ }
    }, [id])
    async function save() {
      const current = epoch.current; setBusy(true); setError(''); setNotice('')
      try {
        const response = await fetch('/airules/general-tools', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': data.csrfToken }, body: JSON.stringify({ sessionId: id, mode, revision: data.revision }) }), value = await response.json()
        if (!response.ok || !value.ok) throw new Error(value.error === 'STALE_STYLE' ? 'Настройка изменилась. Откройте раздел заново перед сохранением.' : 'Настройка не сохранена.')
        if (current === epoch.current) { setData(value); setMode(value.mode); setNotice('Сохранено для этого сеанса. Применится к следующему ответу; уже написанные сообщения не меняются.') }
      } catch (reason) { if (current === epoch.current) setError(reason.message) }
      finally { if (current === epoch.current) setBusy(false) }
    }
    return h('section', { className: 'airules-general-settings' }, h('h2', null, 'Краткость ответов'),
      h('p', null, 'Caveman lite сокращает формулировки, сохраняя технические факты, проверки и сообщения о ходе работы. По умолчанию выключен.'),
      h('label', null, 'Сеанс', h('select', { value: id, disabled: busy, onChange: event => setManual(event.target.value) }, h('option', { value: '' }, 'Выберите сеанс'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id)))),
      h('label', null, 'Режим', h('select', { value: mode, disabled: busy || !data?.supported, onChange: event => setMode(event.target.value) }, h('option', { value: 'off' }, 'Выключен'), h('option', { value: 'lite' }, 'Lite — кратко, полными предложениями'))),
      data && !data.supported && h('p', null, 'Доступно в пресетах 1С, Python и системного администрирования.'),
      h('button', { type: 'button', disabled: busy || !data?.supported || mode === data.mode, onClick: save }, busy ? 'Сохранение…' : 'Сохранить стиль'),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
      h('small', null, 'Это настройка представления текущего сеанса. Она не меняет reasoning, права, инструменты, проверку результатов или документы и не наследуется дочерними сеансами. Запрос пользователя на подробный ответ имеет приоритет.'))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-general-tools', label: () => 'Краткость ответов', order: 68 }, Settings))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = '.airules-general-settings{display:flex;flex-direction:column;gap:16px;font-size:13px}.airules-general-settings h2,.airules-general-settings p{margin:0}.airules-general-settings p,.airules-general-settings small{line-height:1.6}.airules-general-settings label{display:flex;flex-direction:column;gap:8px}.airules-general-settings select,.airules-general-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}.airules-general-settings button{align-self:flex-start;cursor:pointer}.airules-general-settings button:disabled{opacity:.5;cursor:default}'; document.head.appendChild(style); return () => style.remove() })
  }
  return { inject: ['slots', 'sessions'], apply }
} })
