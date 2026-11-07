import { isAbsolute, resolve } from 'node:path'
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const PRESETS = ['1c-airules', 'python-airules', 'sysadmin-airules']
const get = (ctx, key) => typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
export async function documentSession(ctx, id, write = false) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('SESSION_REQUIRED')
  const projections = get(ctx, 'sessionProjections'), sandbox = get(ctx, 'sandboxPolicy')
  let session = get(ctx, 'sessions').get(id), header = session?.header, policy, preset
  if (session) { preset = projections.stateOf(session, 'agentPreset') ?? header.agentPreset; policy = sandbox.resolve({ session }) }
  else {
    const persistence = get(ctx, 'sessionPersistence'), info = await persistence.stat(id)
    if (info?.header?.id !== id || info.eventCount > 20000 || info.sizeBytes > 32 * 1024 * 1024) throw new Error('SESSION_REQUIRED')
    const reader = await persistence.open(id, 'read')
    try {
      header = reader.header; const { events } = await reader.read(0, 20001)
      if (header?.id !== id || !Array.isArray(events) || events.length > 20000) throw new Error('SESSION_REQUIRED')
      const checkpoint = projections.restore({}, events, 0, header, reader.inheritedEventCount ?? header.inheritedEventCount ?? 0).checkpoint
      const row = checkpoint?.sandboxMode
      if (!row || (row.val !== null && !MODES.includes(row.val))) throw new Error('SESSION_REQUIRED')
      preset = checkpoint?.agentPreset?.val ?? header.agentPreset
      policy = sandbox.resolve({ mode: row.val ?? sandbox.defaultMode, session: { id, header } })
    } finally { await reader.close() }
  }
  if (!PRESETS.includes(preset) || header?.id !== id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || !MODES.includes(policy?.mode) || resolve(policy.workspaceRoot) !== resolve(header.cwd)) throw new Error('DOCUMENT_SESSION_REQUIRED')
  const writable = policy.mode !== 'read-only'
  if (write && !writable) throw new Error('WORKSPACE_WRITE_REQUIRED')
  return { id, root: resolve(header.cwd), mode: policy.mode, writable, session, preset }
}
