import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { contract, listRules, readRule, skillsRoot, sharedSkillsRoot } from './core.mjs'
export const name = 'airules-domain-policy'
export const inject = ['systemPrompt', 'tools', 'skills', 'fs']
export const Config = z.object({ domain: z.union(['python', 'sysadmin']).required(), sharedSkills: z.boolean().default(false) })
export function apply(ctx, { domain, sharedSkills = false }) {
  ctx.systemPrompt.section({ name: `airules:domain:${domain}`, order: 4, text: contract(domain) })
  ctx.tools.register(defineTool({
    name: 'domain_rule', description: 'Встроенные предметные правила текущего пресета: без id — индекс, с id — одно правило.',
    parameters: { id: { type: 'string', description: 'Точный id из индекса domain_rule.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: args => ({ text: args?.id ? readRule(domain, args.id) : listRules(domain) }),
  }))
  const providers = []
  for (const [providerName, root] of [[`airules-${domain}`, skillsRoot(domain)], ...(sharedSkills ? [[`airules-${domain}-shared`, sharedSkillsRoot()]] : [])]) {
    ctx.skills.registerProvider(control => {
      const provider = new FileSystemSkillProvider(ctx, control, { providerName, includeDefaultRoots: false, bundledSkillDir: root, watch: false })
      providers.push(provider)
      return provider
    })
  }
  ctx.effect(() => () => { for (const provider of providers) void provider.dispose() })
}
