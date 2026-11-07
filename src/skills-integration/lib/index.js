import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { resolveDshHome, resolveAgentsHome } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSkill, parseSkill, publicRow, safePath, scanFiles, skillRoots, toggleFile } from './core.js'
import { createAssignmentStore } from './assignments.js'
import { createCatalogService, registerCatalogRuntime } from './catalog.js'

export const name = 'airules-dsh-skills'
export const inject = ['webServer', 'connection', 'skills', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy', 'agents', 'agentPresets', 'tools']
export const API = '/airules/skills'
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const get = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
export async function sessionScope(ctx, id) {
  if (!id) return { id: null, root: null, writable: false, globalWritable: false, session: null, mode: null }
  if (typeof id !== 'string' || id.length > 256) throw new Error('SESSION_REQUIRED')
  const projections = get(ctx, 'sessionProjections'), sandbox = get(ctx, 'sandboxPolicy')
  let session = get(ctx, 'sessions')?.get(id), header = session?.header, policy
  if (session) policy = sandbox.resolve({ session })
  else {
    const persistence = get(ctx, 'sessionPersistence'), info = await persistence.stat(id)
    if (info?.header?.id !== id || info?.eventCount > 20000 || info?.sizeBytes > 32 * 1024 * 1024) throw new Error('SESSION_REQUIRED')
    const reader = await persistence.open(id, 'read')
    try {
      header = reader.header
      const { events } = await reader.read(0, 20001)
      if (!Array.isArray(events) || events.length > 20000) throw new Error('SESSION_REQUIRED')
      const checkpoint = projections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0).checkpoint
      const row = checkpoint?.sandboxMode
      if (!row || (row.val !== null && !MODES.includes(row.val))) throw new Error('SESSION_REQUIRED')
      policy = sandbox.resolve({ mode: row.val ?? sandbox.defaultMode, session: { id, header } })
    } finally { await reader.close() }
  }
  if (header?.id !== id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || typeof policy?.workspaceRoot !== 'string' || !MODES.includes(policy?.mode) || resolve(policy.workspaceRoot) !== resolve(header.cwd)) throw new Error('SESSION_REQUIRED')
  return { id, root: resolve(header.cwd), writable: policy.mode !== 'read-only', globalWritable: policy.mode === 'danger-full-access', session, mode: policy.mode }
}
function registryFor(ctx, id) {
  const agent = id ? get(ctx, 'agents')?.get(id) : undefined
  return { registry: agent ? get(ctx, 'agentPresets')?.serviceFor(agent, 'skills') ?? get(ctx, 'skills') : get(ctx, 'skills'), agent }
}
export function createManager({ home, agentsHome, backupRoot, parseYaml = parse }) {
  return {
    async inventory(scope, registry, agent) {
      const roots = skillRoots({ home, agentsHome, projectRoot: scope.root }), files = await scanFiles(roots, parseYaml)
      const listed = await registry.list({ cwd: scope.root ?? undefined, scope: agent })
      const rows = files.rows.map(row => publicRow(row, row.scope === 'project' ? scope.writable : scope.globalWritable))
      for (const row of listed) {
        if (files.rows.some(file => row.path && resolve(file.file) === resolve(row.path))) continue
        if (files.rows.some(file => file.name === row.name && file.managedDisabled)) continue
        rows.push({ id: `registry:${row.name}`, name: row.name, description: row.description, source: row.source, scope: 'global', enabled: row.invocation?.modelInvocable !== false || row.invocation?.userInvocable !== false,
          modelInvocable: row.invocation?.modelInvocable !== false, userInvocable: row.invocation?.userInvocable !== false,
          writable: scope.globalWritable && row.source === 'bundled', bundled: row.source === 'bundled', runtime: row.source !== 'bundled', path: row.path ?? null, revision: null })
      }
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
      return { rows, files: files.rows, truncated: files.truncated, roots, projectRoot: scope.root, writable: scope.writable, globalWritable: scope.globalWritable }
    },
    async content(body, scope, registry, agent) {
      const data = await this.inventory(scope, registry, agent), file = data.files.find(row => row.id === body.id)
      if (file) {
        let raw = file.raw, path = file.file
        if (file.managedDisabled && file.originRevision) {
          path = `${file.file}.disabled`; await safePath(file.anchor, path)
          raw = await readFile(path, 'utf8')
          if (createHash('sha256').update(raw).digest('hex') !== file.originRevision) throw new Error('STALE_SKILL')
          parseSkill(raw, parseYaml)
        }
        return { name: file.name, content: raw, revision: file.revision, path, enabled: file.enabled }
      }
      const row = data.rows.find(row => row.id === body.id)
      if (!row) throw new Error('SKILL_NOT_FOUND')
      const skill = await registry.get(row.name, { cwd: scope.root ?? undefined, scope: agent })
      if (!skill) throw new Error('SKILL_NOT_FOUND')
      return { name: skill.name, content: skill.content, path: skill.path ?? null }
    },
    async mutate(body, scope, registry, agent) {
      const data = await this.inventory(scope, registry, agent)
      if (body.action === 'add') {
        if (!['project', 'global'].includes(body.scope) || !(body.scope === 'project' ? scope.writable : scope.globalWritable)) throw new Error('WRITE_REQUIRED')
        if (data.rows.some(row => row.scope === body.scope && row.name === body.name)) throw new Error('SKILL_EXISTS')
        const root = data.roots.find(row => row.scope === body.scope && row.source.endsWith('-dsh'))
        await createSkill(root, body, parseYaml)
        return { changed: 1 }
      }
      if (body.action !== 'toggle' || !Array.isArray(body.items) || !body.items.length || body.items.length > 2000 || typeof body.enabled !== 'boolean') throw new Error('REQUEST_INVALID')
      const selected = body.items.map(item => {
        const row = data.rows.find(row => row.id === item.id)
        if (!row || !row.writable) throw new Error('WRITE_REQUIRED')
        if (row.revision !== item.revision) throw new Error('STALE_SKILL')
        return { ...row, fileRow: data.files.find(file => file.id === row.id) }
      })
      if (new Set(selected.map(row => row.id)).size !== selected.length) throw new Error('REQUEST_INVALID')
      let changed = 0
      for (const row of selected) {
        if (row.fileRow) changed += Number(await toggleFile(row.fileRow, body.enabled, row.revision, backupRoot))
        else if (row.bundled && !body.enabled) {
          // Native user-dsh rank 400 beats bundled rank 600 in the same preset layer.
          // Runtime providers rank 250 are deliberately read-only here.
          const root = data.roots.find(root => root.source === 'user-dsh')
          await createSkill(root, { name: row.name, description: row.description, content: 'Навык отключён пользователем в настройках DSH.' }, parseYaml, { shadow: true }); changed++
        }
      }
      return { changed }
    },
  }
}
export function handlerFor(ctx, manager, assignments) {
  const token = randomBytes(32).toString('base64url')
  let pending = Promise.resolve()
  return async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data)) }
    try {
      if (ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      const url = new URL(request.url, 'http://localhost')
      let body
      if (request.method === 'GET') body = { sessionId: url.searchParams.get('sessionId') }
      else if (request.method === 'POST') {
        const supplied = Buffer.from(String(request.headers['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
        if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('REQUEST_INVALID')
        const chunks = []; let bytes = 0
        for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 600 * 1024) throw new Error('REQUEST_INVALID'); chunks.push(Buffer.from(chunk)) }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } else return send(405, { ok: false, error: 'METHOD_REJECTED' })
      const scope = await sessionScope(ctx, body.sessionId), { registry, agent } = registryFor(ctx, body.sessionId)
      if (body.action === 'content') return send(200, { ok: true, ...await manager.content(body, scope, registry, agent) })
      if (assignments && ['assignment-save', 'task-context'].includes(body.action)) {
        if (!scope.id) throw new Error('SESSION_REQUIRED')
        const action = pending.then(async () => {
          if (body.action === 'task-context') {
            // Catalog selection is metadata and does not change native permissions.
            await assignments.store.setContext(scope.id, body)
          } else {
            if (!(body.scope === 'global' ? scope.globalWritable : body.scope === 'project' && scope.writable)) throw new Error('WRITE_REQUIRED')
            await assignments.store.save(scope.root, body)
          }
          return { assignments: await assignments.settings(scope, agent) }
        })
        pending = action.catch(() => {})
        return send(200, { ok: true, ...await action, csrfToken: token })
      }
      if (request.method === 'POST') {
        const action = pending.then(() => manager.mutate(body, scope, registry, agent))
        pending = action.catch(() => {})
        let result
        try { result = await action } finally { registry.invalidateCache(); get(ctx, 'skills').invalidateCache() }
        return send(200, { ok: true, ...result, csrfToken: token })
      }
      const { files, roots, ...data } = await manager.inventory(scope, registry, agent)
      return send(200, { ok: true, ...data, ...(assignments ? { assignments: await assignments.settings(scope, agent) } : {}), directories: roots.filter(row => row.source.endsWith('-dsh')).map(row => ({ scope: row.scope, path: row.root })), csrfToken: token })
    } catch (error) {
      const code = ['STALE_SKILL', 'WRITE_REQUIRED', 'SKILL_EXISTS', 'SKILL_INVALID', 'SKILL_FRONTMATTER_REQUIRED', 'PATH_REJECTED', 'SKILL_NOT_FOUND', 'SESSION_REQUIRED', 'REQUEST_INVALID', 'STALE_ASSIGNMENTS', 'ASSIGNMENTS_INVALID', 'ASSIGNMENTS_BUSY'].includes(error.message) ? error.message : error.code === 'EEXIST' ? 'SKILL_EXISTS' : 'SKILLS_UNAVAILABLE'
      send(['STALE_SKILL', 'STALE_ASSIGNMENTS'].includes(code) ? 409 : 400, { ok: false, error: code })
    }
  }
}
export function apply(ctx) {
  const home = resolveDshHome(), manager = createManager({ home, agentsHome: resolveAgentsHome(), backupRoot: resolve(home, 'skills-backups') })
  const assignments = createCatalogService(ctx, createAssignmentStore(home))
  ctx.provide('airulesSkillCatalog', assignments)
  registerCatalogRuntime(ctx, assignments, createUserMessage)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handlerFor(ctx, manager, assignments) }))
}
