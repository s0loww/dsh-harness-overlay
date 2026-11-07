import { defineTool } from '@deepseek-ai/dsh-tools'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import z from '@deepseek-ai/schemastery'
import { loadRulepack } from './core.mjs'
import { registerAirulesRuntime } from './runtime.mjs'
import { registerVerificationProvider } from './verification.mjs'
import { registerProjectToolIsolation, resolveAirulesActivation } from './activation.mjs'

export const name = 'airules-policy-provider'
export const inject = ['skills', 'systemPrompt', 'tools']
export const Config = z.object({
  rulepackRoot: z.string().description('Absolute path to the verified embedded airules rulepack.'),
  compositionScoped: z.boolean().default(false).description('True only inside the dedicated 1c-airules Agent preset composition.'),
})

export function apply(ctx, config) {
  const rulepack = loadRulepack(config?.rulepackRoot)
  const activation = resolveAirulesActivation(ctx, config)
  const roles = registerAirulesRuntime(ctx, rulepack, {
    defineTool, FileSystemSkillProvider, isEnabled: activation.isEnabled, activationMode: activation.mode,
  })
  const verification = registerVerificationProvider(ctx, rulepack, { defineTool, isEnabled: activation.isEnabled })
  if (activation.mode === 'project-preset') registerProjectToolIsolation(ctx, activation.isEnabled)
  return Object.freeze({
    activation: activation.mode,
    roles,
    verification,
  })
}

