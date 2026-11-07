import { isAbsolute, resolve } from 'node:path'
const MAX_EVENTS = 20000
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const get = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
/** Resolve a real native session or a bounded, pure native cold projection. */
export async function projectSession(ctx, id, writing = false) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('SESSION_REQUIRED')
  const projections = get(ctx, 'sessionProjections'), sandbox = get(ctx, 'sandboxPolicy')
  if (!projections || !sandbox) throw new Error('WORKSPACE_READ_REQUIRED')
  let session = get(ctx, 'sessions').get(id), header = session?.header, preset, policy
  if (session) {
    preset = projections.stateOf(session, 'agentPreset') ?? header.agentPreset
    policy = sandbox.resolve({ session })
  } else {
    const persistence = get(ctx, 'sessionPersistence'), info = await persistence.stat(id)
    if (info?.header?.id !== id) throw new Error('SESSION_INVALID')
    if (info?.eventCount > MAX_EVENTS || info?.sizeBytes > 32 * 1024 * 1024) throw new Error('SESSION_TOO_LARGE')
    const reader = await persistence.open(id, 'read')
    try {
      header = reader.header
      if (!header || header.id !== id) throw new Error('SESSION_INVALID')
      const { events } = await reader.read(0, MAX_EVENTS + 1)
      if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error('SESSION_TOO_LARGE')
      const result = projections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0)
      const row = result.checkpoint?.sandboxMode
      // A missing projection is capability absence, not permission to assume a
      // writable deployment default. Null is the native registered no-override state.
      if (!row || (row.val !== null && !MODES.includes(row.val))) throw new Error('SANDBOX_PROJECTION_REQUIRED')
      const mode = row.val ?? sandbox.defaultMode
      if (!MODES.includes(mode)) throw new Error('SANDBOX_PROJECTION_REQUIRED')
      preset = result.checkpoint?.agentPreset?.val ?? header.agentPreset
      policy = sandbox.resolve({ mode, session: { id, header } })
    } finally { await reader.close() }
  }
  if (header?.id !== id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || preset !== '1c-airules') throw new Error('ONEC_SESSION_REQUIRED')
  if (!MODES.includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || resolve(policy.workspaceRoot) !== resolve(header.cwd)) throw new Error('WORKSPACE_READ_REQUIRED')
  const writable = ['workspace-write', 'danger-full-access'].includes(policy.mode)
  if (writing && !writable) throw new Error('WORKSPACE_WRITE_REQUIRED')
  return { root: resolve(header.cwd), writable, mode: policy.mode }
}
