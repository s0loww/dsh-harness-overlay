import { Service } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createStore, ROTATION_PROVIDER } from './store.js'
import { createRotationAdapter } from './rotation.js'
import { createOrchestrationService } from './service.js'
import { createHandler, CONTROL_PATH } from './control.js'
export const name = 'airules-model-orchestration'
export const inject = ['llm','dshHomePath']
export async function apply(ctx) {
  const store = await createStore(ctx.dshHomePath('model-orchestration/settings.json'))
  const adapter = createRotationAdapter({ Base: LlmAdapter, llm: ctx.llm, store })
  const registration = ctx.llm.registerAdapter([ROTATION_PROVIDER], adapter)
  class OrchestrationService extends Service { constructor(scope) { super(scope, 'airulesModelOrchestration'); Object.assign(this, createOrchestrationService({ store, llm: scope.llm, rotationRegistration: registration })) } }
  const service = new OrchestrationService(ctx)
  ctx.inject(['webServer','connection'], ready => ready.effect(() => ready.webServer.register({ kind: 'exact', path: CONTROL_PATH, handler: createHandler(service, { connection: ready.connection }) })))
  ctx.on('session/event', (session, event) => { if (event.type === 'session/end') void store.forgetSession(String(session.id)).catch(() => {}) }, { global: true })
}
