import { apply as applyWorkspace, inject as workspaceInject } from './openspec-workspace.js'
import { registerOpenSpecCommands } from './openspec-commands.js'
import { openSpecEnabled } from './runtime.js'

export const name = 'openspec-workflow'
export const inject = [...workspaceInject, 'skills']

export function apply(ctx, config = {}) {
  ctx.provide('openSpecWorkflow', { enabledFor: target => openSpecEnabled(ctx, target) })
  // Canonical skills are supplied only by the embedded airules provider.
  const mounted = new WeakSet()
  const mount = agent => {
    if (!agent?.ctx || mounted.has(agent) || !openSpecEnabled(ctx, agent)) return
    mounted.add(agent)
    const fiber = agent.ctx.plugin({ name: 'openspec-agent-commands', inject: ['commands', 'skills'], apply(scope) {
      registerOpenSpecCommands(scope)
    } })
    ctx.effect(() => () => fiber.dispose())
  }
  for (const agent of ctx.agents.list?.() ?? []) mount(agent)
  ctx.on('agent/created', ({ agent }) => mount(agent))
  return applyWorkspace(ctx, config)
}

export default { name, inject, apply }
