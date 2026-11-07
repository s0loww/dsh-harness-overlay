import { isAbsolute, resolve } from 'node:path'
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const PRESETS = ['1c-airules', 'python-airules', 'sysadmin-airules']
const get = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
const fail = code => { throw new Error(code) }
export async function workflowSession(ctx, id, writing = false) {
  if (typeof id !== 'string' || !id || id.length > 256) fail('SESSION_REQUIRED')
  const projections = get(ctx, 'sessionProjections'), sandbox = get(ctx, 'sandboxPolicy')
  if (!projections || !sandbox) fail('WORKSPACE_READ_REQUIRED')
  let session = get(ctx, 'sessions')?.get(id), header = session?.header, preset, policy
  if (session) {
    preset = projections.stateOf(session, 'agentPreset') ?? header?.agentPreset
    policy = sandbox.resolve({ session })
  } else {
    const persistence = get(ctx, 'sessionPersistence'), info = await persistence?.stat(id)
    if (info?.header?.id !== id || info.eventCount > 20000 || info.sizeBytes > 32 * 1024 * 1024) fail('SESSION_UNAVAILABLE')
    const reader = await persistence.open(id, 'read')
    try {
      header = reader.header
      if (header?.id !== id) fail('SESSION_UNAVAILABLE')
      const { events } = await reader.read(0, 20001)
      if (!Array.isArray(events) || events.length > 20000) fail('SESSION_UNAVAILABLE')
      const restored = projections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0)
      const projected = restored.checkpoint?.sandboxMode
      if (!projected || (projected.val !== null && !MODES.includes(projected.val))) fail('SANDBOX_PROJECTION_REQUIRED')
      preset = restored.checkpoint?.agentPreset?.val ?? header.agentPreset
      policy = sandbox.resolve({ mode: projected.val ?? sandbox.defaultMode, session: { id, header } })
    } finally { await reader.close() }
  }
  if (header?.id !== id || !PRESETS.includes(preset) || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) fail('WORKFLOW_SESSION_REQUIRED')
  if (!MODES.includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || resolve(policy.workspaceRoot) !== resolve(header.cwd)) fail('WORKSPACE_READ_REQUIRED')
  const writable = ['workspace-write', 'danger-full-access'].includes(policy.mode)
  if (writing && !writable) fail('WORKSPACE_WRITE_REQUIRED')
  return { id, root: resolve(header.cwd), mode: policy.mode, writable, preset }
}
