import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, lstat, mkdir, rename, rm, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

const fail = code => { throw new Error(code) }
const modes = ['read-only', 'workspace-write', 'danger-full-access']
export const DEFAULT_PRESETS = Object.freeze(['1c-airules', 'python-airules', 'sysadmin-airules'])
export const rootKey = value => { if (typeof value !== 'string' || !isAbsolute(value)) fail('PROJECT_ROOT_INVALID'); const root = resolve(value); return process.platform === 'win32' ? root.toLowerCase() : root }
const hash = value => createHash('sha256').update(value).digest('hex')
export const executorRevision = scope => hash(JSON.stringify([scope.sessionId, scope.root, scope.preset, scope.policy]))
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value)
const validPresets = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(validId)

/** Native registry roots are authoritative. Aliases of one root become one project. */
export function projectRows(registry) {
  if (!registry?.list) fail('PROJECT_REGISTRY_REQUIRED')
  const map = new Map()
  for (const row of registry.list().slice(0, 512)) {
    if (!validId(String(row.id)) || typeof row.path !== 'string' || !isAbsolute(row.path)) continue
    const key = rootKey(row.path), existing = map.get(key)
    if (existing) { existing.workspaceIds.push(String(row.id)); existing.sessionIds = [...new Set([...existing.sessionIds, ...(row.sessionIds ?? []).map(String).filter(validId)])]; continue }
    map.set(key, { projectId: String(row.id), workspaceIds: [String(row.id)], projectRoot: resolve(row.path), title: typeof row.title === 'string' && row.title.trim() ? row.title.slice(0, 240) : resolve(row.path), sessionIds: [...new Set((row.sessionIds ?? []).map(String).filter(validId))] })
  }
  return [...map.values()]
}

export function selectionStore(path) {
  let saving = false
  const validate = value => { if (!value || Object.keys(value).sort().join(',') !== 'projectId,schemaVersion' || value.schemaVersion !== 1 || value.projectId !== null && !validId(value.projectId)) fail('PROJECT_SELECTION_INVALID'); return value }
  async function read() { try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) fail('PROJECT_SELECTION_INVALID'); const bytes = await readFile(path); return { value: validate(JSON.parse(bytes.toString('utf8'))), revision: hash(bytes) } } catch (error) { if (error.code === 'ENOENT') return { value: { schemaVersion: 1, projectId: null }, revision: 'missing' }; throw error } }
  return { read, async save(projectId, expectedRevision) {
    const value = validate({ schemaVersion: 1, projectId }); if (saving) fail('PROJECT_SELECTION_BUSY'); saving = true
    const temp = path + '.' + randomUUID() + '.tmp', lock = path + '.lock'; let locked = false
    try { await mkdir(dirname(path), { recursive: true }); const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) fail('PROJECT_SELECTION_INVALID'); try { await writeFile(lock, 'project-selection', { flag: 'wx', mode: 0o600 }); locked = true } catch (error) { if (error.code === 'EEXIST') fail('PROJECT_SELECTION_BUSY'); throw error }; if ((await read()).revision !== expectedRevision) fail('PROJECT_SELECTION_STALE'); await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); if ((await read()).revision !== expectedRevision) fail('PROJECT_SELECTION_STALE'); await rename(temp, path); return read() } finally { saving = false; await rm(temp, { force: true }); if (locked) await rm(lock, { force: true }) }
  } }
}

/** Read existing native authority; never create/resume agents or infer writable rights. */
export async function inspectSession(ctx, id, { signal } = {}) {
  if (!validId(id)) fail('PROJECT_EXECUTOR_UNAVAILABLE')
  signal?.throwIfAborted()
  const agent = ctx.agents?.get(id), session = agent?.session ?? ctx.sessions?.get(id)
  let header = session?.header, policy, preset
  if (session) { preset = agent ? ctx.agentPresets.composedPreset(agent.ctx) : ctx.sessionProjections.stateOf(session, 'agentPreset') ?? header.agentPreset; policy = ctx.sandboxPolicy.resolve({ session }) }
  else {
    const info = await ctx.sessionPersistence.stat(id); signal?.throwIfAborted()
    if (info?.header?.id !== id || info.eventCount > 20000 || info.sizeBytes > 32 * 1024 * 1024) fail('PROJECT_EXECUTOR_UNAVAILABLE')
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { header = reader.header; if (header?.id !== id) fail('PROJECT_EXECUTOR_UNAVAILABLE'); const { events } = await reader.read(0, 20001); signal?.throwIfAborted(); if (!Array.isArray(events) || events.length > 20000) fail('PROJECT_EXECUTOR_UNAVAILABLE'); const checkpoint = ctx.sessionProjections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0).checkpoint; const mode = checkpoint?.sandboxMode; if (!mode || mode.val !== null && !modes.includes(mode.val)) fail('PROJECT_NATIVE_POLICY_REQUIRED'); preset = checkpoint?.agentPreset?.val ?? header.agentPreset; policy = ctx.sandboxPolicy.resolve({ mode: mode.val ?? ctx.sandboxPolicy.defaultMode, session: { id, header } }) } finally { await reader.close() }
  }
  signal?.throwIfAborted()
  if (header?.id !== id || header.origin === 'subagent' || header.parentSession != null || !isAbsolute(header.cwd ?? '')) fail('PROJECT_EXECUTOR_UNAVAILABLE')
  if (!modes.includes(policy?.mode) || policy.sessionId !== id || rootKey(policy.workspaceRoot) !== rootKey(header.cwd)) fail('PROJECT_NATIVE_POLICY_REQUIRED')
  const physical = await realpath(header.cwd); signal?.throwIfAborted()
  if (rootKey(physical) !== rootKey(header.cwd)) fail('PROJECT_SCOPE_CHANGED')
  if (session) {
    const currentPolicy = ctx.sandboxPolicy.resolve({ session }), currentAgent = ctx.agents?.get(id)
    const currentPreset = agent ? ctx.agentPresets.composedPreset(agent.ctx) : ctx.sessionProjections.stateOf(session, 'agentPreset') ?? header.agentPreset
    if (currentAgent !== agent || JSON.stringify(currentPolicy) !== JSON.stringify(policy) || currentPreset !== preset) fail('PROJECT_SCOPE_CHANGED')
  }
  return { id, sessionId: id, root: resolve(header.cwd), projectRoot: resolve(header.cwd), preset, policy, session, agent, active: !!agent, writable: policy.mode !== 'read-only', globalWritable: policy.mode === 'danger-full-access' }
}

export function createProjectContext(ctx, { store } = {}) {
  const list = () => projectRows(ctx.workspaceRegistry)
  function find(projectId) { if (!validId(projectId)) fail('PROJECT_REQUIRED'); const row = list().find(row => row.workspaceIds.includes(projectId)); if (!row) fail('PROJECT_NOT_FOUND'); return row }
  function verify(row, scope) { const current = find(row.projectId); if (rootKey(current.projectRoot) !== rootKey(row.projectRoot) || !current.sessionIds.includes(scope.sessionId) || rootKey(scope.root) !== rootKey(current.projectRoot)) fail('PROJECT_SCOPE_CHANGED') }
  function permissions(scope, options) { if (options.active && !scope.active) fail('PROJECT_EXECUTOR_UNAVAILABLE'); if (options.writing && !scope.writable) fail('PROJECT_WRITE_REQUIRED'); if (options.full && !scope.globalWritable) fail('PROJECT_FULL_ACCESS_REQUIRED') }
  async function resolveProject(projectId, options = {}) {
    const row = find(projectId), presets = options.presets ?? DEFAULT_PRESETS
    if (!validPresets(presets)) fail('PROJECT_PRESETS_INVALID')
    let candidates = row.sessionIds.slice(0, 128)
    // A supplied executor is a pin, not permission to fall back to a more privileged chat.
    if (options.sessionId !== undefined) { if (!validId(options.sessionId) || !row.sessionIds.includes(options.sessionId)) fail('PROJECT_EXECUTOR_MISMATCH'); candidates = [options.sessionId] }
    else {
      const active = validId(options.activeSessionId) && row.sessionIds.includes(options.activeSessionId) ? options.activeSessionId : null
      if(active&&!candidates.includes(active))candidates=[active,...candidates].slice(0,128)
      candidates.sort((a, b) => Number(b === active) - Number(a === active) || Number(!!ctx.agents?.get(b)) - Number(!!ctx.agents?.get(a)))
    }
    for (const id of candidates) {
      let scope
      try { scope = await inspectSession(ctx, id, options); verify(row, scope) } catch (error) { options.signal?.throwIfAborted(); if (options.sessionId !== undefined || error.message === 'PROJECT_SCOPE_CHANGED') throw error; continue }
      if (!presets.includes(scope.preset)) { if (options.sessionId !== undefined) fail('PROJECT_PRESET_UNSUPPORTED'); continue }
      permissions(scope, options)
      return { ...scope, projectId: row.projectId, title: row.title, projectRoot: row.projectRoot }
    }
    fail('PROJECT_EXECUTOR_UNAVAILABLE')
  }
  async function resolveInput(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PROJECT_INPUT_INVALID')
    if (input.projectId === undefined) { const scope = await inspectSession(ctx, input.sessionId, options); if (options.presets && !options.presets.includes(scope.preset)) fail('PROJECT_PRESET_UNSUPPORTED'); permissions(scope, options); return { ...scope, legacy: true } }
    const scope = await resolveProject(input.projectId, { ...options, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) })
    if (input.expectedProjectRoot !== undefined && rootKey(input.expectedProjectRoot) !== rootKey(scope.root)) fail('PROJECT_SCOPE_CHANGED')
    if (input.expectedExecutorRevision !== undefined && input.expectedExecutorRevision !== executorRevision(scope)) fail('PROJECT_EXECUTOR_STALE')
    return scope
  }
  async function bindInput(input, options = {}) { if (input.projectId === undefined) return { ...input }; const scope = await resolveInput(input, options); const bound = { ...input, sessionId: scope.sessionId }; delete bound.projectId; delete bound.expectedProjectRoot; delete bound.expectedExecutorRevision; return bound }
  async function selection({ projectId, activeSessionId, presets = DEFAULT_PRESETS } = {}) {
    const rows = list(), saved = await store.read()
    let selected = projectId === undefined ? saved.value.projectId : projectId
    if (!selected && activeSessionId) { try { const scope = await inspectSession(ctx, activeSessionId); selected = rows.find(row => row.sessionIds.includes(activeSessionId) && rootKey(row.projectRoot) === rootKey(scope.root))?.projectId } catch {} }
    const row = selected ? rows.find(row => row.workspaceIds.includes(selected)) : rows[0]
    let execution = null, executorError = null
    if (row) try { const scope = await resolveProject(row.projectId, { presets, activeSessionId }); execution = { sessionId: scope.sessionId, active: scope.active, writable: scope.writable, globalWritable: scope.globalWritable, preset: scope.preset, revision: executorRevision(scope) } } catch (error) { executorError = /^PROJECT_[A-Z_]+$/u.test(error.message) ? error.message : 'PROJECT_EXECUTOR_UNAVAILABLE' }
    return { projects: rows.map(({ sessionIds, workspaceIds, ...row }) => row), projectId: row?.projectId ?? null, projectRoot: row?.projectRoot ?? null, title: row?.title ?? null, selectionRevision: saved.revision, explicitProjectId: saved.value.projectId, execution, executorError, ...(selected && !row ? { selectionError: 'PROJECT_NOT_FOUND' } : {}) }
  }
  async function select(projectId, revision) { if (projectId !== null) find(projectId); await store.save(projectId, revision); return selection() }
  function bindHandler(handler, options = {}) {
    return async (request, response) => {
      const reject = (status, error) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ok: false, error })) }
      try {
        if (ctx.connection.requestRejection(request) !== undefined) return reject(403, 'NATIVE_CONNECTION_REQUIRED')
        const url = new URL(request.url, 'http://localhost')
        let input, rewritten, body, lease
        if (request.method === 'GET') {
          if (!url.searchParams.has('projectId')) return handler(request, response)
          input = Object.fromEntries(url.searchParams)
        } else if (request.method === 'POST') {
          // Once consumed, forward a replayable exact byte stream even for legacy
          // requests. The original handler remains responsible for CSRF/its limit.
          if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return handler(request, response)
          const chunks = []; let size = 0
          const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
          for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > maxBodyBytes) fail('PROJECT_BODY_LIMIT'); chunks.push(Buffer.from(chunk)) }
          body = Buffer.concat(chunks)
          try { input = JSON.parse(body.toString('utf8')) } catch { fail('PROJECT_INPUT_INVALID') }
          if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PROJECT_INPUT_INVALID')
        } else return handler(request, response)
        if (input.projectId !== undefined) {
          const project = find(input.projectId)
          if (input.sessionId !== undefined && !project.sessionIds.includes(input.sessionId)) fail('PROJECT_EXECUTOR_MISMATCH')
          if (input.expectedProjectRoot !== undefined && rootKey(input.expectedProjectRoot) !== rootKey(project.projectRoot)) fail('PROJECT_SCOPE_CHANGED')
          if (Array.isArray(options.allowGlobalActions) && options.allowGlobalActions.includes(input.action)) {
            rewritten = { ...input }; delete rewritten.projectId; delete rewritten.sessionId
          } else {
            if (request.method === 'POST' && input.sessionId === undefined) fail('PROJECT_EXECUTOR_PIN_REQUIRED')
            let scope
            try { scope = await resolveInput(input, options) } catch (error) {
              if (options.allowUnresolvedConfiguration === true && input.action === 'configuration' && input.sessionId === undefined && error.message === 'PROJECT_EXECUTOR_UNAVAILABLE') { rewritten = { ...input, sessionId: '' }; delete rewritten.projectId }
              else throw error
            }
            if (scope) {
              verify(project, scope)
              const check = await inspectSession(ctx, scope.sessionId, options)
              verify(project, check)
              if (JSON.stringify(check.policy) !== JSON.stringify(scope.policy) || check.agent !== scope.agent || check.preset !== scope.preset) fail('PROJECT_SCOPE_CHANGED')
              rewritten = { ...input, sessionId: scope.sessionId }; delete rewritten.projectId
              const verifyLease = async () => {
                const current = await inspectSession(ctx, scope.sessionId, options); verify(project, current)
                if (executorRevision(current) !== executorRevision(scope) || current.agent !== scope.agent) fail('PROJECT_SCOPE_CHANGED')
                return current
              }
              lease = Object.freeze({ projectId: scope.projectId, projectRoot: scope.projectRoot, sessionId: scope.sessionId, verify: verifyLease, async assertScope(value) {
                if (!value || rootKey(value.root ?? value.projectRoot ?? value.session?.header?.cwd) !== rootKey(scope.root)) fail('PROJECT_SCOPE_CHANGED')
                const id = value.sessionId ?? value.id ?? value.session?.id
                if (id !== undefined && id !== scope.sessionId) fail('PROJECT_SCOPE_CHANGED')
                const mode = value.policy?.mode ?? value.mode
                if (mode !== undefined && mode !== scope.policy.mode || value.writable !== undefined && value.writable !== scope.writable) fail('PROJECT_SCOPE_CHANGED')
                await verifyLease()
              } })
            }
          }
          delete rewritten.expectedProjectRoot; delete rewritten.expectedExecutorRevision
        }
        const forwarded = Object.create(request)
        if (lease) Object.defineProperty(forwarded, Symbol.for('airules.project-request'), { value: lease })
        if (request.method === 'GET') {
          url.search = new URLSearchParams(rewritten).toString()
          Object.defineProperty(forwarded, 'url', { value: url.pathname + url.search, configurable: true })
        } else {
          if (rewritten) body = Buffer.from(JSON.stringify(rewritten))
          Object.defineProperty(forwarded, 'headers', { value: { ...request.headers, 'content-length': String(body.length) }, configurable: true })
          Object.defineProperty(forwarded, Symbol.asyncIterator, { value: async function* () { yield body } })
        }
        return handler(forwarded, response)
      } catch (error) { const value = /^PROJECT_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'PROJECT_CONTEXT_UNAVAILABLE'; return reject(value.includes('STALE') ? 409 : 400, value) }
    }
  }
  return { list, resolve: resolveProject, resolveInput, bindInput, bindHandler, selection, select, verify }
}
