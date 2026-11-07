import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { LlmRuntime, LlmError } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { resolveChildAgentOptions } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js'
import { createStore } from '../src/model-orchestration/lib/store.js'
import { createOrchestrationService } from '../src/model-orchestration/lib/service.js'
import { delegateRole } from '../src/model-orchestration/lib/delegation-core.js'
import { poolCapabilities } from '../src/model-orchestration/lib/rotation.js'

const PRIMARY = 'gpt-6.1-sol', SECONDARY = 'gpt-6.1-terra'
const native = value => pathToFileURL(resolve('var/asar-extract-rc5/dsh/node_modules', value)).href
const undiciPath = resolve(process.env.AIRULES_SUBSCRIPTIONS_MODULES ?? 'dist/airules-official-policy-0.12.0-dev36/payload/packages/airules-dsh-subscriptions/node_modules', 'undici/index.js')
const require = createRequire(import.meta.url)
assert.equal(require(join(undiciPath,'..','package.json')).version,'7.29.1','test the pinned shipping subscription transport')
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require(undiciPath)

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'airules-openai-acceptance-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  const pkg = join(directory,'subscription'), home = join(directory,'home')
  await cp('src/subscriptions',pkg,{recursive:true})
  // Only host identity/storage/tool branding are isolated. LLM, schema,
  // delegation option resolution and the subscription wire adapter are real.
  const dependencies = {
    '@deepseek-ai/schemastery': `export {default} from ${JSON.stringify(native('@deepseek-ai/schemastery/lib/index.mjs'))}`,
    '@deepseek-ai/dsh-llm': `export * from ${JSON.stringify(native('@deepseek-ai/dsh-llm/lib/index.js'))}`,
    '@deepseek-ai/dsh-home-paths': `import{join}from'node:path';export const dshHomePath=(...p)=>join(${JSON.stringify(home)},...p)`,
    '@deepseek-ai/dsh-attachment':'export const AttachmentId=x=>x',
    '@deepseek-ai/dsh-tools':'export const defineTool=x=>x',
    undici:`export {ProxyAgent,fetch} from ${JSON.stringify(pathToFileURL(undiciPath).href)}`,
  }
  for (const [name,body] of Object.entries(dependencies)) {
    const path=join(pkg,'node_modules',name); await mkdir(path,{recursive:true})
    await writeFile(join(path,'package.json'),JSON.stringify({name,type:'module',exports:'./index.js'}))
    await writeFile(join(path,'index.js'),body)
  }
  const subscription = await import(pathToFileURL(join(pkg,'lib/index.js')))
  const llm=new LlmRuntime(new Context()), adapters=new Map(), disposers=[]
  const ctx={logger:{warn(){}},get:key=>key==='llm'?llm:undefined,llm:{
    registerAdapter(ids,adapter){for(const id of ids)adapters.set(id,adapter);return{replace(){},dispose(){}}},
  },effect(factory){const dispose=factory();if(typeof dispose==='function')disposers.push(dispose)},inject(){}}
  subscription.apply(ctx,{providers:['codex'],pool:{enabled:false},models:{codex:[{id:PRIMARY,name:'Primary'},{id:SECONDARY,name:'Secondary'}]}})
  t.after(()=>{for(const dispose of disposers.reverse())dispose()})
  const adapter=adapters.get('codex')
  adapter.options.defaultEffortOf=()=> 'low'
  adapter.discovered=async model => ({id:model,name:model,contextWindow:model===PRIMARY?500000:128000,
    reasoning:{efforts:(model===PRIMARY?['low','high','xhigh']:['low','high']).map(id=>({id,name:id})),defaultEffort:'low'}})
  const registration=llm.registerAdapter(['codex'],adapter);t.after(()=>registration())
  const store=await createStore(join(home,'model-orchestration/settings.json'))
  const service=createOrchestrationService({store,llm})
  return{directory,home,llm,adapter,service,store}
}

test('OpenAI role effort flows through native child options to actual Responses wire without account access',async t=>{
  const f=await fixture(t)
  await f.service.save({roles:{architect:{provider:'codex',model:PRIMARY,reasoningEffort:'xhigh'}},pools:[]})
  const parent={options:{provider:'codex',model:PRIMARY,reasoningEffort:'low'},session:{requestHeader:()=>undefined}}
  let activation
  const subagents={getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true},inheritsParentContext:false}),resolveMaxDepth:()=>2,
    startActivation:async value=>{activation=value;return{childId:'synthetic-activation-no-turn'}}}
  await delegateRole({service:f.service,subagents,role:'architect',task:'Synthetic architecture acceptance',persona:'DSH persona with project limits',
    parent,inherited:parent.options,signal:new AbortController().signal})
  const child=resolveChildAgentOptions(parent,activation.request.agentOptions,1)
  assert.equal(child.reasoningEffort,'xhigh');assert.equal(child.model,PRIMARY)
  assert.equal(activation.label,'airules-role:architect');assert.equal(activation.delivery,'parent')
  assert.equal(activation.request.maxDepth,2);assert.match(activation.request.prompt[0].text,/DSH persona/)
  const dispatcher=new MockAgent();dispatcher.disableNetConnect()
  const previous=getGlobalDispatcher();setGlobalDispatcher(dispatcher)
  t.after(async()=>{setGlobalDispatcher(previous);await dispatcher.close()})
  let payload
  dispatcher.get('https://chatgpt.com').intercept({path:'/backend-api/codex/responses',method:'POST'}).reply(options=>{
    payload=JSON.parse(options.body);return{statusCode:200,data:''}
  })
  const selected=await f.llm.resolveCallConfig(child)
  const response=await f.adapter.request({...selected,sessionId:'synthetic-child',messages:[],modelParameters:{speedTier:'standard'}},
    {accessToken:'synthetic-never-a-real-account',accountId:'synthetic'},new AbortController().signal)
  await response.text()
  assert.equal(payload.model,PRIMARY);assert.equal(payload.reasoning.effort,'xhigh')
  assert.equal(payload.store,false);assert.equal(payload.prompt_cache_key,'synthetic-child')
  assert.equal(payload.service_tier,undefined,'normal effort selection must not opt into a paid priority tier')
  dispatcher.assertNoPendingInterceptors()
})

test('discovered effort bounds reject stale settings and do not extend the advertised account capability',async t=>{
  const f=await fixture(t)
  f.adapter.options.defaultEffortOf=()=> 'ultra'
  const base=await f.llm.resolveCallConfig({provider:'codex',model:PRIMARY})
  assert.equal(base.reasoningEffort,'low','an unsupported configured default must not override discovered metadata')
  await assert.rejects(f.service.save({roles:{developer:{provider:'codex',model:PRIMARY,reasoningEffort:'ultra'}},pools:[]}))
  assert.deepEqual(f.store.snapshot().roles,{})
  const parent={provider:'codex',model:PRIMARY,reasoningEffort:'xhigh'}
  assert.equal((await f.service.resolveRole('tester',parent)).reasoningEffort,'xhigh')
  await f.service.save({roles:{tester:{provider:'codex',model:SECONDARY}},pools:[]})
  assert.equal((await f.service.resolveRole('tester',parent)).reasoningEffort,'low','changing model resolves that model default, not a stale inherited effort')
})

test('withdrawn model stops role preparation and never silently switches provider or executor',async t=>{
  const f=await fixture(t)
  await f.service.save({roles:{developer:{provider:'codex',model:SECONDARY,reasoningEffort:'high'}},pools:[]})
  const previous=f.adapter.resolveModel.bind(f.adapter)
  f.adapter.resolveModel=async(provider,model,...rest)=>{if(model===SECONDARY)throw new LlmError('Synthetic model withdrawn','MODEL_NOT_FOUND');return previous(provider,model,...rest)}
  let activations=0
  const parent={options:{provider:'codex',model:PRIMARY,reasoningEffort:'low'},session:{requestHeader:()=>undefined}}
  const subagents={getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true},inheritsParentContext:false}),resolveMaxDepth:()=>2,
    startActivation:async()=>{activations++;return{childId:'must-not-start'}}}
  await assert.rejects(delegateRole({service:f.service,subagents,role:'developer',task:'Synthetic',persona:'DSH',parent,inherited:parent.options,
    signal:new AbortController().signal}),error=>error.code==='MODEL_NOT_FOUND')
  assert.equal(activations,0)
  assert.equal(f.store.snapshot().roles.developer.model,SECONDARY)
})

test('fallback model metadata is not evidence that a subscription owns or can generate with that model',async t=>{
  const f=await fixture(t)
  f.adapter.discovered=async()=>undefined
  const resolved=await f.llm.resolveCallConfig({provider:'codex',model:'synthetic-unconfirmed-model'})
  assert.equal(resolved.model,'synthetic-unconfirmed-model')
  assert.equal(resolved.provider,'codex')
  // This intentionally demonstrates the boundary: resolution validates call
  // shape/capability fallback, not account entitlement or a live generation.
  assert.equal((await f.adapter.options.tokens.list(true)).length,0)
})

test('OpenAI model-pool capabilities use the intersection and role settings stay installation-local',async t=>{
  const first=await fixture(t), second=await fixture(t)
  const pool={id:'openai-local',name:'OpenAI local',enabled:true,failover:false,routes:[{provider:'codex',model:PRIMARY},{provider:'codex',model:SECONDARY}]}
  const capabilities=await poolCapabilities(first.llm,pool)
  assert.deepEqual(capabilities.reasoning.efforts.map(row=>row.id),['low','high'])
  assert.equal(capabilities.context.contextWindow,128000);assert.deepEqual(capabilities.inputModalities,['text'])
  await first.service.save({roles:{developer:{provider:'codex',model:PRIMARY,reasoningEffort:'high'}},pools:[]})
  assert.deepEqual(second.store.snapshot(),{version:1,roles:{},pools:[]})
  const reopened=await createStore(join(first.home,'model-orchestration/settings.json'))
  assert.equal(reopened.snapshot().roles.developer.reasoningEffort,'high')
  await assert.rejects(first.service.save({roles:{},pools:[{...pool,routes:[pool.routes[0],{provider:'other-provider',model:SECONDARY}]}]}),error=>error.code==='ROTATION_POOL_ROUTES_INVALID')
})
