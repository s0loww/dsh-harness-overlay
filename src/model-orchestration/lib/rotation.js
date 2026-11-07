import { ROTATION_PROVIDER, fail } from './store.js'
const RETRY = new Set(['QUOTA_EXCEEDED','RATE_LIMIT','RATE_LIMITED','TRANSPORT','NETWORK','PROVIDER_5XX'])
export function protocolOf(adapter, provider, model) {
  if (adapter?.constructor?.name === 'CodexAdapter' && provider === 'codex') return 'openai-responses:codex'
  if (adapter?.constructor?.name === 'PiAiAdapter' && typeof adapter.current === 'function') {
    const descriptor = adapter.current().models.getModel(provider, model)
    if (typeof descriptor?.api === 'string') return descriptor.api
  }
  fail('ROTATION_PROTOCOL_UNVERIFIED')
}
export async function poolCapabilities(llm, pool, signal, protocol = protocolOf) {
  const registrations = pool.routes.map(row => llm.registration(row.provider))
  if (!registrations[0] || registrations.some(row => !row || row.adapter !== registrations[0].adapter)) fail('ROTATION_ADAPTER_MISMATCH')
  const protocols = pool.routes.map((row, index) => protocol(registrations[index].adapter, row.provider, row.model))
  if (protocols.some(value => value !== protocols[0])) fail('ROTATION_PROTOCOL_MISMATCH')
  const models = await Promise.all(pool.routes.map(row => llm.resolveModelInfo(row.provider, row.model, signal)))
  const modalities = models[0].inputModalities ?? ['text']
  if (!modalities.includes('text') || models.some(info => JSON.stringify([...(info.inputModalities ?? ['text'])].sort()) !== JSON.stringify([...modalities].sort()) || info.systemPromptUpdate !== models[0].systemPromptUpdate || info.toolUpdate !== models[0].toolUpdate)) fail('ROTATION_CAPABILITY_MISMATCH')
  const efforts = (models[0].reasoning?.efforts ?? []).filter(effort => models.every(info => info.reasoning?.efforts?.some(other => other.id === effort.id)))
  if (models.some(info => Boolean(info.reasoning) !== Boolean(models[0].reasoning))) fail('ROTATION_CAPABILITY_MISMATCH')
  if (models[0].reasoning && !efforts.length) fail('ROTATION_EFFORT_MISMATCH')
  const contextWindow = Math.min(...models.map(info => info.context?.contextWindow ?? 0))
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) fail('ROTATION_CONTEXT_UNVERIFIED')
  return { provider: ROTATION_PROVIDER, id: pool.id, name: pool.name, inputModalities: ['text'],
    context: { contextWindow, maxContextWindow: contextWindow },
    ...(efforts.length ? { reasoning: { efforts, ...(efforts.some(row => row.id === models[0].reasoning?.defaultEffort) ? { defaultEffort: models[0].reasoning.defaultEffort } : {}) } } : {}),
    ...(models.every(info => Number.isSafeInteger(info.defaultMaxTokens)) ? { defaultMaxTokens: Math.min(...models.map(info => info.defaultMaxTokens)) } : {}),
    ...(models[0].systemPromptUpdate ? { systemPromptUpdate: models[0].systemPromptUpdate } : {}),
    ...(models[0].toolUpdate ? { toolUpdate: models[0].toolUpdate } : {}),
  }
}
export function createRotationAdapter({ Base, llm, store, protocol = protocolOf }) {
  return new class extends Base {
    providerInfo() { return { id: ROTATION_PROVIDER, name: 'Ротация моделей · airules' } }
    listModels() { return Promise.resolve(store.snapshot().pools.filter(pool => pool.enabled).map(pool => ({ provider: ROTATION_PROVIDER, id: pool.id, name: pool.name }))) }
    pool(id) { const pool = store.snapshot().pools.find(row => row.id === id && row.enabled); if (!pool) fail('ROTATION_POOL_DISABLED'); return pool }
    resolveModel(_provider, id, signal) { return poolCapabilities(llm, this.pool(id), signal, protocol) }
    async *stream(options) {
      const pool = this.pool(options.model)
      await poolCapabilities(llm, pool, options.signal, protocol)
      if (!options.sessionId) fail('ROTATION_SESSION_REQUIRED')
      const sessionId = String(options.sessionId), pin = await store.pin(pool, sessionId)
      const routes = [pin.route, ...pool.routes.filter(row => row.model !== pin.route.model)]
      let emitted = false
      for (let index = 0; index < routes.length; index++) {
        const selected = routes[index]
        try {
          options.signal?.throwIfAborted()
          const registration = llm.registration(selected.provider)
          const prepared = await llm.prepareCall({ provider: selected.provider, model: selected.model, ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) }, options.signal)
          if (llm.registration(selected.provider) !== registration) fail('ROTATION_REGISTRATION_CHANGED')
          let finished = false
          const messages = options.messages?.map(message => message.role === 'assistant' && message.source?.provider === ROTATION_PROVIDER ? { ...message, source: { ...message.source, provider: selected.provider, model: selected.model } } : message)
          for await (const chunk of prepared.stream({ ...options, ...prepared.config, ...(messages ? { messages } : {}) })) {
            if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw Object.assign(new Error('ROTATION_MEMBER_FAILED'), { code: chunk.reason.failure?.code })
            if (!emitted) { await store.updatePin(pool, sessionId, selected, true); emitted = true }
            if (chunk.type === 'finish') finished = true
            yield chunk
          }
          if (!finished) fail('ROTATION_STREAM_INCOMPLETE')
          return
        } catch (error) {
          if (emitted || pin.committed || !pool.failover || options.signal?.aborted || !RETRY.has(error.code) || index === routes.length - 1) throw error
          await store.updatePin(pool, sessionId, routes[index + 1], false)
        }
      }
    }
  }()
}
