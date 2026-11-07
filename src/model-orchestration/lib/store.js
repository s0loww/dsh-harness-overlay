import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export const ROLES = Object.freeze(['analytic','arch-reviewer','architect','code-reviewer','developer','doc-writer','error-fixer','explorer','metadata-manager','performance-optimizer','planner','refactoring','tester'])
export const ROTATION_PROVIDER = 'airules-rotation'
export function fail(code) { throw Object.assign(new Error(code), { code }) }
export const clone = value => JSON.parse(JSON.stringify(value))
function route(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider','model','reasoningEffort'].includes(key))) fail('MODEL_ROUTE_INVALID')
  for (const key of ['provider','model']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200) fail('MODEL_ROUTE_INVALID')
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort.trim() || value.reasoningEffort.length > 80)) fail('MODEL_EFFORT_INVALID')
  return clone(value)
}
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.roles || typeof input.roles !== 'object' || Array.isArray(input.roles) || !Array.isArray(input.pools) || input.pools.length > 24) fail('ORCHESTRATION_SETTINGS_INVALID')
  const roles = {}, pools = [], ids = new Set()
  for (const [id, value] of Object.entries(input.roles)) { if (!ROLES.includes(id)) fail('ROLE_UNKNOWN'); roles[id] = route(value) }
  for (const pool of input.pools) {
    if (!pool || !/^[a-z][a-z0-9-]{0,47}$/.test(pool.id) || ids.has(pool.id) || typeof pool.name !== 'string' || !pool.name.trim() || pool.name.length > 120 || typeof pool.enabled !== 'boolean' || typeof pool.failover !== 'boolean' || !Array.isArray(pool.routes) || pool.routes.length < 2 || pool.routes.length > 12) fail('ROTATION_POOL_INVALID')
    ids.add(pool.id)
    const routes = pool.routes.map(route)
    if (routes.some(row => row.provider === ROTATION_PROVIDER || row.provider !== routes[0].provider || row.reasoningEffort !== undefined) || new Set(routes.map(row => row.provider + '\0' + row.model)).size !== routes.length) fail('ROTATION_POOL_ROUTES_INVALID')
    pools.push({ id: pool.id, name: pool.name, enabled: pool.enabled, failover: pool.failover, routes })
  }
  for (const binding of Object.values(roles)) if (binding.provider === ROTATION_PROVIDER && !pools.some(pool => pool.id === binding.model && pool.enabled)) fail('ROLE_ROTATION_DISABLED')
  return { version: 1, roles, pools }
}
export async function createStore(filename) {
  let settings = { version: 1, roles: {}, pools: [] }, runtime = { cursors: {}, sessions: {} }, queue = Promise.resolve()
  try { const document = JSON.parse(await readFile(filename, 'utf8')); settings = validateSettings(document.settings); runtime = document.runtime ?? runtime; if (!runtime.cursors || !runtime.sessions || typeof runtime.sessions !== 'object' || Object.keys(runtime.sessions).length > 2048) fail('ROTATION_STATE_INVALID') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const persist = async () => { await mkdir(dirname(filename), { recursive: true }); const temporary = filename + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify({ settings, runtime }), { mode: 0o600 }); await rename(temporary, filename) }
  const mutate = action => { const result = queue.then(async () => { const oldSettings = clone(settings), oldRuntime = clone(runtime); try { const value = await action(); await persist(); return value } catch (error) { settings = oldSettings; runtime = oldRuntime; throw error } }); queue = result.catch(() => {}); return result }
  return {
    snapshot: () => clone(settings),
    save: value => mutate(() => { settings = validateSettings(value); return clone(settings) }),
    async pin(pool, sessionId) { return mutate(() => {
      const key = pool.id + ':' + sessionId, existing = runtime.sessions[key]
      if (existing) { if (!pool.routes.some(row => row.provider === existing.route.provider && row.model === existing.route.model)) fail('ROTATION_PIN_UNAVAILABLE'); return clone(existing) }
      if (Object.keys(runtime.sessions).length >= 2048) fail('ROTATION_SESSION_CAPACITY')
      const index = (Number(runtime.cursors[pool.id]) || 0) % pool.routes.length
      runtime.cursors[pool.id] = index + 1
      return clone(runtime.sessions[key] = { route: pool.routes[index], committed: false })
    }) },
    async updatePin(pool, sessionId, selected, committed) { return mutate(() => {
      const key = pool.id + ':' + sessionId, old = runtime.sessions[key]
      if (!old || old.committed && (old.route.provider !== selected.provider || old.route.model !== selected.model)) fail('ROTATION_PIN_LOCKED')
      runtime.sessions[key] = { route: clone(selected), committed: committed || old.committed }
    }) },
    forgetSession: sessionId => mutate(() => { for (const key of Object.keys(runtime.sessions)) if (key.endsWith(':' + sessionId)) delete runtime.sessions[key] }),
  }
}
