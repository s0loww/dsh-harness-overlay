window.__ModuleLoader__.load({ id: 'airules-dsh-project-context', factory: require => {
  const React = require('react'), h = React.createElement
  let sessions, workspaces, version = 0
  const listeners = new Set(), changed = () => { version++; for (const listener of listeners) listener() }
  const knownProjects = new Set()
  let preferred = undefined, lastRevision = 'missing', csrfToken = null
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const message = code => ({ PROJECT_EXECUTOR_UNAVAILABLE: 'Для выполнения операций проекта сейчас нет доступного исполнителя. Настройки остаются привязаны к проекту.', PROJECT_WRITE_REQUIRED: 'Проект доступен только для чтения.', PROJECT_FULL_ACCESS_REQUIRED: 'Для этой операции нужны полные штатные права.', PROJECT_NOT_FOUND: 'Выбранный проект больше не зарегистрирован. Выберите другой проект.', PROJECT_SELECTION_STALE: 'Выбор проекта изменился. Обновите настройки.', PROJECT_CONTEXT_UNAVAILABLE: 'Не удалось получить список проектов.' })[code] ?? 'Проектный контекст недоступен: ' + code
  async function request(input, token) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000)
    try { const response = await fetch(token ? '/airules/projects' : '/airules/projects?' + new URLSearchParams(input), token ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-airules-csrf': token }, body: JSON.stringify(input), signal: abort.signal } : { headers: { accept: 'application/json' }, signal: abort.signal }); const value = await response.json(); if (!response.ok || !value.ok) throw Error(message(value.error)); return value } catch (error) { if (abort.signal.aborted) throw Error('Превышено время ожидания списка проектов.'); throw error } finally { clearTimeout(timer) }
  }
  function useProject({ presets = ['1c-airules', 'python-airules', 'sysadmin-airules'] } = {}) {
    const snapshot = React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
    const workspaceSnapshot = React.useSyncExternalStore(listener => workspaces.list.subscribe(listener), () => workspaces.list.getSnapshot())
    const sharedVersion = React.useSyncExternalStore(subscribe, () => version)
    const rows = Object.values(snapshot?.byId ?? {}), active = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot?.current ?? ''
    const workspaceIdentity = JSON.stringify((workspaceSnapshot?.items ?? []).map(row => [row.workspaceId, row.path, row.sessionIds]))
    const presetKey = presets.join(',')
    const [data, setData] = React.useState(null), [loading, setLoading] = React.useState(true), [error, setError] = React.useState('')
    const epoch = React.useRef(0)
    const load = React.useCallback(async () => {
      const generation = ++epoch.current; setLoading(true); setError('')
      try { const input = { presets: presetKey, ...(active ? { activeSessionId: active } : {}), ...(preferred ? { projectId: preferred } : {}) }; const result = await request(input); if (generation !== epoch.current) return; csrfToken = result.csrfToken; lastRevision = result.selectionRevision; for (const row of result.projects ?? []) knownProjects.add(row.projectId); if (preferred === undefined) preferred = result.explicitProjectId ?? null; setData(result); setError(result.selectionError ? message(result.selectionError) : '') } catch (reason) { if (generation === epoch.current) setError(reason.message) } finally { if (generation === epoch.current) setLoading(false) }
    }, [active, workspaceIdentity, presetKey, sharedVersion])
    React.useEffect(() => { void load(); return () => { epoch.current++ } }, [load])
    async function selectProject(projectId) {
      const generation = ++epoch.current; setLoading(true); setError('')
      try { const result = await request({ action: 'select', projectId: projectId || null, expectedRevision: lastRevision }, csrfToken); if (generation !== epoch.current) return false; preferred = projectId || null; lastRevision = result.selectionRevision; csrfToken = result.csrfToken; changed(); return true } catch (reason) { if (generation === epoch.current) setError(reason.message); return false } finally { if (generation === epoch.current) setLoading(false) }
    }
    return { projectId: data?.projectId ?? '', projectRoot: data?.projectRoot ?? '', title: data?.title ?? '', id: data?.execution?.sessionId ?? '', sessionId: data?.execution?.sessionId ?? '', projects: data?.projects ?? [], active: data?.execution?.active ?? false, writable: data?.execution?.writable ?? false, globalWritable: data?.execution?.globalWritable ?? false, preset: data?.execution?.preset ?? '', executorRevision: data?.execution?.revision, loading, error, executorError: data?.executorError ? message(data.executorError) : '', revision: data?.selectionRevision, selectProject, onChange: selectProject, refresh: load, input: data?.projectId ? { projectId: data.projectId, ...(data.execution?.sessionId ? { sessionId: data.execution.sessionId } : {}) } : {} }
  }
  function projectFetch(url, options, project) {
    if (typeof url !== 'string' || !url.startsWith('/airules/')) return fetch(url, options)
    const pin = id => { if (!project || project.projectId !== id || project.loading === true) throw Error('PROJECT_EXECUTOR_PIN_REQUIRED'); return { projectId: id, expectedProjectRoot: project.projectRoot, ...(project.sessionId ? { sessionId: project.sessionId } : {}), ...(project.executorRevision ? { expectedExecutorRevision: project.executorRevision } : {}) } }
    const parsed = new URL(url, 'http://localhost'), id = parsed.searchParams.get('sessionId')
    if (id && knownProjects.has(id)) { if (parsed.searchParams.has('projectId') && parsed.searchParams.get('projectId') !== id) throw Error('PROJECT_SELECTION_MISMATCH'); parsed.searchParams.delete('sessionId'); for (const [key, value] of Object.entries(pin(id))) parsed.searchParams.set(key, value); url = parsed.pathname + parsed.search }
    if (typeof options?.body === 'string') {
      let body; try { body = JSON.parse(options.body) } catch { return fetch(url, options) }
      if (body && typeof body === 'object' && !Array.isArray(body) && knownProjects.has(body.sessionId)) { if (body.projectId !== undefined && body.projectId !== body.sessionId) throw Error('PROJECT_SELECTION_MISMATCH'); const id = body.sessionId; delete body.sessionId; Object.assign(body, pin(id)); options = { ...options, body: JSON.stringify(body) } }
    }
    return fetch(url, options)
  }
  function ProjectPicker({ project, value, disabled = false, onChange, beforeChange, label = 'Проект' }) {
    const selected = project ?? value
    if (!selected) return null
    return h('div', { className: 'airules-project-picker' }, h('style', null, '.airules-project-picker{display:flex;flex-direction:column;gap:8px;min-width:0}.airules-project-picker label{display:flex;flex-direction:column;gap:8px;margin:0}.airules-project-picker select{width:100%;min-width:0;box-sizing:border-box;padding:8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}.airules-project-picker p{margin:0;overflow-wrap:anywhere;font-size:12px;line-height:1.5;opacity:.75}'), h('label', null, label, h('select', { value: selected.projectId, disabled: disabled || selected.loading, onChange: async event => { const value = event.target.value; if (await beforeChange?.(value) === false) return; return (onChange ?? selected.selectProject)(value) } }, h('option', { value: '' }, selected.loading ? 'Загрузка проектов…' : 'Выберите проект'), selected.projects.map(row => h('option', { key: row.projectId, value: row.projectId }, `${row.title} · ${row.projectRoot}`)))), selected.projectRoot && h('p', null, selected.projectRoot), selected.error && h('p', { role: 'alert' }, selected.error), selected.executorError && h('p', { role: 'status' }, selected.executorError))
  }
  return { inject: ['sessions', 'workspaces'], apply(ctx) { sessions = ctx.sessions; workspaces = ctx.workspaces }, useProject, ProjectPicker, projectFetch, fetchFor: project => (url, options) => projectFetch(url, options, project) }
} })
