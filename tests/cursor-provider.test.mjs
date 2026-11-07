import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{inspectRuntime,loadRuntime}from'../src/cursor-provider/lib/runtime.js'
import{catalogOf,PROVIDER}from'../src/cursor-provider/lib/catalog.js'
import{createController}from'../src/cursor-provider/lib/controller.js'
import{createAdapter,promptOf}from'../src/cursor-provider/lib/adapter.js'
import{externalAllowed,installAccess}from'../src/cursor-provider/lib/access.js'
import{createHandler}from'../src/cursor-provider/lib/control.js'
import{Context}from'../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import{LlmAdapter,LlmRuntime,LlmError,markAgentLoopRequest,isAgentLoopRequest,resolveRetryPolicy}from'../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const temp=async t=>{const dir=await mkdtemp(join(tmpdir(),'cursor-boundary-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
const credentialStore=()=>{let record;return{async readRecord(){return record},async modifyRecord(_key,update){record=await update(record);return record},async deleteRecord(){record=undefined}}}
const waitFor=async condition=>{for(let i=0;i<100;i++){if(await condition())return;await new Promise(r=>setTimeout(r,2))}assert.fail('condition timed out')}
class ErrorBoundary extends Error{constructor(message,code){super(message);this.code=code}}
const row={id:'m',name:'M',provider:PROVIDER,cursorModel:{id:'m'},context:{contextWindow:128000}}
const originalFetch=globalThis.fetch
before(()=>{globalThis.fetch=()=>{throw new Error('NETWORK_DISABLED_IN_CURSOR_TESTS')}})
after(()=>{globalThis.fetch=originalFetch})
async function fixture(t,{tool=false,cancelHangs=false,throwRaw=false}={}){
  const root=await temp(t),calls={cancel:0,disposed:0,executions:0};let stopped=false,release
  const sdk={JsonlLocalAgentStore:class{constructor(path){this.path=path}},Agent:{async create(options){calls.options=options;return{
    async send(prompt){calls.prompt=prompt;return{
      async *stream(){if(throwRaw)throw new Error('SECRET_API_KEY');if(tool){const p=options.local.customTools.test_tool.execute({a:1});await p;calls.callbackSettled=true;return}yield{type:'assistant',message:{content:[{type:'text',text:'Hello '}]}};yield{type:'assistant',message:{content:[{type:'text',text:'world'}]}}},
      async wait(){return{status:stopped?'cancelled':'finished',usage:{inputTokens:4,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}}},
      async cancel(){calls.cancel++;stopped=true;if(cancelHangs)await new Promise(r=>release=r)},
    }},async[Symbol.asyncDispose](){calls.disposed++},
  }}}}
  const signal=new AbortController().signal,controller={async revision(){return 1},async models(){return[row]},async acquire(){return{sdk,apiKey:'synthetic-key',signal,release(){calls.released=true}}}}
  const adapter=createAdapter({Base:class{},LlmError:ErrorBoundary,controller,authorize:()=>{calls.authorized=true;return()=>{calls.revoked=true}},runsRoot:root,settlementMs:20})
  const options={provider:PROVIDER,model:'m',sessionId:'s',signal,messages:[{role:'user',content:[{type:'text',text:'Hi'}]}],tools:tool?[{name:'test_tool',description:'fixture',parameters:{type:'object'}}]:[]}
  return{root,calls,adapter,controller,options,release:()=>release?.()}
}

test('runtime inspection reads only; pins SDK own files and rejects mutation/version mismatch',async t=>{
  const root=await temp(t);await mkdir(join(root,'dist/cjs'),{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name:'@cursor/sdk',version:'1.0.38',main:'./dist/cjs/index.js'}));await writeFile(join(root,'dist/cjs/index.js'),'throw new Error("inspection must not execute")')
  const pin=await inspectRuntime(root);assert.match(pin.sha256,/^[a-f0-9]{64}$/);await writeFile(join(root,'dist/cjs/index.js'),'changed');await assert.rejects(loadRuntime(pin),{code:'CURSOR_RUNTIME_CHANGED'})
  await writeFile(join(root,'package.json'),JSON.stringify({name:'@cursor/sdk',version:'2',main:'./dist/cjs/index.js'}));await assert.rejects(inspectRuntime(root),{code:'CURSOR_SDK_VERSION'})
})
test('actual installed SDK metadata is compatible without executing or copying SDK',async t=>{
  const path='E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules/@cursor/sdk/package.json'
  let meta;try{meta=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code==='ENOENT'){t.skip('external donor runtime absent');return}throw e}
  assert.equal(meta.version,'1.0.38');assert.equal(meta.main,'./dist/cjs/index.js');assert.match(meta.license,/LICENSE/)
})
test('catalog preserves exact variants without silently routing missing model to auto',()=>{
  const models=catalogOf({models:[{id:'m',displayName:'M',variants:[{isDefault:true,params:[{id:'thinking',value:'high'}]},{params:[{id:'thinking',value:'low'}]}]}]})
  assert.equal(models.length,3);assert.deepEqual(models[0].cursorModel,{id:'m',params:[{id:'thinking',value:'high'}]});assert.ok(models.every(m=>m.id.length<128));assert.equal(models[0].contextEstimated,true)
})
test('SDK has no boot/login side effects, credentials remain isolated, explicit login uses correct callback',async t=>{
  const root=await temp(t),credentials=credentialStore();let loaded=0,authOptions
  const sdk={Cursor:{auth:{async login(options){authOptions=options;options.onLoginUrl('https://cursor.com/login?synthetic=1');return{apiKey:'DO_NOT_EXPOSE',apiKeyExpiresAtMs:Date.now()+60000}}},async me(){return{email:'test@example.invalid'}},models:{async list(){return[{id:'m'}]}}}}
  const pin={packageRoot:root,sha256:'a'.repeat(64),version:'1.0.38'}
  const controller=createController({credentials,key:'OWN_SLOT',configPath:join(root,'own.json'),inspect:async()=>pin,load:async()=>{loaded++;return sdk}});t.after(()=>controller.close())
  await controller.snapshot();assert.equal(loaded,0)
  await controller.action({action:'inspect',packageRoot:root});assert.equal(loaded,0)
  await controller.action({action:'configure',packageRoot:root,sha256:pin.sha256});await controller.action({action:'login'})
  await waitFor(async()=>(await controller.snapshot()).models.length===1)
  assert.equal(authOptions.store,null);assert.equal(authOptions.openBrowser,false);assert.ok(authOptions.signal instanceof AbortSignal)
  assert.ok(!JSON.stringify(await controller.snapshot()).includes('DO_NOT_EXPOSE'));assert.equal((await credentials.readRecord()).payload.apiKey,'DO_NOT_EXPOSE')
  await controller.action({action:'logout'});assert.equal((await controller.snapshot()).connected,false)
})
test('late login cannot resurrect a disconnected credential',async t=>{
  const root=await temp(t),credentials=credentialStore();let finish
  const controller=createController({credentials,key:'own',configPath:join(root,'own.json'),load:async()=>({Cursor:{auth:{login:()=>new Promise(r=>finish=r)}}})});t.after(()=>controller.close())
  await controller.action({action:'login'});await waitFor(()=>!!finish);await controller.action({action:'logout'});finish({apiKey:'late',apiKeyExpiresAtMs:Date.now()+60000});await new Promise(r=>setTimeout(r,10));assert.equal(await credentials.readRecord(),undefined)
})
test('untrusted login URL is rejected and never returned as a link',async t=>{
  const root=await temp(t),controller=createController({credentials:credentialStore(),key:'own',configPath:join(root,'own.json'),load:async()=>({Cursor:{auth:{async login(o){o.onLoginUrl('https://cursor.com.attacker.invalid/')}}}})});t.after(()=>controller.close())
  await controller.action({action:'login'});await waitFor(async()=>(await controller.snapshot()).phase==='error');assert.equal((await controller.snapshot()).authorizeUrl,'')
})
function accessFixture(){const handlers={},signal=new AbortController().signal,agent={session:{id:'s'},ctx:{}},ctx={agents:{get:id=>id==='s'?agent:undefined},agentPresets:{serviceFor:()=>({get:()=>({active:false})})},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},on:(name,handler)=>handlers[name]=handler};return{handlers,signal,agent,ctx}}
test('native BUILD/full access is mandatory, cannot use arbitrary claimed session IDs',()=>{
  const{ctx,agent}=accessFixture();assert.equal(externalAllowed(ctx,agent),true);assert.equal(externalAllowed(ctx,{...agent}),false);ctx.agentPresets.serviceFor=()=>({get:()=>({active:true})});assert.equal(externalAllowed(ctx,agent),false);ctx.agentPresets.serviceFor=()=>({get:()=>({active:false})});ctx.sandboxPolicy.resolve=()=>({mode:'workspace-write'});assert.equal(externalAllowed(ctx,agent),false)
})
test('stream requires native request identity + matching model + current access and consumes approval once',async()=>{
  const{ctx,handlers,signal,agent}=accessFixture(),branded=new WeakSet(),authorize=installAccess(ctx,o=>branded.has(o)),options={provider:PROVIDER,model:'m',sessionId:'s',signal}
  assert.throws(()=>authorize(options),{code:'CURSOR_NATIVE_BUILD_ACCESS_REQUIRED'})
  await handlers['agent/request']({agent,signal},()=>({...options}));assert.throws(()=>handlers['llm/stream'](options,()=>{}),{code:'CURSOR_AGENT_LOOP_REQUIRED'})
  branded.add(options);handlers['llm/stream'](options,()=>{});const release=authorize({...options});assert.throws(()=>authorize(options));release();assert.throws(()=>authorize(options))
})
test('text streaming is native, SDK only receives isolated workspace and no raw native tools',async t=>{
  const{calls,adapter,options,root}=await fixture(t),chunks=[];for await(const chunk of adapter.stream(options))chunks.push(chunk)
  assert.equal(chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'Hello world');assert.deepEqual(chunks.at(-1),{type:'finish',reason:{kind:'stop'}})
  assert.deepEqual(calls.options.tools,[]);assert.deepEqual(calls.options.disallowedTools,['task']);assert.deepEqual(calls.options.local.dirs,[]);assert.deepEqual(calls.options.local.settingSources,[]);assert.deepEqual(calls.options.mcpServers,{});assert.deepEqual(calls.options.agents,{});assert.equal(calls.options.local.enableAgentRetries,false);assert.equal(calls.cancel,1);assert.equal(calls.disposed,1);assert.deepEqual(await readdir(root),[]);assert.ok(calls.revoked)
})
test('custom tool returns control after SDK cancellation without executing DSH tool in SDK',async t=>{
  const{calls,adapter,options}=await fixture(t,{tool:true}),chunks=[];for await(const chunk of adapter.stream(options)){if(chunk.type==='tool-call-delta'){assert.equal(calls.cancel,1);assert.equal(calls.disposed,1)}chunks.push(chunk)}
  assert.equal(calls.executions,0);assert.equal(calls.callbackSettled,true);assert.deepEqual(calls.options.tools,['mcp']);assert.equal(chunks.at(-1).reason.kind,'tool-calls');assert.equal(chunks.find(c=>c.type==='tool-call-delta').argumentsDelta,'{"a":1}')
})
test('unconfirmed SDK termination prevents handoff and preserves active private workspace',async t=>{
  const{calls,adapter,options,root,release}=await fixture(t,{tool:true,cancelHangs:true}),chunks=[]
  await assert.rejects(async()=>{for await(const chunk of adapter.stream(options))chunks.push(chunk)},{code:'CURSOR_SETTLEMENT_TIMEOUT'})
  assert.equal(chunks.some(c=>c.type==='tool-call-delta'),false);assert.equal((await readdir(root)).length,1);assert.equal(calls.disposed,0);release();await waitFor(()=>calls.disposed===1)
})
test('SDK errors are redacted at native error boundary',async t=>{
  const{adapter,options}=await fixture(t,{throwRaw:true});await assert.rejects(async()=>{for await(const _ of adapter.stream(options)){}},error=>error.code==='CURSOR_SDK_STREAM_FAILED'&&!error.message.includes('SECRET'))
})
test('image input and unknown models fail before SDK Agent.create',async t=>{
  assert.throws(()=>promptOf({messages:[{content:[{type:'image',url:'https://example.invalid'}]}]}),{code:'CURSOR_TEXT_ONLY'})
  const{adapter,options,calls}=await fixture(t);await assert.rejects(async()=>{for await(const _ of adapter.stream({...options,model:'missing'})){}},{code:'CURSOR_MODEL_NOT_IN_CATALOG'});assert.equal(calls.options,undefined)
})
test('HTTP mutation rejects missing native connection and missing CSRF before touching controller',async()=>{
  let actions=0;const controller={action:()=>actions++,snapshot:async()=>({})},response=()=>({writeHead(status){this.status=status},end(){}})
  let out=response();await createHandler(controller)({method:'GET'},out);assert.equal(out.status,403)
  out=response();await createHandler(controller,{connection:{requestRejection:()=>undefined},token:'own'})({method:'POST',headers:{}},out);assert.equal(out.status,403);assert.equal(actions,0)
})
test('actual rc.5 LlmRuntime and branded request pass through native middleware into isolated SDK boundary',async t=>{
  const f=await fixture(t),ctx=new Context(),agent={session:{id:'s'},ctx:{}}
  ctx.provide('agents',{get:id=>id==='s'?agent:undefined});ctx.provide('agentPresets',{serviceFor:()=>({get:()=>({active:false})})});ctx.provide('sandboxPolicy',{resolve:()=>({mode:'danger-full-access'})})
  const authorize=installAccess(ctx,isAgentLoopRequest),llm=new LlmRuntime(ctx)
  const adapter=createAdapter({Base:LlmAdapter,LlmError,controller:f.controller,authorize,runsRoot:f.root,retryPolicy:resolveRetryPolicy({mode:'normal',maxRetries:0},'fixture')})
  const registration=llm.registerAdapter([PROVIDER],adapter);t.after(()=>registration())
  const route=await ctx.waterfall(null,'agent/request',{agent,signal:f.options.signal},()=>({provider:PROVIDER,model:'m'}))
  const prepared=await llm.prepareCall(route,f.options.signal),options=markAgentLoopRequest(Object.freeze({...f.options,...prepared.config})),chunks=[]
  for await(const chunk of prepared.stream(options))chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(f.calls.cancel,1);assert.equal(f.calls.disposed,1)
})
