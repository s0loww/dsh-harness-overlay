window.__ModuleLoader__.load({ id: 'airules-dsh-memory-workspace', factory: require => {
  const React = require('react'), h = React.createElement
  let sessions
  async function request(input, token) {
    const response = await fetch(token ? '/airules/memory' : `/airules/memory?${new URLSearchParams(input)}`, token
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-airules-csrf': token }, body: JSON.stringify(input) }
      : { headers: { accept: 'application/json' } })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(`${result.message ?? 'Память недоступна.'} (${result.error ?? response.status})`)
    return result
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
  function Result({ result, action }) {
    const textOf = value => typeof value === 'string' ? value : String(value?.text ?? value?.content ?? value?.chunk_text ?? value?.chunk ?? '')
    const chunks = (result.results ?? []).flatMap(row => Array.isArray(row?.search_result) ? row.search_result : Array.isArray(row?.searchResult) ? row.searchResult : [row])
    const stateLabels = { DATASET_PROCESSING_COMPLETED: 'Обработка завершена', DATASET_PROCESSING_STARTED: 'Идёт обработка', DATASET_PROCESSING_NOT_STARTED: 'Обработка не запускалась', uploaded: 'Текст загружен', 'outcome-unknown': 'Исход операции неизвестен', 'processing-requested': 'Обработка запрошена' }
    let content
    if (result.submitted) content = h('p', { role: 'status' }, 'Запрос передан в выбранный чат. Проверьте ход выполнения и подтверждение DSH; запись ещё не считается выполненной. Текст заметки сохранён в форме.')
    else if (action === 'graph') content = h(Graph, { graph: result.graph ?? result })
    else if (action === 'documents') content = result.documents?.length ? h('ul', null, result.documents.map(doc => h('li', { key: doc.id }, h('strong', null, doc.name || 'Документ'), doc.type && ` · ${doc.type}`, h('p', { className: 'am-muted' }, `Источник: ${doc.id}`)))) : h('p', null, 'В памяти этого проекта пока нет документов.')
    else if (action === 'recall') content = chunks.length ? h('div', null, chunks.map((chunk, i) => h('article', { key: i, className: 'am-chunk' }, h('p', { style: { whiteSpace: 'pre-wrap' } }, textOf(chunk) || 'Сервер вернул запись без текстового фрагмента.'), h('p', { className: 'am-muted' }, `Источник: ${chunk?.document_id ?? chunk?.documentId ?? chunk?.id ?? 'не указан'}`)))) : h('p', null, result.missingDataset ? 'У проекта ещё нет набора памяти. Добавьте подтверждённую заметку.' : 'Совпадений не найдено.')
    else if (action === 'status') content = h('div', null, h('p', null, 'Cognee доступен. Запрос авторизован.'), h('p', { className: 'am-muted' }, result.datasetId ? 'Набор текущего проекта найден.' : 'Набор появится после первой загрузки заметки.'), h('ul', null, Object.entries(result.capabilities ?? {}).map(([key, enabled]) => h('li', { key }, `${{ documents: 'Документы', upload: 'Загрузка', process: 'Обработка', recall: 'Поиск', graph: 'Граф', status: 'Состояние обработки' }[key] ?? key}: ${enabled ? 'доступно' : 'недоступно'}`))))
    else if (action === 'task') { const status = typeof result.status === 'string' ? result.status : result.status?.status ?? result.status?.state; content = h('div', null, h('p', null, stateLabels[status] ?? status ?? 'Сервер вернул состояние обработки.'), result.exactTask === false && h('p', { className: 'am-muted' }, 'Сервер показывает последнюю обработку набора; это не подтверждение конкретного ID задачи.')) }
    else content = h('p', null, stateLabels[result.state] ?? 'Ответ операции получен.')
    return h('section', { 'aria-live': 'polite' }, h('h3', null, 'Результат'), content, result.truncated && action !== 'graph' && h('p', null, 'Показана ограниченная часть результата.'), h('details', null, h('summary', null, 'Технические сведения'), h('pre', null, JSON.stringify(result, null, 2))))
  }
  function Memory() {
    const snapshot = React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const [manual, setManual] = React.useState(null), sessionId = manual ?? active
    const [data, setData] = React.useState(null), [config, setConfig] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
    const [result, setResult] = React.useState(null), [action, setAction] = React.useState(''), [query, setQuery] = React.useState(''), [text, setText] = React.useState(''), [title, setTitle] = React.useState(''), [taskId, setTaskId] = React.useState('')
    const epoch = React.useRef(0), sequence = React.useRef(0)
    const load = React.useCallback(async () => {
      const generation = epoch.current, seq = ++sequence.current
      setBusy(true)
      try { const value = await request({ action: 'configuration', ...(sessionId ? { sessionId } : {}) }); if (generation === epoch.current && seq === sequence.current) { setData(value); setConfig(value.config); setError('') } }
      catch (reason) { if (generation === epoch.current && seq === sequence.current) setError(reason.message) }
      finally { if (generation === epoch.current && seq === sequence.current) setBusy(false) }
    }, [sessionId])
    React.useEffect(() => { epoch.current++; setData(null); setConfig(null); setResult(null); setError(''); setText(''); setTitle(''); setQuery(''); setTaskId(''); setAction(''); void load(); return () => { epoch.current++ } }, [load])
    async function act(nextAction) {
      const generation = epoch.current, seq = ++sequence.current
      if (['remember', 'process'].includes(nextAction) && !window.confirm(nextAction === 'remember' ? 'Передать сохранение заметки в выбранный чат? Будет запрос к его модели и штатное подтверждение операции. Текст заметки остаётся данными.' : 'Передать обработку набора в выбранный чат? Будет запрос к его модели и штатное подтверждение. Локальная обработка может занять время.')) return
      setBusy(true); setError('')
      try {
        const value = await request({ action: nextAction, sessionId, expectedRevision: data.revision, ...(nextAction === 'configure' ? { config } : {}), ...(nextAction === 'recall' ? { query, topK: 8 } : {}), ...(nextAction === 'remember' ? { text, title, confirm: true } : {}), ...(nextAction === 'process' ? { confirm: true } : {}), ...(nextAction === 'task' ? { taskId } : {}) }, data.csrfToken)
        if (generation === epoch.current && seq === sequence.current) {
          if (nextAction === 'configure') { setData(previous => ({ ...previous, ...value })); setConfig(value.config) }
          else { setResult(value); setAction(nextAction); const receipt = value.taskId ?? value.receipt?.taskId; if (receipt) setTaskId(String(receipt)) }
        }
      } catch (reason) { if (generation === epoch.current && seq === sequence.current) setError(reason.message) }
      finally { if (generation === epoch.current && seq === sequence.current) setBusy(false) }
    }
    const writable = !!data?.scope?.writable, connected = !!data?.config?.enabled
    const button = (label, verb, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick: () => void act(verb) }, label)
    return h('section', { className: 'airules-memory' }, h('h2', null, 'Память проекта'),
      h('p', { className: 'am-muted' }, 'Cognee хранит документы и строит граф знаний локально. Подключения Memora остаются в MCP. Выберите хранилище для конкретной задачи; записи между ними автоматически не копируются.'),
      h('label', null, 'Открытый проектный сеанс', h('select', { value: sessionId, disabled: busy, onChange: event => setManual(event.target.value) }, h('option', { value: '' }, 'Выберите сеанс…'), rows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id)))),
      h('button', { disabled: busy, onClick: () => void load() }, 'Обновить настройки'),
      error && h('p', { role: 'alert', className: 'am-error' }, error), busy && h('p', { role: 'status' }, 'Операция выполняется…'),
      config && h('details', { open: !connected }, h('summary', null, 'Локальное подключение Cognee'),
        h('label', null, h('input', { type: 'checkbox', checked: config.enabled, disabled: busy || !data.scope?.globalWritable, onChange: event => setConfig({ ...config, enabled: event.target.checked }) }), 'Включить Cognee'),
        h('label', null, 'Локальный адрес API', h('input', { value: config.endpoint, disabled: busy || !data.scope?.globalWritable, onChange: event => setConfig({ ...config, endpoint: event.target.value }) })),
        h('label', null, h('input', { type: 'checkbox', checked: config.localProcessing, disabled: busy || !data.scope?.globalWritable, onChange: event => setConfig({ ...config, localProcessing: event.target.checked }) }), 'Обработка настроена на локальные модели без платных API'),
        h('p', { className: 'am-muted' }, 'Это подтверждение конфигурации сервера. DSH не меняет модели Cognee. Для изменения общего подключения выберите открытый сеанс с полным доступом.'), button('Сохранить подключение', 'configure', !data.scope?.globalWritable)),
      data?.scope && h('p', { className: 'am-muted' }, `${data.scope.projectRoot}\nНабор: ${data.scope.dataset}`),
      h('div', { className: 'am-toolbar' }, button('Проверить связь', 'status', !connected || !sessionId), button('Документы', 'documents', !connected || !sessionId), button('Граф', 'graph', !connected || !sessionId)),
      h('form', { onSubmit: event => { event.preventDefault(); void act('recall') } }, h('label', null, 'Найти в памяти проекта', h('input', { value: query, maxLength: 4000, onChange: event => setQuery(event.target.value) })), h('button', { type: 'submit', disabled: busy || !connected || !sessionId || !query.trim() }, 'Найти')),
      h('details', null, h('summary', null, 'Добавить подтверждённую заметку'), h('p', { className: 'am-muted' }, 'Укажите факт, источник и дату проверки. Не загружайте пароли и ключи. Сохранение загружает текст; индексирование запускается отдельно.'),
        h('label', null, 'Название', h('input', { value: title, maxLength: 120, onChange: event => setTitle(event.target.value) })), h('label', null, 'Текст и источник', h('textarea', { rows: 6, maxLength: 32000, value: text, onChange: event => setText(event.target.value) })),
        h('div', { className: 'am-toolbar' }, button('Сохранить заметку', 'remember', !connected || !writable || !text.trim()), button('Обработать набор', 'process', !connected || !writable || !data?.config?.localProcessing))),
      h('label', null, 'Идентификатор задачи (необязательно)', h('input', { value: taskId, maxLength: 256, onChange: event => setTaskId(event.target.value) })), button('Проверить обработку', 'task', !connected || !sessionId),
      result && h(Result, { result, action }),
      h('p', { className: 'am-muted' }, 'Поиск использует выдержки CHUNKS без генерации ответа. Качество русского текста зависит от локальных моделей. Набор привязан к пути проекта: после перемещения проекта потребуется явное решение о переносе памяти.'))
  }
  function apply(ctx) {
    sessions = ctx.get('sessions')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-memory', label: () => 'Память проекта', order: 69 }, Memory))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = '.airules-memory{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}.airules-memory h2,.airules-memory p{margin:0}.airules-memory h2{font-size:24px}.airules-memory label{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.airules-memory label>input:not([type=checkbox]),.airules-memory label>textarea{flex:1;min-width:180px}.airules-memory input,.airules-memory textarea,.airules-memory select,.airules-memory button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px;max-width:100%;box-sizing:border-box}.airules-memory button{cursor:pointer;align-self:start}.airules-memory button:disabled{opacity:.5;cursor:default}.airules-memory details{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.airules-memory summary{cursor:pointer;font-weight:600}.airules-memory pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-1)}.am-muted{opacity:.72;line-height:1.6;white-space:pre-line}.am-error{color:#ff8d91}.am-toolbar{display:flex;flex-wrap:wrap;gap:8px}'; document.head.appendChild(style); return () => style.remove() })
  }
  return { inject: ['slots', 'sessions'], apply, Memory, Graph, Result }
} })
