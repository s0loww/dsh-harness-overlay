import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { loadRulepack, readRole } from 'airules-dsh-provider/core'
import { delegateRole } from './delegation-core.js'
import { ROLES } from './store.js'
export const name = 'airules-role-delegation'
export const inject = ['tools','subagents','systemPrompt','airulesModelOrchestration']
export const Config = z.object({ rulepackRoot: z.string().required() })
export function apply(ctx, config) {
  const rulepack = loadRulepack(config.rulepackRoot)
  if (ROLES.some(id => !rulepack.roles.has(id)) || rulepack.roles.size !== ROLES.length) throw new Error('ORCHESTRATION_ROLEPACK_MISMATCH')
  ctx.tools.register(defineTool({ name: 'airules_delegate',
    description: 'Запустить отдельного 1С-субагента по роли из airules. Настроенные модель и reasoning применяются исполнителем; если роль не настроена, наследуется текущая модель родителя. Возвращает childId; результат доставляет штатный runtime.',
    parameters: { role: { type: 'string', enum: [...ROLES], required: true }, task: { type: 'string', required: true }, cwd: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return delegateRole({ service: ctx.airulesModelOrchestration, subagents: ctx.subagents, role: args.role, task: args.task, cwd: args.cwd,
      persona: readRole(rulepack, args.role), parent: exec.agent, inherited: exec.agent ? parentAgentOptionsForDelegation(exec.agent) : undefined, signal: exec.signal }) },
  }))
  ctx.systemPrompt.section({ name: 'airules:managed-delegation', order: 6, text: 'Для управляемого делегирования 13 ролям 1С используй airules_delegate(role, task). Этот инструмент загружает проверенную persona и запускает native spawn с настроенной моделью/effort. airules_role остаётся справочником persona; один текст роли не меняет модель. Незаданные привязки наследуют текущую модель. Права и глубину контролирует штатный runtime.' })
}
