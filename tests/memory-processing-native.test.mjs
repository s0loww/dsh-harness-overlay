import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'

const sdk=resolve('var/host-upgrade/rc022/asar/dsh/node_modules'),native=join(sdk,'@deepseek-ai')
const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js')))
const {ToolsService,defineTool}=await import(pathToFileURL(join(native,'dsh-tools/lib/index.js')))
const {NativeToolExecutor}=await import(pathToFileURL(join(native,'dsh-tool-executor-native/lib/index.js')))
const {SubprocessRuntime}=await import(pathToFileURL(join(native,'dsh-subprocess/lib/index.js')))
const {createScope}=await import(pathToFileURL(join(native,'dsh-scope/lib/index.js')))

// Actual 0.2.2 tools/executor/scope/subprocess service and environment scrub;
// only the managed process transport and approval UI are synthetic. No Docker,
// model inference, live ACL changes or external API calls are made.
async function fixture(t,{platform='win32'}={}){
  const base=await mkdtemp(join(tmpdir(),'memory-processing-native-')),root=join(base,'project'),composeDir=join(base,'cognee'),backupRoot=join(base,'backups'),bindingPath=join(base,'binding.json')
  await Promise.all([mkdir(root),mkdir(composeDir),mkdir(backupRoot)])
  t.after(async()=>{const rel=relative(resolve(tmpdir()),base);assert.ok(!isAbsolute(rel)&&rel.startsWith('memory-processing-native-'));await rm(base,{recursive:true,force:true})})
  await writeFile(join(base,'package.json'),'{"type":"module"}')
  await symlink(sdk,join(base,'node_modules'),'junction')
  await cp('src/memory-workspace/lib',join(base,'lib'),{recursive:true})
  await cp('src/native-tools-compat/rc022.js',join(base,'native-tools.js'))
  const {createNativeProcessing}=await import(pathToFileURL(join(base,'lib/processing-native.js')))
  const {processingCommand}=await import(pathToFileURL(join(base,'lib/processing-runtime.js')))
  const {executeNativeTool}=await import(pathToFileURL(join(base,'native-tools.js')))
  const binding={schemaVersion:1,composeDir,composeFile:'compose.yaml',envFile:'.env',container:'fixture_cognee',service:'cognee',ownerSid:'S-1-5-21-111-222-333-1001'}
  await writeFile(bindingPath,JSON.stringify(binding))
  const ctx=new Context(),events=[],spawns=[],resolutions=[],approvals=[]
  let owner,callback,decision='allowed-once',approvalHook,resolveHook,spawnHook,exitCode=0,quiet=true,output='{"healthy":true}',stderr='private-fixture-secret',terminated=0,observedError,lastExecution
  ctx.provide('systemPrompt',{tools(){},section(){return()=>{}},getSectionOrder(){return 0}})
  const toolsPlugin=ctx.plugin({inject:['systemPrompt'],apply(scope){new ToolsService(scope)}});await toolsPlugin.await();assert.equal(toolsPlugin.state,2)
  class FixtureSubprocess extends SubprocessRuntime{
    async resolveExecutable(file,env,signal){signal.throwIfAborted();events.push('resolve');resolutions.push({file,env});await resolveHook?.();return join(base,file+'.exe')}
    spawn(spec){
      events.push('spawn');spawns.push(spec);spawnHook?.(spec)
      const stdout=new PassThrough(),err=new PassThrough()
      const done=new Promise(resolveDone=>queueMicrotask(()=>{stdout.end(output);err.end(stderr);resolveDone({exitCode})}))
      return{stdout,stderr:err,done,waitForExit:async signal=>{signal?.throwIfAborted();events.push('wait');return quiet},terminate:async()=>{terminated++;events.push('terminate')}}
    }
  }
  const subprocessPlugin=ctx.plugin({apply(scope){new FixtureSubprocess(scope)}});await subprocessPlugin.await();assert.equal(subprocessPlugin.state,2)
  const agent={status:'idle',session:{id:'processing-owner',header:{id:'processing-owner',cwd:root}}},agents=new Map([[agent.session.id,agent]])
  let policy={mode:'danger-full-access',sessionId:agent.session.id,workspaceRoot:root}
  ctx.provide('agents',{get:id=>agents.get(id)})
  ctx.provide('agentPresets',{composedPreset:()=> '1c-airules'})
  ctx.provide('sandboxPolicy',{resolve:()=>policy})
  ctx.provide('sandbox',{confine:async()=>{events.push('confine');throw Error('full access must not call confined ACL runner')}})
  ctx.provide('approval',{request:async spec=>{events.push('approve');approvals.push(spec);await approvalHook?.();return decision}})
  const executorPlugin=ctx.plugin({inject:['tools','subprocess','agents','agentPresets','sandboxPolicy','sandbox','approval'],apply(scope){owner=scope;scope.tools.setExecutor(new NativeToolExecutor(scope))}});await executorPlugin.await();assert.equal(executorPlugin.state,2)
  const child=createScope(owner,agent);agent.ctx=child.ctx
  const broker=createNativeProcessing(owner,{bindingPath,backupRoot,platform})
  const summary={profile:{embeddings:{provider:'fastembed',model:'BAAI/bge-small-en-v1.5'},extraction:{provider:'gliner',model:'fastino/gliner2.5-base-v1'}},restart:true,externalApi:false}
  owner.tools.register(defineTool({name:'airules_memory_processing_fixture',description:'Native processing fixture',parameters:{},output:{schema:{type:'object',additionalProperties:true},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}},async execute(_args,execution){lastExecution=execution;try{return await callback(execution)}catch(error){observedError=error;throw error}}}))
  t.after(()=>ctx.fiber.dispose())
  async function run(fn,{signal=new AbortController().signal}={}){callback=fn;observedError=undefined;const result=await executeNativeTool(owner,{name:'airules_memory_processing_fixture',arguments:{},agent,callId:'processing-call',signal});if(observedError)throw observedError;return result}
  return{base,root,bindingPath,binding,backupRoot,broker,summary,events,spawns,resolutions,approvals,agent,agents,run,command:kind=>processingCommand(kind,binding),execution:()=>lastExecution,terminated:()=>terminated,policy:value=>{policy={...policy,...value}},decision:value=>{decision=value},onApproval:fn=>{approvalHook=fn},onResolve:fn=>{resolveHook=fn},onSpawn:fn=>{spawnHook=fn},output:value=>{output=value},stderr:value=>{stderr=value},exit:value=>{exitCode=value},quiet:value=>{quiet=value}}
}

test('SDK022 app-owned read probe is fixed, explicitly local Docker, scrubbed and model-free without a chat',async t=>{
  const f=await fixture(t),names=['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION','DSH_TEST_SECRET','OPENROUTER_API_KEY'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]))
  for(const name of names)process.env[name]='private-fixture-secret'
  try{
    const result=await f.broker.runner(f.command('inspect-server'))
    assert.deepEqual(result,{code:0,stdout:'{"healthy":true}'})
    assert.equal(f.approvals.length,0);assert.equal(f.events.includes('confine'),false)
    assert.equal(f.spawns.length,1);const spec=f.spawns[0]
    assert.deepEqual(spec.argv.slice(1,3),['--host','npipe:////./pipe/docker_engine'])
    assert.deepEqual(spec.argv.slice(3),f.command('inspect-server').args)
    assert.equal(spec.cwd,f.binding.composeDir);assert.deepEqual(spec.stdio,{stdin:'ignore',stdout:'pipe',stderr:'pipe'})
    for(const name of names)assert.equal(spec.env[name],undefined,name)
    assert.ok(!JSON.stringify(result).includes('private-fixture-secret'))
  }finally{for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]}
})

test('SDK022 native tool execution supplies real token/agent and requires approval before full-access recreate',async t=>{
  const f=await fixture(t)
  await f.run(async execution=>{
    assert.equal(typeof execution.token,'symbol');assert.equal(execution.agent,f.agent);assert.equal(execution.callId,'processing-call')
    await assert.rejects(f.broker.runner(f.command('recreate'),execution),/PROCESSING_NATIVE_APPROVAL_REQUIRED/)
    assert.equal(await f.broker.authorize(execution,f.summary),'allowed-once')
    return f.broker.runner(f.command('recreate'),execution)
  })
  assert.equal(f.spawns.length,1);assert.equal(f.events.includes('confine'),false,'official full-access semantics bypass ACL confinement')
  assert.ok(f.events.indexOf('approve')<f.events.indexOf('spawn'));assert.equal(f.approvals[0].agent,f.agent);assert.equal(f.approvals[0].callId,'processing-call')
  assert.match(f.approvals[0].reason,/no 1C deployment/);assert.ok(!f.approvals[0].reason.includes('private-fixture-secret'))
  await assert.rejects(f.broker.runner(f.command('recreate')),/PROCESSING_NATIVE_EXECUTION_REQUIRED/)
  await f.run(async execution=>{await assert.rejects(f.broker.runner(f.command('recreate'),execution),/APPROVAL_REQUIRED/);return{ok:true}})
  assert.equal(f.spawns.length,1,'one execution approval is not transferable to another tool call')
})

test('native read-only/workspace policies and subagents cannot acquire global processing mutation authority',async t=>{
  for(const mode of ['read-only','workspace-write']){
    const f=await fixture(t);f.policy({mode})
    await assert.rejects(f.run(execution=>f.broker.authorize(execution,f.summary)),/MEMORY_FULL_ACCESS_REQUIRED/)
    assert.equal(f.approvals.length,0);assert.equal(f.spawns.length,0)
  }
  const f=await fixture(t);f.agent.session.header.origin='subagent'
  await assert.rejects(f.run(execution=>f.broker.authorize(execution,f.summary)),/MEMORY_ORCHESTRATOR_WRITE_REQUIRED/)
  assert.equal(f.approvals.length,0);assert.equal(f.spawns.length,0)
})

test('denied approval and policy/root replacement during awaited native approval/lookup prevent dispatch',async t=>{
  const denied=await fixture(t);denied.decision('denied')
  await denied.run(async execution=>{assert.equal(await denied.broker.authorize(execution,denied.summary),'denied');await assert.rejects(denied.broker.runner(denied.command('recreate'),execution),/APPROVAL_REQUIRED/);return{ok:true}})
  assert.equal(denied.spawns.length,0)
  for(const phase of ['approval','lookup']){
    const f=await fixture(t),replace=()=>f.policy({additionalWritableRoots:[f.backupRoot]})
    if(phase==='approval')f.onApproval(replace);else f.onResolve(replace)
    await assert.rejects(f.run(async execution=>{await f.broker.authorize(execution,f.summary);return f.broker.runner(f.command('recreate'),execution)}),/PROCESSING_SCOPE_CHANGED/)
    assert.equal(f.spawns.length,0)
  }
  const root=await fixture(t);root.onApproval(()=>{root.agent.session.header.cwd=root.backupRoot})
  await assert.rejects(root.run(execution=>root.broker.authorize(execution,root.summary)),/MEMORY_NATIVE_POLICY_REQUIRED/)
  assert.equal(root.spawns.length,0)
})

test('fixed command allowlist rejects injected Python, wrong cwd/container and arbitrary ACL targets before resolving executables',async t=>{
  const f=await fixture(t)
  for(const changed of [{...f.command('inspect-cache'),args:['exec','fixture_cognee','python','-c','print("secret")']},{...f.command('inspect-server'),cwd:f.backupRoot},{...f.command('inspect-server'),args:f.command('inspect-server').args.map(value=>value==='fixture_cognee'?'other_container':value)},{operation:'shell',file:'powershell',args:[],cwd:f.root}])await assert.rejects(f.broker.runner(changed),/PROCESSING_COMMAND_INVALID/)
  await f.run(async execution=>{
    await f.broker.authorize(execution,f.summary)
    await assert.rejects(f.broker.runner({operation:'protect-private',file:'icacls.exe',args:[f.root,'/grant','Everyone:F'],cwd:f.binding.composeDir},execution),/PROCESSING_COMMAND_INVALID/)
    return{ok:true}
  })
  assert.equal(f.resolutions.length,0);assert.equal(f.spawns.length,0)
})

test('hardlinked machine binding is rejected before executing even an app-owned read probe',async t=>{
  const f=await fixture(t);await link(f.bindingPath,join(f.base,'alias.json'))
  await assert.rejects(f.broker.runner(f.command('inspect-cache')),/PROCESSING_BINDING_INVALID/)
  assert.equal(f.spawns.length,0)
})

test('native subprocess exit/lookup failures, nonquiescence and output overflow never expose stderr or provider secrets',async t=>{
  for(const failure of ['exit','lookup','quiet','overflow']){
    const f=await fixture(t)
    if(failure==='exit')f.exit(7)
    if(failure==='lookup')f.onResolve(()=>{throw Error('private-fixture-secret from executable resolution')})
    if(failure==='quiet')f.quiet(false)
    if(failure==='overflow')f.output('x'.repeat(256*1024+1))
    await assert.rejects(f.broker.runner(f.command('inspect-server')),error=>error.message==='PROCESSING_NATIVE_COMMAND_FAILED'&&!JSON.stringify(error).includes('private-fixture-secret'))
    if(failure!=='lookup')assert.ok(f.terminated()>0)
  }
})

test('native completion rechecks the current policy and app-owned Linux read probe pins the local socket',async t=>{
  const f=await fixture(t,{platform:'linux'});f.onSpawn(()=>f.policy({mode:'workspace-write'}))
  await assert.rejects(f.run(async execution=>{await f.broker.authorize(execution,f.summary);return f.broker.runner(f.command('recreate'),execution)}),/MEMORY_FULL_ACCESS_REQUIRED/)
  assert.equal(f.spawns.length,1);assert.ok(f.terminated()>0)
  const read=await fixture(t,{platform:'linux'});await read.broker.runner(read.command('inspect-cache'))
  assert.deepEqual(read.spawns[0].argv.slice(1,3),['--host','unix:///var/run/docker.sock'])
})

test('aborted native lookup, replaced agent and changed binding cannot dispatch an already approved command',async t=>{
  const aborted=await fixture(t),cancel=new AbortController()
  aborted.onResolve(()=>cancel.abort())
  await assert.rejects(aborted.run(async execution=>{await aborted.broker.authorize(execution,aborted.summary);return aborted.broker.runner(aborted.command('recreate'),execution)},{signal:cancel.signal}),/PROCESSING_NATIVE_COMMAND_FAILED/)
  assert.equal(aborted.spawns.length,0)
  const replaced=await fixture(t)
  replaced.onApproval(()=>replaced.agents.set(replaced.agent.session.id,{...replaced.agent}))
  await assert.rejects(replaced.run(execution=>replaced.broker.authorize(execution,replaced.summary)),/MEMORY_ACTIVE_PROJECT_REQUIRED/)
  assert.equal(replaced.spawns.length,0)
  const changed=await fixture(t)
  changed.onApproval(()=>writeFile(changed.bindingPath,JSON.stringify({...changed.binding,composeDir:changed.backupRoot})))
  await assert.rejects(changed.run(async execution=>{await changed.broker.authorize(execution,changed.summary);return changed.broker.runner(changed.command('recreate'),execution)}),/PROCESSING_COMMAND_INVALID/)
  assert.equal(changed.spawns.length,0)
})
