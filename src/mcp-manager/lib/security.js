import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'

const optional = (ctx, name) => { try { return ctx?.get?.(name) ?? ctx?.[name] } catch { return undefined } }
export const MANAGER_ROOT = '/airules/mcp-manager'

export function managerToolAllowed(ctx, agent) {
  if (!agent?.session || agent.session.header?.agentPreset !== '1c-airules' || typeof agent.session.header.cwd !== 'string') return false
  const scope = agent.ctx ?? ctx
  const plan = optional(scope, 'planMode') ?? optional(ctx, 'planMode')
  let active
  if (typeof plan?.get === 'function') { const state = plan.get(agent); active = state?.pending ?? state?.active }
  else { const state = (optional(scope, 'sessionProjections') ?? optional(ctx, 'sessionProjections'))?.stateOf?.(agent.session, 'plan'); active = state?.running?.wanted ?? state?.wanted ?? state?.active }
  if (active !== false) return false
  const policy = (optional(scope, 'sandboxPolicy') ?? optional(ctx, 'sandboxPolicy'))?.resolve?.({ session: agent.session })
  return policy?.mode === 'danger-full-access' || (policy?.mode === 'workspace-write' && typeof policy.workspaceRoot === 'string' && resolve(policy.workspaceRoot) === resolve(agent.session.header.cwd))
}

const safePayload = value => {
  if (Array.isArray(value)) return value.map(safePayload)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, (key === 'error' || key === 'message') && typeof item === 'string' ? 'MCP_OPERATION_FAILED' : safePayload(item)]))
  return value
}

function oauthCallback(request, allowOAuthState) {
  if (request.method !== 'GET') return false
  const address = request.socket?.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  try {
    const authority = new URL(`http://${request.headers?.host ?? ''}`)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname)) return false
    const url = new URL(request.url, 'http://localhost')
    const state = url.searchParams.get('state') ?? ''
    return url.pathname === `${MANAGER_ROOT}/api/oauth/callback` && /^[a-f0-9]{32}$/u.test(state) && allowOAuthState(state) ? state : false
  } catch { return false }
}

/** Wrap only this plugin's routes; no global host or DOM monkeypatch. */
export function createSecureManagerHandler(handler, { connection, allowOAuthState = () => false, token = randomBytes(32).toString('base64url') }) {
  const consumedStates = new Set()
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
    const callback = oauthCallback(request, allowOAuthState)
    const callbackPath = new URL(request.url ?? '/', 'http://localhost').pathname === `${MANAGER_ROOT}/api/oauth/callback`
    if (callbackPath) {
      if (!callback || consumedStates.has(callback)) return send(403, { ok: false, error: 'OAUTH_STATE_REJECTED' })
      consumedStates.add(callback)
      if (consumedStates.size > 256) consumedStates.delete(consumedStates.values().next().value)
    }
    let admitted = false
    try { admitted = !!connection && connection.requestRejection(request) === undefined } catch {}
    if (!admitted && !callback) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const supplied = Buffer.from(String(request.headers?.['x-dsh-csrf'] ?? '')), expected = Buffer.from(token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })
    }
    let type = ''
    const guardedResponse = new Proxy(response, { get(target, property) {
      if (property === 'setHeader') return (key, value) => { if (String(key).toLowerCase() === 'content-type') type = String(value); return target.setHeader(key, value) }
      if (property === 'end') return (data, ...args) => {
        let output = data
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          const text = String(data)
          if (type.includes('application/json')) {
            try { output = JSON.stringify({ ...safePayload(JSON.parse(text)), csrfToken: token }) }
            catch { output = JSON.stringify({ ok: false, error: 'MCP_RESPONSE_INVALID' }) }
          } else if (type.includes('text/html')) {
            const success = text.includes("type: 'mcp-oauth-success'")
            const completion = { type: success ? 'mcp-oauth-success' : 'mcp-oauth-error' }
            const server = text.match(/serverName:\s*"([A-Za-z0-9_-]{1,32})"/u)?.[1]
            if (success && server) completion.serverName = server
            output = '<!doctype html><meta charset="utf-8"><title>MCP OAuth</title><p>' + (success ? 'Авторизация MCP завершена. Вернитесь в DSH.' : 'Авторизация MCP не завершена. Повторите действие в DSH.') + '</p><script>if(window.opener)window.opener.postMessage(' + JSON.stringify(completion) + ',"*");setTimeout(()=>window.close(),1500)</script>'
          }
        }
        return target.end(output, ...args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }, set(target, property, value) { return Reflect.set(target, property, value, target) } })
    try { return await handler(request, guardedResponse) }
    catch { return send(400, { ok: false, error: 'MCP_OPERATION_FAILED', csrfToken: token }) }
  }
}
