import { randomBytes, timingSafeEqual } from 'node:crypto'
import { workflowSession } from './session.js'
export const API = '/airules/workflows'
const safeCode = error => /^[A-Z][A-Z0-9_:-]{0,95}$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'WORKFLOW_UNAVAILABLE'
async function readBody(request) {
  const chunks = []; let size = 0
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 16384) throw new Error('BODY_LIMIT'); chunks.push(Buffer.from(chunk)) }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'sessionId', 'workflowId', 'setup', 'revision', 'mode'].includes(key))) throw new Error('BODY_REJECTED')
  return body
}
export function createHandler(ctx, service) {
  const token = randomBytes(32).toString('base64url')
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
    try {
      if (!ctx.connection || ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost'), action = url.searchParams.get('action') ?? 'status'
        const scope = await workflowSession(ctx, url.searchParams.get('sessionId'))
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
        if (action === 'status') return send(200, { ok: true, ...await service.status(scope), csrfToken: token })
        if (action === 'setup') return send(200, { ok: true, ...await service.setup(scope), csrfToken: token })
        if (action === 'runs') return send(200, { ok: true, runs: await service.runs(scope) })
        if (action === 'result') return send(200, { ok: true, result: await service.result(scope, url.searchParams.get('runId')) })
        return send(405, { ok: false, error: 'ACTION_REJECTED' })
      }
      if (request.method !== 'POST') return send(405, { ok: false, error: 'METHOD_REJECTED' })
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
      if (!String(request.headers?.['content-type'] ?? '').startsWith('application/json')) return send(400, { ok: false, error: 'JSON_REQUIRED' })
      const body = await readBody(request)
      if (body.action === 'previewSetup') {
        const scope = await workflowSession(ctx, body.sessionId)
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
        return send(200, { ok: true, ...await service.previewSetup(scope, body.setup) })
      }
      if (body.action === 'saveSetup') {
        const scope = await workflowSession(ctx, body.sessionId, true)
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
        return send(200, { ok: true, ...await service.saveSetup(scope, body.setup, body.revision) })
      }
      if (body.action === 'setMode') {
        const scope = await workflowSession(ctx, body.sessionId, true)
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
        return send(200, { ok: true, ...await service.setMode(scope, body.mode) })
      }
      if (body.action !== 'plan') return send(405, { ok: false, error: 'ACTION_REJECTED' })
      const scope = await workflowSession(ctx, body.sessionId, true)
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
      return send(200, { ok: true, plan: await service.plan(scope, body.workflowId) })
    } catch (error) { return send(400, { ok: false, error: safeCode(error), message: 'Проверки проекта недоступны. Проверьте выбранный проект, права и его привязки.' }) }
  }
}
