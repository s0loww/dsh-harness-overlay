import test from'node:test'
import assert from'node:assert/strict'
import{readFile,mkdtemp,writeFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{pathToFileURL}from'node:url'
import{resolveNativeHostOptions,installAcceptanceModelSelection,assertAcceptancePreStep}from'../scripts/native-host-options.mjs'
const modules=resolve('var/host-upgrade/rc022/asar/dsh/node_modules'),releaseLockPath=resolve('upstream/official-desktop/0.2.2-rc.1/release.lock.json')
test('live runtime resolution preserves rc5 defaults and requires exact explicit022 native source/lock',async t=>{
 const old=await resolveNativeHostOptions();assert.equal(old.hostVersion,'0.2.1-rc.5')
 const next=await resolveNativeHostOptions({nativeModules:modules,releaseLockPath});assert.equal(next.hostVersion,'0.2.2-rc.1');assert.equal(next.nativeModules,modules)
 await assert.rejects(resolveNativeHostOptions({releaseLockPath}),/NATIVE_MODULES_REQUIRED/)
 await assert.rejects(resolveNativeHostOptions({nativeModules:old.nativeModules,releaseLockPath}),/NATIVE_VERSION_MISMATCH/)
 const root=await mkdtemp(join(tmpdir(),'airules-live-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));const lock=JSON.parse(await readFile(releaseLockPath));lock.hostVersion='0.2.2-rc.2';await writeFile(join(root,'lock.json'),JSON.stringify(lock))
 await assert.rejects(resolveNativeHostOptions({nativeModules:modules,releaseLockPath:join(root,'lock.json')}),/VERSION_UNSUPPORTED/)
})
test('actual022 AgentModel selection is persisted before native pre-step listener installation; route drift fails locally',async()=>{
 const {AgentModel,installModelSelection}=await import(pathToFileURL(join(modules,'@deepseek-ai/dsh-agent/lib/index.js')))
 const route={provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'medium',maxTokens:4096},state={pending:null,lastUsed:null},events=[]
 const session={append(type,data){events.push(type);state.pending=data},requestHeader(){return undefined}}
 const agent={model:new AgentModel(()=>state,session,{})},listeners=[]
 installAcceptanceModelSelection({scope:{on(type,callback){events.push(type);listeners.push(callback)}},agent,route,hostVersion:'0.2.2-rc.1',installModelSelection})
 assert.deepEqual(events,['model/selection','agent/pre-step']);assert.deepEqual(agent.model.current(),{provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort})
 assertAcceptancePreStep({modelSelection:agent.model.current()},route)
 assert.throws(()=>assertAcceptancePreStep({modelSelection:{...route,reasoningEffort:'low'}},route),/PRESTEP_ROUTE_DRIFT/)
 const decision={kind:'enter',messages:[]};assert.equal(await listeners[0]({agent:{session},messages:[],signal:new AbortController().signal,step:1,modelSelection:agent.model.current()},async()=>decision),decision)
 let args;installAcceptanceModelSelection({scope:{},agent:{},route,hostVersion:'0.2.1-rc.5',installModelSelection(...values){args=values}});assert.deepEqual(args[1],{current:route,assembled:undefined})
})
