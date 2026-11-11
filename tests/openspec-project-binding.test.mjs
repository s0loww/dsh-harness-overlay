import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, cp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve, relative, isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runInNewContext} from 'node:vm'

async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'openspec-project-binding-'))
  t.after(async()=>{assert.ok(relative(resolve(tmpdir()),base).startsWith('openspec-project-binding-'));assert.equal(isAbsolute(relative(resolve(tmpdir()),base)),false);await rm(base,{recursive:true,force:true})})
  const pkg=join(base,'plugin');await cp('src/openspec-workflow',pkg,{recursive:true})
  for(const[name,code]of Object.entries({'@fission-ai/openspec':'export {}','@j1nn0/agent-handoff':'export const createHandoff=x=>x','@j1nn0/agent-progress':'export const judgeProgress=x=>x','@deepseek-ai/dsh-llm':'export const createUserMessage=x=>x','@deepseek-ai/dsh-skill':'export const isUserInvocable=()=>true; export const renderSkillContent=x=>x.content'})){
    const directory=join(pkg,'node_modules',name);await mkdir(join(directory,'lib'),{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({name,type:'module',version:'1.12.0',exports:'./lib/index.js'}));await writeFile(join(directory,'lib/index.js'),code)
  }
  const projects=[join(base,'one'),join(base,'two')]
  for(const project of projects){await mkdir(join(project,'openspec/changes/demo'),{recursive:true});await writeFile(join(project,'openspec/changes/demo/proposal.md'),'# Demo\n');await writeFile(join(project,'openspec/changes/demo/tasks.md'),'- [ ] Task\n')}
  return{base,projects,workspace:await import(pathToFileURL(join(pkg,'lib/openspec-workspace.js')))}
}

test('project selection is shared across chats while execution and ticket provenance stay local',async t=>{
  const {projects:[root,other],workspace:{createProjectSelectionStore,OpenSpecWorkspace}}=await fixture(t)
  const store=createProjectSelectionStore(),first=new OpenSpecWorkspace(root,{sessionId:'first',projectSelection:store.forRoot(root)}),second=new OpenSpecWorkspace(root,{sessionId:'second',projectSelection:store.forRoot(join(root,'.'))}),foreign=new OpenSpecWorkspace(other,{sessionId:'foreign',projectSelection:store.forRoot(other)})
  first.select('demo');assert.equal(second.selectedChange,'demo');assert.equal(foreign.selectedChange,null)
  second.setStage({stage:'design'});assert.equal(first.selectedStage,'design');assert.equal(first.selectedPath,'changes/demo/design.md')
  assert.equal(first.workflowSnapshot().sessionId,'first');assert.equal(second.workflowSnapshot().sessionId,'second')
  first.ticketList={mode:'mcp',sessionId:'first',issues:[{ticket:'ONE-1'}]};assert.equal(second.ticketList,undefined)
  first.newChangeBaseline=new Set(['demo']);assert.equal(second.newChangeBaseline,null)
  const before=second.snapshot();assert.equal(typeof before.projectRoot,'string');assert.equal(before.selectedChange,'demo')
  second.clearSelection();assert.equal(first.selectedChange,null);assert.equal(foreign.selectedChange,null)
  assert.throws(()=>new OpenSpecWorkspace(other,{projectSelection:store.forRoot(root)}),/OPENSPEC_PROJECT_SELECTION_MISMATCH/)
  const limited=createProjectSelectionStore({limit:1});limited.forRoot(root);assert.throws(()=>limited.forRoot(other),/OPENSPEC_PROJECT_CAPACITY/)
})

test('HTTP project navigation is shared without sharing caller workflow session identity or write rights',async t=>{
  const {projects:[root,other],workspace}=await fixture(t),routes=new Map(),agents=new Map()
  for(const[id,cwd]of[['a',root],['b',root],['c',other]])agents.set(id,{session:{id,header:{id,cwd,agentPreset:'1c-airules'}},status:'idle',followup(){throw Error('model must not run')}})
  const ctx={agents:{list:()=>[],get:id=>agents.get(id)},sessions:{get:id=>agents.get(id)?.session},systemPrompt:{context:()=>()=>{}},on:()=>()=>{},get(name){if(name==='planMode')return{get:()=>({active:true})};if(name==='sandboxPolicy')return{resolve:({session})=>({mode:'read-only',workspaceRoot:session.header.cwd,sessionId:session.id})};return this[name]},inject(_names,fn){return fn({get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined,effect:fn=>fn(),webServer:{register:row=>{routes.set(row.path,row.handler);return()=>{}}}})}}
  workspace.apply(ctx,{workspacePath:root})
  async function call(id,input){let status,value;const path=input?'/onec/openspec/action':'/onec/openspec';await routes.get(path)({method:input?'POST':'GET',url:path+'?sessionId='+id,headers:{'x-dsh-csrf':token},async *[Symbol.asyncIterator](){if(input)yield Buffer.from(JSON.stringify({...input,sessionId:id}))}},{setHeader(){},set statusCode(code){status=code},end(text){value=JSON.parse(text)}});return{status,...value}}
  let token;const initial=await call('a');token=initial.csrfToken
  assert.equal((await call('a',{action:'select',change:'demo'})).ok,true)
  const second=await call('b');assert.equal(second.selectedChange,'demo');assert.equal(second.workflow.sessionId,'b');assert.equal((await call('c')).selectedChange,null)
  assert.equal((await call('b',{action:'write',path:'changes/demo/proposal.md',content:'# Refused'})).ok,false)
  assert.equal(await readFile(join(root,'openspec/changes/demo/proposal.md'),'utf8'),'# Demo\n')
})

test('client draft ownership uses trusted project roots and bounds retained projects independently of session IDs',async()=>{
  let plugin;runInNewContext(await readFile('src/openspec-workflow/lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){plugin=row.factory(name=>name==='react'?{createElement(){}}:(()=>{throw Error('legacy missing optional project UI')})())}}}})
  const first={projectRoot:'c:/projects/one',sessionId:'chat-a'},second={...first,sessionId:'chat-b'},other={projectRoot:'c:/projects/two',sessionId:'chat-c'}
  assert.equal(plugin.projectDraftKey(first),plugin.projectDraftKey(second));assert.notEqual(plugin.projectDraftKey(first),plugin.projectDraftKey(other));assert.equal(plugin.projectDraftKey({sessionId:'chat-only'}),null)
  const drafts={'changes/demo/proposal.md':{text:'# Unsaved',version:'original'}}
  assert.equal(plugin.rememberProjectDrafts(plugin.projectDraftKey(first),drafts),true);assert.equal(plugin.readProjectDrafts(plugin.projectDraftKey(second))['changes/demo/proposal.md'].text,'# Unsaved');assert.deepEqual(Object.keys(plugin.readProjectDrafts(plugin.projectDraftKey(other))),[])
  for(let i=1;i<128;i++)assert.equal(plugin.rememberProjectDrafts('project-'+i,drafts),true)
  assert.equal(plugin.rememberProjectDrafts('overflow',drafts),false);assert.equal(plugin.readProjectDrafts('c:/projects/one')['changes/demo/proposal.md'].text,'# Unsaved')
  assert.equal(plugin.rememberProjectDrafts('c:/projects/one',{}),true);assert.equal(plugin.rememberProjectDrafts('new-slot',drafts),true)
})

test('ticket settings select a project and retain editor ownership when its automatic executor changes',async()=>{
  let plugin,selection={projectId:'project-one',projectRoot:'c:/projects/one',id:'chat-a'}
  const picker=()=>{},React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useSyncExternalStore:(_subscribe,read)=>read()}
  runInNewContext(await readFile('src/openspec-workflow/lib/client.js','utf8'),{window:{__ModuleLoader__:{load(row){plugin=row.factory(name=>name==='react'?React:name==='airules-dsh-project-context'?{useProject:()=>selection,ProjectPicker:picker}:undefined)}}}})
  const first=plugin.TicketSystemSettingsSection();assert.equal(first.children[0].type,picker);assert.equal(first.children[0].props.project.projectId,'project-one');assert.equal(first.children[1].props.key,'project-one');assert.equal(first.children[1].props.sessionId,'chat-a');assert.equal(first.children[1].props.projectId,'project-one')
  selection={...selection,id:'chat-b'};const second=plugin.TicketSystemSettingsSection();assert.equal(second.children[1].props.key,first.children[1].props.key);assert.equal(second.children[1].props.sessionId,'chat-b')
  selection={projectId:'project-two',id:'chat-c'};const other=plugin.TicketSystemSettingsSection();assert.notEqual(other.children[1].props.key,first.children[1].props.key)
})

test('optional project service wraps every OpenSpec route while original CSRF and access checks remain authoritative',async t=>{
  const {projects:[root],workspace}=await fixture(t),routes=new Map(),calls=[]
  const agent={session:{id:'executor',header:{id:'executor',cwd:root,agentPreset:'1c-airules'}},status:'idle'},service={bindHandler(original,options){assert.deepEqual(options,{presets:['1c-airules']});return async(request,response)=>{calls.push(request.url.split('?')[0]);const url=new URL(request.url,'http://localhost');if(url.searchParams.get('projectId')==='registered-project')url.searchParams.set('sessionId','executor');return original({...request,url:url.pathname+url.search},response)}}}
  let removeProjectService
  const ctx={agents:{list:()=>[],get:id=>id==='executor'?agent:undefined},sessions:{get:id=>id==='executor'?agent.session:undefined},systemPrompt:{context:()=>()=>{}},on:()=>()=>{},get(name){if(name==='planMode')return{get:()=>({active:true})};if(name==='sandboxPolicy')return{resolve:()=>({mode:'read-only',workspaceRoot:root,sessionId:'executor'})};return this[name]},inject(names,fn){if(names[0]==='airulesProjects'){removeProjectService=fn({airulesProjects:service});return()=>{}}return fn({get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined,effect:fn=>fn(),webServer:{register:row=>{routes.set(row.path,row.handler);return()=>{}}}})}}
  workspace.apply(ctx,{workspacePath:root})
  async function call(path,method='GET',body){let status,value;const route=path.split('?')[0];await routes.get(route)({url:path,method,headers:{},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body))}},{setHeader(){},set statusCode(code){status=code},end(text){value=JSON.parse(text)}});return{status,...value}}
  const initial=await call('/onec/openspec?projectId=registered-project');assert.equal(initial.ok,true);assert.equal(initial.enabled,true);assert.equal(initial.workflow.sessionId,'executor')
  assert.equal((await call('/onec/openspec/git?projectId=registered-project')).ok,true)
  assert.equal((await call('/onec/openspec/read?projectId=registered-project&path=changes/demo/proposal.md')).ok,true)
  assert.equal((await call('/onec/openspec/action?projectId=registered-project','POST',{action:'select',change:'demo'})).status,403)
  assert.deepEqual([...new Set(calls)].sort(),['/onec/openspec','/onec/openspec/action','/onec/openspec/git','/onec/openspec/read'])
  removeProjectService();assert.equal((await call('/onec/openspec?projectId=registered-project')).enabled,false);assert.equal((await call('/onec/openspec?sessionId=executor')).enabled,true)
})
