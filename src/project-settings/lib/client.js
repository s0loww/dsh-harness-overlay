window.__ModuleLoader__.load({ id: 'airules-dsh-project-settings', factory: require => {
  let projectApi
  try { const candidate = require('airules-dsh-project-context'); if (typeof candidate?.useProject === 'function') projectApi = candidate } catch {}
  const scopedFetch = (...args) => projectApi ? projectApi.projectFetch(...args) : fetch(...args)
  function useProjectFetch(project) { const ref = projectApi ? React.useRef(project) : null; if (ref) ref.current = project; return (...args) => projectApi ? projectApi.projectFetch(args[0], args[1], ref.current) : fetch(...args) }

  const React = require('react'), h = React.createElement
  let sessions
  function useSessionList() {
    return React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
  }
  function Discovery({ sessionId, onApply, projectContext }) {
    const scopedFetch = useProjectFetch(projectContext)
    const [environment, setEnvironment] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [query, setQuery] = React.useState(''), [base, setBase] = React.useState(''), [platform, setPlatform] = React.useState(''), [checked, setChecked] = React.useState({})
    const generation = React.useRef(0)
    React.useEffect(() => { generation.current++; setEnvironment(null); setBusy(false); setError(''); setBase(''); setPlatform(''); setChecked({}); return () => { generation.current++ } }, [sessionId])
    async function scan() {
      const epoch = generation.current
      setBusy(true); setError('')
      try {
        const response = await scopedFetch(`/airules/project-settings/environment?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.message || 'Среда проекта недоступна.')
        if (generation.current === epoch) { setEnvironment(body); setChecked({}); setBase(''); setPlatform('') }
      } catch (reason) { if (generation.current === epoch) setError(reason.message) }
      finally { if (generation.current === epoch) setBusy(false) }
    }
    const matches = value => String(value).toLowerCase().includes(query.toLowerCase())
    const list = (items, render) => h('ul', null, ...items.map((item, index) => h('li', { key: index }, render(item))))
    const applyBase = () => { const choice = environment.catalogs.bases.find(item => item.id === base); if (choice) onApply({ INFOBASE_NAME: choice.name, INFOBASE_KIND: choice.kind, INFOBASE_PATH: choice.path }) }
    const applyPlatform = () => { const choice = environment.platforms.platforms.find(item => item.path === platform); if (choice) onApply({ PLATFORM_PATH: choice.path, PLATFORM_VERSION: choice.version }) }
    const proposal = environment?.proposal
    return h('section', { className: 'airules-project-discovery' }, h('h3', null, onApply ? 'Помощник настройки существующего проекта' : 'Среда 1С'), h('p', null, 'Локальные каталоги платформ, зарегистрированные базы и исходники. Проверяется наличие файлов; платформа и базы не запускаются.'), h('button', { type: 'button', disabled: busy || !sessionId, onClick: scan }, busy ? 'Обнаружение…' : environment ? 'Обновить обнаружение' : 'Обнаружить среду проекта'), error && h('p', { role: 'alert' }, error), environment && h(React.Fragment, null,
      h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: 'Поиск в обнаруженной среде', 'aria-label': 'Поиск среды 1С' }),
      environment.configuredPlatform && h('p', null, `Заданная платформа: ${environment.configuredPlatform.path} · ${environment.configuredPlatform.executableFound ? 'bin/1cv8.exe найден' : 'bin/1cv8.exe не найден'}`),
      h('details', { open: true }, h('summary', null, `Платформа 1С (${environment.platforms.platforms.length})`), list(environment.platforms.platforms.filter(item => matches(`${item.version} ${item.path}`)), item => `${item.version} · ${item.path}`), !environment.platforms.platforms.length && h('p', null, 'Исполняемый файл 1cv8.exe в стандартных каталогах не найден.'), environment.platforms.truncated && h('p', null, 'Список ограничен числом просмотренных каталогов.'), onApply && h('div', null, h('select', { value: platform, onChange: event => setPlatform(event.target.value), 'aria-label': 'Выбрать установленную платформу' }, h('option', { value: '' }, 'Выберите платформу для проекта'), ...environment.platforms.platforms.map(item => h('option', { key: item.path, value: item.path }, `${item.version} · ${item.path}`))), h('button', { type: 'button', disabled: !platform, onClick: applyPlatform }, 'Добавить платформу в черновик'))),
      h('details', { open: true }, h('summary', null, `Зарегистрированные базы (${environment.catalogs.bases.length})`), h('p', null, environment.catalogScope), list(environment.catalogs.bases.filter(item => matches(`${item.name} ${item.path}`)), item => `${item.name} · ${item.kind} · ${item.path} · ${item.source}`), list(environment.catalogs.catalogs, item => `${item.label}: ${item.status}`), environment.catalogs.truncated && h('p', null, 'Показан ограниченный список баз.'), onApply && h('div', null, h('select', { value: base, onChange: event => setBase(event.target.value), 'aria-label': 'Выбрать зарегистрированную базу' }, h('option', { value: '' }, 'Выберите базу для проекта'), ...environment.catalogs.bases.map(item => h('option', { key: item.id, value: item.id }, `${item.name} · ${item.kind}`))), h('button', { type: 'button', disabled: !base, onClick: applyBase }, 'Добавить базу в черновик'))),
      h('details', { open: true }, h('summary', null, `Исходники XML / EDT (${environment.sources.sources.length})`), list(environment.sources.sources.filter(item => matches(`${item.name} ${item.path}`)), item => `${item.name || item.kind} · ${item.format} · ${item.path}${item.compatibility ? ` · совместимость: ${item.compatibility}` : ''}`), !environment.sources.sources.length && h('p', null, 'Маркеры Configuration.xml / Configuration.mdo в пределах поиска не найдены.'), environment.sources.truncated && h('p', null, `Поиск ограничен: просмотрено ${environment.sources.scannedEntries} записей.`)),
      h('details', { open: true }, h('summary', null, 'Локальные инструменты'), list(environment.tools.filter(item => matches(`${item.id} ${item.path ?? ''}`)), item => `${item.id}: ${item.installed ? item.path : 'не найден в стандартных путях/PATH'}`)),
      onApply && h('details', { open: true }, h('summary', null, 'Предпросмотр предлагаемых параметров'), h('p', null, 'Отметьте нужные поля. Предложение и выбор базы меняют только черновик; файл изменится после «Сохранить».'), ...Object.entries(proposal.values).map(([key, value]) => h('label', { key, className: 'airules-project-proposal' }, h('input', { type: 'checkbox', checked: !!checked[key], onChange: event => setChecked(current => ({ ...current, [key]: event.target.checked })) }), h('span', null, `${key} = ${value}`))), list(proposal.reasons, item => item), proposal.ambiguousSources && h('p', null, 'Найдено несколько основных конфигураций: каталог исходников выберите вручную.'), proposal.ambiguousPlatforms && h('p', null, 'Найдено несколько платформ: выберите нужную версию в списке выше.'), h('button', { type: 'button', disabled: !Object.values(checked).some(Boolean), onClick: () => onApply(Object.fromEntries(Object.entries(proposal.values).filter(([key]) => checked[key]))) }, 'Добавить отмеченное в черновик'))))
  }
  function EnvironmentSettings() {
    const snapshot = useSessionList(), rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? null
    const project = projectApi ? projectApi.useProject({ presets: ['1c-airules'] }) : null
    const scopedFetch = useProjectFetch(project)
    const [manual, setManual] = React.useState(null), id = projectApi ? project.projectId : manual ?? active
    React.useEffect(() => setManual(null), [active])
    return h('section', { className: 'airules-project-settings' }, h('h2', null, 'Среда проекта 1С'), (projectApi ? h(projectApi.ProjectPicker, { project, disabled: false }) : h('label', null, 'Проектный сеанс', h('select', { value: id ?? '', onChange: event => setManual(event.target.value || null) }, h('option', { value: '' }, 'Выберите сеанс проекта'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id))))), h(Discovery, { key: id, sessionId: id, projectContext: project }))
  }
  function ProjectSettings() {
    const snapshot = useSessionList(), sessionRows = Object.values(snapshot?.byId ?? {})
    const active = sessionRows.find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? null
    const project = projectApi ? projectApi.useProject({ presets: ['1c-airules'] }) : null
    const scopedFetch = useProjectFetch(project)
    const [manual, setManual] = React.useState(null), id = projectApi ? project.projectId : manual ?? active
    const [data, setData] = React.useState(null), [draft, setDraft] = React.useState({}), [search, setSearch] = React.useState(''), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false)
    const generation = React.useRef(0), state = React.useRef(null)
    const owner = React.useRef(id)
    const canWrite = !!data?.writable && (!projectApi || project.writable && !project.loading)
    const dirty = Object.keys(draft).length
    state.current = { dirty, id }
    React.useEffect(() => { setManual(null) }, [active])
    const load = React.useCallback(async () => {
      const epoch = generation.current
      if (!id) { setData(null); setBusy(false); setError(''); return }
      setBusy(true); setError(''); setNotice('')
      try {
        const response = await scopedFetch(`/airules/project-settings?sessionId=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.message || 'Не удалось прочитать настройки.')
        if (epoch === generation.current) { setData(body); setDraft({}) }
      } catch (reason) { if (epoch === generation.current) setError(reason.message) }
      finally { if (epoch === generation.current) setBusy(false) }
    }, [id])
    React.useEffect(() => { generation.current++; owner.current = id; setData(null); setDraft({}); load(); return () => { generation.current++ } }, [load])
    React.useEffect(() => { const prevent = event => { if (state.current?.dirty) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent) }, [])
    const change = (field, value) => { if (projectApi && !canWrite) return; setDraft(current => {
      const next = { ...current, [field.key]: value }
      if (!field.secret && value === data.values[field.key]) delete next[field.key]
      return next
    }) }
    const applyDetected = updates => {
      if (!canWrite || busy) return
      setDraft(current => { const next = { ...current }; for (const [key, value] of Object.entries(updates)) { if (value !== data.values[key]) next[key] = value; else delete next[key] } return next })
      setNotice('Выбранные параметры добавлены в черновик. Проверьте поля и нажмите «Сохранить».')
    }
    async function save() {
      if (projectApi && !canWrite) { setError('Проект сейчас доступен только для чтения. Черновик сохранён.'); return }
      const epoch = generation.current, updates = { ...draft }
      setBusy(true); setError(''); setNotice('')
      try {
        const response = await scopedFetch('/airules/project-settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': data.csrfToken }, body: JSON.stringify({ sessionId: id, revision: data.revision, updates }) })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.message || 'Сохранение не выполнено. Черновик сохранён в форме.')
        if (epoch === generation.current) { setData(body); setDraft({}); setNotice(body.changed ? 'Настройки сохранены. Предыдущая версия существующего файла защищена в каталоге DSH.' : 'Изменений в файле нет.') }
      } catch (reason) { if (epoch === generation.current) setError(reason.message) }
      finally { if (epoch === generation.current) setBusy(false) }
    }
    const filtered = (data?.fields ?? []).filter(field => `${field.label} ${field.key}`.toLowerCase().includes(search.toLowerCase()))
    const groups = [...new Set(filtered.map(field => field.group))]
    if (projectApi && owner.current !== id) return h('section', { className: 'airules-project-settings' }, h('h2', null, 'Настройки проекта 1С'), h(projectApi.ProjectPicker, { project, disabled: false }), h('p', { role: 'status' }, 'Загрузка настроек выбранного проекта…'))
    function fieldRow(field) {
      const value = Object.hasOwn(draft, field.key) ? draft[field.key] : field.secret ? '' : data.values[field.key]
      const props = { id: `airules-project-${field.key}`, value, disabled: busy || !canWrite, onChange: event => change(field, event.target.value), autoComplete: 'off', maxLength: 4096 }
      return h('div', { className: 'airules-project-field', key: field.key }, h('label', { htmlFor: props.id }, field.label), h('small', null, field.key), field.choices ? h('select', props, h('option', { value: '' }, 'Не задано'), ...field.choices.map(option => h('option', { key: option, value: option }, field.key === 'USE_EDT' ? option === 'true' ? '1C:EDT' : 'Конфигуратор' : option))) : h('input', { ...props, type: field.secret ? 'password' : 'text', placeholder: field.secret ? data.secrets[field.key] ? 'Задано. Введите новое значение для замены.' : 'Не задано' : '' }), field.secret && h('div', null, h('small', null, data.secrets[field.key] ? 'Значение задано и не передаётся в браузер. ' : 'Значение не задано. '), h('button', { type: 'button', disabled: busy || !canWrite, onClick: () => change(field, '') }, 'Очистить при сохранении')), data.redactedKeys.includes(field.key) && h('small', null, 'Существующее значение скрыто: содержит реквизиты доступа. Без явной правки сохранится как есть. Пароль задавайте отдельным полем.'))
    }
    return h('section', { className: 'airules-project-settings' }, h('h2', null, 'Настройки проекта 1С'), h('p', null, 'Локальные параметры .dev.env выбранного проекта. Сохраняются только изменённые поля.'), (projectApi ? h(projectApi.ProjectPicker, { project, disabled: busy, beforeChange: () => !dirty || window.confirm('Перейти к другому проекту и сбросить несохранённые изменения?') }) : h('label', null, 'Проектный сеанс', h('select', { value: id ?? '', disabled: busy, onChange: event => { if (!dirty || window.confirm('Перейти к другому проекту и сбросить несохранённые изменения?')) setManual(event.target.value || null) } }, h('option', { value: '' }, 'Выберите сеанс проекта'), ...sessionRows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id))))), !id && h('p', null, 'Выберите проект в списке.'), error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice), data && h(React.Fragment, null, h('p', { className: 'airules-project-root' }, data.projectRoot), !canWrite && h('p', null, 'Настройки доступны для чтения. Сохранение требует доступа к рабочей папке с записью.'), h('input', { type: 'search', placeholder: 'Поиск параметров по названию или ключу', value: search, onChange: event => setSearch(event.target.value), 'aria-label': 'Поиск параметров проекта' }), h(Discovery, { sessionId: id, projectContext: project, onApply: canWrite && !busy ? applyDetected : undefined }), ...groups.map(group => h('details', { key: group, open: true }, h('summary', null, group), ...filtered.filter(field => field.group === group).map(fieldRow))), h('div', { className: 'airules-project-save' }, h('button', { type: 'button', disabled: busy || !dirty || !canWrite, onClick: save }, busy ? 'Обработка…' : `Сохранить${dirty ? ` (${dirty})` : ''}`), h('button', { type: 'button', disabled: busy, onClick: () => { if (!dirty || window.confirm('Обновить файл и сбросить несохранённые изменения?')) load() } }, 'Перечитать файл'))))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.effect(() => { const tag = document.createElement('style'); tag.textContent = '.airules-project-settings{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px}.airules-project-settings h2,.airules-project-settings p{margin:0}.airules-project-settings p{line-height:1.5}.airules-project-settings input,.airules-project-settings select{box-sizing:border-box;width:100%;padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:inherit;background:var(--dsw-alias-bg-layer-1);font:inherit}.airules-project-settings details{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:12px}.airules-project-settings summary{font-size:15px;font-weight:600;cursor:pointer}.airules-project-field{display:flex;flex-direction:column;gap:5px;margin-top:14px}.airules-project-field small{color:var(--dsw-alias-label-secondary);font-size:11px}.airules-project-settings button{color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px 12px;cursor:pointer}.airules-project-settings button:disabled{opacity:.5;cursor:default}.airules-project-save{display:flex;gap:8px;position:sticky;bottom:0;padding:12px 0;background:var(--dsw-alias-bg-layer-2)}.airules-project-root{overflow-wrap:anywhere;font-family:monospace}'; document.head.appendChild(tag); return () => tag.remove() })
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-onec-project', label: () => 'Настройки проекта 1С', order: 25 }, ProjectSettings))
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-onec-environment', label: () => 'Среда 1С', order: 24 }, EnvironmentSettings))
    ctx.effect(() => { const tag = document.createElement('style'); tag.textContent = '.airules-project-discovery{display:flex;flex-direction:column;gap:10px}.airules-project-discovery h3{margin:0;font-size:16px}.airules-project-discovery ul{padding-left:20px;overflow-wrap:anywhere}.airules-project-discovery li{margin:6px 0}.airules-project-discovery details>*+*{margin-top:10px}.airules-project-proposal{display:flex;align-items:flex-start;gap:8px;margin-top:9px;overflow-wrap:anywhere}.airules-project-proposal input[type=checkbox]{width:auto;flex:none}'; document.head.appendChild(tag); return () => tag.remove() })
  }
  return { inject: ['slots', 'sessions'], apply }
} })
