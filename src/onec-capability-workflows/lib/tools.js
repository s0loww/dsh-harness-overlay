import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { CATEGORIES, discoverCapabilities } from './core.js'
export const name = 'airules-onec-capability-tools'
export const inject = ['tools', 'systemPrompt', 'airulesOnecCapabilities', 'sandboxPolicy', 'agentPresets']
export function sessionScope(ctx, exec) {
  const agent = exec?.agent, session = agent?.session
  if (!session?.header?.cwd || typeof session.header.cwd !== 'string' || !isAbsolute(session.header.cwd) || ctx.agentPresets.composedPreset(agent.ctx) !== '1c-airules') throw new Error('ONEC_ACTIVE_SESSION_REQUIRED')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || resolve(policy.workspaceRoot) !== resolve(session.header.cwd)) throw new Error('ONEC_SCOPE_REJECTED')
  exec.signal?.throwIfAborted()
  return { root: session.header.cwd }
}
export async function runAction(ctx, args, exec) {
  const scope = sessionScope(ctx, exec), store = ctx.airulesOnecCapabilities.investigations
  if (args.action === 'list') return store.list(scope.root)
  if (args.action === 'open') return store.open(scope.root, args)
  if (args.action === 'status') return store.status(scope.root, args.caseId)
  if (args.action === 'evidence') return store.evidence(scope.root, args)
  if (args.action === 'close') return store.close(scope.root, args)
  throw new Error('INVESTIGATION_ACTION_INVALID')
}
export function apply(ctx) {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  ctx.tools.register(defineTool({ name: 'airules_capabilities',
    description: 'Найти фактически видимые этому агенту определения инструментов по задаче 1С. Возвращает реальные схемы и кандидаты, не выполняет MCP, health probe, подключение или команды.',
    parameters: { category: { type: 'string', enum: Object.keys(CATEGORIES) }, query: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } }, output,
    execute(args, exec) { sessionScope(ctx, exec); return discoverCapabilities(ctx.tools.schemas(exec.agent), args) },
  }))
  ctx.tools.register(defineTool({ name: 'airules_debug_case',
    description: 'Локальная проектная запись расследования 1С: list/open/status/evidence/close, гипотезы и хеши выбранных source/report файлов. Это notebook: не правит BSL, не ставит пробы, не запускает ИБ/ЖР/MCP/deploy и не удостоверяет вывод модели. Изменения записи требуют expectedRevision из status.',
    parameters: { action: { type: 'string', enum: ['list', 'open', 'status', 'evidence', 'close'], required: true }, caseId: { type: 'string' }, title: { type: 'string' }, hypotheses: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } }, expectedRevision: { type: 'string' }, kind: { type: 'string', enum: ['proposal', 'observation', 'report', 'cleanup'] }, text: { type: 'string' }, outcome: { type: 'string', enum: ['reported-resolved', 'unresolved', 'abandoned'] } }, output,
    execute(args, exec) { return runAction(ctx, args, exec) },
  }))
  ctx.systemPrompt.section({ name: 'airules:onec-capability-workflows', order: 7,
    text: 'Для неизвестной возможности 1С доступен airules_capabilities: это определения текущего scoped каталога, не проверка доступности backend. Фасад и прямые MCP равноправны; используй живую схему и проверенную область проекта. Для runtime-расследования airules_debug_case хранит гипотезы/хеши и отмечает stale; он не выполняет instrumentation, проверку ИБ, Apply или cleanup. Полные процедуры загружай через соответствующий skill.' })
}
