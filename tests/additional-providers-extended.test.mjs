import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { PLAN_SUBSCRIPTIONS, aliasPlanProvider, createApiPlanController } from '../src/additional-providers/lib/api-plans.js'
import { createPlanHandler } from '../src/additional-providers/lib/plan-control.js'
import { builtinProviders } from '../var/asar-extract-rc5/dsh/node_modules/@earendil-works/pi-ai/dist/providers/all.js'
import { PiAiAdapter } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
import { LlmError, resolveRetryPolicy } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { noEnvironment } from '../src/additional-providers/lib/controller.js'

function fixture(available = true) {
  const records = new Map(), reads = [], writes = []
  const providers = new Map(PLAN_SUBSCRIPTIONS.map(spec => [spec.id, aliasPlanProvider(builtinProviders().find(p => p.id === spec.nativeId), spec)]).filter(([,p]) => available && p))
  let changed = 0
  const credentials = {
    async readRecord(key) { reads.push(key); return records.get(key) },
    async modifyRecord(key, update) { const value = await update(records.get(key)); if (value !== undefined) records.set(key, value); writes.push(key) },
    async deleteRecord(key) { records.delete(key); writes.push(key) },
  }
  const controller = createApiPlanController({credentials, keyFor:id=>`own/${id}`, providers, changed:()=>changed++})
  return {records,reads,writes,providers,controller,get changed(){return changed}}
}
const row = async(f,id=PLAN_SUBSCRIPTIONS[0].id)=>(await f.controller.snapshot()).providers.find(p=>p.id===id)
const save = async(f,key='fixture-private-key',id=PLAN_SUBSCRIPTIONS[0].id)=>f.controller.action({action:'save',provider:id,revision:(await row(f,id)).revision,key})

test('plan catalog aliases actual native protocols without ambient credentials or requests', async()=>{
  const f=fixture(), originalFetch=globalThis.fetch
  globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')}
  try {
    assert.equal(f.providers.size,3)
    for(const spec of PLAN_SUBSCRIPTIONS){
      const native=builtinProviders().find(p=>p.id===spec.nativeId), alias=f.providers.get(spec.id)
      assert.ok(alias.getModels().length>0)
      assert.equal(alias.protocols,native.protocols)
      assert.equal(alias.getModels()[0].provider,spec.id)
      assert.equal(native.getModels()[0].provider,spec.nativeId)
      assert.equal(await f.controller.resolveApiKey(spec.id),undefined)
    }
    assert.equal(await noEnvironment.env('ZAI_API_KEY'),undefined)
    assert.equal(await noEnvironment.fileExists('foreign-auth.json'),false)
    assert.ok(f.reads.every(key=>key.startsWith('own/')))
  } finally {globalThis.fetch=originalFetch}
})

test('explicit save replaces only own key, snapshots never disclose it, logout invalidates models',async()=>{
  const f=fixture();f.records.set('native/zai',{kind:'api-key',key:'foreign-secret'})
  await save(f)
  assert.equal((await row(f)).connected,true)
  assert.equal(await f.controller.resolveApiKey(PLAN_SUBSCRIPTIONS[0].id),'fixture-private-key')
  assert.deepEqual(await f.controller.store.read(PLAN_SUBSCRIPTIONS[0].id),{type:'api_key',key:'fixture-private-key'})
  assert.equal(await f.controller.store.read('zai'),undefined)
  assert.doesNotMatch(JSON.stringify(await f.controller.snapshot()),/fixture-private-key|foreign-secret/)
  await assert.rejects(f.controller.store.modify('zai',()=>({})),/READ_ONLY/)
  await f.controller.action({action:'logout',provider:PLAN_SUBSCRIPTIONS[0].id,revision:(await row(f)).revision})
  assert.equal(await f.controller.resolveApiKey(PLAN_SUBSCRIPTIONS[0].id),undefined)
  assert.equal(f.records.get('native/zai').key,'foreign-secret')
  assert.equal(f.changed,2)
})

test('simultaneous stale editors cannot overwrite newer key; malformed operations cannot mutate',async()=>{
  const f=fixture(), before=await row(f), op={action:'save',provider:before.id,revision:before.revision,key:'first-fixture-key'}
  const result=await Promise.allSettled([f.controller.action(op),f.controller.action({...op,key:'second-fixture-key'})])
  assert.equal(result[0].status,'fulfilled');assert.match(result[1].reason.message,/PLAN_STALE/)
  await assert.rejects(f.controller.action({...op,revision:(await row(f)).revision,key:'bad\nvalue'}),/KEY_INVALID/)
  await assert.rejects(f.controller.action({...op,account:'native'}),/FIELDS_REJECTED/)
  await assert.rejects(f.controller.action({...op,provider:'zai'}),/PROVIDER_REJECTED/)
  assert.equal(f.writes.length,1)
  f.controller.close();await assert.rejects(save(f),/CLOSED/)
})

test('missing native provider degrades clearly and never stores an unusable key',async()=>{
  const f=fixture(false)
  assert.equal((await row(f)).available,false)
  await assert.rejects(save(f),/PROVIDER_UNAVAILABLE/)
  assert.equal(f.writes.length,0)
})

test('actual native PiAiAdapter resolves every plan model, hides disconnected catalog and retains native metadata',async()=>{
  const f=fixture(), profiles=new Map([...f.providers].map(([id,piProvider])=>[id,{provider:id,displayName:piProvider.name,piProvider,
    streamIdleTimeoutMs:300000,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,
    retryPolicy:resolveRetryPolicy(undefined),modelErrors:new Map(),configuredMaxTokens:new Map()}]))
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async id=>{const key=await f.controller.resolveApiKey(id);if(!key)throw new LlmError('missing','MISSING_CREDENTIAL');return key},auth:{credentials:f.controller.store,authContext:noEnvironment}})
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')}
  try {
    for(const spec of PLAN_SUBSCRIPTIONS){
      assert.deepEqual(await adapter.listModels(spec.id),[])
      await save(f,`fixture-key-${spec.credentialId}`,spec.id)
      const models=await adapter.listModels(spec.id);assert.ok(models.length>0)
      for(const model of models){const info=await adapter.resolveModel(spec.id,model.id);assert.equal(info.provider,spec.id);assert.ok(info.context.contextWindow>0)}
    }
  } finally {globalThis.fetch=originalFetch}
})

test('plan HTTP control requires native admission, CSRF, bounded JSON and returns redacted errors',async()=>{
  const f=fixture(), handler=createPlanHandler(f.controller,{token:'csrf',connection:{requestRejection:req=>req.admitted?undefined:'deny'}})
  async function call(method='GET',body='',csrf='',admitted=true){
    const request=Readable.from(body?[body]:[]);Object.assign(request,{method,admitted,headers:{'x-dsh-csrf':csrf,'content-type':'application/json'}})
    let status,output;await handler(request,{writeHead(code){status=code},end(value){output=JSON.parse(value)}});return {status,output}
  }
  assert.equal((await call('GET','','',false)).status,403)
  assert.equal((await call('POST','{}')).status,403)
  assert.equal((await call('PATCH')).status,405)
  assert.equal((await call('POST','x'.repeat(8193),'csrf')).output.error,'PLAN_BODY_LIMIT')
  assert.equal((await call('POST','{','csrf')).output.error,'PLAN_ACTION_FAILED')
  const current=await row(f), body=JSON.stringify({action:'save',provider:current.id,revision:current.revision,key:'http-fixture-private'})
  const saved=await call('POST',body,'csrf');assert.equal(saved.status,200);assert.doesNotMatch(JSON.stringify(saved),/http-fixture-private/)
  assert.equal((await call('POST',body,'csrf')).status,409)
  f.controller.snapshot=async()=>{throw new Error('native-error-with-private-key')}
  const failure=await call();assert.doesNotMatch(JSON.stringify(failure),/native-error-with-private-key/)
})

test('plan UI exports unified-page contract and disconnected state cannot save or logout',()=>{
  let exported;const React={createElement:(type,props,...children)=>({type,props,children}),useState:initial=>[initial,()=>{}],useRef:value=>({current:value}),useCallback:value=>value,useEffect(){}}
  runInNewContext(readFileSync(new URL('../src/additional-providers/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(module){exported=module.factory(()=>React)}}}})
  assert.deepEqual(Array.from(exported.PLAN_SUBSCRIPTIONS,p=>p.id),PLAN_SUBSCRIPTIONS.map(p=>p.id))
  const nodes=[];function visit(node){if(!node||typeof node!=='object')return;nodes.push(node);node.children?.flat().forEach(visit)}
  visit(exported.ApiPlanSettings({providerId:PLAN_SUBSCRIPTIONS[0].id}))
  assert.equal(nodes.find(n=>n.props?.role==='status').children[0],'Статус неизвестен')
  assert.equal(nodes.find(n=>n.type==='input').props.type,'password')
  assert.equal(nodes.find(n=>n.type==='button'&&n.children[0]==='Сохранить ключ').props.disabled,true)
  assert.equal(nodes.find(n=>n.type==='button'&&n.children[0]==='Отключить').props.disabled,true)
})
