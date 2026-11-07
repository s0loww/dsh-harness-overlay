import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { readSettings, saveSettings } from './core.js'
import { projectSession } from './session.js'
import { environmentStatus } from './environment.js'
export const name = 'airules-dsh-project-settings'
export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy']
export const API = '/airules/project-settings'
export const ENVIRONMENT_API = `${API}/environment`
export { projectSession }
const token = randomBytes(32).toString('base64url')
async function bodyOf(request) {
  let bytes = 0, chunks = []
  for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 128 * 1024) throw new Error('BODY_LIMIT'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
}
const messages = {
  STALE_SETTINGS: 'Файл изменился после открытия формы. Черновик сохранён в форме; обновите данные и повторите правки.',
  WORKSPACE_WRITE_REQUIRED: 'Для сохранения нужен режим доступа к рабочей папке с записью.',
  PASSWORD_USE_SEPARATE_FIELD: 'Пароль укажите отдельным полем IB_PASSWORD, а не в строке подключения.',
  VALUE_INVALID: 'Проверьте формат полей: допустимы однострочные значения до 4096 знаков.',
}
export function handlerFor(ctx, backupHome = dshHomePath(), discoveryPaths) {
  return async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data)) }
    try {
      if (!ctx.connection || ctx.connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost'), id = url.searchParams.get('sessionId')
        const scope = await projectSession(ctx, id)
        if (url.pathname === ENVIRONMENT_API) return send(200, { ok: true, ...await environmentStatus(scope.root, discoveryPaths) })
        return send(200, { ok: true, ...readSettings(scope.root), projectRoot: scope.root, writable: scope.writable, csrfToken: token })
      }
      if (new URL(request.url, 'http://localhost').pathname === ENVIRONMENT_API) return send(405, { ok: false, error: 'READ_ONLY_API' })
      if (request.method !== 'POST') return send(405, { ok: false, error: 'METHOD_REJECTED' })
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
      if (!String(request.headers?.['content-type'] ?? '').startsWith('application/json')) return send(400, { ok: false, error: 'JSON_REQUIRED' })
      const body = await bodyOf(request), scope = await projectSession(ctx, body.sessionId, true)
      const result = saveSettings(scope.root, body, backupHome)
      return send(200, { ok: true, ...result, projectRoot: scope.root, writable: true, csrfToken: token })
    } catch (error) {
      const code = ['STALE_SETTINGS', 'WORKSPACE_WRITE_REQUIRED', 'PASSWORD_USE_SEPARATE_FIELD', 'VALUE_INVALID'].includes(error.message) ? error.message : 'PROJECT_SETTINGS_UNAVAILABLE'
      return send(code === 'STALE_SETTINGS' ? 409 : 400, { ok: false, error: code, message: messages[code] ?? 'Настройки проекта недоступны. Выберите сеанс 1c-airules; проверьте доступ к папке и файлу .dev.env. Большой закрытый сеанс откройте перед редактированием.' })
    }
  }
}
export function apply(ctx) {
  const handler = handlerFor(ctx)
  for (const path of [ENVIRONMENT_API, API]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
}
