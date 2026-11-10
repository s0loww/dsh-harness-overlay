import { defineTool } from '@deepseek-ai/dsh-tools'
import { planEvaluation, runEvaluation, renderEvaluationReport } from './core.js'
import { createDeclarativeFixtureRunner } from './fixture-runner.js'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createNativeSessionFactory, modelRouteId } from './native-factory.js'
import { createNativeSessionRunner } from './model-runner.js'

export const name = 'airules-skill-evaluation-agent'
export const inject = ['tools', 'systemPrompt', 'agents', 'agentPresets', 'sandboxPolicy', 'llm', 'sessionQuery', 'approval']
const presets = ['1c-airules', 'python-airules', 'sysadmin-airules']
export function evaluationScope(ctx, exec) {
  if (exec?.signal?.aborted) throw new Error('SKILL_EVAL_CANCELLED')
  const agent = exec?.agent, session = agent?.session, id = session?.id
  if (!agent || typeof id !== 'string' || ctx.agents.get(id) !== agent || session.header?.id !== id || !isAbsolute(session.header?.cwd ?? '') || !presets.includes(ctx.agentPresets.composedPreset(agent.ctx))) throw new Error('SKILL_EVAL_NATIVE_SCOPE_REQUIRED')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode) || policy.sessionId !== id || typeof policy.workspaceRoot !== 'string' || resolve(policy.workspaceRoot) !== resolve(session.header.cwd)) throw new Error('SKILL_EVAL_NATIVE_POLICY_REQUIRED')
  return { agent, session, sessionId: id, root: resolve(policy.workspaceRoot), mode: policy.mode, origin: session.header.origin ?? 'lead', preset: ctx.agentPresets.composedPreset(agent.ctx) }
}
const scopeKey = scope => JSON.stringify({ id: scope.sessionId, root: scope.root, mode: scope.mode, origin: scope.origin, preset: scope.preset })
const assertCurrentJournal = (scope, observed) => { if (!Number.isSafeInteger(scope.session.seq) || scope.session.seq !== observed.through + 1) throw new Error('SKILL_EVAL_USER_CHECKPOINT_CHANGED') }
function selectedRoute(ctx, scope) {
  if (typeof ctx.llm?.registration !== 'function' || typeof ctx.sessionQuery?.observeSession !== 'function' || typeof ctx.approval?.request !== 'function' || typeof scope.agent.model?.select !== 'function') return null
  const selected = scope.agent.model.current()
  if (!selected) return null
  try { modelRouteId(selected) } catch { return null }
  return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
}
async function userCheckpoint(ctx, scope, exec, recheck) {
  const observation = await ctx.sessionQuery.observeSession(scope.sessionId, { signal: exec.signal, projectionMode: 'none' })
  try {
    recheck()
    const events = observation.events, inherited = observation.inheritedEventCount ?? 0
    if (!Array.isArray(events) || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length) throw new Error('SKILL_EVAL_NATIVE_HISTORY_REQUIRED')
    for (let index = events.length - 1; index >= Math.max(inherited, events.length - 20_000); index--) {
      const event = events[index]
      if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || event.data?.source?.kind !== 'user' || event.data.source.form === 'recall') continue
      if (event.seq !== index) throw new Error('SKILL_EVAL_NATIVE_HISTORY_REQUIRED')
      const content = event.data.content
      const text = Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n') : null
      return { through: events.length - 1, latestUser: { seq: event.seq, text: text?.length <= 1500 ? text : null } }
    }
    return { through: events.length - 1, latestUser: null }
  } finally { observation[Symbol.dispose]?.() }
}
export function builtinFixtureSpec() {
  const skill = { name: 'fixture-comment-spacing', description: 'Normalize comment spacing in synthetic source fixtures.', files: { 'SKILL.md': '# Fixture\nNormalize the comment marker spacing; preserve BOM.' } }
  return { current: skill, previous: { ...skill, files: { 'SKILL.md': '# Previous fixture\nNormalize comment marker spacing.' } }, tasks: [
    { id: 'bom-comments', kind: 'positive', prompt: 'Fix comment spacing in the synthetic code fixture.', files: { 'code.bsl': '\uFEFF//+ fixture\n' }, expectedFiles: { 'code.bsl': '\uFEFF// + fixture\n' }, finalIncludes: ['done'], fixtureSteps: [{ op: 'read-skill', whenSkill: true }, { op: 'replace', path: 'code.bsl', from: '//+', to: '// +' }, { op: 'final', text: 'done' }] },
    { id: 'near-miss', kind: 'near-miss', prompt: 'Say hello; no source editing.', files: {}, finalIncludes: ['hello'], fixtureSteps: [{ op: 'final', text: 'hello' }] },
  ] }
}
export function createEvaluationController(ctx, { fixtureRunnerFactory = createDeclarativeFixtureRunner, nativeFactory = createNativeSessionFactory } = {}) {
  const states = new WeakMap()
  const getState = agent => {
    if (!agent || typeof agent !== 'object') throw new Error('SKILL_EVAL_AGENT_REQUIRED')
    if (!states.has(agent)) states.set(agent, { plan: null, result: null, pending: null, running: false })
    return states.get(agent)
  }
  return {
    async act(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['action', 'specJson', 'planId'].includes(key))) throw new Error('SKILL_EVAL_ARGUMENTS_INVALID')
      const scope = evaluationScope(ctx, exec)
      const recheck = () => {
        const fresh = evaluationScope(ctx, exec)
        if (fresh.agent !== scope.agent || scopeKey(fresh) !== scopeKey(scope)) throw new Error('SKILL_EVAL_SCOPE_CHANGED')
      }
      const state = getState(exec?.agent)
      const route = selectedRoute(ctx, scope)
      if (args.action === 'status') return { ok: true, planId: state.plan?.planId ?? null, sessions: state.plan?.sessions ?? 0, running: state.running, resultAvailable: !!state.result, modelExecution: route ? 'explicit-user-checkpoint-required' : 'unavailable', modelId: route ? modelRouteId(route) : null, explanation: route ? 'Для модели: plan → review → отдельное точное сообщение пользователя → run-model. Затем требуется штатное approval. fixture запускается без модели.' : 'Выберите модель в native SDK022. Требуются native llm, sessionQuery и approval. Сейчас доступны только plan/fixture/report.' }
      if (args.action === 'plan') {
        if (state.running) throw new Error('SKILL_EVAL_BUSY')
        if (args.specJson !== undefined && (typeof args.specJson !== 'string' || Buffer.byteLength(args.specJson) > 512 * 1024)) throw new Error('SKILL_EVAL_SPEC_INVALID')
        let spec
        try { spec = args.specJson ? JSON.parse(args.specJson) : builtinFixtureSpec() } catch { throw new Error('SKILL_EVAL_SPEC_INVALID') }
        if (route && spec.modelId === undefined) spec.modelId = modelRouteId(route)
        state.plan = planEvaluation(spec); state.result = null; state.pending = null
        return { ok: true, planId: state.plan.planId, name: state.plan.name, modelId: state.plan.modelId, sessions: state.plan.sessions, tasks: state.plan.tasks.map(task => ({ id: task.id, kind: task.kind, prompt: task.prompt, fixtureSupported: task.fixtureSteps.length > 0 })), variants: state.plan.variants.map(variant => ({ label: variant.label, revision: variant.skill?.revision ?? null })), execution: 'plan-only', note: 'План не запускает модель. fixture — проверка механики стенда, не качества модели.' }
      }
      if (!state.plan || args.planId !== state.plan.planId) throw new Error('SKILL_EVAL_PLAN_CHANGED')
      if (['review', 'run-model'].includes(args.action)) {
        if (state.running) throw new Error('SKILL_EVAL_BUSY')
        if (scope.origin === 'subagent') throw new Error('SKILL_EVAL_LEAD_REQUIRED')
        if (!route || modelRouteId(route) !== state.plan.modelId) throw new Error('SKILL_EVAL_MODEL_CHANGED')
        const verifyModel = () => { recheck(); const fresh = selectedRoute(ctx, evaluationScope(ctx, exec)); if (!fresh || modelRouteId(fresh) !== state.plan.modelId) throw new Error('SKILL_EVAL_MODEL_CHANGED') }
        state.running = true
        try {
          const observed = await userCheckpoint(ctx, scope, exec, verifyModel)
          assertCurrentJournal(scope, observed)
          if (args.action === 'review') {
            const phrase = `Одобряю оценку навыка ${state.plan.planId} ${state.plan.modelId} ${randomUUID()}`
            state.pending = { phrase, afterSeq: observed.through, planId: state.plan.planId, scopeKey: scopeKey(scope) }
            return { ok: true, planId: state.plan.planId, modelId: state.plan.modelId, sessions: state.plan.sessions, maxModelRequests: state.plan.sessions * 8, approvalRequest: phrase, message: 'Проверьте задания и варианты плана. Для платного запуска отправьте эту строку отдельным следующим сообщением в текущем чате. Модель не может подтвердить запуск сама. Не более 8 запросов и 4096 output tokens на сессию; возможна тарификация выбранного провайдера.' }
          }
          const pending = state.pending
          if (!pending || pending.planId !== state.plan.planId || pending.scopeKey !== scopeKey(scope) || !observed.latestUser || observed.latestUser.seq <= pending.afterSeq || observed.latestUser.text !== pending.phrase) throw new Error('SKILL_EVAL_USER_CHECKPOINT_REQUIRED')
          state.pending = null // One-shot; denial, timeout and unknown outcomes never auto-retry.
          const decision = await ctx.approval.request({ agent: scope.agent, toolName: 'airules_skill_eval', callId: exec.callId, reason: `Skill evaluation ${state.plan.name}; exact plan ${state.plan.planId}; model ${state.plan.modelId}; ${state.plan.sessions} isolated model sessions; up to ${state.plan.sessions * 8} requests. Paid provider calls, no project writes or deploy.`, signal: exec.signal })
          verifyModel()
          if (decision !== 'allowed-once') throw new Error('SKILL_EVAL_APPROVAL_REQUIRED')
          const committed = await userCheckpoint(ctx, scope, exec, verifyModel)
          assertCurrentJournal(scope, committed)
          if (committed.latestUser?.seq !== observed.latestUser.seq || committed.latestUser?.text !== pending.phrase) throw new Error('SKILL_EVAL_USER_CHECKPOINT_CHANGED')
          const verifyAuthorized = () => { verifyModel(); assertCurrentJournal(scope, committed) }
          state.result = null
          const openSession = nativeFactory({ sourceLlm: ctx.llm, route, verifyScope: verifyAuthorized })
          const result = await runEvaluation({ plan: state.plan, runner: createNativeSessionRunner({ modelId: state.plan.modelId, openSession, verifyScope: verifyAuthorized }), authorization: { run: true, planId: state.plan.planId, modelId: state.plan.modelId }, signal: exec.signal })
          verifyAuthorized(); state.result = result
          return { ok: true, execution: 'model', result, approvalEvidence: { sessionId: scope.sessionId, eventSeq: observed.latestUser.seq }, interpretation: 'Native isolated execution is evidence from this exact run; no automatic skill promotion or general quality claim.' }
        } finally { state.running = false }
      }
      if (args.action === 'fixture') {
        if (state.running) throw new Error('SKILL_EVAL_BUSY')
        if (state.plan.tasks.some(task => !task.fixtureSteps.length)) throw new Error('SKILL_EVAL_FIXTURE_STEPS_REQUIRED')
        state.running = true
        try {
          state.result = null
          const result = await runEvaluation({ plan: state.plan, runner: fixtureRunnerFactory(state.plan), signal: exec.signal })
          recheck()
          state.result = result
          return { ok: true, execution: 'fixture', modelRequests: 0, result: state.result }
        } finally { state.running = false }
      }
      if (args.action === 'report') {
        if (!state.result) throw new Error('SKILL_EVAL_RESULT_REQUIRED')
        return { ok: true, execution: state.result.execution, modelRequests: state.result.modelRequests, report: renderEvaluationReport(state.result), result: state.result }
      }
      throw new Error('SKILL_EVAL_ACTION_INVALID')
    },
  }
}
export function apply(ctx) {
  const controller = createEvaluationController(ctx)
  ctx.tools.register(defineTool({
    name: 'airules_skill_eval',
    description: 'Оценка навыка current/previous/no-skill. plan без specJson создаёт synthetic BOM+near-miss; custom specJson содержит skill/files/tasks. fixture — deterministic in-memory steps без модели. Модель: plan→review→точное отдельное оригинальное user/message→run-model и штатное approval; только ведущий агент. 2–3 задания, до9freshrestrictednativeagents, до8modelrequests наcase. Никаких shell/MCP/hostFS/deploy. review/fixture/run-model/report требуют точный planId. Fixture PASS не проверяет качество модели. После paid timeout не повторяй без нового review пользователя.',
    parameters: { action: { type: 'string', enum: ['status', 'plan', 'review', 'fixture', 'run-model', 'report'], required: true }, specJson: { type: 'string' }, planId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => controller.act(args, exec),
  }))
  ctx.systemPrompt.section({ name: 'airules:skill-evaluation', order: 21, text: 'airules_skill_eval создаёт план current/previous/no-skill с positive и near-miss. fixture запускает только синтетические шаги в памяти без модели; его PASS не является модельной приёмкой. Для модели обязателен review плана и отдельное точное оригинальное сообщение пользователя, затем run-model и native approval. Модель не подтверждает себя; planning не разрешает платные запросы. Новый isolated nativeagent каждогоcase имеет только3in-memory fixturetools, без shell/MCP/hostFS/навыков проекта. Секреты не копировать. Автопродвижения навыка и деплоя нет.' })
}
