import { createController, API } from './control.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'airules-dsh-memory-workspace'
export const inject = ['webServer', 'connection', 'agents', 'agentPresets', 'sandboxPolicy', 'approval', 'dshHomePath', 'tools']
export function apply(ctx) {
  const controller = createController(ctx, { configPath: ctx.dshHomePath('memory-workspace/config.json'), createUserMessage })
  ctx.provide('airulesMemory', controller)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: controller.handler }))
}
