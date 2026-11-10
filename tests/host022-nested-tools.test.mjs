import test from'node:test'
import assert from'node:assert/strict'
import{mkdtemp,mkdir,readFile,writeFile,symlink,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{resolve,join}from'node:path'
import{pathToFileURL}from'node:url'
const sdk=resolve('var/host-upgrade/rc022/asar/dsh/node_modules'),native=join(sdk,'@deepseek-ai')
const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js')))
const {ToolsService,defineTool}=await import(pathToFileURL(join(native,'dsh-tools/lib/index.js')))
const {NativeToolExecutor}=await import(pathToFileURL(join(native,'dsh-tool-executor-native/lib/index.js')))
const {createScope}=await import(pathToFileURL(join(native,'dsh-scope/lib/index.js')))
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'airules-nested022-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(sdk,join(root,'node_modules'),'junction');await writeFile(join(root,'helper.js'),await readFile('src/native-tools-compat/rc022.js'));const {executeNativeTool}=await import(pathToFileURL(join(root,'helper.js')))
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){},section(){return()=>{}},getSectionOrder(){return 0}});let tools,owner,disposeExecutor
 const service=ctx.plugin({inject:['systemPrompt'],apply(scope){tools=new ToolsService(scope)}});await service.await()
 const plugin=ctx.plugin({inject:['tools'],apply(scope){owner=scope;disposeExecutor=scope.tools.setExecutor(new NativeToolExecutor(scope))}});await plugin.await();assert.equal(plugin.state,2)
 t.after(()=>ctx.fiber.dispose());return{ctx,tools,owner,executeNativeTool,root,disposeExecutor}
}
function tool(name,execute){return defineTool({name,description:'fixture',parameters:{},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},additionalProperties:false},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}},execute})}

test('real022 registry pipeline preserves nested parent, Agent, root correlation and final result observers',async t=>{
 const f=await fixture(t),parent=Symbol('outer'),agent={session:{id:'fixture'}};let body,observed
 f.owner.tools.register(tool('nested_fixture',(_args,exec)=>{body=exec;return{ok:true}}))
 f.owner.on('tools/result',(exec,result)=>{observed={exec,result}})
 const result=await f.executeNativeTool(f.owner,{name:'nested_fixture',arguments:{},agent,parent,callId:'nested',rootCallId:'outer',signal:new AbortController().signal})
 assert.equal(result.isError,false);assert.deepEqual(result.value,{ok:true});assert.equal(body.parent,parent);assert.equal(body.agent,agent);assert.equal(body.rootCallId,'outer');assert.notEqual(body.token,parent);assert.equal(observed.exec.token,body.token);assert.equal(observed.result,result)
})

test('real022 scoped guards and approval denial remain authoritative for nested calls',async t=>{
 const f=await fixture(t),parent=Symbol('outer'),agent={session:{id:'fixture'}};let invoked=0,asked=0
 f.owner.tools.register(tool('nested_fixture',()=>{invoked++;return{ok:true}}))
 const scope=createScope(f.owner,agent);scope.ctx.tools.guard(exec=>{assert.equal(exec.parent,parent);return 'SCOPED_DENIED'})
 const input={name:'nested_fixture',arguments:{},agent,parent,callId:'nested',rootCallId:'outer'}
 let result=await f.executeNativeTool(f.owner,input);assert.equal(result.isError,true);assert.match(result.content[0].text,/SCOPED_DENIED/);assert.equal(invoked,0)
 await scope.dispose()
 f.ctx.provide('approval',{async request(request){asked++;assert.equal(request.agent,agent);return'rejected'}})
 f.owner.on('tools/pre-execute',async(exec,next)=>({kind:'ask',reason:'fixture approval'}))
 result=await f.executeNativeTool(f.owner,input);assert.equal(result.isError,true);assert.equal(asked,1);assert.equal(invoked,0)
})

test('real022 nested dispatch rechecks a tool revoked during native approval and never invokes body',async t=>{
 const f=await fixture(t),agent={session:{id:'fixture'}},parent=Symbol('outer');let invoked=0
 const registration=f.owner.tools.register(tool('nested_fixture',()=>{invoked++;return{ok:true}}))
 f.ctx.provide('approval',{async request(){registration();return'allowed-once'}})
 f.owner.on('tools/pre-execute',async()=>({kind:'ask'}))
 const result=await f.executeNativeTool(f.owner,{name:'nested_fixture',arguments:{},agent,parent,callId:'nested',rootCallId:'outer'})
 assert.equal(result.isError,true);assert.equal(invoked,0);assert.match(result.content[0].text,/not found|unknown|available/i)
})



test('real022 nested helper refuses executor revocation during approval and honors cancellation',async t=>{
 const f=await fixture(t),agent={session:{id:'fixture'}};let invoked=0
 f.owner.tools.register(tool('nested_fixture',()=>{invoked++;return{ok:true}}))
 const stopped=new AbortController();stopped.abort()
 const input={name:'nested_fixture',arguments:{},agent,parent:Symbol('outer'),callId:'nested',rootCallId:'outer'}
 const result=await f.executeNativeTool(f.owner,{...input,signal:stopped.signal});assert.equal(result.isError,true);assert.equal(invoked,0)
 f.ctx.provide('approval',{async request(){f.disposeExecutor();return'allowed-once'}})
 f.owner.on('tools/pre-execute',async()=>({kind:'ask'}))
 await assert.rejects(f.executeNativeTool(f.owner,input),/executor.*unavailable/i);assert.equal(invoked,0)
})

test('actual general-tools bundledNode product executes native child under original parent authority',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'lib'))
 for(const file of ['render.js','style.js'])await writeFile(join(f.root,'lib',file),await readFile('src/general-tools/lib/'+file))
 await writeFile(join(f.root,'lib/native-tools.js'),await readFile('src/native-tools-compat/rc022.js'))
 const {bundledNode}=await import(pathToFileURL(join(f.root,'lib/render.js')))
 let outerToken,child
 f.owner.tools.register(defineTool({name:'load_workspace_dependencies',description:'fixture',parameters:{},output:{schema:{type:'object',properties:{node:{type:'string'}},additionalProperties:false},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}},execute(_args,exec){child=exec;return{node:process.execPath}}}))
 f.owner.tools.register(tool('product_outer',async(_args,exec)=>{outerToken=exec.token;assert.equal(await bundledNode(f.owner,exec),process.execPath);return{ok:true}}))
 const result=await f.executeNativeTool(f.owner,{name:'product_outer',arguments:{},agent:{session:{id:'fixture'}},callId:'product-outer'})
 assert.equal(result.isError,false);assert.equal(child.parent,outerToken);assert.equal(child.rootCallId,'product-outer');assert.equal(child.callId,'product-outer:mermaid-runtime')
})


test('production background workbench retains native job ownership after outer return, including cancellation and foreign job_output denial', {timeout:15000}, async t=>{
 const f=await fixture(t)
 const waitFor=async(predicate)=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('BACKGROUND_FIXTURE_WAIT_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,1))}}
 const {LocalJobRegistry}=await import(pathToFileURL(join(native,'dsh-jobs-local/lib/index.js')))
 const jobTools=await import(pathToFileURL(join(native,'dsh-tool-jobs/lib/index.js')))
 const agent={id:'background-owner',session:{id:'background-owner',header:{id:'background-owner',cwd:f.root,agentPreset:'1c-airules'},append(){return{seq:1}}},status:'idle',inbox:{nextStep:[],remove(){}},inject(){},followup(){throw Error('MODEL_WAKE_FORBIDDEN')}}
 const scoped=createScope(f.owner,agent);agent.ctx=scoped.ctx
 f.ctx.provide('agents',{get:id=>id===agent.id?agent:undefined})
 f.ctx.provide('sessions',{get:id=>id===agent.id?agent.session:undefined})
 f.ctx.provide('sessionProjections',{stateOf:()=> '1c-airules'})
 f.ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:f.root})})
 const registry=f.ctx.plugin({inject:['agents'],apply(scope){new LocalJobRegistry(scope,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:65536,pumpPollMs:5})}});await registry.await();assert.equal(registry.state,2)
 const control=f.ctx.plugin(jobTools,{completionDelivery:'quiet',inlineOutputBytes:0});await control.await();assert.equal(control.state,2)
 await mkdir(join(f.root,'workbench/lib'),{recursive:true});await writeFile(join(f.root,'workbench/package.json'),'{"type":"module"}')
 for(const file of ['workbench.js','session.js'])await writeFile(join(f.root,'workbench/lib',file),await readFile('src/onec-panels/lib/'+file))
 await writeFile(join(f.root,'workbench/lib/native-tools.js'),await readFile('src/native-tools-compat/rc022.js'))
 const {createWorkbench}=await import(pathToFileURL(join(f.root,'workbench/lib/workbench.js')))
 let owner,workbench
 const mounted=f.ctx.plugin({inject:['tools','jobs','sessions','sessionProjections','sandboxPolicy'],apply(scope){owner=scope;workbench=createWorkbench(scope,{configPath:join(f.root,'background.json')})}});await mounted.await()
 const config=await workbench.configuration();await workbench.save({readOnlyTools:['mcp__synthetic__read'],timeoutMs:5000},config.revision)
 let approval,approvalCount=0,outerToken,child,outerReturned=false,hold=false,childAborted=false
 f.ctx.provide('approval',{async request(input){assert.equal(input.agent,agent);approvalCount++;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FIXTURE_APPROVAL_TIMEOUT')),2000);approval=()=>{clearTimeout(timer);resolve()}});return'allowed-once'}})
 owner.on('tools/pre-execute',async(exec,next)=>exec.name==='mcp__synthetic__read'?{kind:'ask',reason:'synthetic readonly MCP approval'}:next())
 owner.tools.register(defineTool({name:'mcp__synthetic__read',description:'synthetic local read only',parameters:{},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},additionalProperties:false},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}},async execute(_args,exec){child=exec;assert.equal(outerReturned,true);assert.equal(exec.parent,outerToken);assert.equal(exec.agent,agent);if(hold)await new Promise(resolve=>exec.signal.addEventListener('abort',()=>{childAborted=true;resolve()},{once:true}));return{ok:true}}}))
 owner.tools.register(defineTool({name:'background_fixture',description:'production background wrapper',parameters:{},output:{schema:{type:'object',additionalProperties:true},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}},execute(_args,exec){outerToken=exec.token;return workbench.background({tool:'mcp__synthetic__read',arguments:{}},exec)}}))
 const outer=await f.executeNativeTool(owner,{name:'background_fixture',arguments:{},agent,callId:'background-outer'});assert.equal(outer.isError,false);outerReturned=true
 const jobId=outer.value.jobId;assert.equal(owner.jobs.list(agent.id).find(job=>job.id===jobId).status,'running')
 await waitFor(()=>!!approval);approval();approval=undefined
 const output=await f.executeNativeTool(owner,{name:'job_output',arguments:{job_id:jobId,wait:true,timeout_ms:1000},agent,callId:'collect-owned'})
 assert.equal(output.isError,false);assert.equal(output.value.job.status,'completed');assert.match(output.value.text,/ok/);assert.equal(child.rootCallId,'background-outer');assert.equal(approvalCount,1)
 const foreign=await f.executeNativeTool(owner,{name:'job_output',arguments:{job_id:jobId},agent:{id:'foreign-owner',session:{id:'foreign-owner'}},callId:'collect-foreign'})
 assert.equal(foreign.isError,true);assert.match(foreign.content[0].text,/another session/)
 hold=true;outerReturned=false
 const second=await f.executeNativeTool(owner,{name:'background_fixture',arguments:{},agent,callId:'cancel-outer'});assert.equal(second.isError,false);outerReturned=true
 await waitFor(()=>!!approval);approval()
 await waitFor(()=>child?.rootCallId==='cancel-outer')
 owner.jobs.kill(second.value.jobId,agent.id,'fixture cancellation')
 const cancelled=await f.executeNativeTool(owner,{name:'job_output',arguments:{job_id:second.value.jobId,wait:true,timeout_ms:1000},agent,callId:'collect-cancelled'})
 assert.equal(cancelled.isError,false);assert.equal(cancelled.value.job.status,'killed');assert.equal(childAborted,true)
})
