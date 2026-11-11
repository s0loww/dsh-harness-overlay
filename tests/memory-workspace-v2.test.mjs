import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createMemoryWorkspace } from '../src/memory-workspace/lib/workspace.js'
import { datasetForRoot } from '../src/memory-workspace/lib/core.js'
import { createModelKeyStore } from '../src/memory-workspace/lib/model-key.js'
import { createProjectContext, selectionStore } from '../src/project-context/lib/core.js'
import { Context } from '../var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SandboxedFileSystem } from '../var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js'
const binding={namespace:'fixture-project',search:{tool:'mcp__memory_fixture__search',scopeArgument:'project',queryArgument:'query'},remember:{tool:'mcp__memory_fixture__save',scopeArgument:'project',textArgument:'text'}}
async function fixture(t){
  const base=await mkdtemp(join(tmpdir(),'memory-workspace-v2-')),root=join(base,'project'),home=join(base,'home');await mkdir(root);await mkdir(home)
  t.after(async()=>{const rel=relative(resolve(tmpdir()),base);assert.ok(!isAbsolute(rel)&&rel.startsWith('memory-workspace-v2-'));await rm(base,{recursive:true,force:true})})
  const agents=new Map(),policies=new Map(),calls=[],messages=[]
  for(const id of ['a','b']){const agent={ctx:{preset:'1c-airules'},status:'idle',session:{id,header:{id,cwd:root}},followup:async value=>messages.push(value)};agents.set(id,agent);policies.set(id,{mode:'workspace-write',workspaceRoot:root,sessionId:id})}
  const native=new Context();native.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>policies.get('a')});let fs
  const plugin=native.plugin({inject:['sandboxPolicy'],apply(ctx){fs=new SandboxedFileSystem(ctx,{cwd:root,diffBasisMaxBytes:10*1024*1024})}});await plugin.await();assert.equal(plugin.state,2);t.after(()=>native.fiber.dispose())
  const ctx={connection:{requestRejection:()=>undefined},agents:{get:id=>agents.get(id)},agentPresets:{composedPreset:ctx=>ctx.preset,serviceFor:(_agent,kind)=>kind==='fs'?fs:undefined},sandboxPolicy:{resolve:({session})=>policies.get(session.id)},approval:{request:async()=> 'allowed-once'},tools:{schemas:()=>[]},fs}
  const configPath=join(home,'config.json');await writeFile(configPath,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true}));await writeFile(join(home,'auth.json'),JSON.stringify({apiKey:'fixture-private-key'}))
  let profile={allowed:true,embeddings:{provider:'fastembed',model:'BAAI/bge-small-en-v1.5',dimensions:384},extraction:{provider:'gliner',model:'fastino/gliner2.5-base-v1'}},invalidations=0
  const processingManager={configuration:async()=>({profile,revision:'processing-v1',bindingAvailable:true,applied:{state:'observed',matchesDesired:true}}),invalidateCredential:async()=>{invalidations++},apply:async input=>{calls.push({backend:'processing',input});return{applied:true}},save:async({profile:value})=>{profile=value},catalog:async()=>({models:[]})}
  let record=null;const keyStore=createModelKeyStore({readRecord:async()=>record,modifyRecord:async(_key,fn)=>{record=fn(record)}},'fixture/key')
  let controller
  const memoriaFactory=(_ctx,{binding,execution,verifyScope})=>({status(){return{availability:'catalog-only',connected:null,operations:{search:{available:true},remember:{available:true}}}},async recall(input){verifyScope();const allowed=await controller.gate({name:binding.search.tool,parent:execution.token,agent:execution.agent,signal:execution.signal},async()=>({kind:'allow'}));assert.equal(allowed.kind,'allow');calls.push({backend:'memoria',action:'recall',namespace:binding.namespace,input});return{results:[{text:'Memoria fixture',source:{recordId:'m1'}}]}},async remember(input){verifyScope();calls.push({backend:'memoria',action:'remember',namespace:binding.namespace,input});return{state:'stored',recordId:'m1',indexed:null,namespace:binding.namespace}}})
  const serviceFactory=()=>Object.fromEntries(['status','listDocuments','recall','graph','remember','process','task'].map(action=>[action,async(root,input)=>{calls.push({backend:'cognee',action,root,input});if(action==='remember')return{state:'uploaded',indexed:false,dataset:datasetForRoot(root),contentHash:'a'.repeat(64)};if(action==='recall')return{results:[{text:'Cognee fixture',document_id:'c1'}]};return{documents:[],nodes:[],edges:[],capabilities:{recall:true,process:true}}}]))
  controller=createMemoryWorkspace(ctx,{configPath,processingManager,keyStore,serviceFactory,memoriaFactory,createUserMessage:value=>value})
  async function request(method,input,csrf){let status,value;const req=Readable.from(method==='POST'?[JSON.stringify(input)]:[]);Object.assign(req,{method,url:'/?'+new URLSearchParams(input),headers:{'content-type':'application/json',...(csrf?{'x-airules-csrf':csrf}:{})}});await controller.handler(req,{writeHead:code=>{status=code},end:text=>{value=JSON.parse(text)}});return{status,value}}
  const initial=await request('GET',{action:'configuration'})
  const exec=id=>({agent:agents.get(id),callId:'fixture-'+id,token:Symbol(id),signal:new AbortController().signal})
  return{controller,ctx,agents,policies,root,home,calls,messages,keyStore,processingManager,request,exec,csrf:initial.value.csrfToken,initial:initial.value,get invalidations(){return invalidations}}
}
async function global(f,mode,writeTarget='auto'){const view=await f.controller.configuration();return f.request('POST',{action:'policyGlobal',policy:{schemaVersion:1,mode,writeTarget},expectedRevision:view.policy.globalRevision},f.csrf)}
async function project(f,mode='inherit',writeTarget='inherit'){const view=await f.controller.configuration({sessionId:'a'});return f.request('POST',{action:'projectPolicy',sessionId:'a',policy:{schemaVersion:1,mode,writeTarget,memoria:binding},expectedRevision:view.policy.projectRevision},f.csrf)}
test('global mode and model/key preferences work without a chat; stale/closed/standard executor never hides them',async t=>{
  const f=await fixture(t);assert.equal(f.initial.scope,null);assert.equal(f.initial.policy.effective.mode,'cognee')
  assert.equal((await global(f,'both')).status,200)
  const closed=await f.controller.configuration({sessionId:'closed'});assert.equal(closed.scope,null);assert.equal(closed.policy.effective.mode,'both');assert.ok(closed.projectError)
  f.agents.get('a').ctx.preset='standard'
  const standard=await f.controller.configuration({sessionId:'a'});assert.equal(standard.scope,null);assert.equal(standard.processing.profile.embeddings.provider,'fastembed')
  assert.equal(f.calls.length,0)
})
test('project override is shared by chats, persisted through native FS, and read-only cannot change it',async t=>{
  const f=await fixture(t);await global(f,'both');assert.equal((await project(f,'memoria')).status,200)
  assert.equal((await f.controller.configuration({sessionId:'b'})).policy.effective.mode,'memoria')
  assert.equal(JSON.parse(await readFile(join(f.root,'.dsh/memory.json'),'utf8')).mode,'memoria')
  f.policies.get('a').mode='read-only';assert.equal((await project(f,'cognee')).status,400)
  assert.equal((await f.controller.configuration({sessionId:'b'})).policy.effective.mode,'memoria')
})
test('both recall preserves sources, native MCP gate requires router parent, and stale policy refuses before reads',async t=>{
  const f=await fixture(t);await global(f,'both');await project(f)
  const response=await f.controller.act({action:'recall',sessionId:'a',query:'fixture'},f.exec('a'))
  assert.equal(response.status,'complete');assert.deepEqual(Object.keys(response.backends),['memoria','cognee']);assert.deepEqual(response.results.map(row=>row.backend),['memoria','cognee'])
  assert.equal((await f.controller.gate({name:binding.search.tool,agent:f.agents.get('a')},async()=>({kind:'allow'}))).kind,'deny')
  const originalPolicy=f.policies.get('a');f.policies.set('a',{...originalPolicy,sessionId:'stale'})
  assert.equal((await f.controller.gate({name:binding.search.tool,agent:f.agents.get('a')},async()=>({kind:'allow'}))).kind,'deny')
  f.policies.set('a',originalPolicy)
  const view=await f.controller.configuration({sessionId:'a'});await global(f,'cognee');const before=f.calls.length
  await assert.rejects(f.controller.act({action:'recall',sessionId:'a',query:'fixture',expectedPolicyRevision:view.policy.policyRevision},f.exec('a')),/MEMORY_POLICY_STALE/)
  assert.equal(f.calls.length,before)
})
test('both writes keep two durable receipts and preserve native approval; Cognee-only mode does not write Memoria',async t=>{
  const f=await fixture(t);await global(f,'both','both');await project(f)
  const input={action:'remember',sessionId:'a',text:'Verified fixture source=unit',title:'Fixture',confirm:true}
  const result=await f.controller.act(input,f.exec('a'));assert.equal(result.status,'complete');assert.equal(f.calls.filter(row=>row.action==='remember').length,2)
  const again=await f.controller.act({...input,sessionId:'b'},f.exec('b'));assert.equal(again.status,'complete');assert.equal(f.calls.filter(row=>row.action==='remember').length,2)
  await global(f,'cognee');await f.controller.act({...input,text:'Different fixture'},f.exec('a'))
  assert.equal(f.calls.at(-1).backend,'cognee')
  await assert.rejects(f.controller.act({...input,backend:'memoria'},f.exec('a')),/MEMORY_BACKEND_DISABLED/)
})
test('UI write/apply only queues exact policy/profile intent and never contains an API key',async t=>{
  const f=await fixture(t);await project(f)
  f.policies.get('a').mode='danger-full-access'
  const response=await f.request('POST',{action:'processingApply',sessionId:'a',confirm:true,expectedRevision:'processing-v1'},f.csrf)
  assert.equal(response.value.submitted,true);assert.equal(f.calls.length,0)
  const text=f.messages[0].content[0].text;assert.ok(text.includes('expectedProcessingRevision'));assert.ok(text.includes('processing-v1'));assert.ok(text.includes('expectedPolicyRevision'))
  assert.equal((await f.request('GET',{action:'processingApply',sessionId:'a'})).status,405)
})
test('credential save uses native store CAS, never echoes the secret or queues it; invalidation is explicit',async t=>{
  const f=await fixture(t),secret='sk-or-v1-test-fixture-secret',credential=f.initial.processing.openRouterCredential
  const denied=await f.request('POST',{action:'processingCredentialSave',secret,expectedRevision:credential.revision});assert.equal(denied.status,403)
  const saved=await f.request('POST',{action:'processingCredentialSave',secret,expectedRevision:credential.revision},f.csrf)
  assert.equal(saved.status,200);assert.equal(JSON.stringify(saved).includes(secret),false);assert.equal(f.invalidations,1)
  const view=await f.controller.configuration();assert.equal(view.processing.openRouterCredential.configured,true);assert.equal(JSON.stringify(view).includes(secret),false)
  assert.equal((await f.request('POST',{action:'processingCredentialSave',secret:'sk-or-v1-different-fixture',expectedRevision:credential.revision},f.csrf)).status,409)
  assert.equal(f.messages.length,0);assert.equal(await f.keyStore.resolve(),secret)
})
async function coldFixture(t){
  const f=await fixture(t),other=join(f.home,'other-project');await mkdir(other)
  f.agents.clear();f.ctx.sessions={get:()=>undefined};let creates=0
  f.ctx.agents.create=()=>{creates++;throw Error('no agent creation')};f.ctx.agents.resume=()=>{creates++;throw Error('no agent resume')}
  f.policies.set('other',{mode:'workspace-write',workspaceRoot:other,sessionId:'other'})
  f.ctx.sandboxPolicy.resolve=({session})=>({...f.policies.get(session.id)})
  const headers=new Map([['a',{id:'a',cwd:f.root,agentPreset:'1c-airules'}],['b',{id:'b',cwd:f.root,agentPreset:'1c-airules'}],['other',{id:'other',cwd:other,agentPreset:'python-airules'}]])
  f.ctx.sessionPersistence={stat:async id=>({header:headers.get(id),eventCount:0,sizeBytes:100}),open:async id=>({header:headers.get(id),read:async()=>({events:[]}),close:async()=>{}})}
  f.ctx.sessionProjections={restore:(_state,_events,_zero,header)=>({checkpoint:{sandboxMode:{val:f.policies.get(header.id).mode},agentPreset:{val:header.agentPreset}}})}
  f.ctx.workspaceRegistry={list:()=>[{id:'one',path:f.root,title:'One',sessionIds:['a','b']},{id:'two',path:other,title:'Two',sessionIds:['other']}]}
  const projects=createProjectContext(f.ctx,{store:selectionStore(join(f.home,'project-selection.json'))})
  f.controller.handler=projects.bindHandler(f.controller.handler,{presets:['1c-airules','python-airules','sysadmin-airules'],allowGlobalActions:['policyGlobal','processingSave','processingCredentialSave','processingModels','processingStatus']})
  const view=(sessionId='a',projectId='one')=>f.request('GET',{action:'configuration',projectId,sessionId})
  const save=(policy,revision,sessionId='a',projectId='one')=>f.request('POST',{action:'projectPolicy',projectId,sessionId,policy,expectedRevision:revision},f.csrf)
  return{...f,other,view,save,get creates(){return creates}}
}
test('cold native project preferences load and save through a private lease without creating an agent',async t=>{
  const f=await coldFixture(t),initial=await f.view();assert.equal(initial.status,200);assert.ok(!initial.value.projectError)
  assert.deepEqual(initial.value.scope,{projectRoot:f.root,dataset:datasetForRoot(f.root),writable:true,globalWritable:false,active:false,executorAvailable:false})
  const changed=await f.save({schemaVersion:1,mode:'both',writeTarget:'auto'},initial.value.policy.projectRevision)
  assert.equal(changed.status,200);assert.equal(changed.value.policy.effective.mode,'both');assert.equal(changed.value.scope.active,false)
  const second=await f.view('b');assert.equal(second.value.policy.effective.mode,'both');assert.equal(second.value.policy.policyRevision,changed.value.policy.policyRevision)
  const unrelated=await f.view('other','two');assert.equal(unrelated.value.policy.effective.mode,'cognee')
  assert.equal((await f.save({schemaVersion:1,mode:'memoria',writeTarget:'auto'},initial.value.policy.projectRevision)).status,409)
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'.dsh/memory.json'),'utf8')),{schemaVersion:1,mode:'both',writeTarget:'auto'})
  assert.equal(f.creates,0);assert.equal(f.messages.length,0);assert.equal(f.calls.length,0)
})
test('cold native read-only authority can inspect but cannot save project memory preferences',async t=>{
  const f=await coldFixture(t);f.policies.get('a').mode='read-only'
  const view=await f.view();assert.equal(view.status,200);assert.equal(view.value.scope.writable,false);assert.equal(view.value.scope.globalWritable,false)
  const denied=await f.save({schemaVersion:1,mode:'both',writeTarget:'auto'},view.value.policy.projectRevision)
  assert.equal(denied.value.error,'MEMORY_WRITE_REQUIRED');assert.equal(existsSync(join(f.root,'.dsh/memory.json')),false)
  assert.equal(f.creates,0);assert.equal(f.calls.length,0)
})
test('cold scope permits global/model preferences but never authorizes memory calls, MCP or processing',async t=>{
  const f=await coldFixture(t),view=await f.view()
  const global=await f.request('POST',{action:'policyGlobal',projectId:'one',sessionId:'a',policy:{schemaVersion:1,mode:'both',writeTarget:'auto'},expectedRevision:view.value.policy.globalRevision},f.csrf);assert.equal(global.status,200)
  const selected=await f.request('POST',{action:'processingSave',projectId:'one',sessionId:'a',profile:view.value.processing.profile,expectedRevision:view.value.processing.revision},f.csrf);assert.equal(selected.status,200)
  assert.equal((await f.request('GET',{action:'processingModels',projectId:'one',sessionId:'a',kind:'embeddings',provider:'fastembed'})).status,200)
  for(const action of ['status','documents','graph','task','memoraCatalog'])assert.equal((await f.request('GET',{action,projectId:'one',sessionId:'a'})).value.error,'MEMORY_ACTIVE_PROJECT_REQUIRED')
  for(const action of ['recall','remember','process','processingApply'])assert.equal((await f.request('POST',{action,projectId:'one',sessionId:'a',confirm:true,query:'fixture',text:'fixture'},f.csrf)).value.error,'MEMORY_ACTIVE_PROJECT_REQUIRED')
  assert.equal(f.calls.length,0);assert.equal(f.messages.length,0);assert.equal(f.creates,0)
})
test('revoking cold authority after save lock acquisition preserves the existing project policy',async t=>{
  const f=await coldFixture(t),initial=await f.view();await f.save({schemaVersion:1,mode:'both',writeTarget:'auto'},initial.value.policy.projectRevision)
  const current=await f.view(),file=join(f.root,'.dsh/memory.json'),before=await readFile(file)
  f.ctx.sandboxPolicy.resolve=({session})=>{if(existsSync(file+'.lock'))f.policies.get(session.id).mode='read-only';return{...f.policies.get(session.id)}}
  const denied=await f.save({schemaVersion:1,mode:'memoria',writeTarget:'auto'},current.value.policy.projectRevision)
  assert.equal(denied.value.error,'PROJECT_SCOPE_CHANGED');assert.deepEqual(await readFile(file),before);assert.equal(existsSync(file+'.lock'),false)
})
test('cold project memory policy refuses junction and hardlink aliases without affecting global preferences',async t=>{
  const f=await coldFixture(t),external=join(f.other,'private');await mkdir(external);const file=join(external,'memory.json'),bytes=JSON.stringify({schemaVersion:1,mode:'memoria',writeTarget:'auto'});await writeFile(file,bytes)
  await symlink(external,join(f.root,'.dsh'),process.platform==='win32'?'junction':'dir')
  const view=await f.view();assert.equal(view.status,200);assert.equal(view.value.scope,null);assert.equal(view.value.projectError,'MEMORY_PROJECT_LINK_REJECTED');assert.equal(view.value.policy.effective.mode,'cognee')
  assert.equal((await f.save({schemaVersion:1,mode:'both',writeTarget:'auto'},'missing')).value.error,'MEMORY_PROJECT_LINK_REJECTED');assert.equal(await readFile(file,'utf8'),bytes)
  await rm(join(f.root,'.dsh'));await mkdir(join(f.root,'.dsh'));await link(file,join(f.root,'.dsh/memory.json'))
  const linked=await f.view();assert.equal(linked.value.projectError,'MEMORY_PROJECT_LINK_REJECTED');assert.equal(linked.value.scope,null)
  assert.equal((await f.save({schemaVersion:1,mode:'both',writeTarget:'auto'},'missing')).value.error,'MEMORY_PROJECT_LINK_REJECTED');assert.equal(await readFile(file,'utf8'),bytes)
})
