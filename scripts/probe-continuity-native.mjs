import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile,copyFile,symlink,cp} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {createNativeContinuity} from '../src/context-continuity/lib/native.js'
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)))
export async function runNativeContinuityProbe({sdkRoot=join(repo,'var/host-upgrade/rc022/asar/dsh/node_modules')}={}){
 const native=name=>import(pathToFileURL(join(sdkRoot,'@deepseek-ai',name,'lib/index.js')))
 const {Context}=await native('cordis'),{Session}=await native('dsh-session'),{LocalFileSystem}=await native('dsh-fs-local'),{SandboxedFileSystem}=await native('dsh-fs-sandbox'),{createUserMessage}=await native('dsh-llm'),{agentEvents}=await native('dsh-agent'),{default:ToolsService}=await native('dsh-tools')
 const workspace=join(repo,'var/continuity-native',randomUUID());await mkdir(join(workspace,'src'),{recursive:true});await writeFile(join(workspace,'src/a.txt'),'FRESH_NATIVE_SOURCE')
 await mkdir(join(workspace,'openspec/changes/fixture'),{recursive:true});await writeFile(join(workspace,'openspec/changes/fixture/tasks.md'),'- [x] DONE_TASK_BODY\n- [ ] TODO_TASK_BODY\n')
 const contract=JSON.parse(await readFile(join(repo,'../project_rules/core/tools/continuity/contract.json'),'utf8'))
 const session=Session.create('native-continuity',undefined,{version:4,id:'native-continuity',createdAt:Date.now(),isSeeded:false,cwd:workspace})
 let policy={mode:'read-only',sessionId:session.id,workspaceRoot:workspace}
 const c=new Context();c.provide('sandboxPolicy',{defaultMode:'read-only',resolve:()=>policy});const fs=new SandboxedFileSystem(c,{cwd:workspace,diffBasisMaxBytes:1048576})
 const agent={id:session.id,session,ctx:c},agents=new Map([[session.id,agent]])
 const ctx={agents,agentPresets:{composedPreset:()=> '1c-airules',serviceFor:()=>c.fs},sandboxPolicy:{resolve:()=>policy},fs,jobs:{list:()=>[]}}
 const service=createNativeContinuity(ctx,{contract,mode:'balanced',collectGit:false,criticalFiles:['src/a.txt'],createUserMessage})
 const checks=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push({name,passed:true})}
 const packageRoot=join(workspace,'probe-package');await mkdir(join(packageRoot,'node_modules'),{recursive:true})
 await writeFile(join(packageRoot,'package.json'),'{"type":"module"}')
 await symlink(join(sdkRoot,'@deepseek-ai'),join(packageRoot,'node_modules/@deepseek-ai'),'junction')
 await copyFile(join(repo,'src/context-continuity/lib/agent.js'),join(packageRoot,'agent.js'))
 const toolsContext=new Context();toolsContext.provide('systemPrompt',{tools:()=>()=>{}})
 const realTools=new ToolsService(toolsContext)
 toolsContext.provide('airulesContinuity',service)
 const toolPlugin=await import(pathToFileURL(join(packageRoot,'agent.js')))
 toolPlugin.apply(toolsContext)
 check('actual defineTool schema and native ToolsService registration',realTools.view().visible.has('airules_continuity'))
 const add=(type,data)=>{const event=session.append(type,data);service.event(session,event);return event}
 // Genuine Session events validate native envelopes and retained-surface transitions.
 const observedTarget=await fs.resolve(join(workspace,'src/a.txt'),{cwd:workspace})
 service.fsObserved(observedTarget,{kind:'present',version:(await fs.stat(observedTarget)).version},{agent,name:'read',callId:'read1'})
 service.toolResult({agent,name:'read',callId:'read1',arguments:{file_path:'src/a.txt'}},{isError:false,value:{path:'src/a.txt'}})
 const message={role:'tool',content:[{type:'text',text:'old source'}],source:{callId:'read1',name:'read'}}
 session.append('tool/result',{message},{surfaceOp:'append'})
 const base={kind:'continue',messages:[]}
 add('compaction/start',{compactionId:'compact-1'})
 add('compaction/end',{compactionId:'compact-1'})
 const restored=await service.restore(agent,undefined,base)
 check('successful native lifecycle delivers once',restored.messages.length===1)
 check('packet budget includes UTF8 metadata',Buffer.byteLength(restored.messages[0].content[0].text)<=12288)
 check('retained source is not duplicated',!restored.messages[0].content[0].text.includes('FRESH_NATIVE_SOURCE'))
 check('unpublished candidate remains retryable',(await service.restore(agent,undefined,base)).messages.length===1)
 service.event(session,session.append('user/message',restored.messages[0],{surfaceOp:'append'}))
 check('second delivery suppressed',(await service.restore(agent,undefined,base)).messages.length===0)
 add('compaction/start',{compactionId:'compact-lost'})
 session.append('user/message',createUserMessage({content:[{type:'text',text:'synthetic summary'}]}),{surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]})
 add('compaction/end',{compactionId:'compact-lost'})
 const fresh=await service.restore(agent,undefined,base)
 check('lost critical source freshly read through native filesystem',fresh.messages[0]?.content[0].text.includes('FRESH_NATIVE_SOURCE'))
 check('old cached source body never restored',!fresh.messages[0].content[0].text.includes('old source'))
 add('compaction/start',{compactionId:'failed'});add('compaction/end',{compactionId:'failed',error:['fixture failure']})
 check('failed compact delivers nothing',(await service.restore(agent,undefined,base)).messages.length===0)
 await service.refresh(agent,undefined,true)
 const status=await service.act({action:'status'},{agent})
 check('read-only never writes checkpoint',status.checkpoint.durable===false)
 check('real native fs and Session used',fs instanceof LocalFileSystem&&session instanceof Session)
 policy={...policy,mode:'workspace-write'};await service.refresh(agent,undefined,true)
 check('native CAS checkpoint publication',(await service.act({action:'status'},{agent})).checkpoint.durable===true)
 check('actual native sandbox FS provider used',fs instanceof SandboxedFileSystem)
 const checkpoint=(await service.act({action:'status'},{agent})).checkpoint
 const raw=JSON.parse(await readFile(join(workspace,checkpoint.path),'utf8'))
 check('OpenSpec checkpoint includes only native version and task counts',raw.openspec?.[0]?.done===1&&raw.openspec[0].total===2&&!JSON.stringify(raw).includes('TASK_BODY'))
 check('canonical checkpoint byte limit and scope',Buffer.byteLength(JSON.stringify(raw)+'\n')<=4096&&raw.sessionId===session.id&&raw.projectKey.length===64)
 const schema=JSON.parse(await readFile(join(repo,'../project_rules/core/tools/continuity/checkpoint.schema.json'),'utf8'))
 const validate=(value,s)=>{
  if(s.$ref)s=schema.$defs[s.$ref.split('/').at(-1)]
  if(s.const!==undefined)assert.deepEqual(value,s.const)
  if(s.enum)assert.ok(s.enum.includes(value))
  if(s.type==='object'){
   assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value))
   for(const key of s.required??[])assert.ok(Object.hasOwn(value,key),key)
   for(const [key,row]of Object.entries(value)){if(s.additionalProperties===false)assert.ok(Object.hasOwn(s.properties,key),key);if(s.properties?.[key])validate(row,s.properties[key])}
  }else if(s.type==='array'){assert.ok(Array.isArray(value));if(s.maxItems)assert.ok(value.length<=s.maxItems);for(const row of value)validate(row,s.items)}
  else if(s.type==='integer'){assert.ok(Number.isSafeInteger(value));if(s.minimum!==undefined)assert.ok(value>=s.minimum)}
  else if(s.type){assert.equal(typeof value,s.type);if(s.maxLength)assert.ok(value.length<=s.maxLength);if(s.minLength)assert.ok(value.length>=s.minLength);if(s.pattern)assert.match(value,new RegExp(s.pattern))}
 }
 validate(raw,schema);check('checkpoint conforms to canonical strict schema',true)
 add('compaction/start',{compactionId:'restart'});add('compaction/end',{compactionId:'restart'})
 const restarted=createNativeContinuity(ctx,{contract,collectGit:false,createUserMessage})
 await restarted.refresh(agent,undefined,true)
 check('restart uses exact native journal lifecycle',(await restarted.restore(agent,undefined,base)).messages.length===1)
 const restartMessage=(await restarted.restore(agent,undefined,base)).messages[0]
 restarted.event(session,session.append('user/message',restartMessage,{surfaceOp:'append'}))
 check('restart restoration also delivered once',(await restarted.restore(agent,undefined,base)).messages.length===0)
 const dispose=c.on('agent/pre-step',(payload,next)=>restarted.preStep(payload,next),{global:true,prepend:true})
 const throughNative=await agentEvents(c,agent).waterfall('agent/pre-step',{signal:new AbortController().signal},async()=>{
  const start=session.append('compaction/start',{compactionId:'middleware'});restarted.event(session,start)
  const end=session.append('compaction/end',{compactionId:'middleware'});restarted.event(session,end)
  return base
 })
 check('native Cordis agent middleware waits downstream compact and restores',throughNative.messages.length===1)
 dispose()
 // Boot the actual global package through Cordis, so undeclared service access
 // fails here exactly as it does in the complete harness (not a plain mock).
 await cp(join(repo,'src/context-continuity/lib'),join(packageRoot,'lib'),{recursive:true})
 await mkdir(join(packageRoot,'runtime/continuity'),{recursive:true});await writeFile(join(packageRoot,'runtime/continuity/contract.json'),JSON.stringify(contract))
 const globalContext=new Context()
 for(const [name,value]of Object.entries({...ctx,subprocess:{},sandbox:{}}))globalContext.provide(name,value)
 const indexPlugin=await import(pathToFileURL(join(packageRoot,'lib/index.js'))),indexFork=globalContext.plugin(indexPlugin,{collectGit:false})
 await indexFork.await()
 const globalService=globalContext.get('airulesContinuity')
 check('actual global plugin activates under strict native injection',!!globalService)
 globalService.event(session,session.append('compaction/start',{compactionId:'global-plugin'}))
 globalService.event(session,session.append('compaction/end',{compactionId:'global-plugin'}))
 const injected=await agentEvents(globalContext,agent).waterfall('agent/pre-step',{signal:new AbortController().signal},async()=>base)
 check('actual global plugin restores with injected fs and jobs services',injected.messages.length===1)
 await indexFork.dispose()
 add('compaction/start',{compactionId:'scope-change'});add('compaction/end',{compactionId:'scope-change'})
 agents.delete(session.id)
 check('removed native agent cannot receive restoration',(await service.restore(agent,undefined,base)).messages.length===0)
 return {schemaVersion:1,sdkRoot,checks,modelRequests:0,mcpCalls:0,deployments:0}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runNativeContinuityProbe({sdkRoot:process.argv[2]&&resolve(process.argv[2])}),null,2))

