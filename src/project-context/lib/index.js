import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { createProjectContext, selectionStore, DEFAULT_PRESETS } from './core.js'
export const name = 'airules-dsh-project-context'
export const inject = ['workspaceRegistry', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'agentPresets', 'sandboxPolicy', 'webServer', 'connection', 'dshHomePath']
export const API = '/airules/projects'
const code = error => /^PROJECT_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'PROJECT_CONTEXT_UNAVAILABLE'
export function handlerFor(ctx, service) {
  const csrfToken = randomBytes(32).toString('base64url')
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
    try {
      if (ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method === 'GET') { const input = Object.fromEntries(new URL(request.url, 'http://localhost').searchParams); if (Object.keys(input).some(key => !['projectId', 'activeSessionId', 'presets'].includes(key))) throw Error('PROJECT_INPUT_INVALID'); const value = await service.selection({ ...input, presets: input.presets ? input.presets.split(',') : DEFAULT_PRESETS }); return send(200, { ok: true, ...value, csrfToken }) }
      if (request.method !== 'POST') return send(405, { ok: false, error: 'PROJECT_METHOD_REQUIRED' })
      const supplied = Buffer.from(String(request.headers['x-airules-csrf'] ?? '')), expected = Buffer.from(csrfToken)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'PROJECT_CSRF_REQUIRED' })
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw Error('PROJECT_JSON_REQUIRED')
      const chunks = []; let bytes = 0; for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 8192) throw Error('PROJECT_BODY_LIMIT'); chunks.push(Buffer.from(chunk)) }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!input || Object.keys(input).some(key => !['action', 'projectId', 'expectedRevision'].includes(key)) || input.action !== 'select') throw Error('PROJECT_INPUT_INVALID')
      return send(200, { ok: true, ...await service.select(input.projectId, input.expectedRevision), csrfToken })
    } catch (error) { const value = code(error); send(value.includes('STALE') ? 409 : 400, { ok: false, error: value }) }
  }
}
export function apply(ctx) { const service = createProjectContext(ctx, { store: selectionStore(join(ctx.dshHomePath('project-context'), 'selection.json')) }); ctx.provide('airulesProjects', service); ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handlerFor(ctx, service) })) }
