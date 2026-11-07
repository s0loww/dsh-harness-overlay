import { defineTool } from '@deepseek-ai/dsh-tools'
import { workflowSession } from './session.js'
export const name = 'airules-workflow-tools'
export const inject = ['tools', 'systemPrompt', 'airulesWorkflows', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy']
export async function runTool(ctx, action, args, exec) {
  if (!exec?.agent?.session?.id) throw new Error('ACTIVE_AGENT_REQUIRED')
  const scope = await workflowSession(ctx, exec.agent.session.id, ['plan', 'run', 'recover'].includes(action))
  if (action === 'status') return ctx.airulesWorkflows.status(scope)
  if (action === 'plan') return ctx.airulesWorkflows.plan(scope, args.workflowId, { agent: exec.agent, token: exec.token, rootCallId: exec.rootCallId, signal: exec.signal, callId: exec.callId })
  if (action === 'result') return ctx.airulesWorkflows.result(scope, args.runId)
  if (action === 'cancel') return ctx.airulesWorkflows.cancel(scope, args.runId)
  if (action === 'run') return ctx.airulesWorkflows.run(scope, args, { agent: exec.agent, token: exec.token, rootCallId: exec.rootCallId, signal: exec.signal, callId: exec.callId })
  if (action === 'recover') return ctx.airulesWorkflows.recover(scope, args, { agent: exec.agent, token: exec.token, rootCallId: exec.rootCallId, signal: exec.signal, callId: exec.callId })
  throw new Error('ACTION_REJECTED')
}
export function apply(ctx) {
  const text = key => ({ type: 'string', required: true, description: key })
  const definitions = [
    ['status', {}, 'Прочитать настроенные workflow и ограничения. Не запускает платформу, базы или проверки.'],
    ['plan', { workflowId: text('ID зарегистрированного workflow') }, 'Сформировать и сохранить план проверок по проектному binding. Процессы не запускаются.'],
    ['run', { planId: text('ID сохранённого плана'), planDigest: text('Digest сохранённого плана'), requestId: text('Уникальный ID запроса') }, 'Выполнить сохранённый план через штатные права и sandbox DSH. По умолчанию разрешены doctor/analyze и встроенная заглушка deploy-apply без 1С и баз. Реальный deploy-apply требует отдельного машинного режима enabled, проверенной версии runner и связанной цели.'],
    ['result', { runId: text('ID прогона') }, 'Прочитать результат принадлежащего этому сеансу прогона.'],
    ['cancel', { runId: text('ID собственного активного прогона') }, 'Запросить отмену собственного прогона; отмена не является откатом.'],
    ['recover', { runId: text('ID прерванного прогона'), targetId: text('ID его цели'), providerId: text('ID проверенного recovery provider из result.recoveryOptions'), requestId: text('Уникальный ID запроса восстановления') }, 'Восстановить или сверить состояние цели через проверенный provider. Подтверждает остановку исполнителя, сохраняет связанное доказательство и только затем снимает принадлежащую прогону блокировку. В fixture-only доступно восстановление только тестового маркера заглушки. Реальное восстановление требует явно настроенного машинного provider, режима enabled и поручения пользователя.'],
  ]
  for (const [action, parameters, description] of definitions) ctx.tools.register(defineTool({ name: `airules_workflow_${action}`, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return runTool(ctx, action, args, exec) } }))
  ctx.systemPrompt.section({ name: 'airules:workflow-execution', order: 7,
    text: 'Для зарегистрированных сценариев используй airules_workflow_status, затем plan/run/result. Выполнение сохраняет текущие native sandbox и approvals. Сверяй execution.deployMode: fixture-only разрешает deploy-apply ТОЛЬКО исполнителя deploy-fixture (запись тестового маркера, без 1С/баз). Реальное применение допускается только в отдельно настроенном режиме enabled и при явном поручении пользователя выполнить деплой; настройка и планирование не означают разрешения запустить его. Unit/UI с изменением базы, serve/stop пока не включены. Не обходи ограничения прямым вызовом runner. Фасад MCP не требуется. PASS требует связанного отчёта применения; это технический результат обновления, не функциональная приёмка.' })
}
