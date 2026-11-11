import {createHash,randomBytes,timingSafeEqual} from 'node:crypto'
import {lstat,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {scrubbedParentEnv} from '@deepseek-ai/dsh-subprocess'
import {createSettingsStore} from './settings.js'
import {createNativeMaintenance} from './native.js'
import {createGitSourceService,DEFAULT_SOURCES} from './source.js'
import {createRolloutService} from './rollout.js'
import {discoverGithubRelease,downloadGithubRelease,createOfficialInstallerAdapter,createUpdaterService,createWorkerJob} from './updater.js'
import {prepareUpdateCandidate} from './updater-candidate.js'
import {launchUpdateWorker} from './worker-launch.js'
import {readWorkerJob} from './update-worker.mjs'
export const name='airules-dsh-git-maintenance'
export const inject=['airulesProjects','webServer','connection','dshHomePath','agents','agentPresets','sandboxPolicy','sandbox','subprocess','approval']
export const API='/airules/git-maintenance'
const fail=code=>{throw Error(code)},safe=error=>/^(?:MAINTENANCE_|SOURCE_|ROLLOUT_|UPDATE_|PROJECT_)[A-Z_]+$/u.test(error?.message??'')?error.message:'MAINTENANCE_UNAVAILABLE'
const bundled=fileURLToPath(new URL('../runtime/',import.meta.url))
export function createController(ctx,{home=ctx.dshHomePath('git-maintenance'),native=createNativeMaintenance(ctx,{scrubbedParentEnv}),settings=createSettingsStore(join(home,'settings.json')),sourceFactory=createGitSourceService,rolloutFactory=createRolloutService,installerFactory=createOfficialInstallerAdapter,updaterFactory=createUpdaterService,launchWorker=launchUpdateWorker}={}){
 const token=randomBytes(32).toString('base64url'),sources=sourceFactory({root:join(home,'git'),run:native.run}),rollouts=new Map(),updaters=new Map(),preparedSources=new Map();let busy=false,discovered=null,downloaded=null
 async function engineInfo(){try{const value=JSON.parse(await readFile(join(bundled,'embedded-source.json'),'utf8'));const {inventory,...info}=value;return info}catch{return null}}
 async function rollout(config){const key=config.python;if(!rollouts.has(key))rollouts.set(key,rolloutFactory({root:join(home,'rollout'),run:native.run,verifyScope:native.verifyScope,python:config.python}));return rollouts.get(key)}
 async function updater(config,execution){const engineRoot=config.harness.engineRoot;if(!engineRoot)fail('UPDATE_ENGINE_REQUIRED');if(!updaters.has(engineRoot)){const adapter=await installerFactory({engineRoot,prepareCandidate:(release,target,{signal}={})=>prepareUpdateCandidate({engineRoot,release,target,signal})});updaters.set(engineRoot,updaterFactory({root:join(home,'updates'),installer:adapter,verifyScope:exec=>exec?.verify?.()}))}return updaters.get(engineRoot)}
 async function source(input,config,execution){
  if(input.sourceMode==='embedded'){const info=await engineInfo();if(!info?.commit)fail('ROLLOUT_EMBEDDED_UNAVAILABLE');return{root:join(bundled,'embedded-source'),commit:info.commit,repository:DEFAULT_SOURCES.airules.repository,ref:'embedded',source:'embedded',version:info.version}}
  if(!['git','local'].includes(input.sourceMode))fail('SOURCE_INPUT_INVALID')
  const row={kind:'airules',repository:config.airules.repository,ref:config.airules.ref,...(input.sourceMode==='local'?{localPath:config.airules.localPath}:{})};if(input.sourceMode==='local'&&!row.localPath)fail('SOURCE_LOCAL_ROOT_INVALID')
  const ready=await sources.prepare(row,execution);preparedSources.set('airules',ready);return ready
 }
 async function configuration(){const stored=await settings.read();return{...stored,defaults:DEFAULT_SOURCES,embedded:await engineInfo(),source:preparedSources.get('airules')??null,discovered:discovered&&{version:discovered.version,commit:discovered.commit,hostVersion:discovered.hostVersion},downloaded:downloaded?{version:downloaded.manifest?.version,ready:true}:null}}
 async function act(input,{uiInitiated=false}={}){
  if(input.action==='configuration')return configuration()
  const stored=await settings.read(),config=stored.settings
  if(input.action==='cancelUpdate'){
   if(!uiInitiated)fail('UPDATE_CANCEL_UI_REQUIRED')
   if(typeof input.transactionId!=='string'||!/^[-a-f0-9]{36}$/u.test(input.transactionId))fail('UPDATE_ID_INVALID')
   const path=join(home,'updates/jobs',input.transactionId+'.json'),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8192)fail('UPDATE_WORKER_JOB_INVALID')
   const bytes=await readFile(path);if(bytes.length>8192)fail('UPDATE_WORKER_JOB_INVALID')
   const job=await readWorkerJob(path,createHash('sha256').update(bytes).digest('hex')),service=await updater({...config,harness:{...config.harness,engineRoot:job.engineRoot}})
   const cancelled=await service.cancelPending({transactionId:job.transactionId,token:job.token});return{cancelled,updates:await service.status()}
  }
  if(input.action==='projectStatus'){const selected=await native.scope(input);return{project:await (await rollout(config)).status(selected),...await configuration()}}
  if(input.action==='rulesDetail'){const selected=await native.scope(input);return{detail:await (await rollout(config)).detail(selected,{planId:input.planId,path:input.path})}}
  if(input.action==='updateStatus'){const service=await updater(config);return{updates:await service.status(),...await configuration()}}
  if(busy)fail('MAINTENANCE_BUSY');busy=true;let execution
  try{
   execution=await native.execution(input,({saveSettings:'Save Git source and updater settings.',prepareSource:'Fetch or read a pinned airules source snapshot into the managed cache. Project files are unchanged.',rulesPlan:'Prepare and compare an airules candidate. No project apply, MCP or 1C deployment.',rulesApply:'Apply the exact reviewed airules plan to this project, with backups. MCP and 1C deployment are unchanged.',rulesRollback:'Restore the exact managed project rule files from their receipt; refuse newer edits.',checkHarness:'Check the configured Git repository and its published update release. No installation.',downloadUpdate:'Download and verify the selected harness release into the managed cache.',prepareUpdate:'Prepare a locally certified harness update candidate and preview installed-file changes.',queueUpdate:'Queue this exact harness update for a full Desktop exit, then restart. Accounts and chats are preserved.',queueRollback:'Queue rollback of this installed harness update for a full Desktop exit.'})[input.action]??'Git maintenance operation.',{uiInitiated})
   if(input.action==='saveSettings')return await settings.save(input.settings,input.revision,execution.verify)
   if(['prepareSource','rulesPlan','rulesApply','rulesRollback','rulesDetail'].includes(input.action)&&execution.scope.preset!=='1c-airules')fail('ROLLOUT_ONEC_PROJECT_REQUIRED')
   if(input.action==='prepareSource')return{source:await source(input,config,execution),...await configuration()}
   if(input.action==='rulesPlan'){const pinned=await source(input,config,execution);return{plan:await (await rollout(config)).plan(execution.scope,{source:pinned,bindings:input.bindings,includeSkills:input.includeSkills===true,adoptExistingInstructions:input.adoptExistingInstructions===true},execution)}}
   if(input.action==='rulesApply')return{result:await (await rollout(config)).apply(execution.scope,{planId:input.planId},execution)}
   if(input.action==='rulesRollback')return{result:await (await rollout(config)).rollback(execution.scope,{receiptId:input.receiptId},execution)}
   if(input.action==='rulesDetail')return{detail:await (await rollout(config)).detail(execution.scope,{planId:input.planId,path:input.path},execution)}
   if(input.action==='checkHarness'){
    const commit=await sources.prepare({kind:'harness',repository:config.harness.repository,ref:config.harness.ref},execution);preparedSources.set('harness',commit)
    try{discovered=await discoverGithubRelease({repository:config.harness.repository,signal:execution.signal});await execution.verify();return{harnessSource:{commit:commit.commit,repository:commit.repository},release:discovered}}catch(error){if(['UPDATE_RELEASE_NOT_PUBLISHED','UPDATE_RELEASE_ASSETS_REQUIRED','UPDATE_RELEASE_INVALID'].includes(error.message))return{harnessSource:{commit:commit.commit,repository:commit.repository},release:null,message:'Ветка Git получена. Готового установочного релиза пока нет; исходники сами по себе не устанавливаются.'};throw error}
   }
   if(input.action==='downloadUpdate'){if(!discovered)fail('UPDATE_RELEASE_REQUIRED');downloaded=await downloadGithubRelease({manifest:discovered,root:join(home,'downloads'),signal:execution.signal});await execution.verify();return{downloaded:{version:discovered.version,ready:true}}}
   if(input.action==='prepareUpdate'){
    const service=await updater(config,execution),target={installRoot:config.harness.installRoot,profileRoot:config.harness.profileRoot,...(config.harness.previousReceiptPath?{previousReceiptPath:config.harness.previousReceiptPath}:{})},releaseRoot=input.local===true?config.harness.localReleaseRoot:downloaded?.root
    if(!releaseRoot)fail('UPDATE_RELEASE_REQUIRED');return{updatePlan:await service.prepare({releaseRoot,repository:config.harness.repository,target},execution)}
   }
   if(input.action==='queueUpdate'||input.action==='queueRollback'){
    const service=await updater(config,execution),queued=input.action==='queueUpdate'?await service.queue({planId:input.planId,authorization:{planId:input.planId,execute:true}},execution):await service.queueRollback({transactionId:input.transactionId,authorization:{transactionId:input.transactionId,rollback:true}},execution)
    try{await execution.verify();const job=await createWorkerJob({root:join(home,'updates'),engineRoot:config.harness.engineRoot,transactionId:queued.transactionId,token:queued.token})
     const armed=await launchWorker(ctx,{job,node:config.node,home,execution});if(!armed?.started)fail('UPDATE_WORKER_NOT_CONFIRMED');await execution.verify();return{queued:{transactionId:queued.transactionId,state:queued.state,workerStarted:true,message:'Полностью выйдите из DSH через меню приложения. Обновление выполнится после выхода; затем Desktop запустится снова.'}}
    }catch(error){try{await service.cancelPending({transactionId:queued.transactionId,token:queued.token})}catch{fail('UPDATE_WORKER_CANCEL_UNCONFIRMED')}throw error}
   }
   fail('MAINTENANCE_ACTION_INVALID')
  }finally{execution?.dispose?.();busy=false}
 }
 async function handler(request,response){
  const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value))}
  if(ctx.connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
  try{let input;if(request.method==='GET'){input=Object.fromEntries(new URL(request.url,'http://localhost').searchParams);input.action??='configuration';if(Object.keys(input).some(k=>!['action','projectId','sessionId','expectedProjectRoot','expectedExecutorRevision'].includes(k)))fail('MAINTENANCE_INPUT_INVALID');if(!['configuration','projectStatus','updateStatus'].includes(input.action))fail('MAINTENANCE_METHOD_REQUIRED')}
   else if(request.method==='POST'){const a=Buffer.from(String(request.headers['x-airules-csrf']??'')),b=Buffer.from(token);if(a.length!==b.length||!timingSafeEqual(a,b))return send(403,{ok:false,error:'MAINTENANCE_CSRF_REQUIRED'});if(!String(request.headers['content-type']??'').startsWith('application/json'))fail('MAINTENANCE_JSON_REQUIRED');let size=0,chunks=[];for await(const part of request){size+=Buffer.byteLength(part);if(size>128*1024)fail('MAINTENANCE_BODY_LIMIT');chunks.push(Buffer.from(part))}input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['action','projectId','sessionId','expectedProjectRoot','expectedExecutorRevision','settings','revision','sourceMode','bindings','includeSkills','adoptExistingInstructions','planId','receiptId','path','local','transactionId'].includes(k)))fail('MAINTENANCE_INPUT_INVALID')}
   else return send(405,{ok:false,error:'MAINTENANCE_METHOD_REQUIRED'})
   return send(200,{ok:true,...await act(input,{uiInitiated:request.method==='POST'}),csrfToken:token})
  }catch(error){const code=safe(error);return send(code.includes('STALE')||code.includes('CHANGED')?409:400,{ok:false,error:code,...(typeof error.receiptId==='string'?{receiptId:error.receiptId}:{})})}
 }
 return{act,handler,configuration,dispose:native.dispose}
}
export function apply(ctx){const controller=createController(ctx);ctx.provide('airulesGitMaintenance',controller);ctx.effect(()=>ctx.webServer.register({kind:'exact',path:API,handler:controller.handler}));ctx.effect(()=>()=>controller.dispose())}
