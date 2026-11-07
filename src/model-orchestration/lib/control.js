import { randomBytes, timingSafeEqual } from 'node:crypto'
export const CONTROL_PATH = '/airules/model-orchestration'
export function createHandler(service, { connection, token = randomBytes(32).toString('base64url') }) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
    if (connection.requestRejection(request) !== undefined) return send(403, { ok: false })
    if (!['GET','POST'].includes(request.method)) return send(405, { ok: false })
    try {
      let catalog
      if (request.method === 'POST') {
        const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false })
        let size = 0; const chunks = []
        for await (const part of request) { const chunk = Buffer.from(part); size += chunk.length; if (size > 65536) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const signal = AbortSignal.timeout(20000)
        if (input.action === 'save') await service.save(input.settings, signal)
        else if (input.action === 'catalog') catalog = await service.catalog(signal)
        else throw new Error('ACTION_REJECTED')
      }
      return send(200, { ok: true, settings: service.snapshot(), ...(catalog ? { catalog } : {}), csrfToken: token })
    } catch { return send(400, { ok: false, error: 'ORCHESTRATION_REQUEST_REJECTED' }) }
  }
}
