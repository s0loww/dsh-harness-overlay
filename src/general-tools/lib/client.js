window.__ModuleLoader__.load({ id: 'airules-dsh-general-tools', factory: require => {
  let projectApi
  try { const candidate = require('airules-dsh-project-context'); if (typeof candidate?.useProject === 'function') projectApi = candidate } catch {}
  const scopedFetch = (...args) => projectApi ? projectApi.projectFetch(...args) : fetch(...args)
  function useProjectFetch(project) { const ref = projectApi ? React.useRef(project) : null; if (ref) ref.current = project; return (...args) => projectApi ? projectApi.projectFetch(args[0], args[1], ref.current) : fetch(...args) }

  const React = require('react'), h = React.createElement
  let sessions
  function Settings() {
    const snapshot = React.useSyncExternalStore(fn => sessions.list.subscribe(fn), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const project = projectApi ? projectApi.useProject() : null
    const scopedFetch = useProjectFetch(project)
    const [manual, setManual] = React.useState(null), id = projectApi ? project.projectId : manual ?? active
    const [data, setData] = React.useState(null), [mode, setMode] = React.useState('off'), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false)
    const epoch = React.useRef(0)
    const owner = React.useRef(id)
    React.useEffect(() => setManual(null), [active])
    React.useEffect(() => {
      const current = ++epoch.current; owner.current = id; setData(null); setError(''); setNotice(''); setMode('off'); setBusy(false)
      if (id) scopedFetch(`/airules/general-tools?sessionId=${encodeURIComponent(id)}`).then(r => r.json()).then(value => { if (current !== epoch.current) return; if (!value.ok) throw new Error('Не удалось прочитать стиль проекта.'); setData(value); setMode(value.mode) }).catch(reason => { if (current === epoch.current) setError(reason.message) })
      return () => { epoch.current++ }
    }, [id])
    async function save() {
      if (projectApi && !canWrite) { setError('Проект сейчас доступен только для чтения. Черновик сохранён.'); return }
      const current = epoch.current; setBusy(true); setError(''); setNotice('')
      try {
        const response = await scopedFetch('/airules/general-tools', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': data.csrfToken }, body: JSON.stringify({ sessionId: id, mode, revision: data.revision }) }), value = await response.json()
        if (!response.ok || !value.ok) throw new Error(value.error === 'STALE_STYLE' ? 'Настройка изменилась. Откройте раздел заново перед сохранением.' : 'Настройка не сохранена.')
        if (current === epoch.current) { setData(value); setMode(value.mode); setNotice('Сохранено для всех чатов этого проекта. Применится к следующему ответу; уже написанные сообщения не меняются.') }
      } catch (reason) { if (current === epoch.current) setError(reason.message) }
      finally { if (current === epoch.current) setBusy(false) }
    }
    const canWrite = data?.writable !== false && (!projectApi || project.writable && !project.loading)
    if (projectApi && owner.current !== id) return h('section', { className: 'airules-general-settings' }, h('h2', null, 'Краткость ответов'), h(projectApi.ProjectPicker, { project, disabled: false }), h('p', { role: 'status' }, 'Загрузка настройки выбранного проекта…'))
    return h('section', { className: 'airules-general-settings' }, h('h2', null, 'Краткость ответов'),
      h('p', null, 'Caveman lite сокращает формулировки, сохраняя технические факты, проверки и сообщения о ходе работы. По умолчанию выключен.'),
      (projectApi ? h(projectApi.ProjectPicker, { project, disabled: busy }) : h('label', null, 'Сеанс', h('select', { value: id, disabled: busy, onChange: event => setManual(event.target.value) }, h('option', { value: '' }, 'Выберите сеанс'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id))))),
      h('label', null, 'Режим', h('select', { value: mode, disabled: busy || !data?.supported || !canWrite, onChange: event => setMode(event.target.value) }, h('option', { value: 'off' }, 'Выключен'), h('option', { value: 'lite' }, 'Lite — кратко, полными предложениями'))),
      !canWrite && h('p', null, 'Для изменения настройки проекта разрешите запись в рабочую папку.'),
      data && !data.supported && h('p', null, 'Доступно в пресетах 1С, Python и системного администрирования.'),
      h('button', { type: 'button', disabled: busy || !data?.supported || !canWrite || mode === data.mode, onClick: save }, busy ? 'Сохранение…' : 'Сохранить стиль'),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
      h('small', null, 'Это настройка представления выбранного проекта. Она не меняет reasoning, права, инструменты, проверку результатов или документы и применяется к чатам этого проекта. Запрос пользователя на подробный ответ имеет приоритет.'))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-general-tools', label: () => 'Краткость ответов', order: 68 }, Settings))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = '.airules-general-settings{display:flex;flex-direction:column;gap:16px;font-size:13px}.airules-general-settings h2,.airules-general-settings p{margin:0}.airules-general-settings p,.airules-general-settings small{line-height:1.6}.airules-general-settings label{display:flex;flex-direction:column;gap:8px}.airules-general-settings select,.airules-general-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}.airules-general-settings button{align-self:flex-start;cursor:pointer}.airules-general-settings button:disabled{opacity:.5;cursor:default}'; document.head.appendChild(style); return () => style.remove() })
  }
  return { inject: ['slots', 'sessions'], apply }
} })
