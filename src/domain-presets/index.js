import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import z from '@deepseek-ai/schemastery'
import { createPresets } from './composition.mjs'
export const name = 'airules-domain-presets'
export const inject = ['agentPresets']
export const Config = z.object({ python: z.boolean().default(true), sysadmin: z.boolean().default(true), workflows: z.boolean().default(false), sharedSkills: z.boolean().default(false), generalTools: z.boolean().default(false), documents: z.boolean().default(false) })
export function apply(ctx, config = {}) {
  for (const preset of createPresets(config)) ctx.plugin(AgentPreset, preset)
}
