import { ROLES, ROTATION_PROVIDER, validateSettings, fail } from './store.js'
import { poolCapabilities } from './rotation.js'
export function createOrchestrationService({ store, llm, rotationRegistration }) {
  return {
    snapshot: () => store.snapshot(),
    async save(input, signal) {
      const value = validateSettings(input)
      for (const pool of value.pools) if (pool.enabled) await poolCapabilities(llm, pool, signal)
      for (const binding of Object.values(value.roles)) {
        if (binding.provider === ROTATION_PROVIDER) {
          const info = await poolCapabilities(llm, value.pools.find(pool => pool.id === binding.model), signal)
          if (binding.reasoningEffort !== undefined && !info.reasoning?.efforts.some(row => row.id === binding.reasoningEffort)) fail('ROLE_EFFORT_UNSUPPORTED')
        } else await llm.resolveCallConfig(binding, signal)
      }
      const result = await store.save(value); rotationRegistration?.replace([ROTATION_PROVIDER]); return result
    },
    async catalog(signal) {
      const result = []
      for (const provider of llm.listProviders()) {
        try {
          const rows = await llm.listModels(provider.id)
          for (const model of rows) {
            try { const info = await llm.resolveModelInfo(provider.id, model.id, signal); result.push({ provider: provider.id, providerName: provider.name, model: model.id, name: model.name, efforts: info.reasoning?.efforts ?? [] }) } catch { /* stale/unavailable catalog entry */ }
          }
        } catch { /* an unavailable provider does not hide other catalogs */ }
      }
      return result
    },
    async resolveRole(role, inherited, signal) {
      if (!ROLES.includes(role)) fail('ROLE_UNKNOWN')
      const mapping = store.snapshot().roles[role]
      if (!mapping && (!inherited?.provider || !inherited?.model)) fail('ROLE_MODEL_UNCONFIGURED')
      const source = mapping ?? { provider: inherited.provider, model: inherited.model, ...(inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort }) }
      const resolved = await llm.resolveCallConfig(source, signal)
      return { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
    },
  }
}
