window.__ModuleLoader__.load({ id: 'airules-dsh-agent-import', factory: require => {
  const React = require('react'), h = React.createElement
  let sessions
  function ImportSettings() {
    const snapshot = React.useSyncExternalStore(fn => sessions.list.subscribe(fn), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const [manual, setManual] = React.useState(null), id = manual ?? active
    const [origin, setOrigin] = React.useState('claude'), [scope, setScope] = React.useState('project'), [status, setStatus] = React.useState(null), [preview, setPreview] = React.useState(null), [selected, setSelected] = React.useState({}), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
    const epoch = React.useRef(0)
    React.useEffect(() => setManual(null), [active])
    React.useEffect(() => {
      const current = ++epoch.current; setStatus(null); setPreview(null); setSelected({}); setError(''); setNotice(''); setBusy(false)
      if (id) fetch(`/airules/agent-import?sessionId=${encodeURIComponent(id)}`).then(r => r.json()).then(data => { if (epoch.current === current) { if (!data.ok) throw new Error(data.message || 'Сеанс недоступен.'); setStatus(data) } }).catch(reason => { if (epoch.current === current) setError(reason.message) })
      return () => { epoch.current++ }
    }, [id, origin, scope])
    async function action(kind) {
      const current = epoch.current; setBusy(true); setError(''); setNotice('')
      try {
        const response = await fetch('/airules/agent-import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': status.csrfToken }, body: JSON.stringify({ action: kind, sessionId: id, origin, scope, ...(kind === 'apply' ? { revision: preview.revision, selected: Object.keys(selected).filter(key => selected[key]) } : {}) }) }), data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.message || 'Импорт не выполнен.')
        if (current === epoch.current) { if (kind === 'preview') { setPreview(data); setSelected({}) } else { window.dispatchEvent(new Event('airules-skills-changed')); setPreview(null); setSelected({}); setNotice(`Импортировано: ${data.imported}. Резервная запись: ${data.backupId}. Откройте новый сеанс для применения инструкций.`) } }
      } catch (reason) { if (current === epoch.current) setError(reason.message) }
      finally { if (current === epoch.current) setBusy(false) }
    }
    const writable = scope === 'global' ? status?.globalWritable : status?.writable
    const states = { new: 'Можно импортировать', identical: 'Уже совпадает', conflict: 'Конфликт: существующее сохранено' }
    return h('section', { className: 'airules-import' }, h('h2', null, 'Импорт из других агентов'), h('p', null, 'Выберите инструкции и навыки для DSH. Предпросмотр показывает содержимое и конфликты до записи.'),
      h('label', null, 'Проектный сеанс', h('select', { value: id, disabled: busy, onChange: e => setManual(e.target.value) }, h('option', { value: '' }, 'Выберите сеанс'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.title ?? row.label ?? row.id)))),
      h('div', { className: 'airules-import-options' }, h('label', null, 'Источник', h('select', { value: origin, disabled: busy, onChange: e => setOrigin(e.target.value) }, ...[['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['opencode', 'OpenCode']].map(([value, label]) => h('option', { key: value, value }, label)))), h('label', null, 'Область', h('select', { value: scope, disabled: busy, onChange: e => setScope(e.target.value) }, h('option', { value: 'project' }, 'Выбранный проект'), h('option', { value: 'global' }, 'Общие правила и навыки')))),
      status && h('p', null, scope === 'project' ? status.projectRoot : 'Источник — стандартный домашний каталог выбранного агента. Назначение — домашний каталог DSH.'),
      h('button', { type: 'button', disabled: busy || !status, onClick: () => action('preview') }, busy ? 'Выполняется…' : 'Предпросмотр импорта'),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
      preview && h(React.Fragment, null, h('p', null, `Назначение: ${preview.target}`), h('p', null, 'Правила добавляются отдельными блоками в AGENTS.md; существующие инструкции сохраняются. Навыки копируются только в новые каталоги. Конфликты не заменяются.'),
        !preview.entries.length && h('p', null, 'Подходящих файлов для импорта не найдено.'),
        ...preview.entries.map(entry => h('details', { key: entry.id }, h('summary', null, h('label', { onClick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked: !!selected[entry.id], disabled: busy || entry.status !== 'new', onChange: e => setSelected(prev => ({ ...prev, [entry.id]: e.target.checked })) }), ` ${entry.title} · ${states[entry.status]}`)), h('p', null, `${entry.source} → ${entry.destination} · файлов: ${entry.fileCount}`), entry.hasScripts && h('p', null, 'В навыке есть скрипты. Копируются только исходные файлы: команды и установка зависимостей не запускаются. Навык останется выключенным до включения на странице «Навыки».'), entry.inventory && h('ul', null, ...entry.inventory.map(file => h('li', { key: file.path }, `${file.path} · ${file.bytes} байт${file.script ? ' · скрипт' : ''}`))), h('pre', null, entry.content))),
        preview.skipped.length > 0 && h('details', null, h('summary', null, `Пропущено: ${preview.skipped.length}`), ...preview.skipped.map((item, index) => h('p', { key: index }, `${item.source}: ${item.reason}`))),
        !writable && h('p', null, scope === 'global' ? 'Для записи общих правил нужен полный доступ штатной песочницы.' : 'Сеанс доступен только для чтения.'),
        h('button', { type: 'button', disabled: busy || !writable || !Object.values(selected).some(Boolean), onClick: () => action('apply') }, 'Импортировать выбранное')),
      h('small', null, 'Чаты, MCP, аккаунты и ключи не переносятся. Скрипты копируются как файлы и не запускаются. Пакеты с секретами, ссылками или двоичными программами пропускаются целиком.'))
  }
  function apply(ctx) {
    sessions = ctx.sessions
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-agent-import', label: () => 'Импорт из других агентов', order: 57 }, ImportSettings))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = '.airules-import{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}.airules-import h2,.airules-import p{margin:0}.airules-import p{line-height:1.5;overflow-wrap:anywhere}.airules-import label{display:flex;flex-direction:column;gap:7px}.airules-import-options{display:grid;grid-template-columns:1fr 1fr;gap:12px}.airules-import select,.airules-import button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px}.airules-import button{cursor:pointer;align-self:flex-start}.airules-import button:disabled{opacity:.5;cursor:default}.airules-import details{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px}.airules-import summary{cursor:pointer}.airules-import summary label{display:inline-flex;flex-direction:row;align-items:center}.airules-import pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-1)}'; document.head.appendChild(style); return () => style.remove() })
  }
  return { inject: ['slots', 'sessions'], apply }
} })
