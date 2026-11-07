import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createController, noEnvironment, PROVIDER } from './controller.js'
import { createHandler, CONTROL_PATH } from './control.js'
import { aliasProvider } from './provider.js'
import { PLAN_SUBSCRIPTIONS,aliasPlanProvider,createApiPlanController } from './api-plans.js'
import { createPlanHandler,PLAN_CONTROL_PATH } from './plan-control.js'

export const name = 'airules-additional-providers'
export const inject = ['llm', 'credentials']
export function apply(ctx) {
  const nativeProviders=builtinProviders()
  const provider = aliasProvider(nativeProviders.find(row => row.id === 'kimi-coding'))
  const controller = createController({ credentials: ctx.credentials, key: credentialKey(name, 'kimi'), modelsFactory: builtinModels, provider })
  const profiles = new Map([[PROVIDER, {
    provider: PROVIDER, displayName: provider.name, piProvider: provider,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: resolveRetryPolicy(undefined), modelErrors: new Map(), configuredMaxTokens: new Map(),
  }]])
  const adapter = new PiAiAdapter({ profiles: () => profiles,
    async resolveApiKey() {
      if (!(await controller.store.read(PROVIDER))) throw new LlmError('Подключите Kimi в настройках дополнительных провайдеров.', 'MISSING_CREDENTIAL')
      return undefined
    }, auth: { credentials: controller.store, authContext: noEnvironment }, resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
  ctx.effect(() => () => controller.close())
  ctx.inject(['webServer', 'connection'], ready => ready.effect(() => ready.webServer.register({ kind: 'exact', path: CONTROL_PATH, handler: createHandler(controller, { connection: ready.connection }) })))
  const planProviders=new Map(PLAN_SUBSCRIPTIONS.map(spec=>[spec.id,aliasPlanProvider(nativeProviders.find(row=>row.id===spec.nativeId),spec)]).filter(([,value])=>value))
  let planRegistration
  const plans=createApiPlanController({credentials:ctx.credentials,keyFor:id=>credentialKey(name,id),providers:planProviders,
    changed:()=>planRegistration?.replace([...planProviders.keys()]),
  })
  const planProfiles=new Map([...planProviders].map(([id,piProvider])=>[id,{
    provider:id,displayName:piProvider.name,piProvider,streamIdleTimeoutMs:300000,
    maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,
    retryPolicy:resolveRetryPolicy(undefined),modelErrors:new Map(),configuredMaxTokens:new Map(),
  }]))
  const planAdapter=new PiAiAdapter({profiles:()=>planProfiles,
    async resolveApiKey(id){const key=await plans.resolveApiKey(id);if(!key)throw new LlmError('Подключите ключ выбранного плана в настройках провайдеров.','MISSING_CREDENTIAL');return key},
    auth:{credentials:plans.store,authContext:noEnvironment},resolveAttachments:()=>ctx.get('attachments'),
  })
  ctx.effect(()=>{
    if(!planProfiles.size)return
    const registration=ctx.llm.registerAdapter([...planProfiles.keys()],planAdapter)
    planRegistration=registration
    return ()=>{planRegistration=undefined;registration()}
  })
  ctx.effect(()=>()=>plans.close())
  ctx.inject(['webServer','connection'],ready=>ready.effect(()=>ready.webServer.register({kind:'exact',path:PLAN_CONTROL_PATH,handler:createPlanHandler(plans,{connection:ready.connection})})))
}
