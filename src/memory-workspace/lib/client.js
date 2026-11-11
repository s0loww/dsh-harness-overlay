window.__ModuleLoader__.load({ id: 'airules-dsh-memory-workspace', factory: require => {
  let projectApi
  try { const candidate = require('airules-dsh-project-context'); if (typeof candidate?.useProject === 'function') projectApi = candidate } catch {}
  const scopedFetch = (...args) => projectApi ? projectApi.projectFetch(...args) : fetch(...args)
  function useProjectFetch(project) { const ref = projectApi ? React.useRef(project) : null; if (ref) ref.current = project; return (...args) => projectApi ? projectApi.projectFetch(args[0], args[1], ref.current) : fetch(...args) }

  const React = require('react'), h = React.createElement
  let sessions
  async function request(input, token, projectContext) {
    const routeFetch = projectApi ? projectApi.fetchFor(projectContext) : fetch
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000)
    try {
    const response = await routeFetch(token ? '/airules/memory' : `/airules/memory?${new URLSearchParams(input)}`, token
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-airules-csrf': token }, body: JSON.stringify(input), signal: controller.signal }
      : { headers: { accept: 'application/json' }, signal: controller.signal })
    let result
    try { result = await response.json() } catch { throw new Error(`Сервер памяти вернул некорректный ответ (HTTP ${response.status}).`) }
    if (!response.ok || !result.ok) throw new Error(`${result.message ?? 'Память недоступна.'} (${result.error ?? response.status})`)
    return result
    } catch (error) { if (controller.signal.aborted) throw new Error('Время ожидания истекло. Проверьте состояние сервера и результат в чате перед повтором операции.'); throw error }
    finally { clearTimeout(timer) }
  }
  function Graph({ graph }) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [], edges = Array.isArray(graph?.edges) ? graph.edges : []
    const id = node => String(node.id ?? node.node_id ?? ''), label = node => String(node.label ?? node.name ?? node.id ?? '').slice(0, 100)
    const points = new Map(nodes.map((node, i) => [id(node), { x: 400 + 300 * Math.cos(2 * Math.PI * i / Math.max(nodes.length, 1)), y: 230 + 170 * Math.sin(2 * Math.PI * i / Math.max(nodes.length, 1)) }]))
    return h('section', null, h('h3', null, 'Граф памяти'), h('p', null, `${nodes.length} узлов · ${edges.length} связей. Ограниченное представление обработанных записей.`),
      nodes.length ? h('svg', { viewBox: '0 0 800 460', role: 'img', 'aria-label': 'Граф памяти текущего проекта', style: { width: '100%', minHeight: 180 } },
        edges.map((edge, i) => { const from = points.get(String(edge.source ?? edge.from)), to = points.get(String(edge.target ?? edge.to)); return from && to ? h('line', { key: `e${i}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: '#687ba4' }, h('title', null, String(edge.label ?? edge.type ?? ''))) : null }),
        nodes.map(node => { const point = points.get(id(node)); return h('g', { key: id(node) }, h('circle', { cx: point.x, cy: point.y, r: 6, fill: '#85aaff' }, h('title', null, label(node))), nodes.length <= 30 && h('text', { x: point.x + 9, y: point.y + 4, fill: 'currentColor', fontSize: 11 }, label(node).slice(0, 24))) })) : h('p', null, 'В этом наборе пока нет доступных узлов.'),
      graph?.truncated && h('p', { role: 'status' }, 'Показана часть графа.'))
  }
  function Result({ result, action, backend, nested = false }) {
    if (!nested && result.backends && typeof result.backends === 'object') {
      const labels = action === 'remember' ? { complete: 'Результаты сохранения получены', partial: 'Частичный результат сохранения', unavailable: 'Сохранение не подтверждено' } : { complete: 'Источники ответили', partial: 'Частичный ответ источников', unavailable: 'Источники памяти недоступны' }
      const states = { ok: 'ответ получен', unavailable: 'недоступен', failed: 'ошибка', 'not-attempted': 'не выполнялся' }
      return h('section', { 'aria-live': 'polite' }, h('h3', null, 'Результат'), h('p', { role: 'status' }, labels[result.status] ?? 'Ответ источников памяти'),
        Object.entries(result.backends).map(([name, value]) => h('article', { key: name, className: 'am-backend' }, h('h4', null, `${{ cognee: 'Cognee', memoria: 'Memoria' }[name] ?? name}: ${states[value.status] ?? value.status ?? 'состояние неизвестно'}`),
          value.error && h('p', { className: 'am-error' }, String(value.error)), value.result && h(Result, { result: value.result, action, backend: name, nested: true }))),
        h('details', null, h('summary', null, 'Технические сведения'), h('pre', null, JSON.stringify(result, null, 2))))
    }
    const textOf = value => typeof value === 'string' ? value : String(value?.text ?? value?.content ?? value?.chunk_text ?? value?.chunk ?? '')
    const chunks = (result.results ?? []).flatMap(row => Array.isArray(row?.search_result) ? row.search_result : Array.isArray(row?.searchResult) ? row.searchResult : [row])
    const stateLabels = { DATASET_PROCESSING_COMPLETED: 'Обработка завершена', DATASET_PROCESSING_STARTED: 'Идёт обработка', DATASET_PROCESSING_NOT_STARTED: 'Обработка не запускалась', uploaded: 'Текст загружен', stored: 'Запись сохранена', 'outcome-unknown': 'Исход операции неизвестен', 'processing-requested': 'Обработка запрошена' }
    let content
    if (result.submitted) content = h('p', { role: 'status' }, action === 'processingApply' ? 'Запрос применения профиля передан в чат. Выбранные модели ещё не считаются активными; дождитесь результата операции DSH.' : action === 'process' ? 'Запрос обработки передан в чат. Обработка ещё не считается запущенной или завершённой; проверьте результат операции DSH.' : 'Запрос передан в выбранный чат. Проверьте результат выполнения DSH; запись ещё не считается выполненной. Текст заметки сохранён в форме.')
    else if (action === 'graph') content = h(Graph, { graph: result.graph ?? result })
    else if (action === 'documents') content = result.documents?.length ? h('ul', null, result.documents.map(doc => h('li', { key: doc.id }, h('strong', null, doc.name || 'Документ'), doc.type && ` · ${doc.type}`, h('p', { className: 'am-muted' }, `Источник: ${doc.id}`)))) : h('p', null, 'В памяти этого проекта пока нет документов.')
    else if (action === 'recall') content = chunks.length ? h('div', null, chunks.map((chunk, i) => h('article', { key: i, className: 'am-chunk' }, h('p', { style: { whiteSpace: 'pre-wrap' } }, textOf(chunk) || 'Сервер вернул запись без текстового фрагмента.'), h('p', { className: 'am-muted' }, `Источник: ${chunk?.document_id ?? chunk?.documentId ?? chunk?.source?.recordId ?? chunk?.id ?? 'не указан'}${chunk?.source?.tool ? ` · инструмент: ${chunk.source.tool}` : ''}`), chunk?.source?.scopeEvidence && h('p', { className: 'am-muted' }, `Область: ${typeof chunk.source.scopeEvidence === 'string' ? chunk.source.scopeEvidence : JSON.stringify(chunk.source.scopeEvidence)}`)))) : h('p', null, result.missingDataset ? 'У проекта ещё нет набора памяти. Добавьте подтверждённую заметку.' : 'Совпадений не найдено.')
    else if (action === 'status') content = backend === 'memoria' || result.backend === 'memoria'
      ? h('div', null, h('p', null, 'Memoria: сведения о проектной привязке получены.'), h('p', { className: 'am-muted' }, result.connected === true ? 'Соединение подтверждено сервером.' : 'Наличие схем и настроенной области не подтверждает ответ сервера. Доступность проверяется реальным поисковым запросом.'))
      : h('div', null, h('p', null, 'Cognee доступен. Запрос авторизован.'), h('p', { className: 'am-muted' }, result.datasetId ? 'Набор текущего проекта найден.' : 'Набор появится после первой загрузки заметки.'), h('ul', null, Object.entries(result.capabilities ?? {}).map(([key, enabled]) => h('li', { key }, `${{ documents: 'Документы', upload: 'Загрузка', process: 'Обработка', recall: 'Поиск', graph: 'Граф', status: 'Состояние обработки' }[key] ?? key}: ${enabled ? 'доступно' : 'недоступно'}`))))
    else if (action === 'task') { const status = typeof result.status === 'string' ? result.status : result.status?.status ?? result.status?.state; content = h('div', null, h('p', null, result.missingDataset ? result.unknownOutcome ? 'Набор памяти пока недоступен. Исход прежней обработки не подтверждён; не повторяйте запуск автоматически.' : 'Обработка ещё не запускалась: в памяти проекта пока нет документов.' : stateLabels[status] ?? status ?? 'Сервер вернул состояние обработки.'), !result.missingDataset && result.exactTask === false && h('p', { className: 'am-muted' }, 'Сервер показывает последнюю обработку набора; это не подтверждение конкретного ID задачи.')) }
    else content = h('p', null, stateLabels[result.state] ?? 'Ответ операции получен.')
    return h('section', { 'aria-live': 'polite' }, h('h3', null, 'Результат'), content, result.truncated && action !== 'graph' && h('p', null, 'Показана ограниченная часть результата.'), h('details', null, h('summary', null, 'Технические сведения'), h('pre', null, JSON.stringify(result, null, 2))))
  }
  const MODES = { cognee: 'Cognee', memoria: 'Memoria', both: 'Обе' }
  const APPROVALS = { required: 'Запрашивать', disabled: 'Не запрашивать' }
  const WRITES = { auto: 'Автоматически по типу записи', cognee: 'Cognee', memoria: 'Memoria', both: 'Обе — две отдельные записи' }
  const MODEL_STATES = { installed: 'установлена', loaded: 'загружена', cached: 'установлена в кэше', available: 'доступна через API', unavailable: 'недоступна', unknown: 'наличие не проверено' }
  const field = (label, control) => h('label', null, label, control)
  const select = (value, options, onChange, disabled = false) => h('select', { value, disabled, onChange: event => onChange(event.target.value) }, options.map(([id, label]) => h('option', { key: id, value: id }, label)))
  const clone = value => JSON.parse(JSON.stringify(value))
  function writeOptions(mode, current, inherited = false) {
    const options = Object.entries(WRITES).filter(([id]) => mode === 'both' || id === 'auto' || id === mode)
    if (inherited) options.unshift(['inherit', 'Наследовать общую настройку'])
    if (current && !options.some(([id]) => id === current)) options.push([current, `${WRITES[current] ?? current} — недоступно в режиме ${MODES[mode] ?? mode}`])
    return options
  }
  const defaultProject = () => ({ schemaVersion: 1, mode: 'inherit', writeTarget: 'inherit', approval: 'inherit' })
  const defaultGlobal = () => ({ schemaVersion: 1, mode: 'cognee', writeTarget: 'auto', approval: 'required' })
  const defaultProcessing = () => ({ allowed: false, embeddings: { provider: 'fastembed', model: 'BAAI/bge-small-en-v1.5' }, extraction: { provider: 'gliner', model: 'fastino/gliner2.5-base-v1' } })
  const safeButton = (label, onClick, disabled = false, pending = false) => h('button', { type: 'button', disabled, 'aria-disabled': pending || disabled, onClick: () => { if (!pending && !disabled) void onClick() } }, label)
  function PolicyPanel({ policy, sessionId, scope, token, busy, onSave, projectContext }) {
    const global = policy?.global ?? defaultGlobal(), project = policy?.project ?? defaultProject()
    const [globalDraft, setGlobal] = React.useState(clone(global)), [projectDraft, setProject] = React.useState(clone(project))
    const [catalog, setCatalog] = React.useState([]), [catalogBusy, setCatalogBusy] = React.useState(false), [catalogMessage, setCatalogMessage] = React.useState('')
    const generation = React.useRef(0)
    React.useEffect(() => setGlobal(clone(global)), [policy?.globalRevision])
    React.useEffect(() => { generation.current++; setProject(clone(project)); setCatalog([]); setCatalogBusy(false); setCatalogMessage(''); return () => { generation.current++ } }, [sessionId, policy?.projectRevision])
    const updateGlobal = values => { if (!busy) setGlobal({ ...globalDraft, ...values }) }
    const updateProject = values => { if (!busy) setProject({ ...projectDraft, ...values }) }
    const binding = projectDraft.memoria ?? {}, updateBinding = values => updateProject({ memoria: { ...binding, ...values } })
    const updateOperation = (operation, key, value) => updateBinding({ [operation]: { ...(binding[operation] ?? {}), [key]: value } })
    const projectMode = projectDraft.mode === 'inherit' ? global.mode : projectDraft.mode
    const inheritedConflict = projectDraft.writeTarget === 'inherit' && global.writeTarget !== 'auto' && projectMode !== 'both' && global.writeTarget !== projectMode
    function changeGlobalMode(mode) { updateGlobal({ mode, writeTarget: mode === 'both' || ['auto', mode].includes(globalDraft.writeTarget) ? globalDraft.writeTarget : 'auto' }) }
    function changeProjectMode(mode) {
      const effectiveMode = mode === 'inherit' ? global.mode : mode
      updateProject({ mode, writeTarget: effectiveMode === 'both' || ['inherit', 'auto', effectiveMode].includes(projectDraft.writeTarget) ? projectDraft.writeTarget : 'auto' })
    }
    async function loadCatalog() {
      if (catalogBusy || !sessionId || scope?.active === false) return
      const current = generation.current; setCatalogBusy(true); setCatalogMessage('Чтение доступных схем…')
      try { const value = await request({ action: 'memoraCatalog', sessionId }, undefined, projectContext); if (current === generation.current) { setCatalog(value.tools ?? []); setCatalogMessage(value.tools?.length ? `Доступно схем: ${value.tools.length}. Наличие схемы не подтверждает соединение с сервером.` : 'Для этого проекта инструменты Memoria пока не видны. Подключите MCP и обновите каталог.') } }
      catch (error) { if (current === generation.current) setCatalogMessage(error.message) }
      finally { if (current === generation.current) setCatalogBusy(false) }
    }
    const toolSelect = operation => {
      const saved = binding[operation]?.tool ?? '', names = [...new Set([...(saved ? [saved] : []), ...catalog.map(row => row.name)])]
      return field(operation === 'search' ? 'MCP-инструмент поиска' : 'MCP-инструмент сохранения', select(saved, [['', 'Не настроен'], ...names.map(name => [name, name])], value => updateOperation(operation, 'tool', value), !scope?.writable))
    }
    function saveProject() {
      const value = clone(projectDraft)
      if (value.memoria && !value.memoria.namespace && !value.memoria.search?.tool && !value.memoria.remember?.tool) delete value.memoria
      return onSave('projectPolicy', { sessionId, policy: value, expectedRevision: policy?.projectRevision })
    }
    return h('section', { className: 'am-policy' },
      h('h3', null, 'Память по умолчанию'),
      h('p', { className: 'am-muted' }, 'Общая настройка применяется ко всем проектам без собственного переопределения. Для её выбора открытый чат не требуется.'),
      field('Режим памяти для новых и наследующих проектов', select(globalDraft.mode, Object.entries(MODES), changeGlobalMode)),
      field('Подтверждения операций памяти', select(globalDraft.approval ?? 'required', Object.entries(APPROVALS), approval => updateGlobal({ approval }))),
      h('p', { className: 'am-muted' }, '«Не запрашивать» отключает дополнительные подтверждения операций памяти. Удаление всегда требует подтверждения. Штатные права DSH, песочница и ограничения MCP сохраняются.'),
      h('details', null, h('summary', null, 'Назначение записей по умолчанию'),
        field('Куда сохранять проверенные записи', select(globalDraft.writeTarget, writeOptions(globalDraft.mode, globalDraft.writeTarget), writeTarget => updateGlobal({ writeTarget }))),
        h('p', { className: 'am-muted' }, 'В режиме «Обе» автоматический выбор направляет факты и handoff в Memoria, документы — в Cognee. Двойная запись создаёт два результата; частичный успех не считается полным. Существующая память автоматически не копируется.')),
      safeButton('Сохранить общую настройку памяти', () => onSave('policyGlobal', { policy: globalDraft, expectedRevision: policy?.globalRevision }), !token, busy),
      h('section', { className: 'am-card' }, h('h3', null, 'Настройка этого проекта'),
        h('p', { className: 'am-muted' }, scope?.projectRoot ?? 'Выберите проект для его настройки. Общие предпочтения доступны отдельно.'),
        field('Режим памяти проекта', select(projectDraft.mode, [['inherit', 'Наследовать общую настройку'], ...Object.entries(MODES)], changeProjectMode, !scope?.writable)),
        field('Подтверждения операций памяти проекта', select(projectDraft.approval ?? 'inherit', [['inherit', 'Наследовать общую настройку'], ...Object.entries(APPROVALS)], approval => updateProject({ approval }), !scope?.writable)),
        field('Назначение записей проекта', select(projectDraft.writeTarget, writeOptions(projectMode, projectDraft.writeTarget, true), writeTarget => updateProject({ writeTarget }), !scope?.writable)),
        inheritedConflict && h('p', { role: 'status', className: 'am-error' }, 'Наследуемое назначение записи несовместимо с режимом проекта. Выберите автоматическое назначение или разрешённое хранилище; записи автоматически перенаправляться не будут.'),
        safeButton('Сохранить настройку проекта', saveProject, !scope?.writable || !token, busy),
        h('p', { className: 'am-muted' }, 'Настройка действует для всех чатов этого проекта.'),
        h('details', null, h('summary', null, 'Привязка Memoria к проекту'),
          h('p', { className: 'am-muted' }, 'Укажите пространство проекта и поля реальных MCP-инструментов. Запрос без проверенной области не отправляется. Фасад не требуется.'),
          safeButton('Обновить каталог Memoria', loadCatalog, !sessionId || scope?.active === false, catalogBusy || busy),
          h('p', { role: 'status', className: 'am-muted' }, catalogMessage || 'Каталог ещё не запрашивался.'),
          field('Пространство проекта в Memoria', h('input', { value: binding.namespace ?? '', maxLength: 256, disabled: !scope?.writable, onChange: event => updateBinding({ namespace: event.target.value }) })),
          toolSelect('search'),
          field('Поле области в поиске', h('input', { value: binding.search?.scopeArgument ?? '', maxLength: 100, disabled: !scope?.writable, placeholder: 'Например: namespace', onChange: event => updateOperation('search', 'scopeArgument', event.target.value) })),
          field('Поле поискового запроса', h('input', { value: binding.search?.queryArgument ?? '', maxLength: 100, disabled: !scope?.writable, placeholder: 'Например: query', onChange: event => updateOperation('search', 'queryArgument', event.target.value) })),
          toolSelect('remember'),
          field('Поле области при сохранении', h('input', { value: binding.remember?.scopeArgument ?? '', maxLength: 100, disabled: !scope?.writable, placeholder: 'Например: namespace', onChange: event => updateOperation('remember', 'scopeArgument', event.target.value) })),
          field('Поле текста записи', h('input', { value: binding.remember?.textArgument ?? '', maxLength: 100, disabled: !scope?.writable, placeholder: 'Например: content', onChange: event => updateOperation('remember', 'textArgument', event.target.value) })),
          field('Поле названия (необязательно)', h('input', { value: binding.remember?.titleArgument ?? '', maxLength: 100, disabled: !scope?.writable, onChange: event => updateOperation('remember', 'titleArgument', event.target.value) })),
          safeButton('Сохранить привязку Memoria', saveProject, !scope?.writable || !token, busy))))
  }
  function ModelSelection({ kind, value, busy, onChange }) {
    const [catalog, setCatalog] = React.useState([]), [pending, setPending] = React.useState(false), [message, setMessage] = React.useState('Наличие модели ещё не проверено.')
    const generation = React.useRef(0)
    React.useEffect(() => { generation.current++; setCatalog([]); setPending(false); setMessage('Наличие модели ещё не проверено.'); return () => { generation.current++ } }, [value.provider, value.endpoint])
    const providers = kind === 'embeddings' ? [['fastembed', 'Локальная встроенная FastEmbed'], ['ollama', 'Локальная Ollama'], ['lmstudio', 'Локальная LM Studio'], ['openrouter', 'OpenRouter API']] : [['gliner', 'Локальная встроенная GLiNER'], ['ollama', 'Локальная Ollama'], ['lmstudio', 'Локальная LM Studio'], ['openrouter', 'OpenRouter API']]
    const update = next => { if (!busy) onChange(next) }
    function changeProvider(provider) {
      const next = { provider, model: '' }
      if (provider === 'ollama') next.endpoint = 'http://127.0.0.1:11434'
      if (provider === 'lmstudio') next.endpoint = 'http://127.0.0.1:1234'
      update(next)
    }
    async function discover() {
      if (pending || busy) return
      const current = generation.current; setPending(true); setMessage('Проверка доступного каталога моделей…')
      try { const result = await request({ action: 'processingModels', kind, provider: value.provider, ...(value.endpoint ? { endpoint: value.endpoint } : {}) }); if (current === generation.current) { setCatalog(result.models ?? []); setMessage(result.note || (result.available ? `Найдено моделей: ${result.models?.length ?? 0}.` : 'Провайдер недоступен. Проверьте сервер и его адрес.')) } }
      catch (error) { if (current === generation.current) setMessage(error.message) }
      finally { if (current === generation.current) setPending(false) }
    }
    const selected = catalog.find(row => row.id === value.model), fixedDimensions = kind === 'embeddings' && Number.isInteger(selected?.dimensions) ? selected.dimensions : null
    const listed = catalog.map(row => [row.id, `${row.label ?? row.id} · ${MODEL_STATES[row.state] ?? row.state ?? 'состояние неизвестно'}`])
    if (value.model && !selected) listed.unshift([value.model, `Сохранено: ${value.model} · наличие не проверено`])
    return h('section', { className: 'am-card' }, h('h4', null, kind === 'embeddings' ? 'Эмбеддинги: смысловой поиск' : 'Извлечение сущностей и связей'),
      field('Провайдер модели', select(value.provider, providers, changeProvider)),
      ['ollama', 'lmstudio'].includes(value.provider) && field('Адрес локального сервера моделей', h('input', { value: value.endpoint ?? '', maxLength: 300, onChange: event => update({ ...value, endpoint: event.target.value }) })),
      safeButton('Обновить список моделей', discover, false, pending || busy),
      h('p', { role: 'status', className: 'am-muted' }, message),
      field('Модель', select(value.model ?? '', [['', 'Выберите доступную модель…'], ...listed], model => { const row = catalog.find(item => item.id === model); const next = { ...value, model }; delete next.dimensions; if (kind === 'embeddings' && Number.isInteger(row?.dimensions)) next.dimensions = row.dimensions; update(next) })),
      kind === 'embeddings' && field('Размерность эмбеддингов', h('input', { type: 'number', min: 1, max: 65536, step: 1, readOnly: !!fixedDimensions, value: value.dimensions ?? '', placeholder: 'Фактическая ширина вектора модели', onChange: event => { if (fixedDimensions) return; const next = { ...value }; const number = Number(event.target.value); if (!event.target.value) delete next.dimensions; else if (Number.isInteger(number) && number >= 1 && number <= 65536) next.dimensions = number; else return; update(next) } })),
      fixedDimensions && value.dimensions !== fixedDimensions && safeButton(`Использовать размерность каталога: ${fixedDimensions}`, () => update({ ...value, dimensions: fixedDimensions }), false, busy),
      kind === 'embeddings' && h('p', { className: 'am-muted' }, 'Укажите фактическую ширину вектора выбранной модели, а не желаемое уменьшение. Если каталог сообщает размерность, она фиксирована. Для другой модели потребуется совместимый индекс; существующий индекс автоматически не перестраивается.'),
      value.provider === 'openrouter' && h('p', { className: 'am-muted' }, 'Запрос каталога не запускает модель. При обработке данные отправляются провайдеру и возможна тарификация. Ключ настраивается приватно на стороне сервера; здесь он не показывается.'))
  }
  function CredentialPanel({ credential, token, busy, onSave }) {
    const [secret, setSecret] = React.useState(''), [message, setMessage] = React.useState(''), [pending, setPending] = React.useState(false)
    const inFlight = React.useRef(false)
    const hasMetadata = credential && typeof credential.configured === 'boolean' && typeof credential.revision === 'string'
    async function save() {
      if (inFlight.current || busy || !secret || !token || !hasMetadata) return
      inFlight.current = true; setPending(true); setMessage('Сохранение ключа в защищённом хранилище DSH…')
      try {
        const saved = await onSave('processingCredentialSave', { secret, expectedRevision: credential?.revision })
        setMessage(saved === true ? 'Ключ сохранён. Для использования выбранных моделей примените профиль к серверу.' : 'Сохранение ключа не подтверждено. Проверьте сообщение операции и повторно введите ключ при необходимости.')
      } catch { setMessage('Сохранение ключа не подтверждено. Проверьте настройки и повторно введите ключ при необходимости.') }
      finally { setSecret(''); inFlight.current = false; setPending(false) }
    }
    return h('details', { className: 'am-credential' }, h('summary', null, 'Ключ OpenRouter'),
      h('p', { className: 'am-muted' }, !hasMetadata ? 'Состояние ключа в хранилище DSH ещё не получено. Обновите настройки.' : credential.configured ? 'В защищённом хранилище DSH сохранён ключ OpenRouter.' : 'В защищённом хранилище DSH ключ OpenRouter не сохранён. На сервере Cognee может быть отдельная приватная настройка.'),
      field('Новый ключ OpenRouter', h('input', { type: 'password', value: secret, maxLength: 4096, autoComplete: 'new-password', spellCheck: false, 'aria-label': 'Новый ключ OpenRouter', onChange: event => { if (!busy && !pending) setSecret(event.target.value) } })),
      safeButton('Сохранить ключ OpenRouter', save, !token || !secret || !hasMetadata, busy || pending),
      h('p', { role: 'status', className: 'am-muted' }, message || 'Сохранённый ключ не показывается и не подставляется в поле. После отправки поле очищается. Ключ не передаётся модели чата; применение профиля — отдельная операция.'))
  }
  function ProcessingPanel({ processing, scope, sessionId, token, busy, onSave }) {
    const [draft, setDraft] = React.useState(clone(processing?.profile ?? defaultProcessing()))
    React.useEffect(() => setDraft(clone(processing?.profile ?? defaultProcessing())), [processing?.revision])
    const changed = next => { if (!busy) setDraft(next) }
    const applied = processing?.applied, dirty = JSON.stringify(draft) !== JSON.stringify(processing?.profile ?? defaultProcessing())
    const stateLabel = { unverified: 'не проверен', observed: 'считан с сервера', applied: 'применён', unknown: 'исход применения неизвестен' }
    return h('details', { className: 'am-processing' }, h('summary', null, 'Модели обработки Cognee'),
      h('p', { className: 'am-muted' }, 'Хранилище Cognee остаётся локальным. Модели эмбеддингов и извлечения связей выбираются независимо: локальная модель или OpenRouter. Эти настройки относятся ко всем проектам данного сервера Cognee.'),
      h('label', null, h('input', { type: 'checkbox', checked: !!draft.allowed, onChange: event => changed({ ...draft, allowed: event.target.checked }) }), 'Разрешить обработку выбранным профилем'),
      h('div', { className: 'am-selection' }, h(ModelSelection, { kind: 'embeddings', value: draft.embeddings, busy, onChange: embeddings => changed({ ...draft, embeddings }) }), h(ModelSelection, { kind: 'extraction', value: draft.extraction, busy, onChange: extraction => changed({ ...draft, extraction }) })),
      h(CredentialPanel, { credential: processing?.openRouterCredential, token, busy, onSave }),
      h('div', { className: 'am-toolbar' }, safeButton('Сохранить выбор моделей', () => onSave('processingSave', { profile: draft, expectedRevision: processing?.revision }), !token || !draft.embeddings.model || !draft.extraction.model, busy),
        safeButton('Применить профиль к серверу', () => onSave('processingApply', { sessionId, expectedRevision: processing?.revision, confirm: true }), !scope?.globalWritable || !token || !processing?.bindingAvailable || dirty, busy)),
      dirty && h('p', { role: 'status', className: 'am-muted' }, 'Сначала сохраните выбранные модели. Применение использует точную сохранённую ревизию профиля.'),
      h('p', { className: 'am-muted' }, 'Сохранение фиксирует желаемый профиль. Применение — отдельная операция через чат с выбранной политикой подтверждений и штатными правами; она может перезапустить Cognee. До подтверждения применения выбранные модели не считаются активными.'),
      h('p', { role: 'status', className: 'am-muted' }, !processing?.bindingAvailable ? 'Привязка локального управления Cognee не настроена. Выбор можно сохранить; применение сейчас недоступно.' : applied ? `Профиль сервера: ${typeof applied === 'string' ? stateLabel[applied] ?? applied : stateLabel[applied.state] ?? applied.status ?? 'сведения получены'}.${applied.matchesDesired === true ? ' Подтверждённый профиль совпадает с сохранённым.' : ' Совпадение с сохранённым профилем пока не подтверждено.'}` : 'Применение профиля ещё не подтверждено.'))
  }
  const rawRequest = request
  function Memory() {
    const snapshot = React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const project = projectApi ? projectApi.useProject() : null
    const projectRef = projectApi ? React.useRef(project) : null; if (projectRef) projectRef.current = project
    const request = (input,token) => rawRequest(input,token,projectRef?.current)
    const [manual, setManual] = React.useState(null), sessionId = projectApi ? project.projectId : manual ?? active
    const [data, setData] = React.useState(null), [config, setConfig] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
    const [result, setResult] = React.useState(null), [action, setAction] = React.useState(''), [query, setQuery] = React.useState(''), [text, setText] = React.useState(''), [title, setTitle] = React.useState(''), [taskId, setTaskId] = React.useState('')
    const [kind, setKind] = React.useState('fact'), [notice, setNotice] = React.useState(''), [attempted, setAttempted] = React.useState('')
    const epoch = React.useRef(0), sequence = React.useRef(0), pending = React.useRef(false), owner = React.useRef(sessionId)
    function accept(value) { setData(value); setConfig(value.config); setError('') }
    const load = React.useCallback(async () => {
      const generation = epoch.current, seq = ++sequence.current
      pending.current = true; setBusy(true); setNotice('Загрузка настроек…')
      try { const value = await request({ action: 'configuration', ...(sessionId ? { sessionId } : {}) }); if (generation === epoch.current && seq === sequence.current) { accept(value); setNotice('Настройки загружены.') } }
      catch (reason) { if (generation === epoch.current && seq === sequence.current) setError(reason.message) }
      finally { if (generation === epoch.current && seq === sequence.current) { pending.current = false; setBusy(false) } }
    }, [sessionId])
    React.useEffect(() => { epoch.current++; owner.current = sessionId; setData(null); setConfig(null); setResult(null); setError(''); setText(''); setTitle(''); setQuery(''); setTaskId(''); setAction(''); setAttempted(''); void load(); return () => { epoch.current++ } }, [load])
    async function run(nextAction, supplied = {}) {
      if (pending.current) return
      if (['remember', 'process', 'processingApply'].includes(nextAction) && data?.policy?.effective?.approval !== 'disabled' && !window.confirm(nextAction === 'remember' ? 'Передать сохранение подтверждённой записи в чат? Назначение определяется политикой проекта; действуют штатные права и approval.' : nextAction === 'processingApply' ? 'Передать применение выбранных моделей в чат? Потребуются полные права и native approval. Возможен перезапуск Cognee; обработка выбранным API может быть платной.' : 'Передать обработку набора Cognee в чат? Будет использован подтверждённый профиль моделей, возможны внешние API и тарификация. Потребуется штатное подтверждение.')) return
      const generation = epoch.current, seq = ++sequence.current
      pending.current = true; setBusy(true); setError(''); setAttempted(nextAction); setResult(null); setNotice({ status: 'Проверка источников памяти…', documents: 'Загрузка документов Cognee…', graph: 'Загрузка графа Cognee…', recall: 'Поиск по политике проекта…', configure: 'Сохранение подключения…', task: 'Проверка обработки…', policyGlobal: 'Сохранение общей политики…', projectPolicy: 'Сохранение политики проекта…', processingSave: 'Сохранение выбора моделей…' }[nextAction] ?? 'Передача запроса в чат…')
      try {
        const input = { action: nextAction, ...(sessionId && !['policyGlobal', 'processingSave', 'processingCredentialSave'].includes(nextAction) ? { sessionId } : {}), ...(data?.revision ? { expectedRevision: data.revision } : {}), ...(!['configure','policyGlobal','projectPolicy','processingSave','processingCredentialSave'].includes(nextAction) && data?.policy?.policyRevision ? { expectedPolicyRevision: data.policy.policyRevision } : {}), ...supplied }
        const value = await request(input, data?.csrfToken)
        if (generation !== epoch.current || seq !== sequence.current) return
        if (['configure', 'policyGlobal', 'projectPolicy', 'processingSave', 'processingCredentialSave'].includes(nextAction)) {
          const fresh = await request({ action: 'configuration', ...(sessionId ? { sessionId } : {}) })
          if (generation !== epoch.current || seq !== sequence.current) return
          accept(fresh); setNotice(nextAction === 'processingCredentialSave' ? 'Ключ сохранён в защищённом хранилище DSH.' : 'Настройки сохранены.')
        } else { setResult(value); setAction(nextAction); setNotice('Ответ получен.'); const receipt = value.taskId ?? value.receipt?.taskId; if (receipt) setTaskId(String(receipt)) }
        return true
      } catch (reason) { if (generation === epoch.current && seq === sequence.current) setError(nextAction === 'processingCredentialSave' ? 'Сохранение ключа OpenRouter не подтверждено. Обновите сведения о защищённом хранилище DSH; ключ не будет показан в сообщении ошибки.' : reason.message); return false }
      finally { if (generation === epoch.current && seq === sequence.current) { pending.current = false; setBusy(false) } }
    }
    const policy = data?.policy, mode = policy?.effective?.mode ?? 'cognee', storedScope = data?.scope
    const scope = storedScope && { ...storedScope, writable: storedScope.writable && (!projectApi || !project.loading && project.writable), globalWritable: storedScope.globalWritable && (!projectApi || !project.loading && project.globalWritable) }
    const activeScope = !!scope && scope.active !== false
    const writable = !!scope?.writable, connected = !!data?.config?.enabled, available = activeScope && (mode !== 'cognee' || connected), cognee = mode !== 'memoria'
    const button = (label, verb, disabled = false, args = {}) => safeButton(label, () => run(verb, args), disabled, busy)
    const source = policy?.effective?.source === 'project' ? 'переопределение проекта' : 'общая настройка'
    if (projectApi && owner.current !== sessionId) return h('section', { className: 'airules-memory' }, h(projectApi.ProjectPicker, { project, disabled: busy }), h('p', { role: 'status' }, 'Загрузка настроек выбранного проекта…'))
    return h('section', { className: 'airules-memory' }, h('h2', null, 'Память'),
      h('p', { className: 'am-muted' }, 'Политика памяти сохраняется для приложения и проекта. Все чаты проекта наследуют её; память не привязана к одному сеансу. Источники не копируются друг в друга автоматически.'),
      h('section', { className: 'am-card am-project' }, h('h3', null, 'Текущий проект'), h('p', null, scope?.projectRoot ?? project?.projectRoot ?? 'Проект не выбран'),
        h('p', { className: 'am-muted' }, `Действует: ${MODES[mode] ?? mode} · ${source}. Подтверждения: ${APPROVALS[policy?.effective?.approval ?? 'required'] ?? APPROVALS.required}.`),
        data?.projectError && h('p', { role: 'status', className: 'am-muted' }, typeof data.projectError === 'string' ? data.projectError : 'Для проектных операций выберите доступный чат нашего пресета.'),
        (projectApi ? h(projectApi.ProjectPicker, { project, disabled: busy }) : h('details', null, h('summary', null, 'Дополнительно: исполнитель проектных операций'),
          field('Открытый проектный сеанс', select(sessionId, [['', 'Без проектного исполнителя'], ...rows.map(row => [row.id, row.title ?? row.label ?? row.id])], value => setManual(value))),
          h('p', { className: 'am-muted' }, 'Активный чат выбирается автоматически. Этот выбор определяет проект и штатные права исполнителя; политика памяти сохраняется отдельно и применяется ко всем чатам того же проекта.')))),
      safeButton('Обновить настройки', load, false, busy),
      scope?.active === false && h('p', { className: 'am-muted', role: 'status' }, 'Настройки проекта доступны без активного чата. Для команд памяти нужен активный штатный исполнитель; новые чаты автоматически не создаются.'),
      h('div', { className: 'am-toolbar' }, button('Проверить связь', 'status', !activeScope), button('Документы', 'documents', !activeScope || !cognee || !connected, { backend: 'cognee' }), button('Граф', 'graph', !activeScope || !cognee || !connected, { backend: 'cognee' })),
      !cognee && h('p', { className: 'am-muted' }, 'Документы, граф и обработка Cognee недоступны в режиме Memoria. Поиск и сохранение используют выбранную политику.'),
      h('div', { className: 'am-feedback', 'aria-busy': busy }, h('p', { role: error ? 'alert' : 'status', className: error ? 'am-error' : 'am-muted' }, error || notice || 'Выберите действие. Ответ появится здесь.'),
        h('div', { className: 'am-result' }, result ? h(Result, { result, action }) : h('p', { className: 'am-muted' }, error ? 'Операция не вернула подтверждённого результата.' : 'Проверьте источники памяти или выполните поиск.'))),
      h('form', { onSubmit: event => { event.preventDefault(); if (!pending.current) void run('recall', { query, topK: 8 }) } }, field('Найти в памяти проекта', h('input', { value: query, maxLength: 4000, onChange: event => setQuery(event.target.value) })), h('button', { type: 'submit', 'aria-disabled': busy, disabled: !available || !query.trim() }, 'Найти')),
      h('details', null, h('summary', null, 'Добавить подтверждённую запись'), h('p', { className: 'am-muted' }, 'Укажите проверенный факт, источник и дату. Назначение записи определяет сохранённая политика. Секреты и непроверенные выводы не загружайте.'),
        field('Тип записи', select(kind, [['fact', 'Факт или решение'], ['handoff', 'Рабочий контекст / handoff'], ['document', 'Документ для поиска и графа']], setKind)),
        field('Название', h('input', { value: title, maxLength: 120, onChange: event => setTitle(event.target.value) })), field('Текст и источник', h('textarea', { rows: 6, maxLength: 32000, value: text, onChange: event => setText(event.target.value) })),
        button('Сохранить запись через чат', 'remember', !available || !writable || !text.trim(), { text, title, kind, confirm: true })),
      h(PolicyPanel, { policy, sessionId, projectContext: project, scope, token: data?.csrfToken, busy, onSave: run }),
      h(ProcessingPanel, { processing: data?.processing, sessionId, scope, token: data?.csrfToken, busy, onSave: run }),
      h('details', null, h('summary', null, 'Подключение и обработка Cognee'),
        config && h(React.Fragment, null,
          h('label', null, h('input', { type: 'checkbox', checked: config.enabled, disabled: !scope?.globalWritable, onChange: event => { if (!busy) setConfig({ ...config, enabled: event.target.checked }) } }), 'Подключение Cognee включено'),
          field('Локальный адрес API Cognee', h('input', { value: config.endpoint, disabled: !scope?.globalWritable, onChange: event => { if (!busy) setConfig({ ...config, endpoint: event.target.value }) } })),
          h('p', { className: 'am-muted' }, 'Подключение к хранилищу и модели обработки настраиваются отдельно. Секреты на этой странице не отображаются.'),
          button('Сохранить подключение', 'configure', !scope?.globalWritable, { config })),
        h('div', { className: 'am-toolbar' }, button('Обработать набор Cognee через чат', 'process', !connected || !writable || !activeScope || !cognee || !(data?.processing?.profile?.allowed ?? data?.config?.localProcessing), { backend: 'cognee', confirm: true })),
        field('Идентификатор задачи (необязательно)', h('input', { value: taskId, maxLength: 256, onChange: event => setTaskId(event.target.value) })), button('Проверить обработку', 'task', !connected || !activeScope || !cognee, { backend: 'cognee', taskId }),
        attempted === 'task' && h('div', { className: 'am-local-feedback', 'aria-live': 'polite' }, busy ? h('p', null, notice) : error ? h('p', { role: 'alert', className: 'am-error' }, error) : result && h(Result, { result, action: 'task' }))),
      h('p', { className: 'am-muted' }, 'В режиме «Обе» источники и их ошибки показываются раздельно. Пустая или частичная выдача не доказывает отсутствие записи. Документы и граф остаются представлениями своего хранилища.'))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-memory', label: () => 'Память', order: 69 }, Memory))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = '.airules-memory{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}.airules-memory h2,.airules-memory p{margin:0}.airules-memory h2{font-size:24px}.airules-memory h3{font-size:16px;margin:0 0 10px}.airules-memory h4{font-size:14px;margin:0 0 10px}.airules-memory label{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin:10px 0}.airules-memory label:has(>input[type=checkbox]){flex-direction:row;align-items:center}.airules-memory label>input:not([type=checkbox]),.airules-memory label>textarea,.airules-memory select{width:100%;min-width:0}.airules-memory input,.airules-memory textarea,.airules-memory select,.airules-memory button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px;max-width:100%;box-sizing:border-box}.airules-memory button{cursor:pointer;align-self:start}.airules-memory button:disabled,.airules-memory button[aria-disabled=true]{opacity:.5;cursor:default}.airules-memory details,.airules-memory .am-card{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;min-width:0}.airules-memory details>*+*,.airules-memory .am-card>*+*{margin-top:10px}.airules-memory summary{cursor:pointer;font-weight:600}.airules-memory pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-1)}.airules-memory .am-muted{opacity:.72;line-height:1.6;white-space:pre-line;overflow-wrap:anywhere}.airules-memory .am-error{color:#ff8d91;overflow-wrap:anywhere}.airules-memory .am-toolbar{display:flex;flex-wrap:wrap;gap:8px}.airules-memory .am-feedback{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;min-height:120px;box-sizing:border-box}.airules-memory .am-feedback>p{min-height:22px}.airules-memory .am-result{height:180px;max-height:300px;overflow:auto;overflow-anchor:none;scrollbar-gutter:stable}.airules-memory .am-result h3{font-size:14px;margin:8px 0}.airules-memory .am-selection{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:12px}.airules-memory .am-selection label{margin:0}.airules-memory form{display:flex;flex-direction:column;gap:8px}.airules-memory form label{margin:0}.airules-memory .am-policy{display:flex;flex-direction:column;gap:12px}.airules-memory .am-policy>label{margin:0}.airules-memory .am-backend{border-block-start:1px solid var(--dsw-alias-border-l2);padding-block:10px}.airules-memory .am-local-feedback{max-height:240px;overflow:auto}'; document.head.appendChild(style); return () => style.remove() })
  }
  return { inject: ['slots', 'sessions'], apply, Memory, PolicyPanel, ProcessingPanel, CredentialPanel, ModelSelection, Graph, Result }
} })
