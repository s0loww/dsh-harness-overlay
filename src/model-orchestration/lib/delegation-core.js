import { ROLES, fail } from './store.js'
export async function delegateRole({ service, subagents, role, task, persona, parent, inherited, signal, cwd }) {
  if (!ROLES.includes(role) || typeof task !== 'string' || !task.trim() || task.length > 64000 || !parent || typeof persona !== 'string' || !persona.trim()) fail('ROLE_DELEGATION_INVALID')
  const provider = subagents.getProvider('spawn')
  if (!provider?.capabilities?.agentOptions || !provider.capabilities.depthLimit || provider.inheritsParentContext) fail('ROLE_EXECUTION_PROVIDER_UNAVAILABLE')
  const agentOptions = await service.resolveRole(role, inherited, signal)
  signal?.throwIfAborted()
  const maxDepth = subagents.resolveMaxDepth()
  // The native durable descriptor preserves this namespace before the first
  // child step. Skill catalogue routing can resolve the exact orchestration
  // role without inferring it from a prompt or racing the activation result.
  const activation = await subagents.startActivation({ provider: 'spawn', label: `airules-role:${role}`,
    request: { parent, prompt: [{ type: 'text', text: persona + '\n\n## Задача оркестратора\n' + task }], agentOptions,
      ...(cwd === undefined ? {} : { cwd }), ...(maxDepth === undefined ? {} : { maxDepth }) }, signal, delivery: 'parent' })
  return { childId: activation.childId, role, provider: agentOptions.provider, model: agentOptions.model, ...(agentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptions.reasoningEffort }) }
}
