export const AIRULES_PRESET_ID = '1c-airules'
export const AIRULES_TOOL_NAMES = Object.freeze(['airules_rule', 'airules_role', 'airules_verification'])

export function resolveAirulesActivation(ctx, config = {}) {
  if (config.compositionScoped === true) {
    return Object.freeze({ mode: 'composition', isEnabled: () => true })
  }
  const service = ctx?.projectPresets ?? ctx?.get?.('projectPresets')
  if (typeof service?.featuresFor !== 'function') {
    throw new Error('AIRULES_PROJECT_PRESETS_REQUIRED')
  }
  return Object.freeze({
    mode: 'project-preset',
    isEnabled(target) {
      try { return service.featuresFor(target)?.preset === AIRULES_PRESET_ID }
      catch { return false }
    },
  })
}

export function registerProjectToolIsolation(ctx, isEnabled) {
  if (typeof ctx?.tools?.guard !== 'function' || typeof ctx?.on !== 'function') {
    throw new Error('AIRULES_PROJECT_ISOLATION_API_REQUIRED')
  }
  const guardDispose = ctx.tools.guard(exec => AIRULES_TOOL_NAMES.includes(exec?.name) && !isEnabled(exec?.agent)
    ? 'Инструмент доступен только в пресете 1c-airules.' : undefined)
  const restrictionDisposers = new WeakMap()
  const eventDispose = ctx.on('agent/created', ({ agent }) => {
    if (!agent || isEnabled(agent)) return
    const tools = agent.ctx?.tools
    if (typeof tools?.restrict !== 'function') throw new Error('AIRULES_AGENT_TOOL_RESTRICTION_REQUIRED')
    restrictionDisposers.set(agent, tools.restrict({ deny: [...AIRULES_TOOL_NAMES] }))
  })
  const disposed = () => {
    if (typeof eventDispose === 'function') eventDispose()
    if (typeof guardDispose === 'function') guardDispose()
  }
  ctx.effect?.(() => disposed)
  return disposed
}
