import { defineTool } from '@deepseek-ai/dsh-tools'
export const name = 'airules-general-tools-composition'
export const inject = ['tools', 'systemPrompt', 'airulesGeneralTools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'craft_mermaid_render',
    description: 'Отрендерить локальный Mermaid .mmd в PNG закреплённым beautiful-mermaid/resvg. Результат помещается в новый каталог внутри outDir проекта. После успеха нужна визуальная проверка PNG. Не устанавливает зависимости и не запускает произвольный код.',
    parameters: { input: { type: 'string', required: true, description: 'Файл .mmd внутри проекта.' }, outDir: { type: 'string', required: true, description: 'Каталог артефактов внутри проекта.' }, theme: { type: 'string', enum: ['craft-light', 'craft-dark'] } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => ctx.airulesGeneralTools.render(args, exec),
  }))
  ctx.systemPrompt.section({ name: 'airules:caveman-lite', order: 20, text: context => ctx.airulesGeneralTools.styleText(context?.agent ?? context?.scope) })
}
