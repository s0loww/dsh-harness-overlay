import { randomBytes, timingSafeEqual } from 'node:crypto'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseAuthority(value) {
  const raw = String(value ?? '').trim()
  if (raw === '' || /[\\/@?#]/u.test(raw)) return undefined
  try {
    const parsed = new URL(`http://${raw}`)
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return undefined
    return { host: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase() }
  } catch {
    return undefined
  }
}

function loopbackPeer(request) {
  const address = String(request.socket?.remoteAddress ?? '').toLowerCase()
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

/**
 * R159: общее чтение тела локального запроса с лимитом. Байты считаются по мере
 * поступления, превышение обрывает чтение до склейки (ошибка REQUEST_TOO_LARGE,
 * для ответа 413); текст декодируется один раз, UTF-8 не рвётся на границе чанков.
 */
export async function readLimitedBody(request, maxBytes) {
  const tooLarge = () => Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE' })
  if (Number(request.headers?.['content-length']) > maxBytes) throw tooLarge()
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw tooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fixed-loopback authority and per-process CSRF guard for local DSH Web routes.
 * Host reflection is rejected before Origin comparison; mutating methods also
 * require a same-origin browser request and the unguessable session token.
 */
export function createLocalHttpGuard(options = {}) {
  const token = typeof options.token === 'string' && options.token.length >= 12
    ? options.token
    : randomBytes(32).toString('base64url')

  return Object.freeze({
    token,
    matchesToken(request) {
      return constantTimeEqual(request.headers?.['x-dsh-csrf'], token)
    },
    authorize(request, policy = {}) {
      if (!loopbackPeer(request)) return { ok: false, code: 'LOOPBACK_PEER_REQUIRED' }
      const authority = parseAuthority(request.headers?.host)
      if (!authority) return { ok: false, code: 'LOCAL_AUTHORITY_REQUIRED' }

      const method = String(request.method ?? 'GET').toUpperCase()
      const mutating = policy.csrf === true || !SAFE_METHODS.has(method)
      const origin = request.headers?.origin
      if (origin === undefined) {
        if (mutating) return { ok: false, code: 'LOCAL_SAME_ORIGIN_REQUIRED' }
      } else {
        try {
          const parsed = new URL(String(origin))
          const protocol = request.socket?.encrypted === true ? 'https:' : 'http:'
          if (parsed.protocol !== protocol || parsed.host.toLowerCase() !== authority.host || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
            return { ok: false, code: 'LOCAL_SAME_ORIGIN_REQUIRED' }
          }
        } catch {
          return { ok: false, code: 'LOCAL_SAME_ORIGIN_REQUIRED' }
        }
      }

      if (mutating && !constantTimeEqual(request.headers?.['x-dsh-csrf'], token)) {
        return { ok: false, code: 'CSRF_REQUIRED' }
      }
      return { ok: true }
    },
  })
}

