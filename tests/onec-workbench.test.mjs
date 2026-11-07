import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {normalizeGraph,createGraphStore,backgroundConfig,createWorkbench,workbenchHandler} from '../src/onec-panels/lib/workbench.js'

const graph={nodes:[{id:'a',name:'<script>literal</script>'},{id:'b',name:'B'}],edges:[{source:'a',target:'b',type:'calls'}]}
const result=value=>({isError:false,value:{structuredContent:value}})
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'dsh-workbench-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const agent={id:'one',session:{id:'one',header:{id:'one',cwd:root,agentPreset:'1c-airules'}}}
 const jobs=new Map();let nested,jobRun
 const ctx={connection:{requestRejection:()=>undefined},sessions:{get:id=>id==='one'?agent.session:undefined},sessionPersistence:{stat:async()=>undefined},sessionProjections:{stateOf:()=> '1c-airules'},sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:root})},
 tools:{get:name=>name==='mcp__fixture__read'?{}:null,execute:async input=>{nested=input;return result(graph)}},
 jobs:{list:()=>[...jobs.values()],start(options){jobs.set('job1',{id:'job1',owner:options.owner,kind:options.kind,status:'running'});jobRun=options.run;return 'job1'},kill(id,owner){assert.equal(jobs.get(id).owner,owner);jobs.get(id).status='stopping'}}}
 const service=createWorkbench(ctx,{configPath:join(root,'background.json')})
 return{root,ctx,agent,service,jobs,get nested(){return nested},get jobRun(){return jobRun}}
}
async function http(ctx,service,method,input,token){let status,body;const raw=JSON.stringify(input);const req={method,url:'/?'+new URLSearchParams(input),headers:{'x-airules-csrf':token},async *[Symbol.asyncIterator](){yield raw}};await workbenchHandler(ctx,service)(req,{writeHead(code){status=code},end(text){body=JSON.parse(text)}});return{status,body}}

test('graph preserves literal labels and rejects malformed identities; bounded view discloses omitted edges',()=>{
 assert.equal(normalizeGraph({structuredContent:graph}).nodes[0].label,'<script>literal</script>')
 assert.throws(()=>normalizeGraph({nodes:[{id:'a'},{id:'a'}],edges:[]} ),/IDENTITIES/)
 assert.throws(()=>normalizeGraph({content:[{type:'text',text:'not json'}]}))
 const full={nodes:Array.from({length:121},(_,id)=>({id:String(id)})),edges:[{from:'0',to:'120'}]}
 const view=normalizeGraph(full);assert.equal(view.nodes.length,120);assert.equal(view.edges.length,0);assert.equal(view.truncated,true)
 assert.equal(normalizeGraph({data:{graph,degraded:true,next_cursor:'next'}}).degraded,true)
})
test('observed graphs are isolated by session and exact project root and expire',async t=>{
 const {root,agent}=await setup(t);let now=100;const store=createGraphStore({now:()=>now}),exec={agent,name:'mcp__fixture__graph',callId:'observed',arguments:{projectId:'project'}}
 assert.equal(store.capture({...exec,name:'read'},result(graph)),false)
 assert.equal(store.capture(exec,{isError:true}),false)
 assert.equal(store.capture(exec,result(graph)),true)
 assert.equal(store.get('other',root),null);assert.equal(store.get('one',join(root,'other')),null)
 const view=store.get('one',root);assert.equal(view.callId,'observed');view.nodes[0].label='mutated';assert.notEqual(store.get('one',root).nodes[0].label,'mutated')
 now+=1800001;assert.equal(store.get('one',root),null)
})
test('background configuration rejects broad names and stale concurrent writes',async t=>{
 const {service}=await setup(t);for(const value of [{readOnlyTools:['*']},{readOnlyTools:['shell']},{timeoutMs:1800001},{readOnlyTools:['mcp__x','mcp__x']}])assert.throws(()=>backgroundConfig(value))
 const initial=await service.configuration();await service.save({readOnlyTools:['mcp__fixture__read'],timeoutMs:1000},initial.revision)
 await assert.rejects(service.save({},initial.revision),/STALE/)
})
test('background execution uses reviewed registered tool and native parent token, without altering original result',async t=>{
 const fixture=await setup(t),{service,agent}=fixture;const config=await service.configuration();await service.save({readOnlyTools:['mcp__fixture__read'],timeoutMs:1000},config.revision)
 const token={native:true},exec={agent,name:'airules_background_call',callId:'wrapper',rootCallId:'root',token}
 await assert.rejects(service.background({tool:'mcp__other__write',arguments:{}},exec),/NOT_REVIEWED/)
 const queued=await service.background({tool:'mcp__fixture__read',arguments:{limit:3}},exec);assert.equal(queued.jobId,'job1')
 let output='';const running=fixture.jobRun({append:chunk=>output+=chunk});const completed=await running.done
 assert.equal(completed.status,'completed');assert.equal(fixture.nested.parent,token);assert.equal(fixture.nested.rootCallId,'root');assert.equal(fixture.nested.agent,agent);assert.ok(output.includes('nodes'))
})
test('owned cancellation remains killed even when underlying MCP resolves successfully after abort',async t=>{
 const fixture=await setup(t),{service,agent,ctx}=fixture;const config=await service.configuration();await service.save({readOnlyTools:['mcp__fixture__read']},config.revision)
 let resolveCall;ctx.tools.execute=()=>new Promise(resolve=>{resolveCall=resolve})
 await service.background({tool:'mcp__fixture__read',arguments:{}},{agent,name:'airules_background_call',callId:'wrapper',token:{}})
 const running=fixture.jobRun({append(){}});await Promise.resolve();running.cancel();resolveCall(result(graph));assert.equal((await running.done).status,'killed')
})
test('HTTP requires native admission and CSRF; cancellation accepts only own running job',async t=>{
 const {service,ctx,jobs}=await setup(t)
 assert.equal((await http({...ctx,connection:undefined},service,'GET',{action:'configuration'})).status,403)
 assert.equal((await http(ctx,service,'POST',{action:'configuration',config:{}},'wrong')).status,403)
 const config=await http(ctx,service,'GET',{action:'configuration'});assert.equal(config.status,200)
 jobs.set('other',{id:'other',owner:'two',status:'running'});assert.equal((await http(ctx,service,'POST',{action:'cancel',sessionId:'one',jobId:'other',confirm:true},service.csrfToken)).status,400)
 jobs.set('mine',{id:'mine',owner:'one',status:'running'});assert.equal((await http(ctx,service,'POST',{action:'cancel',sessionId:'one',jobId:'mine',confirm:true},service.csrfToken)).status,200);assert.equal(jobs.get('mine').status,'stopping')
 assert.equal((await http(ctx,service,'GET',{sessionId:'two'})).status,400)
})
