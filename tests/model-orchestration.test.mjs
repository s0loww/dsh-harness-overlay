import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, cp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { createStore, validateSettings, ROLES, ROTATION_PROVIDER } from '../src/model-orchestration/lib/store.js'
import { createRotationAdapter, poolCapabilities } from '../src/model-orchestration/lib/rotation.js'
import { createOrchestrationService } from '../src/model-orchestration/lib/service.js'
import { delegateRole } from '../src/model-orchestration/lib/delegation-core.js'
import { createHandler } from '../src/model-orchestration/lib/control.js'
import { Context } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { LlmAdapter, LlmRuntime, LlmError } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { resolveChildAgentOptions } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js'

const pool = () => ({ id:'coding', name:'Coding', enabled:true, failover:false, routes:[{provider:'codex',model:'a'},{provider:'codex',model:'b'}] })
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'airules-model-orchestration-')); t.after(()=>rm(directory,{recursive:true,force:true}))
  const filename=join(directory,'settings.json'), store=await createStore(filename), calls=[]
  class CodexAdapter extends LlmAdapter {
    mode='success'
    providerInfo(provider){return{id:provider,name:'Synthetic native test'}}
    listModels(provider){return Promise.resolve(['a','b'].map(id=>({provider,id,name:id})))}
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image'],context:{contextWindow:id==='a'?32000:16000},defaultMaxTokens:1000,reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}})}
    async *stream(options){
      calls.push(options)
      if(this.mode==='quota-first'&&options.model==='a')throw new LlmError('synthetic quota','QUOTA_EXCEEDED')
      if(this.mode==='auth')throw new LlmError('synthetic auth','INVALID_CREDENTIAL')
      yield{type:'text-delta',text:'synthetic'}
      if(this.mode==='partial')throw new LlmError('synthetic network','TRANSPORT')
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  const llm=new LlmRuntime(new Context()), provider=new CodexAdapter(), registration=llm.registerAdapter(['codex'],provider)
  t.after(()=>registration())
  const adapter=createRotationAdapter({Base:LlmAdapter,llm,store}), rotationRegistration=llm.registerAdapter([ROTATION_PROVIDER],adapter)
  t.after(()=>rotationRegistration())
  const service=createOrchestrationService({store,llm,rotationRegistration})
  return{store,filename,llm,provider,adapter,service,calls}
}
const collect = async stream => {const result=[];for await(const chunk of stream)result.push(chunk);return result}
const call = sessionId => ({provider:ROTATION_PROVIDER,model:'coding',sessionId,messages:[],reasoningEffort:'high',signal:new AbortController().signal})

test('13 role IDs match the actual project_rules contracts; defaults have no pools, writes or remote work', async t=>{
  const f=await fixture(t)
  assert.equal(ROLES.length,13);assert.equal(new Set(ROLES).size,13)
  assert.deepEqual(f.store.snapshot(),{version:1,roles:{},pools:[]})
  assert.deepEqual(await f.adapter.listModels(),[]);assert.equal(f.calls.length,0)
  await assert.rejects(readFile(f.filename),{code:'ENOENT'})
  const {readdir}=await import('node:fs/promises')
  const actual=(await readdir('D:/AI_Projects/project_rules/overlays/1c/agents')).filter(name=>name.endsWith('.md')).map(name=>name.slice(0,-3)).sort()
  assert.deepEqual([...ROLES].sort(),actual)
})
test('validated role mappings persist separately and resolve real native effort with inheritance',async t=>{
  const f=await fixture(t)
  await f.service.save({roles:{developer:{provider:'codex',model:'b',reasoningEffort:'high'}},pools:[]})
  const reopened=await createStore(f.filename)
  assert.equal(reopened.snapshot().roles.developer.model,'b')
  assert.equal((await f.service.resolveRole('developer',{provider:'codex',model:'a',reasoningEffort:'low'})).reasoningEffort,'high')
  assert.equal((await f.service.resolveRole('developer',{provider:'codex',model:'a',reasoningEffort:'low'})).maxTokens,undefined)
  assert.equal((await f.service.resolveRole('tester',{provider:'codex',model:'a',reasoningEffort:'low'})).reasoningEffort,'low')
  await assert.rejects(f.service.save({roles:{developer:{provider:'codex',model:'b',reasoningEffort:'unsupported'}},pools:[]}))
  await assert.rejects(f.service.resolveRole('made-up',{provider:'codex',model:'a'}),{code:'ROLE_UNKNOWN'})
  assert.equal(f.calls.length,0)
})
test('managed delegation supplies actual native child options, persona, depth and cancellation',async t=>{
  const f=await fixture(t);await f.service.save({roles:{architect:{provider:'codex',model:'b',reasoningEffort:'high'}},pools:[]})
  let specification
  const parent={options:{provider:'codex',model:'a',reasoningEffort:'low'},session:{requestHeader:()=>undefined}}, signal=new AbortController().signal
  const subagents={getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true},inheritsParentContext:false}),resolveMaxDepth:()=>3,startActivation:async spec=>{specification=spec;return{childId:'native-child'}}}
  const result=await delegateRole({service:f.service,subagents,role:'architect',task:'Review architecture',persona:'verified persona',parent,inherited:parent.options,signal})
  assert.equal(result.childId,'native-child');assert.equal(specification.provider,'spawn');assert.equal(specification.request.maxDepth,3);assert.equal(specification.signal,signal)
  assert.equal(specification.label,'airules-role:architect')
  assert.match(specification.request.prompt[0].text,/verified persona[\s\S]*Review architecture/)
  const nativeChild=resolveChildAgentOptions(parent,specification.request.agentOptions,1)
  assert.equal(nativeChild.model,'b');assert.equal(nativeChild.reasoningEffort,'high')
  const aborted=new AbortController();aborted.abort()
  await assert.rejects(delegateRole({service:f.service,subagents,role:'architect',task:'Task',persona:'Persona',parent,inherited:parent.options,signal:aborted.signal}))
})
test('pool metadata is conservative; cross-provider, recursion, protocol and capability mismatches reject',async t=>{
  const f=await fixture(t), p=pool(), info=await poolCapabilities(f.llm,p)
  assert.equal(info.context.contextWindow,16000);assert.deepEqual(info.inputModalities,['text'])
  assert.throws(()=>validateSettings({roles:{},pools:[{...p,routes:[p.routes[0],{provider:'other',model:'c'}]}]}),{code:'ROTATION_POOL_ROUTES_INVALID'})
  assert.throws(()=>validateSettings({roles:{},pools:[{...p,routes:[{provider:ROTATION_PROVIDER,model:'x'},{provider:ROTATION_PROVIDER,model:'y'}]}]}),{code:'ROTATION_POOL_ROUTES_INVALID'})
  await assert.rejects(poolCapabilities(f.llm,p,undefined,(_adapter,_provider,model)=>model==='a'?'one':'two'),{code:'ROTATION_PROTOCOL_MISMATCH'})
  const original=f.provider.resolveModel.bind(f.provider)
  f.provider.resolveModel=async(provider,id)=>({...await original(provider,id),inputModalities:id==='a'?['text']:['text','image']})
  await assert.rejects(poolCapabilities(f.llm,p),{code:'ROTATION_CAPABILITY_MISMATCH'})
})
test('round robin chooses new sessions, pins existing sessions and persists across restart',async t=>{
  const f=await fixture(t);await f.service.save({roles:{},pools:[pool()]})
  await collect(f.llm.stream(call('one')));await collect(f.llm.stream(call('two')));await collect(f.llm.stream(call('one')))
  assert.deepEqual(f.calls.map(row=>row.model),['a','b','a']);assert.ok(f.calls.every(row=>row.reasoningEffort==='high'))
  const reopened=await createStore(f.filename), pin=await reopened.pin(pool(),'one');assert.equal(pin.route.model,'a');assert.equal(pin.committed,true)
})
test('explicit failover handles native quota terminal chunks only before output',async t=>{
  const f=await fixture(t);const p={...pool(),failover:true};await f.service.save({roles:{},pools:[p]});f.provider.mode='quota-first'
  const chunks=await collect(f.llm.stream(call('new')))
  assert.deepEqual(f.calls.map(row=>row.model),['a','b']);assert.equal(chunks.at(-1).reason.kind,'stop')
  assert.equal((await f.store.pin(p,'new')).route.model,'b')
})
test('partial output, auth, disabled failover and locked sessions never replay another model',async t=>{
  for(const mode of ['partial','auth','quota-first']){
    const f=await fixture(t);await f.service.save({roles:{},pools:[{...pool(),failover:mode!=='quota-first'}]});f.provider.mode=mode
    const chunks=await collect(f.llm.stream(call(mode)))
    assert.equal(f.calls.length,1,mode);assert.equal(chunks.at(-1).reason.kind,'error',mode)
  }
  const f=await fixture(t);await f.service.save({roles:{},pools:[{...pool(),failover:true}]})
  await collect(f.llm.stream(call('locked')));f.provider.mode='quota-first'
  const later=await collect(f.llm.stream(call('locked')))
  assert.deepEqual(f.calls.map(row=>row.model),['a','a']);assert.equal(later.at(-1).reason.kind,'error')
})
test('native catalog and settings actions make no inference and reject missing admission/CSRF',async t=>{
  const f=await fixture(t), catalog=await f.service.catalog()
  assert.equal(catalog.length,2);assert.equal(f.calls.length,0)
  const handler=createHandler(f.service,{token:'csrf',connection:{requestRejection:req=>req.admitted?undefined:403}})
  async function request(method,input,csrf,admitted=true){const req=Readable.from(input?[JSON.stringify(input)]:[]);Object.assign(req,{method,headers:{'x-dsh-csrf':csrf},admitted});let status,body;await handler(req,{writeHead:value=>{status=value},end:value=>{body=JSON.parse(value)}});return{status,body}}
  assert.equal((await request('GET',null,null,false)).status,403)
  assert.equal((await request('POST',{action:'save',settings:{roles:{},pools:[]}},'wrong')).status,403)
  const ok=await request('POST',{action:'catalog'},'csrf');assert.equal(ok.status,200);assert.equal(ok.body.catalog.length,2)
})
test('client registers both functional settings sections and public component exports',async()=>{
  let module;const sections=[]
  const React={createElement:(type,props,...children)=>({type,props,children})}
  runInNewContext(await readFile('src/model-orchestration/lib/client.js','utf8'),{window:{__ModuleLoader__:{load:value=>{module=value.factory(()=>React)}}}})
  module.apply({slots:{inject:(_name,callback)=>callback(),register:descriptor=>{sections.push(descriptor);return()=>{}}}})
  assert.deepEqual(sections.map(row=>row.id),['airules-role-models','airules-model-rotation'])
  assert.equal(typeof module.RoleModelsSettings,'function');assert.equal(typeof module.RotationSettings,'function')
})
test('actual package host and composition tool load against pinned native peers and verified embedded rolepack',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'airules-model-package-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const modules=join(directory,'node_modules'),pkg=join(modules,'airules-dsh-model-orchestration')
  await mkdir(modules);await cp('src/model-orchestration',pkg,{recursive:true})
  await symlink(resolve('var/asar-extract-rc5/dsh/node_modules/@deepseek-ai'),join(modules,'@deepseek-ai'),'junction')
  await symlink(resolve('src/airules-provider'),join(modules,'airules-dsh-provider'),'junction')
  const host=await import(pathToFileURL(join(pkg,'lib/index.js'))),delegation=await import(pathToFileURL(join(pkg,'lib/delegation.js')))
  const f=await fixture(t),root=new Context();const llm=new LlmRuntime(root);const registration=llm.registerAdapter(['codex'],f.provider);t.after(()=>registration());root.provide('dshHomePath',(...parts)=>join(directory,'home',...parts))
  const definitions=[],sections=[];root.provide('tools',{register:definition=>{definitions.push(definition);return()=>{}}});root.provide('systemPrompt',{section:section=>{sections.push(section);return()=>{}}})
  let actual
  root.provide('subagents',{getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true},inheritsParentContext:false}),resolveMaxDepth:()=>3,startActivation:async spec=>{actual=spec;return{childId:'actual-native-call'}}})
  const hostFiber=root.plugin(host);await hostFiber.await();t.after(()=>hostFiber.dispose())
  const rulepackRoot=resolve('dist/airules-official-policy-0.12.0-dev13/payload/packages/airules-dsh-rulepack')
  const childFiber=root.plugin(delegation,{rulepackRoot});await childFiber.await();t.after(()=>childFiber.dispose())
  assert.equal(definitions.length,1);assert.equal(definitions[0].name,'airules_delegate');assert.equal(sections[0].name,'airules:managed-delegation')
  const parent={options:{provider:'codex',model:'a',reasoningEffort:'high'},session:{requestHeader:()=>undefined}}
  const result=await definitions[0].execute({role:'developer',task:'Do not run inference; verify wiring.'},{agent:parent,signal:new AbortController().signal})
  assert.equal(result.childId,'actual-native-call');assert.equal(actual.request.agentOptions.model,'a');assert.match(actual.request.prompt[0].text,/разработчик|разработк/iu)
  assert.equal(f.calls.length,0)
})
