import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DEFAULT_PROCESSING, validateProcessing, discoverProcessingModels, processingFingerprint, isProcessingReady } from '../src/memory-workspace/lib/processing.js'
import { createProcessingManager, processingCommand, validateProcessingCommand } from '../src/memory-workspace/lib/processing-runtime.js'
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const remoteProfile = () => ({ ...structuredClone(DEFAULT_PROCESSING), allowed: true, extraction: { provider: 'openrouter', model: 'fixture/structured' } })
test('processing roles are independent; local endpoints are numeric loopback and credentials never belong to profile',()=>{
  assert.equal(validateProcessing(remoteProfile()).embeddings.provider,'fastembed')
  for(const endpoint of ['https://127.0.0.1:1234','http://localhost:1234','http://192.168.1.2:1234','http://127.0.0.1:1234/?key=private','http://user:pass@127.0.0.1:1234','http://127.0.0.1:1234/admin']) assert.throws(()=>validateProcessing({...remoteProfile(),extraction:{provider:'lmstudio',model:'local',endpoint}}),/PROCESSING_LOCAL_/)
  for(const field of ['apiKey','secret','command']) assert.throws(()=>validateProcessing({...remoteProfile(),[field]:'not-allowed'}),/PROFILE_INVALID/)
  assert.throws(()=>validateProcessing({...remoteProfile(),embeddings:{provider:'openrouter',model:'openai/text-embedding-3-small',dimensions:1}}),/DIMENSIONS_MISMATCH/)
  assert.throws(()=>validateProcessing({...remoteProfile(),extraction:{provider:'gliner',model:'invented/model'}}),/GLINER_MODEL_UNSUPPORTED/)
  assert.equal(processingFingerprint({...remoteProfile(),allowed:false}),processingFingerprint(remoteProfile()))
})
test('Ollama discovers only compatible installed models; loading state and vector width come from metadata',async()=>{
  const calls=[]
  const fetchImpl=async(url,options)=>{calls.push({url,options});const path=new URL(url).pathname
    if(path==='/api/tags')return response({models:[{name:'chat:latest'},{name:'embed:latest'},{name:'legacy:latest'}]})
    if(path==='/api/ps')return response({models:[{name:'embed:latest'}]})
    const name=JSON.parse(options.body).model
    return response(name==='chat:latest'?{capabilities:['completion']}:name==='embed:latest'?{capabilities:['embedding'],model_info:{'bert.embedding_length':768}}:{})
  }
  const result=await discoverProcessingModels({kind:'embeddings',provider:'ollama',fetchImpl})
  assert.deepEqual(result.models,[{id:'embed:latest',label:'embed:latest',kind:'embeddings',state:'loaded',dimensions:768}])
  assert.ok(calls.every(row=>!row.url.includes('/generate')&&!row.url.includes('/embed')&&!row.url.includes('/pull')))
  assert.equal(calls.filter(row=>row.options.method==='POST').length,3)
})
test('LM Studio uses its typed installed-model API, with a bounded older-version fallback',async()=>{
  const result=await discoverProcessingModels({kind:'extraction',provider:'lmstudio',fetchImpl:async url=>url.endsWith('/api/v1/models')?new Response('',{status:404}):response({data:[{id:'local-chat',type:'llm',state:'loaded'},{id:'embedding',type:'embeddings'},{id:'untyped'}]})})
  assert.equal(result.available,true);assert.deepEqual(result.models.map(row=>[row.id,row.state]),[['local-chat','loaded']])
})
test('OpenRouter catalogue uses public GET only, fixed endpoint, explicit modality and no secrets in results',async()=>{
  const calls=[]
  const result=await discoverProcessingModels({kind:'embeddings',provider:'openrouter',fetchImpl:async(url,options)=>{calls.push({url,options});return response({data:[{id:'openai/text-embedding-3-small',name:'Small',architecture:{output_modalities:['embeddings']}},{id:'fixture/chat',architecture:{output_modalities:['text']}}]})}})
  assert.equal(result.models.length,1);assert.equal(result.models[0].dimensions,1536)
  assert.equal(calls[0].url,'https://openrouter.ai/api/v1/embeddings/models');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers.authorization,undefined)
  await assert.rejects(discoverProcessingModels({kind:'embeddings',provider:'openrouter',endpoint:'http://evil',fetchImpl:()=>{throw Error('unexpected')}}),/ENDPOINT_NOT_CONFIGURABLE/)
})
test('unavailable/protected catalogues report availability honestly and redact upstream bodies/errors',async()=>{
  const result=await discoverProcessingModels({kind:'extraction',provider:'lmstudio',fetchImpl:async()=>new Response('secret upstream body',{status:401})})
  assert.equal(result.available,false);assert.equal(result.models.length,0);assert.ok(!JSON.stringify(result).includes('secret'))
  const missing=await discoverProcessingModels({kind:'embeddings',provider:'fastembed'})
  assert.equal(missing.available,false);assert.deepEqual(missing.models,[])
})

async function fixture(t,{dataCount=0,activeRuns=0,platform='linux',key=true}={}){
  const root=await mkdtemp(join(tmpdir(),'airules-processing-'))
  t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-processing-'));await rm(root,{recursive:true,force:true})})
  const composeDir=join(root,'server'),home=join(root,'home');await mkdir(composeDir);await mkdir(home)
  const envPath=join(composeDir,'.env'),composePath=join(composeDir,'compose.yaml')
  const initialEnv='PRIVATE_PASSWORD=preserve-fixture-value\n'+(key?'OPENROUTER_API_KEY=sk-or-v1-private-fixture-value\n':'')
  await writeFile(envPath,initialEnv);await writeFile(composePath,'services:\n  cognee:\n    image: fixture\n    environment:\n      GRAPH_EXTRACTOR: gliner_demo\n')
  const bindingPath=join(home,'binding.json'),profilePath=join(home,'profile.json'),statePath=join(home,'state.json')
  const binding={schemaVersion:1,composeDir,composeFile:'compose.yaml',envFile:'.env',container:'fixture-cognee',service:'cognee',ownerSid:'S-1-5-21-123-456-789-1001'}
  await writeFile(bindingPath,JSON.stringify(binding))
  const log=[],approvals=[],snapshot={version:'1.6.7',healthy:true,databaseVerified:true,keylessLocalDefaults:true,dataCount,activeRuns,remoteGliner:false,environment:{GRAPH_EXTRACTOR:'gliner_demo'}}
  let allowed=true,denied=false,failRecreate=false,failAcl=false,approvalHook,runnerHook
  const options={profilePath,bindingPath,statePath,backupRoot:join(home,'backups'),defaultProfile:{...structuredClone(DEFAULT_PROCESSING),allowed:true},platform,healthAttempts:1,pollDelayMs:0,
    guard(){if(!allowed)throw Error('NATIVE_REVOKED')},authorize:async(exec,summary)=>{approvals.push(summary);await approvalHook?.();return denied?'denied':'allowed-once'},
    runner:async spec=>{log.push(spec);await runnerHook?.(spec)
      if(spec.operation==='protect-private'){if(failAcl)throw Error('ACL_FAILED');return{code:0,stdout:''}}
      if(spec.operation==='inspect-server')return{code:0,stdout:JSON.stringify(snapshot)}
      if(spec.operation==='inspect-cache')return{code:0,stdout:JSON.stringify({models:[{...DEFAULT_PROCESSING.embeddings,id:DEFAULT_PROCESSING.embeddings.model,kind:'embeddings',state:'installed'},{...DEFAULT_PROCESSING.extraction,id:DEFAULT_PROCESSING.extraction.model,kind:'extraction',state:'installed'}]})}
      if(spec.operation==='recreate'){
        if(failRecreate)throw Error('DOCKER_RECREATE_FAILED private stderr')
        const env={};for(const line of (await readFile(envPath,'utf8')).split('\n')){const m=/^([A-Z_]+)=(.*)$/u.exec(line);if(m&&!m[1].includes('KEY')&&!m[1].includes('PASSWORD')){try{env[m[1]]=JSON.parse(m[2])}catch{env[m[1]]=m[2]}}}snapshot.environment=env
        return{code:0,stdout:''}
      }
      throw Error('unexpected operation')
    },fetchImpl:async()=>response({data:[{id:'fixture/structured',name:'Synthetic extraction',architecture:{output_modalities:['text']}}]})}
  const manager=createProcessingManager(options),execution={signal:new AbortController().signal,agent:{id:'fixture-native-lead'}}
  return{root,home,composeDir,envPath,composePath,bindingPath,profilePath,statePath,initialEnv,log,approvals,snapshot,manager,execution,options,binding,allow:value=>{allowed=value},deny:value=>{denied=value},failRestart:value=>{failRecreate=value},failAcl:value=>{failAcl=value},onApproval:fn=>{approvalHook=fn},onCommand:fn=>{runnerHook=fn}}
}
test('configuration/save are model-free and use desired-profile CAS; attestation reflects actual local server',async t=>{
  const f=await fixture(t),initial=await f.manager.configuration()
  assert.equal(initial.applied.matchesDesired,false);assert.equal(f.log.length,0)
  const saved=await f.manager.save({profile:remoteProfile(),expectedRevision:initial.revision})
  assert.equal(saved.profile.extraction.provider,'openrouter');assert.equal(f.log.length,0)
  await assert.rejects(f.manager.save({profile:remoteProfile(),expectedRevision:initial.revision}),/PROFILE_STALE/)
  const inspect=await f.manager.inspect(f.execution)
  assert.equal(inspect.applied.state,'observed');assert.equal(inspect.applied.matchesDesired,false)
  assert.equal(f.log.every(spec=>spec.operation==='inspect-server'),true)
})
test('apply of current built-in models only attests and does not restart/change env, even with existing datasets',async t=>{
  const f=await fixture(t,{dataCount:11}),config=await f.manager.configuration()
  const result=await f.manager.apply({expectedRevision:config.revision,confirm:true,execution:f.execution})
  assert.equal(result.restarted,false);assert.equal(result.applied.matchesDesired,true);assert.equal(isProcessingReady(result),true)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv);assert.equal(f.log.some(row=>row.operation==='recreate'),false);assert.equal(f.approvals.length,1)
  await writeFile(f.envPath,f.initialEnv+'NEW_SETTING=changed\n')
  assert.equal((await f.manager.configuration()).applied.matchesDesired,false)
})
test('actual apply preserves private env, owns a compose override, backs up before mutation and reports separate applied profile',async t=>{
  const f=await fixture(t,{dataCount:11}),first=await f.manager.configuration(),config=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  const result=await f.manager.apply({expectedRevision:config.revision,confirm:true,execution:f.execution})
  assert.equal(result.restarted,true);assert.equal(result.applied.state,'applied');assert.equal(result.applied.matchesDesired,true)
  const env=await readFile(f.envPath,'utf8');assert.ok(env.includes('PRIVATE_PASSWORD=preserve-fixture-value'));assert.ok(env.includes('OPENROUTER_API_KEY='));assert.ok(env.includes('GRAPH_EXTRACTOR="llm"'));assert.ok(env.includes('EMBEDDING_PROVIDER="fastembed"'))
  assert.ok((await readFile(join(f.composeDir,'compose.override.yaml'),'utf8')).includes('GRAPH_EXTRACTOR: ${GRAPH_EXTRACTOR}'))
  assert.ok((await readFile(f.composePath,'utf8')).includes('GRAPH_EXTRACTOR: gliner_demo'))
  const transactions=await readdir(join(f.home,'backups'));assert.equal(transactions.length,1);assert.equal(await readFile(join(f.home,'backups',transactions[0],'env.before'),'utf8'),f.initialEnv)
  assert.ok(!JSON.stringify({result,log:f.log,approvals:f.approvals}).includes('private-fixture-value'))
  assert.equal(f.log.filter(row=>row.operation==='recreate').length,1)
})
test('embedding changes on existing data and busy-server restarts are refused before approval/writes',async t=>{
  const f=await fixture(t,{dataCount:11}),first=await f.manager.configuration()
  const profile={...remoteProfile(),embeddings:{provider:'openrouter',model:'openai/text-embedding-3-small',dimensions:1536}}
  let saved=await f.manager.save({profile,expectedRevision:first.revision})
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/REINDEX_REQUIRED/)
  saved=await f.manager.save({profile:remoteProfile(),expectedRevision:saved.revision});f.snapshot.activeRuns=1
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/SERVER_BUSY/)
  assert.equal(f.approvals.length,0);assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
})
test('missing server key, denied approval and stale profile never start a provider or mutate the server',async t=>{
  const f=await fixture(t,{key:false}),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/OPENROUTER_KEY_REQUIRED/)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
  f.deny(true);await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/APPROVAL_REQUIRED/)
  f.deny(false);f.onApproval(()=>writeFile(f.profilePath,JSON.stringify(DEFAULT_PROCESSING)))
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/PROFILE_STALE/)
  assert.equal(f.log.some(row=>row.operation==='recreate'),false)
})
test('existing user compose override is preserved; unknown recreate outcome stays unready without blind rollback/retry',async t=>{
  const f=await fixture(t),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  await writeFile(join(f.composeDir,'compose.override.yaml'),'# user-owned\n')
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/OVERRIDE_OWNED_BY_USER/)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
  await rm(join(f.composeDir,'compose.override.yaml'));f.failRestart(true)
  const result=await f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution})
  assert.equal(result.outcomeUnknown,true);assert.equal(result.applied.state,'unknown');assert.equal(isProcessingReady(result),false)
  assert.equal(f.log.filter(row=>row.operation==='recreate').length,1);assert.ok(!JSON.stringify(result).includes('private stderr'))
})
test('Windows private files are ACL-protected while empty, and ACL failure prevents secret backup/write',async t=>{
  const f=await fixture(t,{platform:'win32'}),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  f.onCommand(async spec=>{if(spec.operation==='protect-private')assert.equal((await readFile(spec.args[0])).length,0)})
  f.failAcl(true)
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/ACL_FAILED/)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv);assert.equal(f.log.some(row=>row.operation==='recreate'),false)
})
test('native guard revocation during approval blocks server mutation and fixed inspection scripts omit credentials',async t=>{
  const f=await fixture(t),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  f.onApproval(()=>f.allow(false))
  await assert.rejects(f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),/NATIVE_REVOKED/)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
  const command=processingCommand('inspect-cache',f.binding)
  assert.equal(command.file,'docker');assert.equal(validateProcessingCommand(command,f.binding),command)
  assert.throws(()=>validateProcessingCommand({...command,args:['exec','fixture-cognee','python','-c','print("not approved")']},f.binding),/COMMAND_INVALID/)
  assert.throws(()=>processingCommand('shell',f.binding),/COMMAND_INVALID/)
})
test('native credential rotation refreshes server privately even when model profile is unchanged; inspect cannot clear invalidation',async t=>{
  const f=await fixture(t,{dataCount:11}),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  await f.manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution})
  const secret='sk-or-v1-native-owner-new-key',manager=createProcessingManager({...f.options,getOpenRouterKey:async()=>secret})
  await manager.invalidateCredential()
  assert.equal((await manager.configuration()).applied.matchesDesired,false)
  assert.equal((await manager.inspect(f.execution)).applied.matchesDesired,false)
  const before=f.log.filter(row=>row.operation==='recreate').length,result=await manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution})
  assert.equal(result.restarted,true);assert.equal(result.applied.matchesDesired,true);assert.equal(f.log.filter(row=>row.operation==='recreate').length,before+1)
  assert.ok((await readFile(f.envPath,'utf8')).includes(secret))
  for(const value of [result,await manager.configuration(),JSON.parse(await readFile(f.profilePath,'utf8'))])assert.ok(!JSON.stringify(value).includes(secret))
  const backupDirs=await readdir(join(f.home,'backups'))
  for(const directory of backupDirs)assert.ok(!(await readFile(join(f.home,'backups',directory,'receipt.json'),'utf8')).includes(secret))
  const unchanged=await manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution})
  assert.equal(unchanged.restarted,false)
})

test('GLiNER alone does not attest keyless embedding defaults when a server LLM key disables Cognee preflight fallback',async t=>{
  const f=await fixture(t),first=await f.manager.configuration()
  f.snapshot.keylessLocalDefaults=false
  assert.equal((await f.manager.inspect(f.execution)).applied.matchesDesired,false)
  await assert.rejects(f.manager.apply({expectedRevision:first.revision,confirm:true,execution:f.execution}),/PROCESSING_RUNTIME_PROFILE_UNSUPPORTED/)
  assert.equal(f.approvals.length,0)
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
})
test('credential resolver exceptions are redacted and rotation during apply cancels before/after dispatch honestly',async t=>{
  const f=await fixture(t),first=await f.manager.configuration(),saved=await f.manager.save({profile:remoteProfile(),expectedRevision:first.revision})
  const failed=createProcessingManager({...f.options,getOpenRouterKey:async()=>{throw Error('sk-or-v1-do-not-leak')}})
  await assert.rejects(failed.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution}),error=>error.message==='PROCESSING_OPENROUTER_CREDENTIAL_UNAVAILABLE')
  assert.equal(await readFile(f.envPath,'utf8'),f.initialEnv)
  const manager=createProcessingManager({...f.options,getOpenRouterKey:async()=> 'sk-or-v1-native-token-value'})
  f.onCommand(async spec=>{if(spec.operation==='recreate')await manager.invalidateCredential()})
  const result=await manager.apply({expectedRevision:saved.revision,confirm:true,execution:f.execution})
  assert.equal(result.outcomeUnknown,true);assert.equal(isProcessingReady(result),false);assert.equal(f.log.filter(row=>row.operation==='recreate').length,1)
})
