window.__ModuleLoader__.load({ id: 'airules-dsh-skills', factory: require => {
  const React = require('react'), h = React.createElement
  const lookup = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined
  let sessions
  const messages = {
    WRITE_REQUIRED: 'Для проектных изменений включите запись в рабочую папку. Общие навыки меняются в сеансе с полным доступом.',
    STALE_SKILL: 'Навык изменился после загрузки страницы. Обновите список и повторите действие.',
    SKILL_EXISTS: 'Навык с таким именем уже существует в выбранной области. Откройте его или выберите другое имя.',
    SKILL_INVALID: 'Проверьте имя (строчные латинские буквы и дефисы), описание и инструкции.',
    SESSION_REQUIRED: 'Выберите открытый сеанс проекта. Для большого архивного сеанса сначала откройте его чат.',
    PATH_REJECTED: 'Этот навык находится за ссылкой или в неподдерживаемом расположении. Измените его вручную в исходном каталоге.',
    STALE_ASSIGNMENTS: 'Назначения изменились после загрузки. Обновите список и повторите действие.',
    ASSIGNMENTS_INVALID: 'Некорректные назначения. Проверьте формат файла skill-assignments/settings.json в DSH и .dsh/skill-assignments.json в проекте.',
    ASSIGNMENTS_BUSY: 'Другой процесс сохраняет назначения. Повторите позже.',
  }
  function AssignmentPanel({ data, scope: skillScope, busy, onAction }) {
    const settings = data.assignments, definitions = settings?.definitions
    const [targetScope, setTargetScope] = React.useState(data.projectRoot ? 'project' : 'global')
    const names = [...new Set([...(data.rows ?? []).map(row => row.name), ...Object.keys(settings?.common?.overrides ?? {}), ...Object.keys(settings?.project?.overrides ?? {})])].sort()
    const [skill, setSkill] = React.useState(names[0] ?? ''), [selectedTask, setSelectedTask] = React.useState(settings?.context?.selectedTaskType ?? 'auto')
    const empty = { taskTypes: [], roles: [], accessModes: [] }
    const inherited = lookup(settings?.common?.overrides, skill) ?? lookup(settings?.defaults, skill) ?? empty
    const saved = targetScope === 'project' ? lookup(settings?.project?.overrides, skill) ?? inherited : inherited
    const [draft, setDraft] = React.useState(saved)
    React.useEffect(() => { if (!names.includes(skill)) setSkill(names[0] ?? '') }, [names.join('\0')])
    React.useEffect(() => setDraft(saved), [skill, targetScope, settings?.common?.revision, settings?.project?.revision])
    React.useEffect(() => setSelectedTask(settings?.context?.selectedTaskType ?? 'auto'), [settings?.context?.revision, settings?.context?.selectedTaskType])
    if (!settings || !definitions) return null
    if (settings.settingsError) return h('section', { className: 'ask-assignments' }, h('h3', null, 'Назначения навыков'), h('p', { role: 'alert', className: 'ask-error' }, 'Не удалось прочитать назначения. Используется штатный каталог без фильтрации. Проверьте skill-assignments/settings.json в домашнем каталоге DSH, .dsh/skill-assignments.json в проекте и сохранённый контекст сеанса; повреждённые файлы автоматически не заменяются.'))
    const context = settings.context
    const writable = targetScope === 'project' ? data.writable : data.globalWritable
    const own = lookup(targetScope === 'project' ? settings.project.overrides : settings.common.overrides, skill)
    const origin = own ? targetScope === 'project' ? 'Переопределение проекта' : 'Общая настройка'
      : targetScope === 'project' && lookup(settings.common.overrides, skill) ? 'Наследуется общая настройка'
        : lookup(settings.defaults, skill) ? 'Встроенное назначение нашей сборки' : 'Без ограничений'
    const selectAxis = (axis, value, checked) => setDraft(previous => ({ ...previous, [axis]: checked ? [...previous[axis], value] : previous[axis].filter(item => item !== value) }))
    const axis = (key, label, values) => h('fieldset', { className: 'ask-assignment-axis', disabled: busy || !writable }, h('legend', null, label), ...Object.entries(values).map(([value, text]) => h('label', { key: value }, h('input', { type: 'checkbox', checked: draft[key].includes(value), onChange: event => selectAxis(key, value, event.target.checked), 'aria-label': `${label}: ${text}` }), text)))
    const contextLabel = context?.taskType === 'all' ? 'Все типы задач' : definitions.taskTypes[context?.taskType] ?? 'Сеанс не выбран'
    return h('section', { className: 'ask-assignments' }, h('h3', null, 'Назначения навыков по задачам'),
      h('p', { className: 'ask-muted' }, 'Сокращают подборку описаний в контексте. Полные инструкции загружаются по запросу. Явный вызов доступного навыка по имени сохраняется; разрешения действий и SKILL.md не меняются.'),
      context ? h(React.Fragment, null,
        h('div', { className: 'ask-task-context' }, h('label', null, 'Тип текущей задачи', h('select', { value: selectedTask, disabled: busy, onChange: event => setSelectedTask(event.target.value) }, h('option', { value: 'auto' }, 'Авто: план / роль / все типы'), h('option', { value: 'all' }, 'Все типы задач'), ...Object.entries(definitions.taskTypes).map(([value, label]) => h('option', { key: value, value }, label)))),
          h('button', { disabled: busy || selectedTask === context.selectedTaskType, onClick: () => onAction({ action: 'task-context', taskType: selectedTask, revision: context.revision }) }, 'Применить тип задачи')),
        h('p', { className: 'ask-context-status' }, `Сейчас: ${contextLabel} · ${context.role ? `роль ${context.role}` : 'общий агент'} · ${definitions.accessModes[context.accessMode] ?? context.accessMode}${context.nativePlan ? ' · штатный режим планирования' : ''}`),
        h('small', { className: 'ask-muted' }, 'Авто использует штатный план или точную роль управляемого делегата. В обычном чате оставляет все типы. Явный выбор имеет приоритет и не переносится в дочерний сеанс.'),
        settings.status?.selectedCount !== undefined && h('p', { className: 'ask-muted' }, `Последний подготовленный шаг: ${settings.status.selectedCount} из ${settings.status.totalCount} описаний.`),
        settings.status?.deferred && h('p', { className: 'ask-muted' }, 'Обновление подборки отложено: штатный реестр вернул неполный снимок.'))
        : h('p', { className: 'ask-muted' }, 'Выберите проектный сеанс для выбора типа задачи и изменения назначений.'),
      h('details', null, h('summary', null, 'Настроить назначения навыков'), h('div', { className: 'ask-assignment-editor' },
        h('div', { className: 'ask-assignment-selectors' }, h('label', null, 'Область назначений', h('select', { value: targetScope, disabled: busy, onChange: event => setTargetScope(event.target.value) }, h('option', { value: 'global' }, 'Общие значения'), h('option', { value: 'project', disabled: !data.projectRoot }, 'Переопределения проекта'))),
          h('label', null, 'Навык для назначения', h('select', { value: skill, disabled: busy || !names.length, onChange: event => setSkill(event.target.value) }, ...names.map(name => h('option', { key: name, value: name }, name))))),
        h('p', { className: 'ask-muted' }, `${origin}. Пустой выбор в каждой группе означает «все». Приоритет: встроенное → общие значения → проект.`),
        !writable && h('p', { className: 'ask-muted' }, targetScope === 'project' ? 'Для изменения назначений проекта нужна запись в рабочую папку.' : 'Для общих назначений нужен сеанс с полным доступом.'),
        skill && h(React.Fragment, null, axis('taskTypes', 'Тип', definitions.taskTypes), axis('roles', 'Роль', Object.fromEntries(definitions.roles.map(role => [role, role]))), axis('accessModes', 'Доступ', definitions.accessModes),
          h('div', { className: 'ask-assignment-actions' }, h('button', { disabled: busy || !writable, onClick: () => onAction({ action: 'assignment-save', change: 'set', scope: targetScope, skill, assignment: draft, revision: settings[targetScope === 'project' ? 'project' : 'common'].revision }) }, 'Сохранить назначения'),
            h('button', { disabled: busy || !writable || !own, onClick: () => onAction({ action: 'assignment-save', change: 'reset', scope: targetScope, skill, revision: settings[targetScope === 'project' ? 'project' : 'common'].revision }) }, 'Сбросить переопределение'))))))
  }
  function Skills() {
    const snapshot = React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
    const sessionRows = Object.values(snapshot?.byId ?? {})
    const active = sessionRows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? null
    const [manual, setManual] = React.useState(null), sessionId = manual ?? active
    const [data, setData] = React.useState(null), [query, setQuery] = React.useState(''), [scope, setScope] = React.useState('global')
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
    const [selected, setSelected] = React.useState(null), [content, setContent] = React.useState(null), [adding, setAdding] = React.useState(false), [folder, setFolder] = React.useState(false)
    const [draft, setDraft] = React.useState({ name: '', description: '', content: '' })
    const generation = React.useRef(0)
    React.useEffect(() => setManual(null), [active])
    const load = React.useCallback(async () => {
      const epoch = generation.current; setBusy(true); setError('')
      try {
        const response = await fetch(`/airules/skills?sessionId=${encodeURIComponent(sessionId ?? '')}`, { headers: { accept: 'application/json' } }), body = await response.json()
        if (!response.ok || !body.ok) throw new Error(messages[body.error] ?? 'Не удалось загрузить навыки.')
        if (generation.current === epoch) setData(body)
      } catch (reason) { if (generation.current === epoch) setError(reason.message) }
      finally { if (generation.current === epoch) setBusy(false) }
    }, [sessionId])
    React.useEffect(() => { generation.current++; setData(null); setSelected(null); setContent(null); setNotice(''); load(); return () => { generation.current++ } }, [load])
    React.useEffect(() => { const changed = () => load(); window.addEventListener('airules-skills-changed', changed); return () => window.removeEventListener('airules-skills-changed', changed) }, [load])
    async function post(body) {
      const response = await fetch('/airules/skills', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': data.csrfToken }, body: JSON.stringify({ ...body, sessionId }) }), result = await response.json()
      if (!response.ok || !result.ok) throw new Error(messages[result.error] ?? 'Операция не выполнена. Обновите список и проверьте доступ к каталогу.')
      return result
    }
    async function toggle(rows, enabled) {
      const epoch = generation.current
      setBusy(true); setError(''); setNotice('')
      try {
        const result = await post({ action: 'toggle', items: rows.map(({ id, revision }) => ({ id, revision })), enabled })
        if (epoch !== generation.current) return
        setNotice(`${enabled ? 'Включено' : 'Выключено'}: ${result.changed}. Изменение действует при следующем обращении к навыкам.`)
        await load()
      } catch (reason) { if (epoch === generation.current) { await load(); if (epoch === generation.current) setError(reason.message) } }
      finally { if (epoch === generation.current) setBusy(false) }
    }
    async function show(row) {
      const epoch = generation.current; setSelected(row); setContent(null); setBusy(true); setError('')
      try { const result = await post({ action: 'content', id: row.id }); if (epoch === generation.current) setContent(result) }
      catch (reason) { if (epoch === generation.current) setError(reason.message) }
      finally { if (epoch === generation.current) setBusy(false) }
    }
    async function add(event) {
      event.preventDefault(); const epoch = generation.current; setBusy(true); setError('')
      try {
        await post({ action: 'add', scope, ...draft })
        if (epoch !== generation.current) return
        setAdding(false); setDraft({ name: '', description: '', content: '' }); setNotice('Навык добавлен в штатный каталог DSH. Инструкции загружаются по запросу.'); await load()
      } catch (reason) { if (epoch === generation.current) setError(reason.message) }
      finally { if (epoch === generation.current) setBusy(false) }
    }
    async function assignmentAction(body) {
      const epoch = generation.current; setBusy(true); setError(''); setNotice('')
      try {
        await post(body)
        if (epoch !== generation.current) return
        setNotice(body.action === 'task-context' ? 'Тип задачи сохранён для этого сеанса. Права и режим планирования не изменены.' : 'Назначения сохранены. Подборка изменится при следующем шаге агента.')
        await load()
      } catch (reason) { if (epoch === generation.current) { await load(); if (epoch === generation.current) setError(reason.message) } }
      finally { if (epoch === generation.current) setBusy(false) }
    }
    const rows = (data?.rows ?? []).filter(row => row.scope === scope && `${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase()))
    const editable = rows.filter(row => row.writable), enabled = editable.filter(row => row.enabled), disabled = editable.filter(row => !row.enabled)
    const writable = scope === 'global' ? data?.globalWritable : data?.writable
    const directory = data?.directories?.find(row => row.scope === scope)?.path
    async function openDirectory() {
      setFolder(true); setError('')
      try {
        const response = await fetch('/open-in-app/apps'), payload = await response.json()
        const app = ['explorer', 'finder', 'filemanager'].find(app => payload.apps?.includes(app))
        if (!app || !directory) return
        const opened = await fetch('/open-in-app/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app, path: directory }) })
        if (!opened.ok) setNotice('Папка пока не создана или недоступна для открытия. Путь можно скопировать ниже.')
      } catch { setNotice('Путь к папке показан ниже. Её можно открыть в проводнике вручную.') }
    }
    return h('section', { className: 'airules-skills' },
      h('h2', null, 'Навыки'), h('p', { className: 'ask-muted' }, 'Найдите навык, посмотрите его инструкции или измените доступность. Полный текст загружается агентом по запросу.'),
      h('label', { className: 'ask-session' }, 'Проектный сеанс', h('select', { value: sessionId ?? '', disabled: busy, onChange: event => setManual(event.target.value || null) }, h('option', { value: '' }, 'Без проектного сеанса'), ...sessionRows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id)))),
      h('input', { className: 'ask-search', type: 'search', value: query, placeholder: 'Поиск навыков', 'aria-label': 'Поиск навыков', onChange: event => setQuery(event.target.value) }),
      error && h('p', { role: 'alert', className: 'ask-error' }, error), notice && h('p', { role: 'status' }, notice),
      h('div', { className: 'ask-toolbar' }, h('h3', null, 'Навыки ', h('small', null, rows.length)), h('div', null,
        h('button', { title: 'Открыть каталог навыков', 'aria-label': 'Открыть каталог навыков', disabled: !directory || busy, onClick: openDirectory }, '▱'),
        h('button', { title: 'Обновить навыки', 'aria-label': 'Обновить навыки', disabled: busy, onClick: load }, '↻'),
        h('button', { title: 'Добавить навык', 'aria-label': 'Добавить навык', disabled: busy || !writable, onClick: () => { setAdding(!adding); setSelected(null) } }, '+'))),
      h('div', { className: 'ask-scopes' }, h('select', { value: scope, onChange: event => { setScope(event.target.value); setSelected(null); setAdding(false) }, 'aria-label': 'Область навыков', disabled: busy }, h('option', { value: 'global' }, 'Общие'), h('option', { value: 'project', disabled: !data?.projectRoot }, 'Текущий проект')), data?.projectRoot && scope === 'project' && h('small', null, data.projectRoot)),
      folder && directory && h('div', { className: 'ask-directory' }, h('code', null, directory), h('button', { onClick: async () => { try { await navigator.clipboard.writeText(directory); setNotice('Путь скопирован.') } catch { setNotice('Выделите и скопируйте показанный путь.') } } }, 'Копировать путь')),
      data && !writable && h('p', { className: 'ask-muted' }, scope === 'global' ? 'Просмотр общих навыков. Для изменения выберите сеанс с полным доступом.' : 'Просмотр навыков проекта. Для изменения включите запись в рабочую папку.'),
      h('div', { className: 'ask-bulk' }, h('button', { disabled: busy || !enabled.length, onClick: () => toggle(enabled, false) }, `Выключить все · ${enabled.length}/${editable.length}`), disabled.length > 0 && h('button', { disabled: busy, onClick: () => toggle(disabled, true) }, `Включить все · ${disabled.length}`)),
      adding && h('form', { className: 'ask-add', onSubmit: add }, h('h3', null, `Новый навык · ${scope === 'global' ? 'общие' : 'проект'}`),
        h('label', null, 'Имя', h('input', { required: true, value: draft.name, maxLength: 100, placeholder: 'my-skill', onChange: event => setDraft({ ...draft, name: event.target.value }) })),
        h('label', null, 'Когда использовать', h('input', { required: true, value: draft.description, maxLength: 4096, onChange: event => setDraft({ ...draft, description: event.target.value }) })),
        h('label', null, 'Инструкции', h('textarea', { required: true, value: draft.content, rows: 10, onChange: event => setDraft({ ...draft, content: event.target.value }) })),
        h('p', { className: 'ask-muted' }, 'Создаётся новый SKILL.md. Существующие навыки сохраняются. Для переноса комплекта с ресурсами используйте «Импорт из других агентов».'),
        h('button', { type: 'submit', disabled: busy || !writable }, 'Создать навык'), h('button', { type: 'button', onClick: () => setAdding(false) }, 'Отмена')),
      h('div', { className: 'ask-grid' }, ...rows.map(row => h('article', { className: 'ask-card', key: row.id },
        h('button', { className: 'ask-title', onClick: () => show(row), disabled: busy, title: row.description }, h('span', { 'aria-hidden': true }, '♧'), row.name),
        h('button', { className: `ask-state ${row.enabled ? 'on' : 'off'}`, disabled: busy || !row.writable, onClick: () => toggle([row], !row.enabled), title: row.runtime ? 'Управляется плагином' : row.nativePolicyDisabled ? 'Вызовы отключены непосредственно в SKILL.md. Измените исходную политику вручную.' : row.enabled ? 'Выключить навык' : 'Включить навык', 'aria-label': `${row.enabled ? 'Выключить' : 'Включить'} ${row.name}` }, row.nativePolicyDisabled ? '○ Политика SKILL.md' : `${row.enabled ? '● Включено' : '○ Выключено'} ${row.writable ? '⌄' : '·'}`)))),
      !busy && !rows.length && h('p', { className: 'ask-muted' }, query ? 'По запросу ничего не найдено.' : 'В этой области пока нет навыков. Добавьте навык или импортируйте из другого агента.'),
      busy && h('p', { role: 'status', className: 'ask-muted' }, 'Обработка…'),
      selected && h('details', { className: 'ask-viewer', open: true }, h('summary', null, selected.name), h('p', null, selected.description), content?.path && h('code', null, content.path), content && h('pre', null, content.content), h('button', { onClick: () => { setSelected(null); setContent(null) } }, 'Закрыть инструкции')),
      data && h(AssignmentPanel, { key: sessionId ?? 'none', data, scope, busy, onAction: assignmentAction }),
      h('p', { className: 'ask-muted ask-footnote' }, 'Проектные навыки имеют приоритет над общими. Встроенные навыки отключаются локальным правилом доступности; исходные файлы сборки сохраняются. Навыки, предоставленные кодом плагина, доступны для просмотра.'),
      data?.truncated && h('p', null, 'Каталог ограничен 2000 записями. Часть навыков не показана.'))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-skills', label: () => 'Навыки', order: 67 }, Skills))
    ctx.effect(() => {
      const style = document.createElement('style')
      style.textContent = '.airules-skills{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary)}.airules-skills h2,.airules-skills h3,.airules-skills p{margin:0}.airules-skills h2{font-size:24px}.ask-muted{color:var(--dsw-alias-label-secondary);line-height:1.6}.airules-skills button,.airules-skills select,.airules-skills input,.airules-skills textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 12px;box-sizing:border-box}.airules-skills button{cursor:pointer}.airules-skills button:disabled{opacity:.5;cursor:default}.ask-search{width:100%;min-height:40px}.ask-toolbar{display:flex;justify-content:space-between;align-items:center}.ask-toolbar>div,.ask-bulk,.ask-scopes,.ask-directory{display:flex;gap:8px;align-items:center}.ask-toolbar h3{font-size:15px}.ask-toolbar small{color:var(--dsw-alias-label-secondary);font-weight:normal}.ask-toolbar button{min-width:34px;font-size:18px;padding:5px}.ask-scopes{flex-wrap:wrap}.ask-scopes select{border-radius:20px}.ask-scopes small,.ask-directory code{overflow-wrap:anywhere}.ask-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ask-card{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:12px;display:flex;gap:8px;justify-content:space-between;align-items:center;background:var(--dsw-alias-bg-layer-3)}.airules-skills .ask-title{border:0;background:transparent;padding:0;display:flex;align-items:center;gap:10px;font-weight:600;overflow-wrap:anywhere;text-align:left;min-width:0}.ask-title span{color:var(--dsw-alias-label-secondary)}.airules-skills .ask-state{font-size:11px;border:0;white-space:nowrap;padding:5px 7px}.ask-state.on{color:#65d59a;background:#379c6126}.ask-state.off{color:var(--dsw-alias-label-secondary)}.ask-bulk button{padding:5px 10px;font-size:12px}.ask-session{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-secondary)}.ask-session select{flex:1;min-width:0}.ask-add,.ask-viewer{border:1px solid var(--dsw-alias-border-l2);padding:16px;border-radius:9px}.ask-add{display:flex;flex-direction:column;gap:12px}.ask-add label{display:flex;flex-direction:column;gap:5px}.ask-viewer>*+*{margin-top:12px}.ask-viewer pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;padding:14px;background:var(--dsw-alias-bg-layer-1);border-radius:8px;font-size:12px}.ask-viewer code{overflow-wrap:anywhere;font-size:11px}.ask-error{color:#ff8f82}.ask-footnote{font-size:11px}@media(max-width:800px){.ask-grid{grid-template-columns:1fr}.ask-session{flex-direction:column;align-items:stretch}}'
      style.textContent += '.ask-assignments{border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px;display:flex;flex-direction:column;gap:12px}.ask-assignments h3{font-size:16px}.ask-assignments summary{cursor:pointer;font-weight:600;padding:8px 0}.ask-task-context,.ask-assignment-selectors,.ask-assignment-actions{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.ask-task-context label,.ask-assignment-selectors label{display:flex;flex-direction:column;gap:7px;flex:1;min-width:190px}.ask-assignment-editor{display:flex;flex-direction:column;gap:14px;padding:12px 0}.ask-assignment-axis{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:12px}.ask-assignment-axis legend{padding:0 5px;font-weight:600}.ask-assignment-axis label{display:flex;gap:8px;align-items:center;font-size:12px}.ask-assignment-axis input[type=checkbox]{width:14px;height:14px;padding:0;margin:0;flex:none}.ask-context-status{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);line-height:1.5}.ask-assignments small{line-height:1.5}@media(max-width:800px){.ask-assignment-axis{grid-template-columns:1fr}}'
      document.head.appendChild(style); return () => style.remove()
    })
  }
  return { inject: ['slots', 'sessions'], apply }
} })
