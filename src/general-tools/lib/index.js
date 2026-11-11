import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { PRESETS, LITE_TEXT, readStyle, saveStyle, styleSync } from './style.js'
import { sessionScope } from './session.js'
import { renderForAgent } from './render.js'

export const name = 'airules-dsh-general-tools'
export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy', 'sandbox', 'subprocess', 'agentPresets', 'tools']
export const Config = z.object({ nodePath: z.string().default('') })
export const API = '/airules/general-tools'
export function createGeneralService(ctx, home, config = {}) {
  return {
    async status(id,lease) { const scope = await sessionScope(ctx, id); await lease?.assertScope(scope); return { ...await readStyle(home, scope.root), supported: PRESETS.includes(scope.preset), sessionId: id, projectRoot: scope.root, ownership: 'project', writable: scope.writable && scope.origin !== 'subagent' } },
    async setStyle(id, data, lease) {
      const scope = await sessionScope(ctx, id)
      await lease?.assertScope(scope)
      if (!PRESETS.includes(scope.preset)) throw new Error('PRESET_UNSUPPORTED')
      if (!scope.writable || scope.origin === 'subagent') throw new Error('WORKSPACE_WRITE_REQUIRED')
      const verify = async () => { await lease?.verify(); const current = await sessionScope(ctx, id); if (current.root !== scope.root || current.mode !== scope.mode || current.preset !== scope.preset || current.session !== scope.session || current.origin !== scope.origin) throw new Error('PROJECT_SCOPE_CHANGED') }
      return { ...await saveStyle(home, scope.root, data, { verify }), supported: true, sessionId: id, projectRoot: scope.root, ownership: 'project', writable: true }
    },
    styleText(agent) {
      if (!agent?.session?.id || !PRESETS.includes(ctx.agentPresets.composedPreset(agent.ctx))) return ''
      return styleSync(home, agent.session.header?.cwd) === 'lite' ? LITE_TEXT : ''
    },
    async render(args, exec) {
      if (!exec?.agent || !PRESETS.includes(ctx.agentPresets.composedPreset(exec.agent.ctx))) throw new Error('PRESET_UNSUPPORTED')
      return renderForAgent(ctx, args, exec, { nodePath: config.nodePath, helpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature } })
    },
  }
}
export function handlerFor(ctx, service) {
  const csrf = randomBytes(32).toString('base64url')
  return async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data)) }
    try {
      if (ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method === 'GET') return send(200, { ok: true, ...await service.status(new URL(request.url, 'http://localhost').searchParams.get('sessionId'), request[Symbol.for('airules.project-request')]), csrfToken: csrf })
      if (request.method !== 'POST') return send(405, { ok: false, error: 'METHOD_REJECTED' })
      const supplied = Buffer.from(String(request.headers['x-dsh-csrf'] ?? '')), expected = Buffer.from(csrf)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('BODY_INVALID')
      const chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) throw new Error('BODY_INVALID'); chunks.push(Buffer.from(chunk)) }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!data || Object.keys(data).some(key => !['sessionId', 'mode', 'revision'].includes(key))) throw new Error('BODY_INVALID')
      return send(200, { ok: true, ...await service.setStyle(data.sessionId, data, request[Symbol.for('airules.project-request')]), csrfToken: csrf })
    } catch (error) {
      const code = ['SESSION_REQUIRED', 'PROJECT_REQUIRED', 'PROJECT_SCOPE_CHANGED', 'WORKSPACE_WRITE_REQUIRED', 'PRESET_UNSUPPORTED', 'STYLE_INVALID', 'STYLE_BUSY', 'STALE_STYLE', 'PATH_REJECTED', 'BODY_INVALID'].includes(error.message) ? error.message : 'GENERAL_TOOLS_UNAVAILABLE'
      send(code === 'STALE_STYLE' ? 409 : 400, { ok: false, error: code })
    }
  }
}
export function apply(ctx, config = {}) {
  const service = createGeneralService(ctx, resolveDshHome(), config)
  ctx.provide('airulesGeneralTools', service)
  const originalHandler = handlerFor(ctx, service)
  let routeHandler = originalHandler
  ctx.inject?.(['airulesProjects'], ready => { routeHandler = ready.airulesProjects.bindHandler(originalHandler, { presets: ['1c-airules','python-airules','sysadmin-airules'] }); return () => { routeHandler = originalHandler } })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: (request,response) => routeHandler(request,response) }))
}
