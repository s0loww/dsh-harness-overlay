import { randomBytes, timingSafeEqual } from 'node:crypto'

export const ACP_CONTROL_PATH = '/airules/acp-control'

export function createAcpControlHandler(controller, { connection, token = randomBytes(32).toString('base64url') } = {}) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
    if (!connection || connection.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'ACP_NATIVE_ADMISSION_REQUIRED' })
    if (!['GET', 'POST'].includes(request.method)) return send(405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
    if (request.method === 'POST') {
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
    }
    try {
      if (request.method === 'POST') {
        if (Number(request.headers?.['content-length']) > 4096) throw new Error('REQUEST_TOO_LARGE')
        let size = 0; const chunks = []
        for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 4096) throw new Error('REQUEST_TOO_LARGE'); chunks.push(buffer) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (input.action === 'start') await controller.start()
        else if (input.action === 'stop') await controller.stop()
        else if (input.action === 'setAutoStart') await controller.setAutoStart(input.autoStart)
        else throw new Error('ACP_ACTION_REJECTED')
      }
      return send(200, { ok: true, ...controller.snapshot(), csrfToken: token })
    } catch { return send(400, { ok: false, error: 'ACP_CONTROL_FAILED', ...controller.snapshot(), csrfToken: token }) }
  }
}
