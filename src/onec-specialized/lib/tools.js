import { defineTool } from '@deepseek-ai/dsh-tools'
export const name = 'airules-onec-specialized-tools'
export const inject = ['tools', 'systemPrompt', 'airulesOnecSpecialized']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'airules_onec_specialized',
    description: 'Хранилище конфигурации, локальное сравнение обновления/CFE-план и v8unpack через явный проектный binding. status/history/diff/plan не запускают 1С. run запускает только проверенный runner через native sandbox; изменения требуют native approval, связанного плана и отчёта. Без runner честно сообщает причину недоступности.',
    parameters: {
      action: { type: 'string', enum: ['status', 'history', 'diff', 'plan', 'run', 'result', 'cancel', 'validatePlan'], required: true },
      domain: { type: 'string', enum: ['repository', 'ai-merge', 'v8unpack'] }, operation: { type: 'string' },
      objects: { type: 'array', items: { type: 'string' } }, comment: { type: 'string' }, force: { type: 'boolean' }, confirmForce: { type: 'boolean' }, confirmDiscardChanges: { type: 'boolean' },
      planDigest: { type: 'string' }, requestId: { type: 'string' }, runId: { type: 'string' }, limit: { type: 'integer' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return ctx.airulesOnecSpecialized.act(args, exec) },
  }))
  ctx.systemPrompt.section({ name: 'airules:onec-specialized', order: 7, text: 'Для хранилища конфигурации и binary/merge операций доступен airules_onec_specialized: status → plan → run → result. saved-project-report не является live-проверкой. План без runner не означает выполнение. run требует проектного binding, машинного доверия к версии runner и native прав; изменяющие операции запрашивают native approval внутри текущего turn. AI-merge сравнивает ограниченную файловую выгрузку, не проверяет поддержку и не применяет CFE/CF. Дважды изменённые объекты требуют проверки поддержки и CFE-плана. Фасад MCP не требуется.' })
}
