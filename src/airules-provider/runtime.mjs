import { listRoles, listRules, readRole, readRule, roleCapabilityStatus } from './core.mjs'

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

export function createAirulesTools(rulepack, defineTool) {
  return [
    defineTool({
      name: 'airules_rule',
      description: 'Встроенные правила airules. Без id — список; с id — полный текст одного правила.',
      parameters: { id: { type: 'string', description: 'Stable rule id из списка airules_rule.' } },
      output: textOutput(),
      execute(args) {
        return { text: args?.id ? readRule(rulepack, args.id) : listRules(rulepack) }
      },
    }),
    defineTool({
      name: 'airules_role',
      description: 'Встроенный registry ролей airules. Без id — capability status и список; с id — persona для prompt subagent.',
      parameters: { id: { type: 'string', description: 'Stable role id из списка airules_role.' } },
      output: textOutput(),
      execute(args) {
        return { text: args?.id ? readRole(rulepack, args.id) : listRoles(rulepack) }
      },
    }),
  ]
}

export function registerAirulesRuntime(ctx, rulepack, { defineTool, FileSystemSkillProvider, isEnabled, activationMode = 'composition' }) {
  const capability = roleCapabilityStatus(rulepack)
  let skillProvider
  const accessNote = [
    '## Embedded rule access',
    'Apply the active project instructions, project facts and explicit local overrides ahead of overridable embedded defaults. Keep the native DSH permission policy and higher-priority user instructions authoritative.',
    'Rule IDs in this contract belong to the embedded package, not to project files.',
    'An identically named project rule file does not change this tool: read project rule references through the native file tools and resolve the project exception explicitly. Project skill definitions with the same name take precedence through native skill discovery.',
    'Load a required rule with the read-only `airules_rule` tool using its stable `id`.',
  ].join('\n')
  const roleNote = [
    '## Embedded role registry',
    `Capability status: ${capability.status}; native named-role registry: unavailable.`,
    `${capability.roleCount} verified role personas are available through the read-only \`airules_role\` tool.`,
    'Without `id`, list roles. With `id`, load the persona. If airules_delegate is available, use it for managed role execution with configured model bindings; otherwise include the persona in an ordinary subagent prompt.',
    'Do not present these personas as DSH execution providers or as complete agent presets.',
  ].join('\n')

  ctx.systemPrompt.section({
    name: 'airules:contract',
    order: 4,
    text: isEnabled ? context => isEnabled(context?.agent ?? context?.scope) ? `${rulepack.contract.trim()}\n\n${accessNote}` : ''
      : `${rulepack.contract.trim()}\n\n${accessNote}`,
  })
  ctx.systemPrompt.section({ name: 'airules:roles', order: 5,
    text: isEnabled ? context => isEnabled(context?.agent ?? context?.scope) ? roleNote : '' : roleNote })

  for (const tool of createAirulesTools(rulepack, defineTool)) ctx.tools.register(tool)

  const createProvider = (scope, control) => new FileSystemSkillProvider(scope, control, {
    providerName: 'airules-rulepack',
    includeDefaultRoots: false,
    bundledSkillDir: rulepack.skillsRoot,
  })
  if (activationMode === 'composition') {
    ctx.skills.registerProvider(control => {
      skillProvider = createProvider(ctx, control)
      return skillProvider
    })
    ctx.effect(() => () => skillProvider?.dispose())
  } else {
    if (typeof ctx.on !== 'function') throw new Error('AIRULES_PROJECT_SKILL_ISOLATION_API_REQUIRED')
    ctx.on('agent/created', ({ agent }) => {
      if (!agent || !isEnabled?.(agent) || typeof agent.ctx?.skills?.registerProvider !== 'function') return
      agent.ctx.skills.registerProvider(control => createProvider(agent.ctx, control))
    })
  }
  return capability
}
