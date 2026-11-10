import { randomUUID } from 'node:crypto'

export function modelRouteId(route) {
  if (!route || typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model || (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort))) throw new Error('SKILL_EVAL_MODEL_REQUIRED')
  return JSON.stringify({ provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) })
}

async function nativeModules() {
  const metadata = await import('@deepseek-ai/dsh-agent-loop/package.json', { with: { type: 'json' } })
  if (metadata.default.version !== '0.2.2-rc.1') throw new Error('SKILL_EVAL_NATIVE_VERSION_UNSUPPORTED')
  const [cordis, sessions, projections, agents, loop, prompt, llm, tools, executor] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-tool-executor-native'),
  ])
  return { ...cordis, ...sessions, ...projections, ...agents, ...loop, ...prompt, ...llm, ...tools, NativeToolExecutor: executor.NativeToolExecutor }
}

/**
 * Actual native 0.2.2 session host. Entire Cordis tree is new for each case.
 * Authenticated provider adapter is borrowed; no credentials/profile are copied.
 * No filesystem, shell, MCP, native skill discovery or persistence service exists.
 */
export function createNativeSessionFactory({ sourceLlm, route, verifyScope, onCase } = {}) {
  const selectedId = modelRouteId(route)
  if (!sourceLlm || typeof sourceLlm.registration !== 'function' || typeof verifyScope !== 'function') throw new Error('SKILL_EVAL_NATIVE_FACTORY_REQUIRED')
  const registration = sourceLlm.registration(route.provider)
  const verify = () => { verifyScope(); if (sourceLlm.registration(route.provider).adapter !== registration.adapter) throw new Error('SKILL_EVAL_PROVIDER_CHANGED') }
  return async request => {
    verify(); request.signal.throwIfAborted()
    if (request.modelId !== selectedId || Object.values(request.inherit).some(Boolean)) throw new Error('SKILL_EVAL_NATIVE_ISOLATION_REQUIRED')
    const sdk = await nativeModules(); verify(); request.signal.throwIfAborted()
    const context = new sdk.Context(), handles = []
    let handle, finalText = '', stopReason = null, requests = 0, streamedBytes = 0, chunks = 0, disposed = false, nativeAgent, effectiveEffort, rejectedTool = false
    const mount = async (name, inject, apply) => {
      const plugin = context.plugin({ name, inject, apply(scope) { apply(scope) } }); handles.push(plugin); await plugin.await()
      if (plugin.state !== 2) throw new Error('SKILL_EVAL_NATIVE_HOST_FAILED')
      verify(); request.signal.throwIfAborted()
    }
    const cleanup = async () => {
      if (disposed) return
      disposed = true
      try { if (handle) await handle.dispose() }
      finally { await context.fiber.dispose() }
    }
    try {
      await mount('eval-sessions', [], scope => new sdk.SessionStore(scope))
      await mount('eval-projections', [], scope => new sdk.SessionProjectionRegistry(scope))
      const agentsPlugin = context.plugin(sdk.AgentRegistry); handles.push(agentsPlugin); await agentsPlugin.await()
      if (agentsPlugin.state !== 2) throw new Error('SKILL_EVAL_NATIVE_HOST_FAILED')
      await mount('eval-prompt', [], scope => new sdk.SystemPrompt(scope, { includeHarnessIdentity: false, includeRuntimeContext: false }))
      await mount('eval-llm', [], scope => new sdk.LlmRuntime(scope))
      await mount('eval-tools', ['systemPrompt'], scope => new sdk.ToolsService(scope))
      await mount('eval-native-executor', ['tools'], scope => scope.tools.setExecutor(new sdk.NativeToolExecutor(scope, () => 1)))
      await mount('eval-provider', ['llm'], scope => {
        scope.llm.registerAdapter([route.provider], registration.adapter)
        scope.on('llm/stream', (options, next) => {
          verify(); request.signal.throwIfAborted()
          if (options.provider !== route.provider || options.model !== route.model || (route.reasoningEffort !== undefined && options.reasoningEffort !== route.reasoningEffort) || requests >= 8) throw new Error('SKILL_EVAL_MODEL_REQUEST_BUDGET')
          requests++
          if (requests === 1) effectiveEffort = options.reasoningEffort
          else if (options.reasoningEffort !== effectiveEffort) throw new Error('SKILL_EVAL_MODEL_CHANGED')
          const stream = next()
          return (async function* () {
            for await (const chunk of stream) {
              verify(); request.signal.throwIfAborted()
              if (++chunks > 4096 || (streamedBytes += Buffer.byteLength(JSON.stringify(chunk))) > 512 * 1024) throw new Error('SKILL_EVAL_MODEL_OUTPUT_BUDGET')
              yield chunk
            }
          })()
        })
      })
      const loopPlugin = context.plugin(sdk.AgentLoop, { agents: [], maxParallelToolCalls: 1 }); handles.push(loopPlugin); await loopPlugin.await()
      if (loopPlugin.state !== 2) throw new Error('SKILL_EVAL_NATIVE_HOST_FAILED')
      verify(); request.signal.throwIfAborted()
      context.on('session/event', (_session, event) => {
        if (event.type === 'assistant/message') {
          const blocks = event.data.message?.content ?? []
          if (!blocks.some(block => block.type === 'tool-call')) finalText = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
        }
        if (event.type === 'turn/end') stopReason = event.data.reason?.kind ?? null
      })
      context.on('tools/result', execution => { if (!['eval_fixture_read', 'eval_fixture_write', 'eval_skill_read'].includes(execution.name)) rejectedTool = true }, { global: true })
      handle = await context.agents.create({
        sessionId: `skill-eval-${randomUUID()}`, agentOptions: { ...route, maxTokens: 4096 }, signal: request.signal,
        setup(scope, agent) {
          nativeAgent = agent
          scope.tools.restrict({ allow: [] })
          for (const [name, tool, parameters] of [
            ['eval_fixture_read', request.tools.read, { path: { type: 'string', required: true } }],
            ['eval_fixture_write', request.tools.write, { path: { type: 'string', required: true }, text: { type: 'string', required: true } }],
            ['eval_skill_read', request.tools.readSkill, { path: { type: 'string', required: true } }],
          ]) scope.tools.register(sdk.defineTool({ name, description: name === 'eval_skill_read' ? 'Read this variant skill SKILL.md or an explicit relative skill resource. No other skill exists.' : 'Read/write a synthetic in-memory fixture only; absolute paths and host files are forbidden.', parameters,
            output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute(args, execution) {
              verify(); request.signal.throwIfAborted(); execution.signal?.throwIfAborted()
              if (execution.agent !== agent || context.agents.get(agent.id) !== agent) throw new Error('SKILL_EVAL_NATIVE_SCOPE_REQUIRED')
              const result = name === 'eval_fixture_write' ? tool(args.path, args.text) : tool(args.path)
              return typeof result === 'string' ? { text: result } : result
            },
          }))
          scope.systemPrompt.section({ name: 'eval:fixture-policy', order: 1, text: `You are completing a controlled skill evaluation. All tools operate only on synthetic memory fixtures. No shell, filesystem, MCP, network tools or delegation exist. Do the task; don't read a skill for an unrelated task. Use eval_skill_read(path="SKILL.md") when its description applies. Available fixture paths: ${JSON.stringify(request.fixturePaths)}. Available skill catalog: ${JSON.stringify(request.skillCatalog)}.` })
          agent.model.select(route)
        },
      })
      verify(); request.signal.throwIfAborted()
      onCase?.({ context, agent: nativeAgent, session: nativeAgent.session })
      return {
        async run({ signal }) {
          const cancel = () => nativeAgent.cancel({ kind: 'user' })
          signal.addEventListener('abort', cancel, { once: true })
          try {
            verify(); signal.throwIfAborted()
            nativeAgent.followup(sdk.createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'user' } }))
            await nativeAgent.whenIdle(); verify(); signal.throwIfAborted()
            if (stopReason !== 'completed') throw new Error('SKILL_EVAL_NATIVE_RUN_FAILED')
            if (rejectedTool) throw new Error('SKILL_EVAL_NATIVE_TOOL_REJECTED')
            return { finalText, modelRequests: requests }
          } finally { signal.removeEventListener('abort', cancel) }
        },
        async cancel() { nativeAgent.cancel({ kind: 'user' }); await nativeAgent.whenIdle() },
        metrics: () => ({ modelRequests: requests }),
        dispose: cleanup,
      }
    } catch (error) { await cleanup(); throw error }
  }
}
