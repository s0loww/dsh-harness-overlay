import { isAbsolute, resolve } from 'node:path'
const get = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
const modes = ['read-only', 'workspace-write', 'danger-full-access']
export async function sessionScope(ctx, id) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('SESSION_REQUIRED')
  const projections = get(ctx, 'sessionProjections'), policyService = get(ctx, 'sandboxPolicy')
  let session = get(ctx, 'sessions')?.get(id), header = session?.header, policy, restoredPreset
  if (session) policy = policyService.resolve({ session })
  else {
    const persistence = get(ctx, 'sessionPersistence'), info = await persistence.stat(id)
    if (info?.header?.id !== id || info.eventCount > 20000 || info.sizeBytes > 32 * 1024 * 1024) throw new Error('SESSION_REQUIRED')
    const reader = await persistence.open(id, 'read')
    try {
      header = reader.header
      const { events } = await reader.read(0, 20001)
      if (!Array.isArray(events) || events.length > 20000 || header.id !== id) throw new Error('SESSION_REQUIRED')
      const state = projections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0).checkpoint
      restoredPreset = state?.agentPreset?.val
      const mode = state?.sandboxMode?.val
      if (mode !== null && !modes.includes(mode)) throw new Error('SESSION_REQUIRED')
      policy = policyService.resolve({ mode: mode ?? policyService.defaultMode, session: { id, header } })
    } finally { await reader.close() }
  }
  if (header?.id !== id || !isAbsolute(header.cwd ?? '') || !modes.includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || resolve(policy.workspaceRoot) !== resolve(header.cwd)) throw new Error('SESSION_REQUIRED')
  const preset = session ? projections.stateOf(session, 'agentPreset') ?? header.agentPreset : restoredPreset ?? header.agentPreset
  return { id, root: resolve(header.cwd), mode: policy.mode, writable: policy.mode !== 'read-only', session, preset, origin: header.origin ?? (header.parentSession ? 'subagent' : 'lead') }
}
