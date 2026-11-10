/**
 * Lifecycle adapter for a trusted host's isolated native session factory.
 * This is not an OS sandbox and does not discover or launch a headless CLI.
 * No factory is installed by default; the caller must bind the native runtime.
 */
export function createNativeSessionRunner({ modelId, openSession, verifyScope }) {
  if (typeof modelId !== 'string' || !modelId || typeof openSession !== 'function' || typeof verifyScope !== 'function') throw new Error('SKILL_EVAL_NATIVE_FACTORY_REQUIRED')
  let active = null, opening = false, modelRequests = null
  return Object.freeze({
    kind: 'model', modelId,
    async execute({ task, variant, tools, limits, signal }) {
      if (active || opening) throw new Error('SKILL_EVAL_BUSY')
      verifyScope(); signal.throwIfAborted(); opening = true; modelRequests = null
      let session
      const guarded = Object.freeze(Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, (...args) => { verifyScope(); signal.throwIfAborted(); return tool(...args) }])))
      try {
        session = await openSession(Object.freeze({
          purpose: 'airules-skill-evaluation', modelId,
          prompt: task.prompt, fixturePaths: task.fixturePaths ?? [], skillCatalog: variant.name ? Object.freeze([{ name: variant.name, description: variant.description, revision: variant.revision }]) : Object.freeze([]),
          tools: guarded, limits, signal,
          inherit: Object.freeze({ conversation: false, project: false, filesystem: false, shell: false, mcp: false, skills: false, plugins: false, environment: false, profile: false }),
        }))
        opening = false
        if (!session || typeof session.run !== 'function' || typeof session.cancel !== 'function' || typeof session.dispose !== 'function') throw new Error('SKILL_EVAL_NATIVE_SESSION_INVALID')
        active = session
        verifyScope(); signal.throwIfAborted()
        const result = await session.run({ signal })
        verifyScope(); signal.throwIfAborted()
        // Do not pass through provider exceptions, reasoning, token bodies or traces.
        modelRequests = Number.isSafeInteger(result?.modelRequests) ? result.modelRequests : null
        return { finalText: typeof result?.finalText === 'string' ? result.finalText : '', modelRequests }
      } finally {
        opening = false
        try {
          if (typeof session?.metrics === 'function') { try { modelRequests = session.metrics()?.modelRequests ?? modelRequests } catch { modelRequests = null } }
          if (session) {
            try { if (signal.aborted && typeof session.cancel === 'function') await session.cancel() }
            finally { if (typeof session.dispose === 'function') await session.dispose() }
          }
        } finally { if (active === session) active = null }
      }
    },
    async cancel() {
      // The factory receives the same signal during opening and must abort there.
      if (active) await active.cancel()
    },
    metrics: () => ({ modelRequests }),
  })
}
