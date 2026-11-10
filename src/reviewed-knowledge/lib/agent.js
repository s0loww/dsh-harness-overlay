import { defineTool } from '@deepseek-ai/dsh-tools'
export const name = 'airules-reviewed-knowledge-agent'
export const inject = ['tools', 'airulesKnowledge']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'airules_knowledge',
    description: 'Кандидаты проверенных уроков текущего чата: list/create/read/review/approve/stale/supersede/plan/publish. create — draft; review — источник, применимость и секреты. approve требует отдельное реальное сообщение пользователя с выданной revision-bound строкой; модель сама себя не одобряет. plan возвращает memoryConfigRevision. publish доступен только для одобренного урока в Cognee, с expectedMemoryRevision и штатным подтверждением airules_memory; uploaded не означает индекс. Memoria/airules — только предпросмотр, без автоматического переноса или правки правил. После перезапуска кандидат нужно восстановить из старого tool-result и проверить заново. Субагенты передают кандидатов оркестратору.',
    parameters: { action: { type: 'string', enum: ['list', 'create', 'read', 'review', 'approve', 'stale', 'supersede', 'plan', 'publish'] }, proposal: { type: 'object', additionalProperties: true }, id: { type: 'string' }, expectedRevision: { type: 'string' }, findings: { type: 'string' }, evidenceVerified: { type: 'boolean' }, applicabilityVerified: { type: 'boolean' }, secretsChecked: { type: 'boolean' }, why: { type: 'string' }, supersededBy: { type: 'string' }, destination: { type: 'string', enum: ['cognee', 'memoria', 'airules'] }, targetPath: { type: 'string' }, expectedTargetRevision: { type: 'string' }, expectedMemoryRevision: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return ctx.airulesKnowledge.act(args, exec) },
  }))
}
