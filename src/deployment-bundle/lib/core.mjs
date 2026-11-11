import {randomUUID} from 'node:crypto'
import {readFile,readdir,mkdir,writeFile,unlink,copyFile,rename} from 'node:fs/promises'
import {join,resolve,dirname,relative,sep} from 'node:path'
import {absolute,safeRelative,below,guard,kind,hashFile,state,same,json,writeAtomic,writeJson,seal,validSeal,sha,canonical,pathKey,plain,fail,boundedCode,DeploymentError} from './fs.mjs'
import {createOfficialDeploymentAdapters} from './official-adapter.mjs'
import {appendCacheJournal,readCacheJournal,restoreCacheRows} from './cache-journal.mjs'
export {createOfficialDeploymentAdapters,DeploymentError}

const HASH=/^[a-f0-9]{64}$/u,VERSION=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u,ID=/^[a-f0-9-]{36}$/u
const PROFILE_FILES={
 'package.json':JSON.stringify({name:'dsh-profile-desktop',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},null,2)+'\n',
 'cordis.patch.yml':'# User profile patch layer. Managed deployment fragments are appended below.\n[]\n',
 'pnpm-workspace.yaml':'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
}
function validateManifest(value){
 if(!plain(value)||value.schemaVersion!==1||value.kind!=='airules-dsh-deployment'||!VERSION.test(value.version??'')||value.platform!=='win32-x64'||!VERSION.test(value.hostVersion??'')||!plain(value.paths)||!plain(value.files))fail('DEPLOY_MANIFEST_INVALID')
 for(const name of ['engine','uiArtifact','policyArtifact','releaseLock','node','python','officialInstaller'])if(typeof value.paths[name]!=='string')fail('DEPLOY_MANIFEST_PATH_REQUIRED')
 const names=Object.keys(value.files);if(!names.length||names.length>50000||new Set(names.map(n=>n.toLowerCase())).size!==names.length)fail('DEPLOY_INVENTORY_INVALID')
 let total=0
 for(const [name,row]of Object.entries(value.files)){safeRelative(resolve('.'),name);if(!plain(row)||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>32*1024**3||!HASH.test(row.sha256??''))fail('DEPLOY_INVENTORY_INVALID');total+=row.bytes}
 if(total>64*1024**3)fail('DEPLOY_SIZE_LIMIT')
 for(const name of ['releaseLock','node','python','officialInstaller'])if(!Object.hasOwn(value.files,value.paths[name]))fail('DEPLOY_INVENTORY_PATH_MISSING')
 for(const name of ['engine','uiArtifact','policyArtifact']){safeRelative(resolve('.'),value.paths[name]);if(!names.some(path=>path.startsWith(value.paths[name]+'/')))fail('DEPLOY_INVENTORY_PATH_MISSING')}
 for(const name of ['uiArtifact','policyArtifact','releaseLock'])if(!value.paths[name].startsWith(value.paths.engine+'/'))fail('DEPLOY_ENGINE_LAYOUT_INVALID')
 if(value.components?.cognee?.enabled!==true||value.components?.mcp?.enabled!==true)fail('DEPLOY_REQUIRED_COMPONENT_MISSING')
 return value
}
export async function readDeploymentBundle(bundleRoot,{verifyFiles=true,signal}={}){
 const root=absolute(bundleRoot),manifestPath=join(root,'deployment-manifest.json');await guard(root,{allowMissing:false})
 const manifest=validateManifest(await json(manifestPath)),identity=sha(await readFile(manifestPath)),files=Object.keys(manifest.files).sort()
 if(verifyFiles)for(const name of files){signal?.throwIfAborted();if(!same(await hashFile(safeRelative(root,name)),manifest.files[name]))fail('DEPLOY_PAYLOAD_HASH_MISMATCH',{path:name})}
 return{root,manifest,identity,files,totalBytes:files.reduce((sum,name)=>sum+manifest.files[name].bytes,0)}
}
function pathsFor({stateRoot,installRoot,dshHome},manifest){
 const root=absolute(stateRoot),install=absolute(installRoot),home=absolute(dshHome),cache=join(root,'package'),engine=safeRelative(cache,manifest.paths.engine),profile=join(home,'profiles','desktop')
 for(const [a,b]of [[root,install],[root,home],[install,home]])if(pathKey(a)===pathKey(b)||below(a,b)||below(b,a))fail('DEPLOY_ROOTS_OVERLAP')
 return{stateRoot:root,installRoot:install,dshHome:home,cacheRoot:cache,engineRoot:engine,profileRoot:profile,currentPath:join(root,'current.json'),cacheStatePath:join(root,'cache-state.json')}
}
export function createDeploymentService(options={}){
 const {bundleRoot,signal,onProgress=()=>{}}=options,adapters={...createOfficialDeploymentAdapters(),...options.adapters},plans=new Map();let busy=false
 const phase=name=>{signal?.throwIfAborted();onProgress({phase:name})}
 async function loadCurrent(paths){const current=await json(paths.currentPath);if(current&&!validSeal(current))fail('DEPLOY_CURRENT_RECEIPT_INVALID');return current}
 async function pendingDeployments(paths){
  const root=join(paths.stateRoot,'deployments');await guard(root);let entries
  try{entries=await readdir(root,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return[];throw error}
  const pending=[]
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   const transaction=join(root,entry.name),receiptPath=join(transaction,'receipt.json'),id=ID.test(entry.name)?entry.name:'invalid-directory'
   try{
    await guard(transaction);if(!entry.isDirectory()||!ID.test(entry.name))fail('DEPLOY_RECEIPT_INVALID')
    const receipt=await json(receiptPath)
    if(!validSeal(receipt)||receipt.schemaVersion!==1||receipt.kind!=='airules-dsh-deployment-receipt'||receipt.deploymentId!==entry.name||pathKey(receipt.transaction)!==pathKey(transaction)||!plain(receipt.paths)||['stateRoot','installRoot','dshHome'].some(key=>typeof receipt.paths[key]!=='string'||pathKey(receipt.paths[key])!==pathKey(paths[key])))fail('DEPLOY_RECEIPT_INVALID')
    if(['installed','failed-restored','rolled-back'].includes(receipt.status))continue
    pending.push({id,status:typeof receipt.status==='string'&&/^[a-z-]{1,40}$/u.test(receipt.status)?receipt.status:'invalid-status',receiptPath,recoveryFailures:Array.isArray(receipt.recoveryFailures)?receipt.recoveryFailures.slice(0,32).map(row=>({code:boundedCode({code:row?.code})})):[]})
   }catch{pending.push({id,status:'invalid-receipt',receiptPath,recoveryFailures:[{code:'DEPLOY_RECEIPT_INVALID'}]})}
  }
  return pending
 }
 async function assertNoPending(paths){const pending=await pendingDeployments(paths);if(pending.length)fail('DEPLOY_RECOVERY_REQUIRED',{pending})}
 function receiptScope(current,receipt,paths){
  const expected=join(paths.stateRoot,'deployments',current.deploymentId,'receipt.json')
  if(!ID.test(current.deploymentId??'')||pathKey(current.receiptPath)!==pathKey(expected)||pathKey(receipt.transaction)!==pathKey(dirname(expected))||receipt.previousCurrent&&!validSeal(receipt.previousCurrent))fail('DEPLOY_RECEIPT_INVALID')
  if(receipt.machine&&(pathKey(receipt.machine.target)!==pathKey(join(paths.dshHome,'git-maintenance/settings.json'))||receipt.machine.backup!==null&&receipt.machine.backup!=='machine-settings.before.json'))fail('DEPLOY_RECEIPT_INVALID')
  const allowed=new Set(Object.keys(PROFILE_FILES).map(name=>pathKey(join(paths.profileRoot,name))))
  if(!Array.isArray(receipt.bootstrap)||receipt.bootstrap.some(row=>!allowed.has(pathKey(row.target))||row.after?.type!=='file'||!HASH.test(row.after.sha256??'')))fail('DEPLOY_RECEIPT_INVALID')
  if(!below(join(paths.engineRoot,'var/live-promotion-backups'),receipt.overlayReceiptPath))fail('DEPLOY_RECEIPT_INVALID')
 }
 async function context(bundle,paths,id){return{bundleRoot:paths.cacheRoot,sourceBundleRoot:bundle.root,stateRoot:paths.stateRoot,engineRoot:paths.engineRoot,installRoot:paths.installRoot,dshHome:paths.dshHome,profileRoot:paths.profileRoot,manifest:bundle.manifest,identity:bundle.identity,deploymentId:id,signal,paths:bundle.manifest.paths,nodePath:safeRelative(paths.cacheRoot,bundle.manifest.paths.node),pythonPath:safeRelative(paths.cacheRoot,bundle.manifest.paths.python)}}
 async function inspect(bundle,paths){const host=await adapters.inspectOfficial({...await context(bundle,paths,'inspection'),releaseLockPath:safeRelative(bundle.root,bundle.manifest.paths.releaseLock)});if(host.installed&&!host.compatible)fail('DEPLOY_HOST_INCOMPATIBLE');return host}
 async function plan({mode='install'}={}){
  if(!['install','update','repair'].includes(mode))fail('DEPLOY_MODE_INVALID');phase('verify-package')
  const bundle=await readDeploymentBundle(bundleRoot,{signal}),paths=pathsFor(options,bundle.manifest);await assertNoPending(paths)
  const current=await loadCurrent(paths),host=await inspect(bundle,paths),cacheState=await json(paths.cacheStatePath)
  if(cacheState&&!validSeal(cacheState))fail('DEPLOY_CACHE_STATE_INVALID')
  if(pathKey(bundle.root)===pathKey(paths.stateRoot)||below(bundle.root,paths.stateRoot)||below(paths.stateRoot,bundle.root))fail('DEPLOY_SOURCE_STATE_OVERLAP')
  const changes=[],conflicts=[],incoming={...bundle.manifest.files,'deployment-manifest.json':await hashFile(join(bundle.root,'deployment-manifest.json'))}
  for(const name of Object.keys(incoming).sort()){signal?.throwIfAborted();const before=await state(safeRelative(paths.cacheRoot,name)),after={type:'file',...incoming[name]};if(same(before,after))continue;const owned=cacheState?.files?.[name];if(before.type!=='missing'&&(!owned||mode!=='repair'&&!same(before,{type:'file',...owned})))conflicts.push(name);changes.push({path:name,before,after})}
  const bootstrap=[]
  for(const[name,text]of Object.entries(PROFILE_FILES)){const path=join(paths.profileRoot,name),before=await state(path);if(before.type==='missing')bootstrap.push({path:name,after:{type:'file',bytes:Buffer.byteLength(text),sha256:sha(text)}});else if(before.type!=='file')conflicts.push('profile/'+name)}
  const id=randomUUID(),record={schemaVersion:1,planId:id,mode,bundleIdentity:bundle.identity,version:bundle.manifest.version,hostVersion:bundle.manifest.hostVersion,requiresOfficialInstall:!host.installed,currentDeploymentId:current?.deploymentId??null,currentState:await state(paths.currentPath),cacheState:await state(paths.cacheStatePath),paths,changes,conflicts,bootstrap,createdAt:new Date().toISOString()}
  plans.set(id,{record,bundle});return{planId:id,status:conflicts.length?'blocked':'ready',version:record.version,hostVersion:record.hostVersion,mode,requiresOfficialInstall:record.requiresOfficialInstall,packageFiles:bundle.files.length,totalBytes:bundle.totalBytes,cacheChanges:changes.length,conflicts,profileBootstrapFiles:bootstrap.map(row=>row.path),components:['extras','cognee','mcp'],installRoot:paths.installRoot,dshHome:paths.dshHome,stateRoot:paths.stateRoot,previousDeploymentId:record.currentDeploymentId,readOnly:true}
 }
 async function lock(paths,id){await guard(paths.stateRoot);await mkdir(paths.stateRoot,{recursive:true});const path=join(paths.stateRoot,'deployment.lock'),bytes=Buffer.from(id);try{await writeFile(path,bytes,{flag:'wx',mode:0o600})}catch(e){if(e.code==='EEXIST')fail('DEPLOY_BUSY');throw e}return async()=>{if((await readFile(path).catch(()=>Buffer.alloc(0))).equals(bytes))await unlink(path)}}
 async function writeReceipt(path,value){await writeJson(path,seal(value));return seal(value)}
 async function installCache(bundle,paths,transaction,changes){
  const prior=await json(paths.cacheStatePath),owned={...(prior?.files??{})},rows=[]
  for(const change of changes){signal?.throwIfAborted();const from=safeRelative(bundle.root,change.path),to=safeRelative(paths.cacheRoot,change.path);if(!same(await state(to),change.before))fail('DEPLOY_CACHE_CHANGED');let backup=null;if(change.before.type==='file'){backup='cache-before/'+change.path;const dest=safeRelative(transaction,backup);await mkdir(dirname(dest),{recursive:true});await guard(dest);await copyFile(to,dest);if(!same(await state(dest),change.before))fail('DEPLOY_CACHE_BACKUP_INVALID')}rows.push({...change,backup,written:false});await appendCacheJournal(transaction,{kind:'prepare',index:rows.length-1,row:rows.at(-1)});await mkdir(dirname(to),{recursive:true});await guard(to);const temp=to+'.'+randomUUID()+'.tmp';try{await copyFile(from,temp);if(!same(await state(temp),change.after))fail('DEPLOY_CACHE_COPY_INVALID');if(!same(await state(to),change.before))fail('DEPLOY_CACHE_CHANGED');await rename(temp,to)}finally{await unlink(temp).catch(()=>{})}rows.at(-1).written=true;await appendCacheJournal(transaction,{kind:'commit',index:rows.length-1})}
  for(const name of bundle.files)owned[name]=bundle.manifest.files[name]
  owned['deployment-manifest.json']=await hashFile(join(bundle.root,'deployment-manifest.json'))
  await writeJson(paths.cacheStatePath,seal({schemaVersion:1,version:bundle.manifest.version,files:owned}));return rows
 }
 async function restoreCache(paths,transaction,rows,priorState){
  await restoreCacheRows({cacheRoot:paths.cacheRoot,transaction,rows})
  if(priorState)await writeAtomic(paths.cacheStatePath,priorState);else if(await kind(paths.cacheStatePath)==='file')await unlink(paths.cacheStatePath)
 }
 async function configureMachine(ctx,transaction){
  const target=join(ctx.dshHome,'git-maintenance','settings.json'),before=await state(target),old=await json(target),settings=old??{schemaVersion:1,airules:{repository:'https://github.com/s0loww/airules.git',ref:'main',localPath:''},harness:{repository:'https://github.com/s0loww/dsh-harness-overlay.git',ref:'main',engineRoot:'',installRoot:'',profileRoot:'',previousReceiptPath:'',localReleaseRoot:''},python:'python',node:'node'}
  if(settings.schemaVersion!==1||!plain(settings.harness))fail('DEPLOY_MACHINE_SETTINGS_INVALID')
  Object.assign(settings.harness,{engineRoot:ctx.engineRoot,installRoot:ctx.installRoot,profileRoot:ctx.profileRoot,previousReceiptPath:ctx.overlayReceiptPath});settings.node=ctx.nodePath;settings.python=ctx.pythonPath
  const bytes=Buffer.from(JSON.stringify(settings,null,2)+'\n'),backup=before.type==='file'?'machine-settings.before.json':null
  if(backup)await copyFile(target,join(transaction,backup));await writeAtomic(target,bytes,{expected:before});return{target,before,after:await state(target),backup}
 }
 async function restoreMachine(row,transaction){if(!row)return;if(!same(await state(row.target),row.after))fail('DEPLOY_MACHINE_SETTINGS_CHANGED');if(row.backup)await writeAtomic(row.target,await readFile(join(transaction,row.backup)),{expected:row.after});else await unlink(row.target)}
 async function apply({planId,acceptPlan=false}={}){
  if(!acceptPlan)fail('DEPLOY_PLAN_ACCEPTANCE_REQUIRED');if(busy)fail('DEPLOY_BUSY');const selected=plans.get(planId);if(!selected)fail('DEPLOY_PLAN_UNKNOWN');if(selected.record.conflicts.length)fail('DEPLOY_PLAN_BLOCKED');busy=true
  const {record,bundle:prepared}=selected,paths=record.paths,id=randomUUID(),transaction=join(paths.stateRoot,'deployments',id),receiptPath=join(transaction,'receipt.json');let unlock,receipt,ctx,cacheRows=[],cacheBefore,overlay,machine,extras,cognee,mcp,activeComponent=null
  try{
   unlock=await lock(paths,id);await assertNoPending(paths);phase('reverify-package');const bundle=await readDeploymentBundle(bundleRoot,{signal});if(bundle.identity!==prepared.identity)fail('DEPLOY_PACKAGE_CHANGED');if(!same(await state(paths.currentPath),record.currentState)||!same(await state(paths.cacheStatePath),record.cacheState))fail('DEPLOY_STATE_CHANGED')
   await adapters.assertStopped({installRoot:paths.installRoot,signal});await mkdir(transaction,{recursive:true});cacheBefore=await readFile(paths.cacheStatePath).catch(e=>{if(e.code==='ENOENT')return null;throw e});if(cacheBefore)await writeFile(join(transaction,'cache-state.before.json'),cacheBefore,{flag:'wx',mode:0o600})
   receipt={schemaVersion:1,kind:'airules-dsh-deployment-receipt',deploymentId:id,status:'preparing',version:bundle.manifest.version,bundleIdentity:bundle.identity,manifestDescriptor:{schemaVersion:1,kind:bundle.manifest.kind,version:bundle.manifest.version,hostVersion:bundle.manifest.hostVersion,platform:bundle.manifest.platform,paths:bundle.manifest.paths,components:bundle.manifest.components},paths,transaction,previousCurrent:await loadCurrent(paths),startedAt:new Date().toISOString(),components:{},bootstrap:[],officialInstalled:false}
   await writeReceipt(receiptPath,receipt);phase('cache-runtime');cacheRows=await installCache(bundle,paths,transaction,record.changes);ctx=await context(bundle,paths,id)
   await adapters.assertStopped(ctx);const host=await inspect(bundle,paths)
   if(!host.installed){phase('install-official-desktop');await adapters.installOfficial({...ctx,installerPath:safeRelative(paths.cacheRoot,bundle.manifest.paths.officialInstaller),releaseLockPath:safeRelative(paths.cacheRoot,bundle.manifest.paths.releaseLock),transaction});receipt.officialInstalled=true;await writeReceipt(receiptPath,receipt)}
   const verified=await adapters.inspectOfficial({...ctx,releaseLockPath:safeRelative(paths.cacheRoot,bundle.manifest.paths.releaseLock)});if(!verified.installed||!verified.compatible)fail('DEPLOY_OFFICIAL_VERIFY_FAILED');await adapters.assertStopped(ctx)
   phase('bootstrap-profile');await guard(paths.profileRoot);await guard(join(paths.profileRoot,'node_modules'));await mkdir(join(paths.profileRoot,'node_modules'),{recursive:true});await guard(join(paths.profileRoot,'node_modules'))
   for(const row of record.bootstrap){const target=join(paths.profileRoot,row.path);if((await state(target)).type!=='missing')fail('DEPLOY_PROFILE_CHANGED');await writeAtomic(target,Buffer.from(PROFILE_FILES[row.path]),{expected:{type:'missing'}});receipt.bootstrap.push({target,after:await state(target)});await writeReceipt(receiptPath,receipt)}
   if(adapters.configureExtras){phase('configure-extras');activeComponent='extras';extras=await adapters.configureExtras(ctx);activeComponent=null;receipt.components.extras=extras??{};await writeReceipt(receiptPath,receipt)}
   phase('certify-candidate');const candidateRoot=await adapters.prepareCandidate({...ctx,configureCandidateExtras:adapters.configureCandidateExtras})
   phase('apply-overlay');const current=await loadCurrent(paths);overlay=await adapters.applyOverlay({...ctx,candidateRoot,previousReceiptPath:current?.overlayReceiptPath,backupRoot:join(paths.engineRoot,'var/live-promotion-backups','deployment-'+id)});if(!overlay?.receiptPath)fail('DEPLOY_OVERLAY_RECEIPT_REQUIRED');receipt.overlayReceiptPath=overlay.receiptPath;await writeReceipt(receiptPath,receipt)
   ctx.overlayReceiptPath=overlay.receiptPath;machine=await configureMachine(ctx,transaction);receipt.machine=machine;await writeReceipt(receiptPath,receipt)
   for(const name of ['cognee','mcp']){if(typeof adapters[name==='cognee'?'configureCognee':'configureMcp']!=='function')fail('DEPLOY_COMPONENT_ADAPTER_REQUIRED');phase('configure-'+name);activeComponent=name;const value=await adapters[name==='cognee'?'configureCognee':'configureMcp'](ctx);activeComponent=null;if(name==='cognee')cognee=value;else mcp=value;receipt.components[name]=value??{};await writeReceipt(receiptPath,receipt)}
   phase('verify-installation');const verification=await adapters.verifyOverlay({...ctx,receiptPath:overlay.receiptPath});if(verification?.status!=='PASS')fail('DEPLOY_OVERLAY_VERIFY_FAILED');receipt.status='installed';receipt.completedAt=new Date().toISOString();receipt.verification=verification;await writeReceipt(receiptPath,receipt)
   const currentRecord=seal({schemaVersion:1,deploymentId:id,version:bundle.manifest.version,bundleIdentity:bundle.identity,receiptPath,overlayReceiptPath:overlay.receiptPath,engineRoot:paths.engineRoot,installRoot:paths.installRoot,dshHome:paths.dshHome,completedAt:receipt.completedAt});await writeJson(paths.currentPath,currentRecord,{expected:record.currentState});plans.delete(planId)
   return{status:'installed',version:bundle.manifest.version,deploymentId:id,receiptPath,overlayReceiptPath:overlay.receiptPath,engineRoot:paths.engineRoot,components:['extras','cognee','mcp'],officialInstalled:receipt.officialInstalled}
  }catch(error){
   const failures=[]
   if(receipt&&activeComponent&&plain(error.componentReceipt))receipt.components[activeComponent]=error.componentReceipt
   if(activeComponent&&!error.notAttempted)failures.push({component:activeComponent,code:'DEPLOY_COMPONENT_OUTCOME_UNKNOWN'})
   const recover=async(name,fn)=>{try{await fn()}catch(e){failures.push({component:name,code:boundedCode(e)})}}
   if(ctx){if(mcp&&adapters.rollbackMcp)await recover('mcp',()=>adapters.rollbackMcp({...ctx,componentReceipt:mcp,preserveData:true}));if(cognee&&adapters.rollbackCognee)await recover('cognee',()=>adapters.rollbackCognee({...ctx,componentReceipt:cognee,preserveData:true}));if(machine)await recover('machine',()=>restoreMachine(machine,transaction));if(overlay)await recover('overlay',()=>adapters.rollbackOverlay({...ctx,receiptPath:overlay.receiptPath}));if(extras&&adapters.rollbackExtras)await recover('extras',()=>adapters.rollbackExtras({...ctx,componentReceipt:extras,preserveData:true}))}
   for(const row of [...(receipt?.bootstrap??[])].reverse())await recover('bootstrap',async()=>{if(!same(await state(row.target),row.after))fail('DEPLOY_PROFILE_RECOVERY_CONFLICT');await unlink(row.target)})
   if(!cacheRows.length&&receipt)await recover('cache-journal',async()=>{cacheRows=await readCacheJournal(transaction)})
   if(cacheRows.length)await recover('cache',()=>restoreCache(paths,transaction,cacheRows,cacheBefore))
   if(receipt){receipt.status=failures.length?'recovery-required':'failed-restored';receipt.error=boundedCode(error);receipt.recoveryFailures=failures;await writeReceipt(receiptPath,receipt).catch(()=>{})}
   throw new DeploymentError(boundedCode(error),{receiptPath:receipt?receiptPath:undefined,recoveryFailures:failures})
  }finally{if(unlock)await unlock();busy=false}
 }
 async function status(){const bundle=await readDeploymentBundle(bundleRoot,{verifyFiles:false}),paths=pathsFor(options,bundle.manifest),current=await loadCurrent(paths);return{installed:!!current,current,installRoot:paths.installRoot,dshHome:paths.dshHome,stateRoot:paths.stateRoot,pending:await pendingDeployments(paths)}}
 async function rollback({deploymentId}={}){
  if(busy)fail('DEPLOY_BUSY');if(deploymentId!==undefined&&!ID.test(deploymentId))fail('DEPLOY_ID_INVALID');busy=true;let unlock
  try{const incoming=await readDeploymentBundle(bundleRoot,{verifyFiles:false}),paths=pathsFor(options,incoming.manifest),current=await loadCurrent(paths);if(!current||deploymentId&&current.deploymentId!==deploymentId)fail('DEPLOY_CURRENT_REQUIRED');if(!ID.test(current.deploymentId??'')||pathKey(current.receiptPath)!==pathKey(join(paths.stateRoot,'deployments',current.deploymentId,'receipt.json')))fail('DEPLOY_RECEIPT_INVALID');unlock=await lock(paths,current.deploymentId);const receipt=await json(current.receiptPath);if(!validSeal(receipt)||!['installed','rollback-interrupted'].includes(receipt.status)||receipt.deploymentId!==current.deploymentId||pathKey(receipt.paths.stateRoot)!==pathKey(paths.stateRoot)||pathKey(receipt.paths.dshHome)!==pathKey(paths.dshHome)||pathKey(receipt.paths.installRoot)!==pathKey(paths.installRoot)||!plain(receipt.manifestDescriptor))fail('DEPLOY_RECEIPT_INVALID');receiptScope(current,receipt,paths);const bundle={root:paths.cacheRoot,manifest:receipt.manifestDescriptor,identity:receipt.bundleIdentity},ctx=await context(bundle,paths,current.deploymentId);await adapters.assertStopped(ctx)
   const completed=new Set(receipt.rollbackCompleted??[]),preservedModified=receipt.preservedModified??[]
   if(!completed.has('overlay')&&(await adapters.verifyOverlay({...ctx,receiptPath:receipt.overlayReceiptPath}))?.status!=='PASS')fail('DEPLOY_OVERLAY_VERIFY_FAILED')
   if(!completed.has('machine')&&receipt.machine&&!same(await state(receipt.machine.target),receipt.machine.after))preservedModified.push(receipt.machine.target)
   const step=async(name,fn)=>{if(completed.has(name))return;receipt.status='rollback-interrupted';receipt.rollbackActiveStep=name;await writeReceipt(current.receiptPath,receipt);await fn();completed.add(name);receipt.rollbackCompleted=[...completed];delete receipt.rollbackActiveStep;await writeReceipt(current.receiptPath,receipt)}
   try{
    for(const[name,method]of [['mcp','rollbackMcp'],['cognee','rollbackCognee']])if(receipt.components[name]&&adapters[method])await step(name,()=>adapters[method]({...ctx,componentReceipt:receipt.components[name],preserveData:true}))
    await step('machine',async()=>{if(!preservedModified.includes(receipt.machine?.target))await restoreMachine(receipt.machine,receipt.transaction)})
    await step('overlay',()=>adapters.rollbackOverlay({...ctx,receiptPath:receipt.overlayReceiptPath}))
    if(receipt.components.extras&&adapters.rollbackExtras)await step('extras',()=>adapters.rollbackExtras({...ctx,componentReceipt:receipt.components.extras,preserveData:true}))
    await step('bootstrap',async()=>{for(const row of [...receipt.bootstrap].reverse()){if(same(await state(row.target),row.after))await unlink(row.target);else preservedModified.push(row.target)}})
   }catch(error){receipt.status='rollback-interrupted';receipt.rollbackError=boundedCode(error);receipt.preservedModified=preservedModified;await writeReceipt(current.receiptPath,receipt);throw new DeploymentError(boundedCode(error),{receiptPath:current.receiptPath})}
   receipt.status='rolled-back';receipt.rolledBackAt=new Date().toISOString();receipt.preservedModified=preservedModified;await writeReceipt(current.receiptPath,receipt);if(receipt.previousCurrent)await writeJson(paths.currentPath,receipt.previousCurrent);else await unlink(paths.currentPath)
   return{status:'rolled-back',deploymentId:receipt.deploymentId,preservedModified,officialDesktopPreserved:true,memoryDataPreserved:true}
  }finally{if(unlock)await unlock();busy=false}
 }
 async function uninstallOverlay(){const deployments=[];for(let n=0;n<64;n++){const current=await status();if(!current.installed)return{status:'uninstalled-overlay',deployments,officialDesktopPreserved:true,memoryDataPreserved:true};const result=await rollback();deployments.push(result.deploymentId)}fail('DEPLOY_RECEIPT_CHAIN_LIMIT')}
 return{plan,apply,status,rollback,uninstallOverlay}
}
