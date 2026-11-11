import {mkdir,readFile,unlink} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {safeRelative,json,state,same,writeJson,seal,validSeal,fail,guard,sha,pathKey} from './lib/fs.mjs'
import {configureExtras,rollbackExtras} from './extras/index.mjs'
import {planMcpConfiguration,applyMcpConfiguration,rollbackMcpConfiguration} from './mcp/index.mjs'
import {writeProtectedFile} from './mcp/protected-file.mjs'
import {createCogneeAdapter} from './cognee/adapter.mjs'
import {validateConfig} from '../memory-workspace/lib/control.js'

const MEMORY_FILES=['auth.json','processing-binding.json','processing.json','config.json']
function cogneePaths(ctx){return{home:join(ctx.dshHome,'memory-workspace'),root:join(ctx.stateRoot,'components','cognee',ctx.deploymentId),receiptPath:join(ctx.stateRoot,'components','cognee-receipts',ctx.deploymentId+'.json')}}
function verifyCogneeReceipt(ctx,component,receipt){
 const paths=cogneePaths(ctx),allowed=new Set(MEMORY_FILES.map(name=>pathKey(join(paths.home,name))))
 if(!component?.owned||pathKey(component.stateRoot)!==pathKey(paths.root)||pathKey(component.receiptPath)!==pathKey(paths.receiptPath)||!validSeal(receipt)||receipt.schemaVersion!==1||receipt.kind!=='deployment-cognee-binding'||pathKey(receipt.stateRoot)!==pathKey(paths.root)||!Array.isArray(receipt.files)||receipt.files.length>MEMORY_FILES.length)fail('DEPLOY_COGNEE_RECEIPT_INVALID')
 const seen=new Set()
 for(const file of receipt.files){const key=pathKey(file.target);if(!allowed.has(key)||seen.has(key)||file.after?.type!=='file'||!Number.isSafeInteger(file.after.bytes)||file.after.bytes<0||file.after.bytes>256*1024||!/^[a-f0-9]{64}$/u.test(file.after.sha256??''))fail('DEPLOY_COGNEE_RECEIPT_INVALID');seen.add(key)}
 return paths
}

export function createComponentAdapters({cognee=createCogneeAdapter(),cogneePort,offline=false,skipLegacyLinter=false}={}){
 // Both adapters attach a receipt once recipient mutation can have started.
 // Preflight refusals are known no-ops; late errors retain their recovery pointer.
 const recipientComponent=async task=>{try{return await task()}catch(error){if(error.receiptPath)error.componentReceipt={receiptPath:error.receiptPath};else error.notAttempted=true;throw error}}
 const extras=ctx=>recipientComponent(()=>configureExtras({assetsRoot:safeRelative(ctx.bundleRoot,ctx.manifest.components.extras.assets),profileRoot:ctx.profileRoot,dshHome:ctx.dshHome,backupRoot:join(ctx.stateRoot,'components','extras',ctx.deploymentId,ctx.purpose??'live')}))
 return{
  configureExtras:extras,
  async configureCandidateExtras(ctx){const result=await extras(ctx);if(ctx.manifest.components?.linter?.enabled){const{configureLinter}=await import('./linter/config.mjs');await configureLinter({...ctx,purpose:'candidate',skipLegacy:true})}return result},
  rollbackExtras:ctx=>rollbackExtras({receiptPath:ctx.componentReceipt.receiptPath}),
  configureLinter:ctx=>recipientComponent(async()=>{const{configureLinter}=await import('./linter/config.mjs');return configureLinter({...ctx,skipLegacy:skipLegacyLinter})}),
  async rollbackLinter(ctx){const{rollbackLinter}=await import('./linter/config.mjs');return rollbackLinter(ctx)},
  configureMcp:ctx=>recipientComponent(async()=>{const c=ctx.manifest.components.mcp,options={dshHome:ctx.dshHome,catalogPath:safeRelative(ctx.bundleRoot,c.catalog),credentialsPath:safeRelative(ctx.bundleRoot,c.credentials),backupRoot:join(ctx.stateRoot,'components','mcp',ctx.deploymentId)};const plan=await planMcpConfiguration(options);return applyMcpConfiguration({...options,expectedPlanDigest:plan.planDigest})}),
  rollbackMcp:ctx=>ctx.componentReceipt.receiptPath?rollbackMcpConfiguration({receiptPath:ctx.componentReceipt.receiptPath}):{status:'unchanged'},
  async configureCognee(ctx){
   const {home,root,receiptPath}=cogneePaths(ctx),config=join(home,'config.json')
   let receipt,attempted=false
   try{
    const before=await state(config),previous=await json(config,{maxBytes:8192})
    if(!same(await state(config),before))fail('DEPLOY_MEMORY_CONFIG_CHANGED')
    // Existing memory is reused only after strict loopback validation and an
    // authenticated identity probe, never a dataset/body read or key import.
    if(previous){
     let validated;try{validated=validateConfig(previous)}catch{fail('DEPLOY_EXISTING_COGNEE_CONFIG_INVALID')}
     if(!validated.enabled)fail('DEPLOY_EXISTING_COGNEE_REQUIRES_CONFIGURATION')
     const authPath=join(home,'auth.json'),authBefore=await state(authPath),auth=await json(authPath,{maxBytes:8192})
     if(!auth||Object.keys(auth).join(',')!=='apiKey'||typeof auth.apiKey!=='string'||!auth.apiKey||auth.apiKey.length>4096||/[\r\n\0]/u.test(auth.apiKey))fail('DEPLOY_EXISTING_COGNEE_AUTH_INVALID')
     if(!same(await state(authPath),authBefore))fail('DEPLOY_MEMORY_CONFIG_CHANGED')
     try{
      const health=await fetch(new URL('/health',validated.endpoint),{signal:AbortSignal.timeout(15000),redirect:'error'}),body=await health.json()
      if(!health.ok||body.status!=='ready')fail('DEPLOY_EXISTING_COGNEE_UNAVAILABLE')
      const identity=await fetch(new URL('/api/v1/auth/me',validated.endpoint),{headers:{'X-Api-Key':auth.apiKey},signal:AbortSignal.timeout(15000),redirect:'error'})
      await identity.body?.cancel?.().catch(()=>{})
      if(!identity.ok)fail('DEPLOY_EXISTING_COGNEE_AUTH_INVALID')
     }catch(error){if(error.code==='DEPLOY_EXISTING_COGNEE_AUTH_INVALID')throw error;fail('DEPLOY_EXISTING_COGNEE_UNAVAILABLE')}
     if(!same(await state(config),before)||!same(await state(authPath),authBefore))fail('DEPLOY_MEMORY_CONFIG_CHANGED')
     return{status:'reused',owned:false,files:[]}
    }
    // Partial pre-existing profile state is never overwritten, and no server
    // is started until all four destinations have been checked.
    for(const name of MEMORY_FILES)if((await state(join(home,name))).type!=='missing')fail('DEPLOY_MEMORY_PARTIAL_CONFIGURATION')
    const ownerSid=process.platform==='win32'?execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/u)?.[0]:undefined
    if(process.platform==='win32'&&!ownerSid)fail('DEPLOY_OWNER_SID_UNAVAILABLE')
    receipt={schemaVersion:1,kind:'deployment-cognee-binding',status:'preparing',stateRoot:root,owned:true,files:[]}
    await writeJson(receiptPath,seal(receipt));attempted=true
    const installed=await cognee.install({stateRoot:root,assetsRoot:safeRelative(ctx.bundleRoot,ctx.manifest.components.cognee.assets),port:cogneePort??ctx.manifest.components.cognee.port??18080,memoryGiB:5,offline,ownerSid})
    if(typeof installed?.memoryHome!=='string'||pathKey(installed.memoryHome)!==pathKey(join(root,'memory-workspace')))fail('DEPLOY_COGNEE_INSTALL_SCOPE_INVALID')
    await mkdir(home,{recursive:true})
    for(const name of MEMORY_FILES){
     const target=join(home,name);await guard(target);if((await state(target)).type!=='missing')fail('DEPLOY_MEMORY_CONFIG_CHANGED')
     const source=join(installed.memoryHome,name);await guard(source,{allowMissing:false})
     const data=await readFile(source,'utf8'),after={type:'file',bytes:Buffer.byteLength(data),sha256:sha(data)}
     receipt.files.push({target,after,written:false});await writeJson(receiptPath,seal(receipt))
     if((await state(target)).type!=='missing')fail('DEPLOY_MEMORY_CONFIG_CHANGED')
     writeProtectedFile(target,data)
     if(!same(await state(target),after))fail('DEPLOY_MEMORY_CONFIG_CHANGED')
     receipt.files.at(-1).written=true;await writeJson(receiptPath,seal(receipt))
    }
    if(!(await cognee.health({stateRoot:root})).available)fail('DEPLOY_COGNEE_UNAVAILABLE')
    receipt.status='installed';await writeJson(receiptPath,seal(receipt));return{status:'installed',owned:true,stateRoot:root,receiptPath}
   }catch(error){
    if(!attempted){error.notAttempted=true;throw error}
    const failures=[]
    try{if((await state(join(root,'receipt.json'))).type!=='missing')await cognee.stop({stateRoot:root})}catch{failures.push('DEPLOY_COGNEE_STOP_UNKNOWN')}
    try{
     for(const file of receipt.files){const current=await state(file.target);if(current.type!=='missing'&&!same(current,file.after))fail('DEPLOY_MEMORY_ROLLBACK_CONFLICT')}
     if(!failures.length)for(const file of [...receipt.files].reverse()){const current=await state(file.target);if(current.type==='missing')continue;if(!same(current,file.after))fail('DEPLOY_MEMORY_ROLLBACK_CONFLICT');await unlink(file.target)}
    }catch{failures.push('DEPLOY_MEMORY_ROLLBACK_CONFLICT')}
    receipt.status=failures.length?'interrupted':'failed-restored';receipt.recoveryFailures=failures
    await writeJson(receiptPath,seal(receipt))
    error.receiptPath=receiptPath;error.componentReceipt={owned:true,stateRoot:root,receiptPath}
    if(!failures.length)error.notAttempted=true
    throw error
   }
  },
  async rollbackCognee(ctx){
   const component=ctx.componentReceipt;if(!component.owned)return{status:'preserved-existing'}
   const expected=cogneePaths(ctx)
   if(pathKey(component.receiptPath)!==pathKey(expected.receiptPath)||pathKey(component.stateRoot)!==pathKey(expected.root))fail('DEPLOY_COGNEE_RECEIPT_INVALID')
   const receipt=await json(component.receiptPath);verifyCogneeReceipt(ctx,component,receipt)
   for(const file of receipt.files){await guard(file.target);const current=await state(file.target);if(current.type!=='missing'&&!same(current,file.after))fail('DEPLOY_MEMORY_ROLLBACK_CONFLICT')}
   await cognee.stop({stateRoot:component.stateRoot})
   for(const file of [...receipt.files].reverse()){await guard(file.target);const current=await state(file.target);if(current.type==='missing')continue;if(!same(current,file.after))fail('DEPLOY_MEMORY_ROLLBACK_CONFLICT');await unlink(file.target)}
   receipt.status='rolled-back';await writeJson(component.receiptPath,seal(receipt));return{status:'rolled-back',memoryDataPreserved:true}
  },
 }
}
