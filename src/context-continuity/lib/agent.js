import { defineTool } from '@deepseek-ai/dsh-tools'
export const name = 'airules-continuity-agent'
export const inject = ['tools', 'airulesContinuity']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'airules_continuity',
    description: 'Проверить механическое восстановление текущего сеанса после compact. status — метаданные; mark — отметить до двух уже прочитанных файлов задачи для свежего восстановления в opt-in режиме; checkpoint — обновить механические Git-метаданные через штатную песочницу. Не пишет память, handoff или карту и не меняет права.',
    parameters: { action: { type: 'string', enum: ['status', 'mark', 'checkpoint'] }, paths: { type: 'array', items: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return ctx.airulesContinuity.act(args, exec) },
  }))
}
