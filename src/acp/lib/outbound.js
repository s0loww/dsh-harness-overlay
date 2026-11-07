import { existsSync, lstatSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

const SHELLS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'bash.exe', 'sh', 'sh.exe', 'npx', 'npx.cmd', 'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd'])

/** Only an explicitly installed executable: never interpolate a command line. */
export function resolveBundledAcpAgents(agents = {}) {
  return Object.fromEntries(Object.entries(agents).map(([id, config]) => {
    if (!config || typeof config.command !== 'string' || !isAbsolute(config.command) || /[\u0000-\u001f\u007f]/u.test(config.command)) throw new Error('ACP_EXECUTABLE_ABSOLUTE_REQUIRED')
    if (SHELLS.has(basename(config.command).toLowerCase()) || !existsSync(config.command) || !lstatSync(config.command).isFile() || lstatSync(config.command).isSymbolicLink()) throw new Error('ACP_EXECUTABLE_REJECTED')
    if (!Array.isArray(config.args ?? []) || !(config.args ?? []).every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('ACP_ARGUMENTS_INVALID')
    return [id, { ...structuredClone(config), args: [...(config.args ?? [])],
      env: { ...(config.env ?? {}), OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' } }]
  }))
}

const optional = (ctx, name) => { try { return ctx?.get?.(name) ?? ctx?.[name] } catch { return undefined } }

export function outboundAllowed(agent, ctx = agent?.ctx) {
  if (!agent?.session || agent.session.header?.agentPreset !== '1c-airules') return false
  const scope = agent.ctx ?? ctx
  const plan = optional(scope, 'planMode') ?? optional(ctx, 'planMode')
  let active
  if (typeof plan?.get === 'function') {
    const state = plan.get(agent)
    active = state?.pending ?? state?.active
  } else {
    const projections = optional(scope, 'sessionProjections') ?? optional(ctx, 'sessionProjections')
    const state = projections?.stateOf?.(agent.session, 'plan')
    active = state?.running?.wanted ?? state?.wanted ?? state?.active
  }
  if (active !== false) return false
  const sandbox = optional(scope, 'sandboxPolicy') ?? optional(ctx, 'sandboxPolicy')
  // ACP executors cannot enforce the parent process filesystem sandbox.
  return sandbox?.resolve?.({ session: agent.session })?.mode === 'danger-full-access'
}

export function installOutboundPolicy(ctx) {
  ctx.on('dsh-acp/permission-policy', (request, next) => {
    if (request.signal?.aborted) return 'cancelled'
    return outboundAllowed(request.agent, ctx) ? next() : 'deny-once'
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next()
    if (request?.provider?.startsWith('acp-') && !outboundAllowed(agent, ctx)) throw new Error('ACP_BUILD_NATIVE_ACCESS_REQUIRED')
    return request
  }, { prepend: true })
}
