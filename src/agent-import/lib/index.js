import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { previewImport, applyImport } from './core.js'
import { workflowSession } from './session.js'
export const name = 'airules-dsh-agent-import'
export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy']
export const API = '/airules/agent-import'
export function handlerFor(ctx, paths = { userHome: homedir(), dshHome: dshHomePath() }) {
  const csrfToken = randomBytes(32).toString('base64url')
  return async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)) }
    try {
      if (!ctx.connection || ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost'), scope = await workflowSession(ctx, url.searchParams.get('sessionId'))
        await request[Symbol.for('airules.project-request')]?.assertScope(scope)
        return send(200, { ok: true, csrfToken, projectRoot: scope.root, writable: scope.writable, globalWritable: scope.mode === 'danger-full-access' })
      }
      if (request.method !== 'POST') return send(405, { ok: false, error: 'METHOD_REJECTED' })
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(csrfToken)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
      if (!String(request.headers?.['content-type'] ?? '').startsWith('application/json')) throw new Error('JSON_REQUIRED')
      let length = 0, chunks = []
      for await (const chunk of request) { length += Buffer.byteLength(chunk); if (length > 32768) throw new Error('BODY_LIMIT'); chunks.push(Buffer.from(chunk)) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || Object.keys(body).some(key => !['action', 'sessionId', 'origin', 'scope', 'revision', 'selected'].includes(key)) || !['preview', 'apply'].includes(body.action)) throw new Error('BODY_REJECTED')
      const session = await workflowSession(ctx, body.sessionId, body.action === 'apply')
      if (body.action === 'apply' && body.scope === 'global' && session.mode !== 'danger-full-access') throw new Error('GLOBAL_WRITE_REQUIRED')
      await request[Symbol.for('airules.project-request')]?.assertScope(session)
      const options = { ...paths, projectRoot: session.root, origin: body.origin, scope: body.scope, verifyProject: () => request[Symbol.for('airules.project-request')]?.verify() }
      const result = await (body.action === 'preview' ? previewImport(options) : applyImport(options, body))
      if (body.action === 'apply') {
        ctx.get?.('skills')?.invalidateCache?.()
        const agent = ctx.get?.('agents')?.get(body.sessionId)
        if (agent) ctx.get?.('agentPresets')?.serviceFor(agent, 'skills')?.invalidateCache?.()
      }
      return send(200, { ok: true, ...result })
    } catch (error) {
      const code = /^[A-Z][A-Z_]{1,60}$/u.test(error.message) ? error.message : 'IMPORT_UNAVAILABLE'
      return send(code === 'STALE_PREVIEW' ? 409 : 400, { ok: false, error: code, partial: !!error.partial, message: error.partial ? 'Часть файлов могла сохраниться. Обновите предпросмотр и проверьте конфликты; существующие файлы не заменялись.' : ({ STALE_PREVIEW: 'Источники или назначения изменились. Обновите предпросмотр.', GLOBAL_WRITE_REQUIRED: 'Для записи общих правил нужен полный доступ штатной песочницы.', WORKSPACE_WRITE_REQUIRED: 'Для импорта включите запись в рабочую папку.', IMPORT_BUSY: 'Другой импорт уже выполняется. Повторите позже.', LINK_REJECTED: 'Символические ссылки и junction не импортируются.' }[code] ?? 'Импорт недоступен. Проверьте выбранный проект, доступ и формат файлов.') })
    }
  }
}
export function apply(ctx) {
  const originalHandler = handlerFor(ctx)
  let routeHandler = originalHandler
  ctx.inject?.(['airulesProjects'], ready => { routeHandler = ready.airulesProjects.bindHandler(originalHandler, { presets: ['1c-airules','python-airules','sysadmin-airules'] }); return () => { routeHandler = originalHandler } })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: (request,response) => routeHandler(request,response) }))
}
