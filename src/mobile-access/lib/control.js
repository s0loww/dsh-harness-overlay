import { randomBytes, timingSafeEqual } from 'node:crypto'
export const MOBILE_ACCESS_PATH = '/airules/mobile-access'

export function createMobileAccessHandler(controller, { connection, token = randomBytes(32).toString('base64url') } = {}) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
    if (!connection || connection.requestRejection(request) !== undefined) return send(403, { ok: false, message: 'Управление доступом доступно только в локальном DSH Desktop.' })
    if (!['GET', 'POST'].includes(request.method)) return send(405, { ok: false, message: 'Метод не поддерживается.' })
    if (request.method === 'POST') {
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, message: 'Обновите локальную страницу настройки.' })
    }
    try {
      if (request.method === 'POST') {
        if (Number(request.headers?.['content-length']) > 8192) throw new Error('REQUEST_TOO_LARGE')
        let size = 0; const chunks = []
        for await (const chunk of request) { const data = Buffer.from(chunk); size += data.length; if (size > 8192) throw new Error('REQUEST_TOO_LARGE'); chunks.push(data) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        switch (input.action) {
          case 'start': await controller.start(); break
          case 'stop': await controller.stop(); break
          case 'setAutoStart': await controller.setAutoStart(input.enabled); break
          case 'setPort': await controller.setPort(input.port); break
          case 'setPassword': await controller.setPassword(input.password); break
          case 'createPairing': await controller.createPairing(); break
          case 'revoke': await controller.revoke(input.deviceId); break
          case 'revokeAll': await controller.revokeAll(); break
          default: throw new Error('ACTION_REJECTED')
        }
      }
      return send(200, { ok: true, ...controller.snapshot(), csrfToken: token })
    } catch { return send(400, { ok: false, ...controller.snapshot(), message: 'Не удалось изменить доступ с телефона. Проверьте параметры и повторите действие.', csrfToken: token }) }
  }
}
