import { apply as applyEngine } from './engine.js'
import { createSecureManagerHandler, managerToolAllowed } from './security.js'

export const name = 'airules-mcp-manager'
export const inject = ['tools', 'webServer', 'connection']

export function apply(ctx) {
  if (typeof ctx.tools.guard !== 'function' || typeof ctx.extend !== 'function') throw new Error('MCP_ISOLATION_API_REQUIRED')
  let names = () => [], pendingOAuth = () => false
  ctx.tools.guard(({ name, agent }) => {
    if (!names().some(server => name.startsWith(`mcp__${server}__`))) return undefined
    return managerToolAllowed(ctx, agent) ? undefined : 'MCP Manager tools require 1c-airules, native BUILD and workspace write access.'
  })
  const server = Object.create(ctx.webServer)
  Object.defineProperties(server, {
    host: { value: '127.0.0.1' },
    register: { value: route => ctx.webServer.register({ ...route, handler: createSecureManagerHandler(route.handler, { connection: ctx.connection, allowOAuthState: state => pendingOAuth(state) }) }) },
  })
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map(level => [level, () => ctx.logger?.[level]?.('MCP Manager: состояние подключения обновлено.')]))
  return applyEngine(ctx.extend({ webServer: server, logger,
    airulesMcpBindNames: get => { names = get }, airulesMcpBindOAuthState: get => { pendingOAuth = get },
  }))
}
