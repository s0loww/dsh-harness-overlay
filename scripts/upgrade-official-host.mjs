import {cp,mkdir,readFile,writeFile,lstat,chmod,rm,rename,readdir,open,link} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join,dirname,relative,isAbsolute,sep,parse,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {verifyOfficialDesktop} from '../src/targets/official-desktop/target.mjs'
import {verifyUiArtifact} from '../installer/official-ui/common.mjs'
import {verifyPolicyArtifact} from '../installer/official-policy/common.mjs'
import {readLiveUpdateReceipt,exactSubset,SHARED_SUBSET_DEPENDENCIES,STORAGE_DOMAIN,NESTED_ZOD,directoryStateWithNested,PROMOTION_BACKUPS_ROOT} from '../installer/official-live/common.mjs'
import {migrateCordisFragments} from '../installer/official-live/cordis-migration.mjs'
import {stagePackage} from '../installer/official-live/apply.mjs'
import {assertDesktopStopped} from '../installer/official-live/process-guard.mjs'
import {canonical,sameState,targetState,pathKind,sha256} from '../installer/fs-state.mjs'
import {sealReceipt,verifyReceiptIntegrity} from '../installer/receipt.mjs'

const REPO=resolve(fileURLToPath(new URL('..',import.meta.url)))
export const HOST_UPGRADE_ROOT=join(REPO,'var/host-upgrade-transactions')
export const HOST_UPGRADE_ACK='I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_REPLACES_HOST_AND_PROFILE'
export const HOST_ROLLBACK_ACK='I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_RESTORES_HOST_AND_PROFILE_BACKUP'
const executable=promisify(execFile),PACKAGE=/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const approvedPlans=new WeakSet()
const activeLeases=new WeakMap()
const fail=code=>{throw Object.assign(new Error(code),{code})}
const overlap=(a,b)=>{const under=(x,y)=>{const d=relative(resolve(x),resolve(y));return d===''||d!=='..'&&!d.startsWith('..'+sep)&&!isAbsolute(d)};return under(a,b)||under(b,a)}
async function noLinks(path){let at=parse(path).root;for(const part of relative(at,path).split(sep).filter(Boolean)){at=join(at,part);let info;try{info=await lstat(at)}catch(e){if(e.code==='ENOENT')break;throw e}if(info.isSymbolicLink())fail('HOST_UPGRADE_LINK_FORBIDDEN')}}
function absolute(value){if(typeof value!=='string'||!isAbsolute(value))fail('HOST_UPGRADE_ABSOLUTE_PATH_REQUIRED');const path=resolve(value);if(path.toLowerCase()===parse(path).root.toLowerCase())fail('HOST_UPGRADE_VOLUME_ROOT_FORBIDDEN');return path}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child)}return value}
function target(lock){return {kind:'official-desktop',hostVersion:lock.hostVersion,appAsarSha256:lock.files['resources/app.asar']?.sha256}}
function artifactTarget(artifact,expected){const declared=artifact.target;if(declared?.kind!=='official-desktop'||!(declared.hostVersions??[declared.hostVersion]).includes(expected.hostVersion)||declared.appAsarSha256!==expected.appAsarSha256)fail('HOST_UPGRADE_ARTIFACT_TARGET_MISMATCH')}
async function json(path){return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,''))}
async function layers(uiRoot,policyRoot,expected){
 const ui=await verifyUiArtifact(uiRoot),policy=await verifyPolicyArtifact(policyRoot)
 artifactTarget(policy.manifest,expected)
 const uiContract=await json(join(ui.root,'official-ui-manifest.json'))
 artifactTarget(uiContract,expected)
 if(canonical(uiContract.artifact)!==canonical(ui.manifest.artifact)||!(ui.manifest.target?.hostVersions??[ui.manifest.target?.hostVersion]).includes(expected.hostVersion))fail('HOST_UPGRADE_UI_CONTRACT_MISMATCH')
 const packages=[...uiContract.packages.map(row=>({...row,root:ui.root})),...policy.packageNames.map(name=>({name,source:`payload/packages/${name}`,root:policy.root}))]
 const names=packages.map(row=>row.name)
 if(new Set(names).size!==names.length||names.some(name=>!PACKAGE.test(name)))fail('HOST_UPGRADE_PACKAGE_ALLOWLIST_INVALID')
 for(const row of packages){const source=resolve(row.root,row.source);if(!source.startsWith(row.root+sep))fail('HOST_UPGRADE_SOURCE_ESCAPE');row.source=source;if(row.name==='airules-dsh-rulepack'){const identity=await json(join(source,'manifest.json'));if(identity.package?.id!==row.name)fail('HOST_UPGRADE_PACKAGE_IDENTITY_MISMATCH')}else{const identity=await json(join(source,'package.json'));if(identity.name!==row.name)fail('HOST_UPGRADE_PACKAGE_IDENTITY_MISMATCH')}}
 return {ui,policy,uiContract,packages,names}
}

/** Read-only planning. Old receipt is validated against OLD target unchanged. */
export async function buildHostUpgradePlan(options){
 const install=absolute(options.oldInstallRoot),home=absolute(options.homeRoot),electron=absolute(options.electronUserDataRoot),next=absolute(options.newInstallRoot),transaction=absolute(options.transactionRoot)
 if(dirname(transaction)!==HOST_UPGRADE_ROOT)fail('HOST_UPGRADE_TRANSACTION_NOT_DIRECT_CHILD')
 const roots=[install,home,electron,next,transaction]
 for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(overlap(roots[i],roots[j]))fail('HOST_UPGRADE_ROOTS_OVERLAP')
 for(const root of roots)await noLinks(root)
 if(await pathKind(transaction)!=='missing')fail('HOST_UPGRADE_TRANSACTION_EXISTS')
 const oldLockPath=absolute(options.oldReleaseLockPath),newLockPath=absolute(options.newReleaseLockPath)
 const oldVerified=await verifyOfficialDesktop({installRoot:install,releaseLockPath:oldLockPath}),newVerified=await verifyOfficialDesktop({installRoot:next,releaseLockPath:newLockPath})
 const oldTarget=target(oldVerified.lock),newTarget=target(newVerified.lock)
 if(canonical(oldTarget)===canonical(newTarget)||oldTarget.hostVersion===newTarget.hostVersion)fail('HOST_UPGRADE_DISTINCT_HOSTS_REQUIRED')
 const oldLayers=await layers(options.oldUiArtifactRoot,options.oldPolicyArtifactRoot,oldTarget),newLayers=await layers(options.newUiArtifactRoot,options.newPolicyArtifactRoot,newTarget)
 const profile=join(home,'profiles/desktop')
 const previous=await readLiveUpdateReceipt({previousReceiptPath:absolute(options.previousReceiptPath),paths:{install,profile,backup:transaction},target:oldTarget,packageNames:oldLayers.names})
 const identities=previous.receipt.artifacts
 for(const key of ['ui','policy'])if(identities?.[key]?.manifestSha256!==oldLayers[key].manifestSha256||identities[key].version!==oldLayers[key].manifest.artifact.version||identities[key].id!==oldLayers[key].manifest.artifact.id)fail('HOST_UPGRADE_OLD_ARTIFACT_MISMATCH')
 if(canonical([...previous.receipt.artifactPackageNames].sort())!==canonical([...oldLayers.names].sort()))fail('HOST_UPGRADE_OLD_ALLOWLIST_MISMATCH')
 const oldNoops=previous.receipt.dependencyResolution?.verifiedNoops??[]
 if(!Array.isArray(oldNoops)||new Set(oldNoops.map(row=>row?.package)).size!==oldNoops.length||oldNoops.some(row=>!row||(!SHARED_SUBSET_DEPENDENCIES.has(row.package)&&row.package!==STORAGE_DOMAIN)||typeof row.version!=='string'||!['sourceDigest','installedDigest'].every(key=>/^[a-f0-9]{64}$/.test(row[key]??''))||row.mode!==(row.package===STORAGE_DOMAIN?'composite-subset':'same-version-subset')))fail('HOST_UPGRADE_PREVIOUS_NOOPS_INVALID')
 const operations=[],verifiedNoops=[]
 const zod=newLayers.packages.find(row=>row.name===NESTED_ZOD)
 for(const row of newLayers.packages){
  if(row.name===NESTED_ZOD)continue
  const before=await targetState(join(profile,'node_modules',...row.name.split('/')))
  let after=await targetState(row.source),nestedDependency,dependencyMigration
  if(row.name===STORAGE_DOMAIN){if(!zod)fail('HOST_UPGRADE_NESTED_ZOD_REQUIRED');const identity=await json(join(row.source,'package.json')),zi=await json(join(zod.source,'package.json'));if(identity.dependencies?.zod!==zi.version)fail('HOST_UPGRADE_NESTED_ZOD_MISMATCH');after=directoryStateWithNested(after,NESTED_ZOD,await targetState(zod.source));nestedDependency={name:NESTED_ZOD,source:zod.source,targetRelative:'node_modules/zod'}}
  if(before.type!=='missing'&&!previous.owned.has(row.name)){
   const installed=await json(join(profile,'node_modules',...row.name.split('/'),'package.json')),source=await json(join(row.source,'package.json'))
   if((SHARED_SUBSET_DEPENDENCIES.has(row.name)||row.name===STORAGE_DOMAIN)&&installed.version===source.version&&exactSubset(after,before)){verifiedNoops.push({package:row.name,version:source.version,sourceDigest:after.digest,installedDigest:before.digest,mode:row.name===STORAGE_DOMAIN?'composite-subset':'same-version-subset'});continue}
   const receiptNoop=oldNoops.find(noop=>noop.package===row.name),oldSource=oldLayers.packages.find(pkg=>pkg.name===row.name)
   if(!receiptNoop||!oldSource||(!SHARED_SUBSET_DEPENDENCIES.has(row.name)&&row.name!==STORAGE_DOMAIN))fail('HOST_UPGRADE_UNOWNED_PACKAGE_COLLISION')
   let oldSourceState=await targetState(oldSource.source)
   if(row.name===STORAGE_DOMAIN){const oldZod=oldLayers.packages.find(pkg=>pkg.name===NESTED_ZOD);if(!oldZod)fail('HOST_UPGRADE_DEPENDENCY_MIGRATION_INVALID');oldSourceState=directoryStateWithNested(oldSourceState,NESTED_ZOD,await targetState(oldZod.source))}
   const oldIdentity=await json(join(oldSource.source,'package.json'))
   const provenance=newLayers.ui.manifest.packageProvenance?.find(pkg=>pkg.name===row.name)
   if(before.digest!==receiptNoop.installedDigest||oldSourceState.digest!==receiptNoop.sourceDigest||oldIdentity.name!==row.name||installed.name!==row.name||oldIdentity.version!==receiptNoop.version||installed.version!==oldIdentity.version||!exactSubset(oldSourceState,before)||provenance?.origin!=='official-native-runtime'||provenance.hostVersion!==newTarget.hostVersion||provenance.sourceDirectorySha256!==(await targetState(row.source)).digest)fail('HOST_UPGRADE_DEPENDENCY_MIGRATION_INVALID')
   dependencyMigration={previousReceiptSha256:previous.sha256,oldSourceDigest:oldSourceState.digest,installedDigest:before.digest,newSourceDigest:after.digest}
  }
  operations.push({type:nestedDependency?'copy-directory-with-nested-dependency':'copy-directory',package:row.name,source:row.source,targetRelative:`node_modules/${row.name}`,before,after,...nestedDependency?{nestedDependency}:{},...dependencyMigration?{dependencyMigration}:{}})
 }
 for(const [name,state]of previous.owned)if(!newLayers.names.includes(name))operations.push({type:'remove-owned-package',package:name,targetRelative:`node_modules/${name}`,before:state,after:{type:'missing'}})
 const pairs=await Promise.all([
  [join(oldLayers.ui.root,oldLayers.uiContract.cordisFragment),join(newLayers.ui.root,newLayers.uiContract.cordisFragment)],
  [join(oldLayers.policy.root,'cordis.policy.fragment.yml'),join(newLayers.policy.root,'cordis.policy.fragment.yml')]
 ].map(async([oldFile,newFile])=>({oldFragment:await readFile(oldFile,'utf8'),newFragment:await readFile(newFile,'utf8')})))
 const cordis=join(profile,'cordis.patch.yml'),content=migrateCordisFragments(await readFile(cordis,'utf8'),pairs)
 operations.push({type:'merge-cordis',targetRelative:'cordis.patch.yml',before:await targetState(cordis),after:{type:'file',bytes:Buffer.byteLength(content),sha256:sha256(Buffer.from(content))},content})
 const before={install:await targetState(install),home:await targetState(home),electronUserData:await targetState(electron)},newInstallState=await targetState(next)
 if(Object.values(before).some(row=>row.type!=='directory')||newInstallState.type!=='directory')fail('HOST_UPGRADE_FULL_SNAPSHOT_REQUIRED')
 const newOwnership={artifactPackageNames:[...newLayers.names].sort(),packageNames:operations.filter(row=>row.package&&row.type!=='remove-owned-package').map(row=>row.package).sort(),dependencyResolution:{verifiedNoops:verifiedNoops.sort((a,b)=>a.package.localeCompare(b.package,'en')),nested:zod?[{name:NESTED_ZOD,version:(await json(join(zod.source,'package.json'))).version,parent:STORAGE_DOMAIN,target:`node_modules/${STORAGE_DOMAIN}/node_modules/${NESTED_ZOD}`}]:[],preservedTopLevel:zod?[{name:NESTED_ZOD,reason:'exact dependency is nested under dsh-storage-domain'}]:[]}}
 const plan={schemaVersion:1,status:'ready-shadow-only',liveApplySupported:false,paths:{install,home,electronUserData:electron,newInstall:next,profile,transaction},oldTarget,newTarget,oldReleaseLock:{path:oldLockPath,sha256:sha256(await readFile(oldLockPath))},newReleaseLock:{path:newLockPath,sha256:sha256(await readFile(newLockPath))},previousReceipt:{path:previous.receiptFile,sha256:previous.sha256},before,newInstallState,operations,newOwnership,
 artifacts:{ui:{id:newLayers.ui.manifest.artifact.id,version:newLayers.ui.manifest.artifact.version,manifestSha256:newLayers.ui.manifestSha256},policy:{id:newLayers.policy.manifest.artifact.id,version:newLayers.policy.manifest.artifact.version,manifestSha256:newLayers.policy.manifestSha256}}}
 freeze(plan);approvedPlans.add(plan);return plan
}

async function protect(directory,{existing=false}={}){
 if(!existing)await mkdir(directory,{recursive:false,mode:0o700})
 if(process.platform!=='win32'){await chmod(directory,0o700);return {kind:'mode',mode:'0700'}}
 const {stdout}=await executable('whoami',['/user','/fo','csv','/nh'],{windowsHide:true,maxBuffer:65536})
 const sid=stdout.match(/S-1-5-(?:\d+-)*\d+/u)?.[0];if(!sid)fail('HOST_UPGRADE_OWNER_SID_UNAVAILABLE')
 await executable('icacls',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{windowsHide:true,maxBuffer:65536})
 return {kind:'windows-acl',inheritance:false,principals:['current-user','SYSTEM']}
}
async function copyExact(source,destination,expected){
 if(await pathKind(destination)==='directory'){
  if((await readdir(destination)).length)fail('HOST_UPGRADE_DESTINATION_NOT_EMPTY')
  for(const name of await readdir(source))await cp(join(source,name),join(destination,name),{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true})
 }else await cp(source,destination,{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true})
 if(!sameState(await targetState(destination),expected))fail('HOST_UPGRADE_COPY_MISMATCH')
}
/** No live mutation exists here. Failures leave protected evidence for inspection. */
export async function stageHostUpgradeShadow(plan){
 if(!approvedPlans.has(plan)||plan.status!=='ready-shadow-only')fail('HOST_UPGRADE_VERIFIED_PLAN_REQUIRED')
 const p=plan.paths
 await assertDesktopStopped(p.install)
 for(const [key,source]of [['install',p.install],['home',p.home],['electronUserData',p.electronUserData]])if(!sameState(await targetState(source),plan.before[key]))fail('HOST_UPGRADE_SOURCE_DRIFT')
 if(!sameState(await targetState(p.newInstall),plan.newInstallState)||sha256(await readFile(plan.previousReceipt.path))!==plan.previousReceipt.sha256||sha256(await readFile(plan.oldReleaseLock.path))!==plan.oldReleaseLock.sha256||sha256(await readFile(plan.newReleaseLock.path))!==plan.newReleaseLock.sha256)fail('HOST_UPGRADE_INPUT_DRIFT')
 await mkdir(HOST_UPGRADE_ROOT,{recursive:true});await noLinks(HOST_UPGRADE_ROOT)
 const protection=await protect(p.transaction),beforeRoot=join(p.transaction,'before'),shadow=join(p.transaction,'shadow')
 await mkdir(beforeRoot);await mkdir(shadow)
 const evidence=sealReceipt({schemaVersion:1,status:'shadow-pending',liveApplySupported:false,oldTarget:plan.oldTarget,newTarget:plan.newTarget,paths:p,protection,previousReceipt:plan.previousReceipt,oldReleaseLock:plan.oldReleaseLock,newReleaseLock:plan.newReleaseLock,before:plan.before,artifacts:plan.artifacts,newOwnership:plan.newOwnership,operations:plan.operations.map(({content,source,...row})=>row),cleanupPending:[]})
 await writeFile(join(p.transaction,'receipt.pending.json'),canonical(evidence),{flag:'wx'})
 for(const [key,source]of [['install',p.install],['home',p.home],['electronUserData',p.electronUserData]])await copyExact(source,join(beforeRoot,key),plan.before[key])
 await copyExact(p.newInstall,join(shadow,'install'),plan.newInstallState)
 await copyExact(p.home,join(shadow,'home'),plan.before.home);await copyExact(p.electronUserData,join(shadow,'electronUserData'),plan.before.electronUserData)
 const shadowProfile=join(shadow,'home/profiles/desktop')
 for(const operation of plan.operations){
  const destination=join(shadowProfile,...operation.targetRelative.split('/'))
  if(!sameState(await targetState(destination),operation.before))fail('HOST_UPGRADE_SHADOW_BEFORE_MISMATCH')
  if(operation.type==='merge-cordis')await writeFile(destination,operation.content,'utf8')
  else{
   if(operation.before.type!=='missing'){if(!previouslyOwned(plan,operation)||!resolve(destination).startsWith(resolve(shadowProfile)+sep)||operation.targetRelative!==`node_modules/${operation.package}`)fail('HOST_UPGRADE_REMOVAL_NOT_OWNED');await noLinks(destination);await rm(destination,{recursive:true,force:false})}
   if(operation.type!=='remove-owned-package'){await mkdir(dirname(destination),{recursive:true});await stagePackage(operation,destination)}
  }
  if(!sameState(await targetState(destination),operation.after))fail('HOST_UPGRADE_SHADOW_AFTER_MISMATCH')
 }
 for(const [key,source]of [['install',p.install],['home',p.home],['electronUserData',p.electronUserData]])if(!sameState(await targetState(source),plan.before[key]))fail('HOST_UPGRADE_SOURCE_DRIFT')
 await verifyOfficialDesktop({installRoot:join(shadow,'install'),releaseLockPath:plan.newReleaseLock.path})
 const after={install:await targetState(join(shadow,'install')),home:await targetState(join(shadow,'home')),electronUserData:await targetState(join(shadow,'electronUserData'))}
 const receipt=sealReceipt({...evidence,status:'shadow-ready-not-applied',after,completedAt:new Date().toISOString()})
 await writeFile(join(p.transaction,'receipt.json'),canonical(receipt),{flag:'wx'})
 return {status:receipt.status,transactionRoot:p.transaction,receiptPath:join(p.transaction,'receipt.json'),liveModified:false}
}
function previouslyOwned(plan,operation){return operation.before.type==='directory'&&plan.operations.includes(operation)&&operation.package&&PACKAGE.test(operation.package)}

const KEYS=['install','home','electronUserData']
async function durableFile(path,text){const handle=await open(path,'wx',0o600);try{await handle.writeFile(text);await handle.sync()}finally{await handle.close()}}
async function publishReceipt(path,text){
 const temp=join(dirname(path),`.host-receipt-${randomUUID()}.tmp`)
 try{await durableFile(temp,text);await link(temp,path)}finally{if(await pathKind(temp)==='file')await rm(temp,{force:false})}
}
async function latestJournal(path){
 await noLinks(path)
 const prefix=basename(path)+'.generation-',entries=await readdir(dirname(path))
 const candidates=entries.filter(name=>name.startsWith(prefix)&&/^\d{8,12}\.json$/u.test(name.slice(prefix.length))).sort((a,b)=>Number(b.slice(prefix.length,-5))-Number(a.slice(prefix.length,-5))).map(name=>join(dirname(path),name))
 if(await pathKind(path)==='file')candidates.push(path)
 for(const file of candidates)try{await noLinks(file);const value=await json(file);if(verifyReceiptIntegrity(value))return value}catch{}
 fail('HOST_UPGRADE_JOURNAL_INVALID')
}
async function journal(path,value){
 // Append immutable fsynced generations. No rename window can hide the last
 // committed intent, even when the next generation is torn by a process crash.
 const prefix=basename(path)+'.generation-',entries=await readdir(dirname(path))
 const indexes=entries.filter(name=>name.startsWith(prefix)&&/^\d{8,12}\.json$/u.test(name.slice(prefix.length))).map(name=>Number(name.slice(prefix.length,-5)))
 const exists=await pathKind(path)==='file',generation=exists?Math.max(0,...indexes)+1:0
 const sealed=sealReceipt({...value,journalGeneration:generation}),output=generation?join(dirname(path),prefix+String(generation).padStart(8,'0')+'.json'):path
 await durableFile(output,canonical(sealed));return sealed
}
async function boundTransaction(receiptPath,options,expectedStatus){
 receiptPath=absolute(receiptPath)
 const root=dirname(receiptPath)
 if(dirname(root)!==HOST_UPGRADE_ROOT)fail('HOST_UPGRADE_RECEIPT_OUTSIDE_TRANSACTION')
 await noLinks(root)
 await noLinks(receiptPath);if(await pathKind(receiptPath)!=='file')fail('HOST_UPGRADE_TRANSACTION_RECEIPT_INVALID')
 const receipt=await json(receiptPath)
 if(!verifyReceiptIntegrity(receipt)||receipt.schemaVersion!==1||!(Array.isArray(expectedStatus)?expectedStatus:[expectedStatus]).includes(receipt.status)||receipt.paths?.transaction!==root)fail('HOST_UPGRADE_TRANSACTION_RECEIPT_INVALID')
 const p=receipt.paths
 for(const [key,input]of [['install','oldInstallRoot'],['home','homeRoot'],['electronUserData','electronUserDataRoot']])if(absolute(options[input])!==p[key])fail('HOST_UPGRADE_EXPLICIT_ROOT_MISMATCH')
 const roots=KEYS.map(key=>p[key]);for(let i=0;i<roots.length;i++){await noLinks(roots[i]);for(let j=i+1;j<roots.length;j++)if(overlap(roots[i],roots[j]))fail('HOST_UPGRADE_ROOTS_OVERLAP')}
 for(const key of ['oldReleaseLock','newReleaseLock','previousReceipt'])if(sha256(await readFile(receipt[key].path))!==receipt[key].sha256)fail('HOST_UPGRADE_INPUT_DRIFT')
 return receipt
}
async function assertStates(paths,states){for(const key of KEYS)if(!sameState(await targetState(paths[key]),states[key]))fail('HOST_UPGRADE_SOURCE_DRIFT')}
export async function assertAllDesktopInstancesStopped({platform=process.platform,query}={}){
 if(platform!=='win32')return
 let rows
 try{rows=query?await query():JSON.parse((await executable('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)(deepseek.*harness|dsh.*desktop).*\\.exe$' } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"],{windowsHide:true,timeout:15000,maxBuffer:1048576})).stdout.trim()||'[]')}catch{fail('HOST_UPGRADE_PROCESS_CHECK_UNAVAILABLE')}
 if(!Array.isArray(rows))rows=[rows]
 if(rows.length)fail('HOST_UPGRADE_OTHER_DESKTOP_RUNNING')
}
async function stoppedForTransaction(paths){
 // The only bypass is an isolated test fixture: every root is confined to the
 // dedicated repository fixture tree, never the real install/home/userData.
 const fixtureRoot=join(REPO,'var/host-upgrade-fixtures')+sep
 if(KEYS.every(key=>resolve(paths[key]).startsWith(fixtureRoot)))return assertDesktopStopped(paths.install)
 await assertAllDesktopInstancesStopped()
}
function faultAllowed(paths,faultAt){if(faultAt===undefined)return;if(!Number.isInteger(faultAt)||faultAt<1||faultAt>4||KEYS.some(key=>!resolve(paths[key]).startsWith(join(REPO,'var/host-upgrade-fixtures')+sep)))fail('HOST_UPGRADE_FAULT_FIXTURES_ONLY')}
async function recoverRoots(rows,journalPath,base){
 const errors=[]
 for(const row of [...rows].reverse())try{
  if(row.before.type==='missing'){
   if(await pathKind(row.displaced)!=='missing')fail('HOST_UPGRADE_UNEXPECTED_DISPLACED_STATE')
   if(await pathKind(row.live)!=='missing'){
    if(!sameState(await targetState(row.live),row.after))fail('HOST_UPGRADE_UNEXPECTED_LIVE_STATE')
    row.failed=row.live+`.airules-failed-${randomUUID()}`;await rename(row.live,row.failed);await protect(row.failed,{existing:true})
   }
  }
  if(await pathKind(row.displaced)==='directory'){
   if(!sameState(await targetState(row.displaced),row.before))fail('HOST_UPGRADE_DISPLACED_DRIFT')
   if(await pathKind(row.live)!=='missing'){
    if(!sameState(await targetState(row.live),row.after))fail('HOST_UPGRADE_UNEXPECTED_LIVE_STATE')
    row.failed=row.live+`.airules-failed-${randomUUID()}`;await rename(row.live,row.failed);await protect(row.failed,{existing:true})
   }
   await rename(row.displaced,row.live)
  }
  if(!sameState(await targetState(row.live),row.before))fail('HOST_UPGRADE_RECOVERY_STATE_MISMATCH')
  row.phase='recovered';await journal(journalPath,{...base,status:'recovering',roots:rows})
 }catch(error){errors.push(error)}
 await journal(journalPath,{...base,status:errors.length?'recovery-failed':'recovered',roots:rows})
 if(errors.length)throw new AggregateError(errors,'HOST_UPGRADE_RECOVERY_FAILED')
}
async function swapThreeRoots({paths,sources,before,after,attemptRoot,kind,faultAt,fixtureCrashAt}){
 faultAllowed(paths,faultAt)
 faultAllowed(paths,fixtureCrashAt)
 const nonce=randomUUID(),rows=[],journalPath=join(attemptRoot,'swap-journal.json'),base={schemaVersion:1,kind,createdAt:new Date().toISOString()}
 try{
  for(const key of KEYS){
   const live=paths[key],stage=join(dirname(live),`.airules-host-${nonce}-${key}-next`),displaced=join(dirname(live),`.airules-host-${nonce}-${key}-previous`)
   if(await pathKind(stage)!=='missing'||await pathKind(displaced)!=='missing')fail('HOST_UPGRADE_SIBLING_COLLISION')
   await noLinks(dirname(live))
   if(after[key].type==='directory'){await protect(stage);await copyExact(sources[key],stage,after[key])}else if(after[key].type!=='missing')fail('HOST_UPGRADE_ROOT_STATE_INVALID')
   rows.push({key,live,stage:after[key].type==='missing'?null:stage,displaced,before:before[key],after:after[key],phase:'staged'})
  }
  await journal(journalPath,{...base,status:'prepared',roots:rows})
  await stoppedForTransaction(paths);await assertStates(paths,before)
  for(const [index,row]of rows.entries()){
   row.phase='rename-old-intent';await journal(journalPath,{...base,status:'swapping',roots:rows})
   if(!sameState(await targetState(row.live),row.before))fail('HOST_UPGRADE_SOURCE_DRIFT')
   if(row.before.type!=='missing'){await rename(row.live,row.displaced);await protect(row.displaced,{existing:true})}
   row.phase='old-displaced';await journal(journalPath,{...base,status:'swapping',roots:rows})
   if(row.stage)await rename(row.stage,row.live)
   row.phase='installed';await journal(journalPath,{...base,status:'swapping',roots:rows})
   if(faultAt===index+1)fail('HOST_UPGRADE_FIXTURE_FAULT')
   if(fixtureCrashAt===index+1)fail('HOST_UPGRADE_FIXTURE_CRASH')
  }
  await assertStates(paths,after)
  const evidence=await journal(journalPath,{...base,status:'swapped',roots:rows})
  return {journalPath,roots:rows,evidence}
 }catch(error){
  if(error.code==='HOST_UPGRADE_FIXTURE_CRASH')throw error
  if(rows.length)try{await recoverRoots(rows,journalPath,base)}catch(recovery){throw new AggregateError([error,recovery],'HOST_UPGRADE_SWAP_AND_RECOVERY_FAILED')}
  throw error
 }
}

/** All mutation requires an explicit shadow receipt and exact live-root bindings. */
async function applyHostUpgradeUnlocked(receiptPath,options={}){
 if(options.acknowledgement!==HOST_UPGRADE_ACK)fail('HOST_UPGRADE_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'shadow-ready-not-applied'),p=receipt.paths
 faultAllowed(p,options.faultAt)
 faultAllowed(p,options.fixtureCrashAt)
 if(await pathKind(join(p.transaction,'host-apply-receipt.json'))!=='missing')fail('HOST_UPGRADE_ALREADY_APPLIED')
 await stoppedForTransaction(p);await assertStates(p,receipt.before)
 await verifyOfficialDesktop({installRoot:p.install,releaseLockPath:receipt.oldReleaseLock.path})
 const oldReceipt=await json(receipt.previousReceipt.path)
 await readLiveUpdateReceipt({previousReceiptPath:receipt.previousReceipt.path,paths:{install:p.install,profile:p.profile,backup:p.transaction},target:receipt.oldTarget,packageNames:oldReceipt.artifactPackageNames})
 const sources=Object.fromEntries(KEYS.map(key=>[key,join(p.transaction,'shadow',key)]))
 await assertStates(sources,receipt.after)
 for(const key of KEYS)if(!sameState(await targetState(join(p.transaction,'before',key)),receipt.before[key]))fail('HOST_UPGRADE_BACKUP_DRIFT')
 const attempt=join(p.transaction,'apply-'+randomUUID());await protect(attempt)
 const swapped=await swapThreeRoots({paths:p,sources,before:receipt.before,after:receipt.after,attemptRoot:attempt,kind:'host-upgrade',faultAt:options.faultAt,fixtureCrashAt:options.fixtureCrashAt})
 try{await verifyOfficialDesktop({installRoot:p.install,releaseLockPath:receipt.newReleaseLock.path})}
 catch(error){await recoverRoots(swapped.roots,swapped.journalPath,{schemaVersion:1,kind:'host-upgrade'});throw error}
 const result=sealReceipt({...receipt,status:'host-applied',liveApplySupported:true,shadowReceipt:{path:absolute(receiptPath),sha256:sha256(await readFile(receiptPath))},swapJournal:swapped.journalPath,displacedRoots:swapped.roots.map(row=>({key:row.key,path:row.displaced,state:row.before})),appliedAt:new Date().toISOString()})
 const output=join(p.transaction,'host-apply-receipt.json')
 try{if(options.faultAt===4)fail('HOST_UPGRADE_FIXTURE_FAULT');await publishReceipt(output,canonical(result))}catch(error){await recoverRoots(swapped.roots,swapped.journalPath,{schemaVersion:1,kind:'host-upgrade'});throw error}
 return {status:result.status,receiptPath:output,oldReceiptPreserved:true,displacedRootsPreserved:true}
}

async function rollbackHostUpgradeUnlocked(receiptPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'host-applied'),p=receipt.paths
 faultAllowed(p,options.faultAt);faultAllowed(p,options.fixtureCrashAt);await stoppedForTransaction(p)
 await verifyOfficialDesktop({installRoot:p.install,releaseLockPath:receipt.newReleaseLock.path})
 const current=Object.fromEntries(await Promise.all(KEYS.map(async key=>[key,await targetState(p[key])])))
 if(options.allowRuntimeDataChanges!==undefined&&typeof options.allowRuntimeDataChanges!=='boolean')fail('HOST_ROLLBACK_RUNTIME_OPTION_INVALID')
 if(!sameState(current.install,receipt.after.install)||options.allowRuntimeDataChanges!==true&&KEYS.some(key=>!sameState(current[key],receipt.after[key])))fail('HOST_ROLLBACK_CURRENT_STATE_DRIFT')
 const attempt=join(p.transaction,'rollback-'+randomUUID());await protect(attempt);await mkdir(join(attempt,'current'))
 for(const key of KEYS)await copyExact(p[key],join(attempt,'current',key),current[key])
 const sources=Object.fromEntries(KEYS.map(key=>[key,join(p.transaction,'before',key)]))
 await assertStates(sources,receipt.before)
 const swapped=await swapThreeRoots({paths:p,sources,before:current,after:receipt.before,attemptRoot:attempt,kind:'host-rollback',faultAt:options.faultAt,fixtureCrashAt:options.fixtureCrashAt})
 try{await verifyOfficialDesktop({installRoot:p.install,releaseLockPath:receipt.oldReleaseLock.path})}
 catch(error){await recoverRoots(swapped.roots,swapped.journalPath,{schemaVersion:1,kind:'host-rollback'});throw error}
 const output=join(attempt,'receipt.json')
 try{if(options.faultAt===4)fail('HOST_UPGRADE_FIXTURE_FAULT');await publishReceipt(output,canonical(sealReceipt({schemaVersion:1,status:'host-rolled-back',paths:p,sourceReceipt:{path:absolute(receiptPath),sha256:sha256(await readFile(receiptPath))},swapJournal:swapped.journalPath,before:current,after:receipt.before,runtimeDataChangesAllowed:!!options.allowRuntimeDataChanges,displacedRootsPreserved:true})))}catch(error){await recoverRoots(swapped.roots,swapped.journalPath,{schemaVersion:1,kind:'host-rollback'});throw error}
 return {status:'host-rolled-back',receiptPath:output,currentBackupPreserved:true}
}

/** Explicit crash recovery: only known before/after hashes are reconciled. */
async function recoverHostUpgradeUnlocked(receiptPath,journalPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,['shadow-ready-not-applied','host-applied']),p=receipt.paths
 journalPath=absolute(journalPath)
 if(!journalPath.startsWith(p.transaction+sep))fail('HOST_UPGRADE_JOURNAL_ESCAPE')
 const saved=await latestJournal(journalPath)
 if(!verifyReceiptIntegrity(saved)||!['prepared','swapping','recovering','recovery-failed','swapped','recovered'].includes(saved.status)||saved.roots?.length!==3)fail('HOST_UPGRADE_JOURNAL_INVALID')
 for(const row of saved.roots){
  if(!KEYS.includes(row.key)||row.live!==p[row.key])fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
  if(saved.kind==='host-upgrade'){
   if(!sameState(row.before,receipt.before[row.key])||!sameState(row.after,receipt.after[row.key]))fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
  }else if(saved.kind==='host-rollback'&&receipt.status==='host-applied'){
   if(!sameState(row.after,receipt.before[row.key])||!sameState(row.before,await targetState(join(dirname(journalPath),'current',row.key))))fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
  }else fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
  for(const path of [row.stage,row.displaced].filter(Boolean))if(dirname(path)!==dirname(row.live)||!path.split(sep).at(-1).startsWith('.airules-host-'))fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
 }
 if(new Set(saved.roots.map(row=>row.key)).size!==3)fail('HOST_UPGRADE_JOURNAL_SCOPE_INVALID')
 await stoppedForTransaction(p);await recoverRoots(saved.roots,journalPath,{schemaVersion:1,kind:saved.kind})
 return {status:'recovered',liveRootsRestored:true}
}

async function fileLock(path,operation,{recoverStale=false}={}){
 if(recoverStale&&await pathKind(path)==='file'){
  await noLinks(path);const owner=await json(path)
  if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)fail('HOST_UPGRADE_LOCK_INVALID')
  try{process.kill(owner.pid,0);fail('HOST_UPGRADE_MUTATION_LOCKED')}catch(error){if(error.code!=='ESRCH')throw error}
  await rm(path,{force:false})
 }
 let handle
 try{handle=await open(path,'wx',0o600)}catch(error){if(error.code==='EEXIST')fail('HOST_UPGRADE_MUTATION_LOCKED');throw error}
 try{await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await handle.sync();return await operation()}
 finally{await handle.close();await rm(path,{force:false})}
}
async function mutationLock(transaction,operation,{recoverStale=false,paths}={}){
 const shared=join(HOST_UPGRADE_ROOT,'.root-locks')
 if(await pathKind(shared)==='missing')try{await protect(shared)}catch(error){if(error.code!=='EEXIST')throw error}
 await noLinks(shared)
 const hashes=[...new Set(KEYS.map(key=>sha256(Buffer.from(process.platform==='win32'?resolve(paths[key]).toLowerCase():resolve(paths[key])))))].sort()
 const run=index=>index===hashes.length?fileLock(join(transaction,'live-mutation.lock'),operation,{recoverStale}):fileLock(join(shared,hashes[index]+'.lock'),()=>run(index+1),{recoverStale})
 return run(0)
}
export async function applyHostUpgrade(receiptPath,options={}){
 if(options.acknowledgement!==HOST_UPGRADE_ACK)fail('HOST_UPGRADE_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'shadow-ready-not-applied')
 return mutationLock(receipt.paths.transaction,()=>applyHostUpgradeUnlocked(receiptPath,options),{paths:receipt.paths})
}
export async function rollbackHostUpgrade(receiptPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'host-applied')
 return mutationLock(receipt.paths.transaction,()=>rollbackHostUpgradeUnlocked(receiptPath,options),{paths:receipt.paths})
}
export async function recoverHostUpgrade(receiptPath,journalPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,['shadow-ready-not-applied','host-applied'])
 await stoppedForTransaction(receipt.paths)
 return mutationLock(receipt.paths.transaction,()=>recoverHostUpgradeUnlocked(receiptPath,journalPath,options),{recoverStale:true,paths:receipt.paths})
}

/** New-target ownership baseline. Its ordinary promotion rollback is a no-op;
 * host rollback follows the separate full-root receipt linked in metadata. */
export async function emitHostOwnershipAnchor(receiptPath,options={}){
 if(options.acknowledgement!==HOST_UPGRADE_ACK)fail('HOST_UPGRADE_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'host-applied'),p=receipt.paths,backup=absolute(options.ownershipBackupRoot)
 if(dirname(backup)!==PROMOTION_BACKUPS_ROOT||[...KEYS.map(key=>p[key]),p.transaction].some(root=>overlap(root,backup)))fail('HOST_UPGRADE_ANCHOR_PATH_INVALID')
 return mutationLock(p.transaction,async()=>{
  await stoppedForTransaction(p);await verifyOfficialDesktop({installRoot:p.install,releaseLockPath:receipt.newReleaseLock.path})
  const ownership=receipt.newOwnership
  if(!ownership||!Array.isArray(ownership.packageNames)||!Array.isArray(ownership.artifactPackageNames))fail('HOST_UPGRADE_ANCHOR_OWNERSHIP_INVALID')
  const expected=receipt.operations.filter(row=>row.type!=='remove-owned-package'),records=[]
  if(canonical(expected.filter(row=>row.package).map(row=>row.package).sort())!==canonical(ownership.packageNames))fail('HOST_UPGRADE_ANCHOR_OWNERSHIP_INVALID')
  for(const row of expected){
   if(row.targetRelative!=='cordis.patch.yml'&&row.targetRelative!==`node_modules/${row.package}`)fail('HOST_UPGRADE_ANCHOR_OWNERSHIP_INVALID')
   const source=join(p.profile,...row.targetRelative.split('/'));await noLinks(source)
   if(!sameState(await targetState(source),row.after))fail('HOST_UPGRADE_ANCHOR_PACKAGE_DRIFT')
   records.push({type:row.type,package:row.package,target:row.targetRelative,before:row.after,after:row.after,backup:'before/'+row.targetRelative})
  }
  await mkdir(PROMOTION_BACKUPS_ROOT,{recursive:true});await noLinks(backup);await protect(backup)
  for(const row of records){const destination=join(backup,...row.backup.split('/'));await mkdir(dirname(destination),{recursive:true});await copyExact(join(p.profile,...row.target.split('/')),destination,row.before)}
  const baseHostReceipt={path:absolute(receiptPath),sha256:sha256(await readFile(receiptPath))}
  let hostRollbackReceipt=baseHostReceipt,hostRollbackKind='base-host-transaction'
  if(options.finalizationReceiptPath){
   const path=absolute(options.finalizationReceiptPath);await noLinks(path)
   if(dirname(path)!==p.transaction)fail('HOST_UPGRADE_FINALIZATION_RECEIPT_INVALID')
   const final=await json(path)
   if(!verifyReceiptIntegrity(final)||final.status!=='windows-finalized'||canonical(final.hostReceipt)!==canonical(baseHostReceipt)||!sameState(await targetState(p.install),final.after?.install))fail('HOST_UPGRADE_FINALIZATION_RECEIPT_INVALID')
   hostRollbackReceipt={path,sha256:sha256(await readFile(path))};hostRollbackKind='official-windows-finalization'
  }
  const anchor=sealReceipt({schemaVersion:1,status:'applied',target:receipt.newTarget,installRoot:p.install,profileRoot:p.profile,backupRoot:backup,artifacts:receipt.artifacts,artifactPackageNames:ownership.artifactPackageNames,packageNames:ownership.packageNames,dependencyResolution:ownership.dependencyResolution,operations:records,cleanupPending:[],metadata:{anchorOnly:true,semantics:'new-host-owned-package-baseline-no-op-rollback',hostRollbackReceipt,hostRollbackKind,baseHostReceipt,previousOldHostReceipt:receipt.previousReceipt}})
  const output=join(backup,'receipt.json');await publishReceipt(output,canonical(anchor))
  // Exercise the unchanged ordinary ownership reader immediately.
  await readLiveUpdateReceipt({previousReceiptPath:output,paths:{install:p.install,profile:p.profile,backup:join(PROMOTION_BACKUPS_ROOT,'next-'+randomUUID())},target:receipt.newTarget,packageNames:ownership.artifactPackageNames})
  return {status:'ownership-anchor-ready',receiptPath:output,anchorOnly:true,hostRollbackReceipt:hostRollbackReceipt.path,hostRollbackKind}
 },{paths:p})
}
export async function withHostUpgradeLease(receiptPath,options,operation){
 if(![HOST_UPGRADE_ACK,HOST_ROLLBACK_ACK].includes(options?.acknowledgement)||typeof operation!=='function')fail('HOST_UPGRADE_ACK_REQUIRED')
 const receipt=await boundTransaction(receiptPath,options,'host-applied')
 return mutationLock(receipt.paths.transaction,async()=>{const token=Object.freeze({});freeze(receipt);activeLeases.set(token,{path:absolute(receiptPath),receipt});try{return await operation(receipt,token)}finally{activeLeases.delete(token)}},{paths:receipt.paths})
}
export async function rollbackHostUpgradeInLease(receiptPath,options,token){
 if(activeLeases.get(token)?.path!==absolute(receiptPath))fail('HOST_UPGRADE_ACTIVE_LEASE_REQUIRED')
 return rollbackHostUpgradeUnlocked(receiptPath,options)
}
export async function restoreHostRootSetInLease(receiptPath,{sources,expectedCurrent,desired},token){
 const lease=activeLeases.get(token)
 if(lease?.path!==absolute(receiptPath))fail('HOST_UPGRADE_ACTIVE_LEASE_REQUIRED')
 const receipt=lease.receipt,p=receipt.paths
 for(const key of KEYS){const source=absolute(sources[key]);if(!source.startsWith(p.transaction+sep))fail('HOST_UPGRADE_RESTORE_SOURCE_ESCAPE');await noLinks(source);if(!sameState(await targetState(source),desired[key]))fail('HOST_UPGRADE_RESTORE_SOURCE_DRIFT')}
 const attempt=join(p.transaction,'root-restore-'+randomUUID());await protect(attempt)
 return swapThreeRoots({paths:p,sources,before:expectedCurrent,after:desired,attemptRoot:attempt,kind:'host-root-restore'})
}

function parseArgs(args){const values={};let shadow=false;for(let i=0;i<args.length;i++){if(args[i]==='--shadow'){shadow=true;continue}if(args[i]==='--apply'||!args[i].startsWith('--')||i+1>=args.length)fail('HOST_UPGRADE_SHADOW_ONLY_USAGE');values[args[i].slice(2)]=args[++i]}return {values,shadow}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values,shadow}=parseArgs(process.argv.slice(2)),options={}
 for(const [key,value]of Object.entries(values))options[key.replace(/-([a-z])/gu,(_,char)=>char.toUpperCase())]=resolve(value)
 const plan=await buildHostUpgradePlan(options)
 console.log(JSON.stringify(shadow?await stageHostUpgradeShadow(plan):{status:plan.status,liveApplySupported:false,oldTarget:plan.oldTarget,newTarget:plan.newTarget,operations:plan.operations.length,transactionRoot:plan.paths.transaction},null,2))
}

export {layers as verifyHostUpgradeLayers}
