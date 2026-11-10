import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createNativeLinks } from '../src/evidence-links/lib/native.js'
const native=resolve('var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai')
const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js')))
const {SandboxedFileSystem}=await import(pathToFileURL(join(native,'dsh-fs-sandbox/lib/index.js')))
const {ToolsService,defineTool}=await import(pathToFileURL(join(native,'dsh-tools/lib/index.js')))
const {NativeToolExecutor}=await import(pathToFileURL(join(native,'dsh-tool-executor-native/lib/index.js')))
const {createScope}=await import(pathToFileURL(join(native,'dsh-scope/lib/index.js')))
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'airules-links-native-')),workspace=join(root,'workspace');await mkdir(workspace);await mkdir(join(workspace,'src'));await writeFile(join(workspace,'src','module.bsl'),'one\r\ntwo\r\nthree\r\n')
  t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-links-native-'));await rm(root,{recursive:true,force:true})})
  await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(resolve(native,'..'),join(root,'node_modules'),'junction');await writeFile(join(root,'native-tools.js'),await readFile('src/native-tools-compat/rc022.js'));const{executeNativeTool}=await import(pathToFileURL(join(root,'native-tools.js')))
  const ctx=new Context(),policy={mode:'workspace-write',workspaceRoot:workspace,sessionId:'lead'},session={id:'lead',header:{id:'lead',cwd:workspace}},agent={session}
  const approval={requests:[],async request(value){this.requests.push(value);return'allowed-once'}}
  ctx.provide('systemPrompt',{tools(){},section(){return()=>{}},getSectionOrder(){return 0}})
  ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>policy});ctx.provide('agents',{get:id=>id===session.id?agent:null});ctx.provide('approval',approval)
  let fs,owner
  const base=ctx.plugin({inject:['systemPrompt','sandboxPolicy'],apply(scope){new ToolsService(scope);fs=new SandboxedFileSystem(scope,{cwd:workspace,diffBasisMaxBytes:10*1024*1024})}});await base.await();assert.equal(base.state,2)
  ctx.provide('agentPresets',{composedPreset:()=> '1c-airules',serviceFor:(_agent,name)=>name==='fs'?fs:undefined})
  const executor=ctx.plugin({inject:['tools','agents','agentPresets','sandboxPolicy','approval','fs'],apply(scope){owner=scope;scope.tools.setExecutor(new NativeToolExecutor(scope))}});await executor.await();assert.equal(executor.state,2)
  t.after(()=>ctx.fiber.dispose());const child=createScope(owner,agent);agent.ctx=child.ctx
  const service=createNativeLinks(owner,{now:()=> '2026-11-11T10:00:00.000Z'})
  for(const name of ['agent','native','core'])await writeFile(join(root,name+'.js'),await readFile('src/evidence-links/lib/'+name+'.js'))
  const actualAgent=await import(pathToFileURL(join(root,'agent.js')));actualAgent.apply(owner)
  async function invoke(args){return executeNativeTool(owner,{name:'airules_links',arguments:args,agent,callId:'links-fixture',signal:new AbortController().signal})}
  async function value(args){const result=await invoke(args);assert.equal(result.isError,false,JSON.stringify(result));return result.value}
  const add=(revision,extra={})=>({action:'add',from:{kind:'file',path:'src/module.bsl',range:{startLine:1,endLine:2}},to:{kind:'note',backend:'memoria',namespace:'project',recordId:'decision-1'},type:'implements',provenance:{ref:'user-confirmed design note'},confirm:true,expectedRevision:revision,...extra})
  return{root,workspace,ctx,policy,session,agent,approval,fs,invoke,value,add,service,child}
}
test('actual SDK022 native tool and FS persist reference-only metadata; edits mark links stale across sessions',async t=>{
  const f=await fixture(t),initial=await f.value({action:'list'});assert.equal(initial.revision,'missing')
  const saved=await f.value(f.add(initial.revision));assert.equal(saved.metadataOnly,true);assert.equal(f.approval.requests[0].agent,f.agent);assert.equal(f.approval.requests[0].callId,'links-fixture')
  let page=await f.value({action:'query',query:'decision-1'});assert.equal(page.total,1);assert.deepEqual(Object.values(page.links[0].sourceState),['fresh']);assert.equal(page.links[0].referenceVerification,'not-fetched')
  const original=await readFile(join(f.workspace,'.dsh','evidence-links.json'),'utf8');assert.equal(original.includes('one\r'),false);assert.equal(original.includes('decision-1'),true)
  await writeFile(join(f.workspace,'src','module.bsl'),'changed\r\ntwo\r\nthree\r\n');page=await f.value({action:'list'});assert.deepEqual(Object.values(page.links[0].sourceState),['stale']);assert.equal(await readFile(join(f.workspace,'.dsh','evidence-links.json'),'utf8'),original)
  f.policy.mode='read-only';f.session.header.origin='subagent';assert.equal((await f.value({action:'list'})).total,1)
  const denied=await f.invoke(f.add(page.revision));assert.equal(denied.isError,true);assert.match(denied.content[0].text,/LEAD_WRITER_REQUIRED/)
})
test('native approval denial, policy revocation and source changes during approval cannot write',async t=>{
  const f=await fixture(t)
  f.approval.request=async()=> 'rejected';let result=await f.invoke(f.add('missing'));assert.equal(result.isError,true);assert.match(result.content[0].text,/APPROVAL_REQUIRED/);assert.equal((await f.value({action:'list'})).revision,'missing')
  f.approval.request=async()=>{f.policy.mode='read-only';return'allowed-once'};result=await f.invoke(f.add('missing'));assert.equal(result.isError,true);assert.match(result.content[0].text,/LEAD_WRITER_REQUIRED|SCOPE_CHANGED/);f.policy.mode='workspace-write'
  f.approval.request=async()=>{await writeFile(join(f.workspace,'src','module.bsl'),'changed\ntwo\n');return'allowed-once'};result=await f.invoke(f.add('missing'));assert.equal(result.isError,true);assert.match(result.content[0].text,/SOURCE_CHANGED/);assert.equal((await f.value({action:'list'})).revision,'missing')
  await assert.rejects(f.service.act(f.add('missing'),{agent:f.agent,callId:'fake'}),/NATIVE_APPROVAL_REQUIRED/)
})
test('overlapping native writes to one project fail before a second approval; empty source files hash correctly',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'src','empty.bsl'),'')
  let release,arrived;const entered=new Promise(resolve=>{arrived=resolve})
  f.approval.request=async()=>{arrived();return new Promise(resolve=>{release=resolve})}
  const first=f.invoke(f.add('missing',{from:{kind:'file',path:'src/empty.bsl'}}));await entered
  const denied=await f.invoke(f.add('missing',{type:'related'}));assert.equal(denied.isError,true);assert.match(denied.content[0].text,/WRITE_BUSY/)
  release('allowed-once');assert.equal((await first).isError,false)
  const page=await f.value({action:'list'});assert.deepEqual(Object.values(page.links[0].sourceState),['fresh'])
})
test('native query preserves unverified state when a page exceeds the source verification budget',async t=>{
  const f=await fixture(t);let revision='missing'
  for(let index=0;index<17;index++){
    const path=`src/evidence-${index}.bsl`;await writeFile(join(f.workspace,path),'test source')
    const saved=await f.value(f.add(revision,{from:{kind:'file',path},to:{kind:'document',id:`doc-${index}`}}));revision=saved.revision
  }
  const page=await f.value({action:'query',limit:30}),states=page.links.flatMap(link=>Object.values(link.sourceState))
  assert.equal(page.total,17);assert.equal(states.filter(state=>state==='fresh').length,16);assert.equal(states.filter(state=>state==='unverified-budget').length,1)
  assert.equal((await f.invoke({action:'query',limit:31})).isError,true)
})
test('CAS, pagination, foreign stores, source and store junctions cannot bypass project ownership',async t=>{
  const f=await fixture(t);let saved=await f.value(f.add('missing'));saved=await f.value(f.add(saved.revision,{to:{kind:'document',id:'doc-1'},type:'verifiedBy'}))
  const first=await f.value({action:'list',limit:1});assert.equal(first.total,2);assert.ok(first.nextCursor);const second=await f.value({action:'list',limit:1,cursor:first.nextCursor});assert.notEqual(first.links[0].id,second.links[0].id)
  let result=await f.invoke({...f.add('missing'),type:'related'});assert.equal(result.isError,true);assert.match(result.content[0].text,/REVISION_CHANGED/)
  saved=await f.value({action:'remove',linkId:first.links[0].id,expectedRevision:saved.revision,confirm:true});assert.equal((await f.value({action:'list'})).total,1)
  result=await f.invoke({action:'list',limit:1,cursor:first.nextCursor});assert.equal(result.isError,true);assert.match(result.content[0].text,/CURSOR_STALE/)
  const originalWrite=f.fs.writeText.bind(f.fs);f.fs.writeText=async(...args)=>{await writeFile(join(f.workspace,'.dsh','evidence-links.json'),'external-edit');return originalWrite(...args)}
  result=await f.invoke(f.add(saved.revision,{type:'related'}));assert.equal(result.isError,true);assert.equal(await readFile(join(f.workspace,'.dsh','evidence-links.json'),'utf8'),'external-edit');f.fs.writeText=originalWrite
  await writeFile(join(f.workspace,'.dsh','evidence-links.json'),JSON.stringify({schemaVersion:1,projectId:'foreign',nodes:{},links:{}}));result=await f.invoke({action:'list'});assert.equal(result.isError,true);assert.match(result.content[0].text,/STORE_INVALID/)
  const outside=join(f.root,'outside');await mkdir(outside);const at=join(f.workspace,'.dsh');assert.ok(relative(f.root,at).startsWith('workspace'));await rm(at,{recursive:true,force:true});await symlink(outside,at,'junction');result=await f.invoke({action:'list'});assert.equal(result.isError,true);assert.match(result.content[0].text,/LINK_REJECTED/)
  await rm(at);await symlink(outside,join(f.workspace,'src','escape'),'junction');await assert.rejects(f.service.act(f.add('missing',{from:{kind:'file',path:'src/escape/secret'}}),{agent:f.agent,token:Symbol(),callId:'fixture'}),/LINK_REJECTED/)
})
