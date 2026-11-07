window.__ModuleLoader__.load({ id: 'airules-dsh-onec-panels', factory: require => {
  const React = require('react'), h = React.createElement
  function Icon() { return h('span', { 'aria-hidden': true }, '1С') }
  function Panel({ sessionId }) {
    const [data, setData] = React.useState(null), [detail, setDetail] = React.useState(null), [error, setError] = React.useState(''), [loading, setLoading] = React.useState(false)
    const generation = React.useRef(0), request = React.useRef(0)
    const load = React.useCallback(async path => {
      const epoch = generation.current, sequence = ++request.current
      setError(''); setLoading(true)
      if (path) setDetail(null)
      try {
        if (!sessionId) throw new Error('Выберите сеанс проекта 1c-airules.')
        const response = await fetch(`/airules/onec-panels?sessionId=${encodeURIComponent(sessionId)}${path ? `&path=${encodeURIComponent(path)}` : ''}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.message || 'Метаданные недоступны.')
        if (generation.current === epoch && sequence === request.current) path ? setDetail(body) : setData(body)
      } catch (reason) { if (generation.current === epoch && sequence === request.current) setError(reason.message) }
      finally { if (generation.current === epoch && sequence === request.current) setLoading(false) }
    }, [sessionId])
    React.useEffect(() => { generation.current++; setData(null); setDetail(null); load(); return () => { generation.current++ } }, [load])
    const list = (items, render) => h('ul', null, ...items.map((item, i) => h('li', { key: i }, render(item))))
    const inspect = detail && h('section', null, h('h3', null, detail.path), h('p', null, `${detail.bytes} байт · сводка исходного XML`), h('h4', null, 'Объекты'), list(detail.objects, item => `${item.type}: ${item.name}`), h('h4', null, 'Элементы формы'), list(detail.elements, item => `${item.type}: ${item.name}${item.id ? ` (#${item.id})` : ''}`), h('h4', null, 'События'), list(detail.events, item => `${item.name}: ${item.handler}`), detail.truncated && h('p', null, 'Сводка ограничена по глубине и числу элементов.'))
    return h('div', { className: 'airules-onec-panel' }, h('h2', null, 'Метаданные 1С'), h('p', null, 'Объекты XML/EDT, пути модулей и структура форм из рабочей папки выбранного сеанса. Сводка формы показывает исходную структуру; вид в клиенте 1С зависит от платформы.'), h('button', { type: 'button', disabled: loading || !sessionId, onClick: () => { setDetail(null); load() } }, loading ? 'Чтение…' : 'Обновить'), error && h('p', { role: 'alert' }, error), data && h(React.Fragment, null, h('p', null, `Проверено XML: ${data.scannedXml}; записей: ${data.scannedEntries}.${data.truncated ? ' Показан ограниченный результат; уточняйте структуру проекта в редакторе.' : ''}`), h('h3', null, 'Объекты и формы'), data.files.length ? list(data.files, item => h('button', { type: 'button', onClick: () => load(item.path), disabled: loading }, `${item.objects.map(object => `${object.type}: ${object.name}`).join(', ') || item.path} · ${item.path}`)) : h('p', null, 'XML/EDT-метаданные в пределах поиска не найдены.'), h('h3', null, 'Модули BSL'), list(data.modules, item => item), data.warnings.length > 0 && h('p', null, `Пропущено файлов: ${data.warnings.length}. Ограничения размера, XML или безопасного пути.`)), inspect)
  }
  function apply(ctx) {
    ctx.effect(() => { const tag = document.createElement('style'); tag.textContent = '.airules-onec-panel{padding:16px;overflow:auto;max-height:100%;color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}.airules-onec-panel p{line-height:1.5}.airules-onec-panel button{color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;text-align:left;cursor:pointer}.airules-onec-panel li{margin:5px 0}.airules-onec-panel button:disabled{opacity:.6}.airules-onec-panel button:focus-visible{outline:2px solid currentColor}'; document.head.appendChild(tag); return () => tag.remove() })
    ctx.inject(['sidebarRight', 'sidebarRightTabs'], ready => {
      const id = 'airules-dsh-onec-panels/metadata', kind = 'airules-onec-metadata'
      ready.effect(() => ready.get('sidebarRightTabs').register({ id, kind, title: () => 'Метаданные 1С', icon: Icon, guide: [{ order: 30, title: () => 'Метаданные 1С', icon: Icon }] }))
      ready.effect(() => ready.slots.inject('sidebar.right.pane.tab', () => ready.slots.register({ name: 'sidebar.right.pane.tab', key: id }, ({ sessionId }) => h(Panel, { key: sessionId, sessionId }))))
    })
  }
  return { inject: ['slots'], apply }
} })
