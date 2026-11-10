import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile,writeFile,mkdir,cp,rm,rename,open,link,readdir} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join,dirname,basename,isAbsolute,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {canonical,targetState,sameState,pathKind,sha256} from '../installer/fs-state.mjs'
import {sealReceipt,verifyReceiptIntegrity} from '../installer/receipt.mjs'
import {verifyOfficialDesktop} from '../src/targets/official-desktop/target.mjs'
import {HOST_UPGRADE_ROOT,HOST_UPGRADE_ACK,HOST_ROLLBACK_ACK,assertAllDesktopInstancesStopped,withHostUpgradeLease,rollbackHostUpgradeInLease,restoreHostRootSetInLease} from './upgrade-official-host.mjs'

const REPO=resolve(fileURLToPath(new URL('..',import.meta.url))),run=promisify(execFile)
const GUID='1bf39983-50d0-5fe0-9ef4-cece76f67c5e'
const fail=code=>{throw Object.assign(new Error(code),{code})}
const normalized=value=>resolve(value).replaceAll('\\','/').toLowerCase().replace(/\/$/u,'')
const underneath=(root,path)=>{const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
async function json(path){return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,''))}
async function regular(path){const state=await targetState(path);if(state.type!=='file')fail('WINDOWS_FINALIZATION_FILE_REQUIRED');return state}
async function durable(path,text){const h=await open(path,'wx',0o600);try{await h.writeFile(text);await h.sync()}finally{await h.close()}}
async function publish(path,value){const temp=join(dirname(path),`.windows-finalization-${randomUUID()}.tmp`);try{await durable(temp,canonical(sealReceipt(value)));await link(temp,path)}finally{if(await pathKind(temp)==='file')await rm(temp,{force:false})}}
async function noLinks(path){const {lstat}=await import('node:fs/promises');let at=resolve(path);for(;;){try{if((await lstat(at)).isSymbolicLink())fail('WINDOWS_FINALIZATION_LINK_FORBIDDEN')}catch(e){if(e.code!=='ENOENT')throw e}const parent=dirname(at);if(parent===at)break;at=parent}}
function safePath(value){if(typeof value!=='string'||!isAbsolute(value)||/[\0\r\n"]/u.test(value))fail('WINDOWS_FINALIZATION_EXACT_PATH_REQUIRED');return resolve(value)}
async function hostReceipt(path,options,statuses=['host-applied']){
 path=safePath(path);await noLinks(path);await regular(path)
 const value=await json(path)
 if(!verifyReceiptIntegrity(value)||!statuses.includes(value.status)||dirname(dirname(path))!==HOST_UPGRADE_ROOT||value.paths?.transaction!==dirname(path))fail('WINDOWS_FINALIZATION_HOST_RECEIPT_INVALID')
 for(const [key,option]of [['install','oldInstallRoot'],['home','homeRoot'],['electronUserData','electronUserDataRoot']])if(safePath(options[option])!==value.paths[key])fail('WINDOWS_FINALIZATION_ROOT_MISMATCH')
 return value
}
function fixturePaths(host){return ['install','home','electronUserData'].every(key=>underneath(join(REPO,'var/host-upgrade-fixtures'),host.paths[key]))}
function adapter(host,options){if(options.fixtureOps){if(!fixturePaths(host)||options.fixtureOps.fixture!==true)fail('WINDOWS_FINALIZATION_FIXTURES_ONLY');return options.fixtureOps}if(process.platform!=='win32')fail('WINDOWS_FINALIZATION_WINDOWS_REQUIRED');return windowsOps()}
function defaultScope(){
 const registry=[]
 for(const hive of ['CurrentUser','LocalMachine'])for(const view of ['Registry64','Registry32'])for(const subkey of [`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`,'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe'])registry.push({hive,view,subkey})
 const shortcuts=[join(process.env.USERPROFILE??'','Desktop/DeepSeek Harness.lnk'),join(process.env.APPDATA??'','Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk'),join(process.env.PUBLIC??'','Desktop/DeepSeek Harness.lnk'),join(process.env.ProgramData??'','Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk')]
 return {registry,shortcuts}
}
function validateScope(scope,host,fixture){
 if(!scope||!Array.isArray(scope.registry)||scope.registry.length<1||scope.registry.length>16||!Array.isArray(scope.shortcuts)||scope.shortcuts.length>8)fail('WINDOWS_FINALIZATION_OS_SCOPE_INVALID')
 const seen=new Set()
 for(const row of scope.registry){if(!['CurrentUser','LocalMachine'].includes(row.hive)||!['Registry64','Registry32'].includes(row.view)||![`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`,'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe'].includes(row.subkey))fail('WINDOWS_FINALIZATION_REGISTRY_SCOPE_INVALID');const key=canonical(row);if(seen.has(key))fail('WINDOWS_FINALIZATION_OS_SCOPE_INVALID');seen.add(key)}
 for(const path of scope.shortcuts){safePath(path);if(basename(path).toLowerCase()!=='deepseek harness.lnk'||fixture&&!underneath(dirname(host.paths.install),path)||!fixture&&!defaultScope().shortcuts.some(known=>normalized(known)===normalized(path)))fail('WINDOWS_FINALIZATION_SHORTCUT_SCOPE_INVALID')}
 return structuredClone(scope)
}
async function shortcutState(paths){const rows=[];for(const path of paths){await noLinks(path);const state=await targetState(path);if(!['file','missing'].includes(state.type)||state.bytes>1048576)fail('WINDOWS_FINALIZATION_SHORTCUT_INVALID');rows.push({path,state})}return rows}
async function snapshotOS(ops,scope){return {registry:await ops.readRegistry(scope.registry),shortcuts:await shortcutState(scope.shortcuts)}}
async function readOSBefore(path,host){
 path=safePath(path);if(!underneath(host.paths.transaction,path))fail('WINDOWS_FINALIZATION_OS_BACKUP_ESCAPE');await noLinks(path);await regular(path)
 const value=await json(path)
 if(!verifyReceiptIntegrity(value)||value.status!=='windows-os-before'||value.transactionRoot!==host.paths.transaction||canonical(value.paths)!==canonical(host.paths)||canonical(value.oldTarget)!==canonical(host.oldTarget)||canonical(value.newTarget)!==canonical(host.newTarget))fail('WINDOWS_FINALIZATION_OS_BACKUP_INVALID')
 for(const row of value.snapshot.shortcuts)if(row.state.type==='file'){
  const backup=resolve(host.paths.transaction,row.backup)
  if(!underneath(host.paths.transaction,backup)||!sameState(await targetState(backup),row.state))fail('WINDOWS_FINALIZATION_SHORTCUT_BACKUP_INVALID')
 }
 return value
}
function validateSnapshotScope(snapshot,scope){
 if(!Array.isArray(snapshot.registry)||canonical(snapshot.registry.map(({hive,view,subkey})=>({hive,view,subkey})))!==canonical(scope.registry)||canonical(snapshot.shortcuts.map(row=>row.path))!==canonical(scope.shortcuts))fail('WINDOWS_FINALIZATION_SNAPSHOT_SCOPE_INVALID')
}
async function backupShortcutRows(snapshot,host,label){
 const directory=join(host.paths.transaction,label);await mkdir(directory,{recursive:true,mode:0o700})
 for(const row of snapshot.shortcuts)if(row.state.type==='file'){
  row.backup=`${label}/${sha256(Buffer.from(normalized(row.path)))}.lnk`
  await cp(row.path,join(host.paths.transaction,row.backup),{force:false,errorOnExist:true})
  if(!sameState(await targetState(join(host.paths.transaction,row.backup)),row.state))fail('WINDOWS_FINALIZATION_SHORTCUT_BACKUP_INVALID')
 }
}

/** Read-only OS inventory plus private copies; call before launching NSIS. */
export async function captureOSBefore(receiptPath,options={}){
 if(options.fixtureOps&&!options.osScope)fail('WINDOWS_FINALIZATION_FIXTURE_SCOPE_REQUIRED')
 const host=await hostReceipt(receiptPath,options,['shadow-ready-not-applied','host-applied']),ops=adapter(host,options),scope=validateScope(options.osScope??defaultScope(),host,!!options.fixtureOps)
 await ops.assertStopped();const snapshot=await snapshotOS(ops,scope),directory=join(host.paths.transaction,'windows-os-before')
 validateSnapshotScope(snapshot,scope)
 await mkdir(directory,{recursive:false,mode:0o700});await mkdir(join(directory,'shortcuts'))
 for(const row of snapshot.shortcuts)if(row.state.type==='file'){row.backup=`windows-os-before/shortcuts/${sha256(Buffer.from(normalized(row.path)))}.lnk`;await cp(row.path,join(host.paths.transaction,row.backup),{force:false,errorOnExist:true});if(!sameState(await targetState(join(host.paths.transaction,row.backup)),row.state))fail('WINDOWS_FINALIZATION_SHORTCUT_BACKUP_INVALID')}
 const output=join(host.paths.transaction,'windows-os-before.json')
 await publish(output,{schemaVersion:1,status:'windows-os-before',capturedAt:new Date().toISOString(),transactionRoot:host.paths.transaction,paths:host.paths,oldTarget:host.oldTarget,newTarget:host.newTarget,hostReceipt:{path:safePath(receiptPath),sha256:sha256(await readFile(receiptPath))},scope,snapshot})
 return {status:'windows-os-captured',osBeforePath:output,registryKeys:snapshot.registry.length,shortcuts:snapshot.shortcuts.length}
}
async function sha512(path){const hash=createHash('sha512');for await(const block of createReadStream(path))hash.update(block);return hash.digest('base64')}
function value(record,name){return record?.tree?.values?.find(row=>row.name===name)?.value}
function verifyRegistryAfter(snapshot,host){
 const rows=snapshot.registry.filter(row=>row.subkey.includes('\\Uninstall\\')&&row.tree?.exists)
 const matching=rows.filter(row=>typeof value(row,'InstallLocation')==='string'&&normalized(value(row,'InstallLocation'))===normalized(host.paths.install))
 if(!matching.length||matching.some(row=>value(row,'DisplayVersion')!==host.newTarget.hostVersion))fail('WINDOWS_FINALIZATION_REGISTRY_VERSION_MISMATCH')
}
async function verifyBridge(snapshot,host,ops,options){
 const row=snapshot.registry.find(row=>row.hive==='CurrentUser'&&row.view==='Registry64'&&row.subkey===`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`)
 const path=join(host.paths.install,'Uninstall DeepSeek Harness.exe'),uninstall=value(row,'UninstallString')
 if(!row?.tree?.exists||value(row,'DisplayVersion')!==host.oldTarget.hostVersion||normalized(value(row,'InstallLocation')??'')!==normalized(host.paths.install)||typeof uninstall!=='string')fail('WINDOWS_FINALIZATION_OLD_REGISTRY_ROOT_MISMATCH')
 const parsed=uninstall.match(/^"([^"]+)"\s+\/currentuser\s*$/iu)
 if(!parsed||normalized(parsed[1])!==normalized(path))fail('WINDOWS_FINALIZATION_OLD_UNINSTALL_COMMAND_MISMATCH')
 const old=host.before.install.files?.['Uninstall DeepSeek Harness.exe'],state=await regular(path)
 if(!old||!sameState(state,{type:'file',...old}))fail('WINDOWS_FINALIZATION_OLD_UNINSTALLER_BYTES_MISMATCH')
 const signature=await ops.signature(path),thumb=options.expectedBridgeSignerThumbprint??options.expectedSignerThumbprint
 if(signature.status!=='Valid'||signature.thumbprint?.toUpperCase()!==thumb?.toUpperCase())fail('WINDOWS_FINALIZATION_OLD_UNINSTALLER_SIGNATURE_MISMATCH')
 return {path,state,signature,registry:{hive:row.hive,view:row.view,subkey:row.subkey}}
}
export function installerArguments(install){return ['--updated','/S','/currentuser','/D='+safePath(install)]}

/** The actual official installer is the final Windows integration phase. */
export async function runVerifiedOfficialInstallerAndFinalize(receiptPath,options={}){
 if(options.acknowledgement!==HOST_UPGRADE_ACK)fail('HOST_UPGRADE_ACK_REQUIRED')
 const host=await hostReceipt(receiptPath,options),ops=adapter(host,options),before=await readOSBefore(options.osBeforePath,host)
 if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1000||options.timeoutMs>1200000))fail('WINDOWS_FINALIZATION_TIMEOUT_INVALID')
 validateScope(before.scope,host,!!options.fixtureOps)
 validateSnapshotScope(before.snapshot,before.scope)
 const installer=safePath(options.installerPath);await noLinks(installer);await regular(installer)
 if(typeof options.expectedSha512!=='string'||!/^[-A-Za-z0-9+/]{86}==$/u.test(options.expectedSha512)||await sha512(installer)!==options.expectedSha512)fail('WINDOWS_FINALIZATION_INSTALLER_SHA512_MISMATCH')
 if(!/^[A-Fa-f0-9]{40}$/u.test(options.expectedSignerThumbprint??''))fail('WINDOWS_FINALIZATION_SIGNER_PIN_REQUIRED')
 const signature=await ops.signature(installer)
 if(signature.status!=='Valid'||signature.thumbprint?.toUpperCase()!==options.expectedSignerThumbprint.toUpperCase())fail('WINDOWS_FINALIZATION_INSTALLER_SIGNATURE_MISMATCH')
 const output=join(host.paths.transaction,'windows-finalization-receipt.json')
 if(await pathKind(output)!=='missing')fail('WINDOWS_FINALIZATION_ALREADY_RECORDED')
 return withHostUpgradeLease(receiptPath,options,async()=>{
  await ops.assertStopped()
  for(const key of ['install','home','electronUserData'])if(!sameState(await targetState(host.paths[key]),host.after[key]))fail('WINDOWS_FINALIZATION_PREINSTALL_STATE_DRIFT')
  const currentOS=await snapshotOS(ops,before.scope)
  if(canonical(currentOS.registry)!==canonical(before.snapshot.registry)||currentOS.shortcuts.some((row,index)=>!sameState(row.state,before.snapshot.shortcuts[index].state)))fail('WINDOWS_FINALIZATION_OS_BEFORE_DRIFT')
  const bridge=await verifyBridge(currentOS,host,ops,options),privateDirectory=join(host.paths.transaction,'official-installer-source-'+randomUUID());await mkdir(privateDirectory,{recursive:false,mode:0o700})
  const stagedInstaller=join(privateDirectory,basename(installer));await cp(installer,stagedInstaller,{force:false,errorOnExist:true})
  if(await sha512(stagedInstaller)!==options.expectedSha512)fail('WINDOWS_FINALIZATION_INSTALLER_SHA512_MISMATCH')
  const stagedSignature=await ops.signature(stagedInstaller)
  if(stagedSignature.status!=='Valid'||stagedSignature.thumbprint?.toUpperCase()!==options.expectedSignerThumbprint.toUpperCase())fail('WINDOWS_FINALIZATION_INSTALLER_SIGNATURE_MISMATCH')
  const args=installerArguments(host.paths.install),journalPath=join(host.paths.transaction,'windows-installer-intent.json')
  const intent={schemaVersion:1,status:'official-installer-starting',startedAt:new Date().toISOString(),hostReceipt:{path:safePath(receiptPath),sha256:sha256(await readFile(receiptPath))},osBefore:{path:safePath(options.osBeforePath),sha256:sha256(await readFile(options.osBeforePath))},bridge,installer:{path:stagedInstaller,sourcePath:installer,sha512:options.expectedSha512,signature:stagedSignature,args,windowsVerbatimArguments:true},paths:host.paths}
  await publish(journalPath,intent)
  let result,error,afterOS,after,uninstaller
  try{
   result=await ops.runInstaller(stagedInstaller,args,{windowsVerbatimArguments:true,windowsHide:true,timeoutMs:options.timeoutMs??600000})
   await ops.assertInstallerStopped(stagedInstaller,result?.processId);await ops.assertStopped()
   if(result?.exitCode!==0||result?.unknown)fail('WINDOWS_FINALIZATION_INSTALLER_FAILED')
   await verifyOfficialDesktop({installRoot:host.paths.install,releaseLockPath:host.newReleaseLock.path})
   for(const key of ['home','electronUserData'])if(!sameState(await targetState(host.paths[key]),host.after[key]))fail('WINDOWS_FINALIZATION_DATA_CHANGED_BEFORE_FIRST_LAUNCH')
   const path=join(host.paths.install,'Uninstall DeepSeek Harness.exe'),state=await regular(path),sig=await ops.signature(path)
   if(sig.status!=='Valid'||sig.thumbprint?.toUpperCase()!==options.expectedSignerThumbprint.toUpperCase())fail('WINDOWS_FINALIZATION_UNINSTALLER_SIGNATURE_MISMATCH')
   uninstaller={path,state,signature:sig};afterOS=await snapshotOS(ops,before.scope);validateSnapshotScope(afterOS,before.scope);verifyRegistryAfter(afterOS,host);assertOSCompatible(afterOS,before.snapshot,afterOS,{fixture:!!options.fixtureOps})
  }catch(cause){error=cause}
  after??=Object.fromEntries(await Promise.all(['install','home','electronUserData'].map(async key=>[key,await targetState(host.paths[key])])))
  try{afterOS??=await snapshotOS(ops,before.scope)}catch{afterOS={unavailable:true}}
  if(!afterOS.unavailable)await backupShortcutRows(afterOS,host,'windows-os-after')
  const receipt={...intent,status:error?'windows-finalization-failed':'windows-finalized',finishedAt:new Date().toISOString(),installer:{...intent.installer,result:result??{unknown:true}},uninstaller:uninstaller??null,after,afterOS,errorCode:error?.code??error?.name??null,beforeFirstLaunch:true}
  await publish(output,receipt)
  if(error){error.receiptPath=output;throw error}
  return {status:receipt.status,receiptPath:output,officialInstallerExitCode:0,homeUnchanged:true,electronUserDataUnchanged:true}
 })
}

async function copyTreeInto(source,destination,state){await mkdir(destination,{recursive:false,mode:0o700});for(const name of await readdir(source))await cp(join(source,name),join(destination,name),{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true});if(!sameState(await targetState(destination),state))fail('WINDOWS_FINALIZATION_INSTALL_STAGE_MISMATCH')}
function registryCompatible(current,left,right){
 if(canonical(current)===canonical(left)||canonical(current)===canonical(right))return true
 if(!current?.exists)return true
 const oldValues=left?.values??[],newValues=right?.values??[]
 if((current.values??[]).some(value=>![...oldValues,...newValues].some(known=>canonical(known)===canonical(value))))return false
 return (current.children??[]).every(child=>registryCompatible(child.tree,left?.children?.find(row=>row.name===child.name)?.tree,right?.children?.find(row=>row.name===child.name)?.tree))
}
function ownedShortcut(path,fixture){return fixture||defaultScope().shortcuts.slice(0,2).some(known=>normalized(path)===normalized(known))}
function assertOSCompatible(current,before,after,{partial=false,fixture=false}={}){
 for(let index=0;index<current.registry.length;index++){
  const row=current.registry[index],left=before.registry[index],right=after.registry[index]
  if(row.hive==='LocalMachine'&&(canonical(row)!==canonical(left)||canonical(right)!==canonical(left)))fail('WINDOWS_FINALIZATION_UNOWNED_HKLM_CHANGE')
  if(partial?!registryCompatible(row.tree,left.tree,right.tree):canonical(row)!==canonical(right))fail('WINDOWS_FINALIZATION_OS_ROLLBACK_DRIFT')
 }
 for(let index=0;index<current.shortcuts.length;index++){
  const row=current.shortcuts[index],left=before.shortcuts[index],right=after.shortcuts[index]
  if(!ownedShortcut(row.path,fixture)&&(!sameState(row.state,left.state)||!sameState(right.state,left.state)))fail('WINDOWS_FINALIZATION_UNOWNED_SHORTCUT_CHANGE')
  if(partial?![left.state,right.state,{type:'missing'}].some(state=>sameState(row.state,state)):!sameState(row.state,right.state))fail('WINDOWS_FINALIZATION_OS_ROLLBACK_DRIFT')
 }
}
async function applyOSSnapshot(ops,desired,before,after,scope,host,{partial=false,fixture=false}={}){
 if(after.unavailable)fail('WINDOWS_FINALIZATION_OS_AFTER_UNAVAILABLE')
 const current=await snapshotOS(ops,scope);validateSnapshotScope(current,scope);assertOSCompatible(current,before,after,{partial,fixture})
 const changed=desired.registry.filter((row,index)=>canonical(row.tree)!==canonical(current.registry[index].tree))
 if(changed.some(row=>row.hive!=='CurrentUser'))fail('WINDOWS_FINALIZATION_UNOWNED_HKLM_CHANGE')
 if(changed.length)await ops.restoreRegistry(changed)
 for(const [index,row]of desired.shortcuts.entries()){
  if(sameState(row.state,current.shortcuts[index].state))continue
  if(!ownedShortcut(row.path,fixture))fail('WINDOWS_FINALIZATION_UNOWNED_SHORTCUT_CHANGE')
  await noLinks(row.path)
  if(row.state.type==='missing'){if(await pathKind(row.path)==='file')await rm(row.path,{force:false});continue}
  const source=resolve(host.paths.transaction,row.backup)
  if(!underneath(host.paths.transaction,source)||!sameState(await targetState(source),row.state))fail('WINDOWS_FINALIZATION_SHORTCUT_BACKUP_INVALID')
  await mkdir(dirname(row.path),{recursive:true});const temp=join(dirname(row.path),`.deepseek-shortcut-${randomUUID()}.tmp`)
  await cp(source,temp,{force:false,errorOnExist:true})
  if(!sameState(await targetState(temp),row.state))fail('WINDOWS_FINALIZATION_SHORTCUT_BACKUP_INVALID')
  await rename(temp,row.path)
 }
 const done=await snapshotOS(ops,scope)
 if(canonical(done.registry)!==canonical(desired.registry)||done.shortcuts.some((row,index)=>!sameState(row.state,desired.shortcuts[index].state)))fail('WINDOWS_FINALIZATION_OS_RESTORE_MISMATCH')
}
async function rootStates(host){return Object.fromEntries(await Promise.all(['install','home','electronUserData'].map(async key=>[key,await targetState(host.paths[key])])))}
async function saveCurrentRoots(host,directory,states){
 await mkdir(directory,{recursive:true,mode:0o700})
 for(const key of ['install','home','electronUserData'])if(states[key].type==='directory'){
  await cp(host.paths[key],join(directory,key),{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true})
  if(!sameState(await targetState(join(directory,key)),states[key]))fail('WINDOWS_FINALIZATION_CURRENT_BACKUP_DRIFT')
 }else if(states[key].type!=='missing')fail('WINDOWS_FINALIZATION_ROOT_STATE_INVALID')
}
async function restoreRollbackStart(ops,intent,before,final,host,token){
 const currentOS=await snapshotOS(ops,before.scope);validateSnapshotScope(currentOS,before.scope)
 assertOSCompatible(currentOS,before.snapshot,final.afterOS,{partial:true,fixture:intent.fixture})
 await applyOSSnapshot(ops,final.afterOS,before.snapshot,final.afterOS,before.scope,host,{partial:true,fixture:intent.fixture})
 const current=await rootStates(host)
 for(const key of ['install','home','electronUserData'])if(![intent.current[key],host.after[key],host.before[key],{type:'missing'}].some(state=>sameState(current[key],state)))fail('WINDOWS_FINALIZATION_RECOVERY_ROOT_DRIFT')
 const sources=Object.fromEntries(['install','home','electronUserData'].map(key=>[key,join(intent.currentBackup,key)]))
 await restoreHostRootSetInLease(final.hostReceipt.path,{sources,expectedCurrent:current,desired:intent.current},token)
}
/** Exact-current-state rollback with compensating recovery and immutable intent. */
export async function rollbackOfficialWindowsFinalization(finalizationPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 finalizationPath=safePath(finalizationPath);await noLinks(finalizationPath);const final=await json(finalizationPath)
 if(!verifyReceiptIntegrity(final)||!['windows-finalized','windows-finalization-failed'].includes(final.status))fail('WINDOWS_FINALIZATION_RECEIPT_INVALID')
 const host=await hostReceipt(final.hostReceipt.path,options),ops=adapter(host,options),before=await readOSBefore(final.osBefore.path,host)
 validateScope(before.scope,host,!!options.fixtureOps);validateSnapshotScope(before.snapshot,before.scope);validateSnapshotScope(final.afterOS,before.scope)
 if(dirname(finalizationPath)!==host.paths.transaction||sha256(await readFile(final.hostReceipt.path))!==final.hostReceipt.sha256||sha256(await readFile(final.osBefore.path))!==final.osBefore.sha256)fail('WINDOWS_FINALIZATION_RECEIPT_LINK_MISMATCH')
 await ops.assertInstallerStopped(final.installer.path,final.installer.result?.processId);await ops.assertStopped()
 return withHostUpgradeLease(final.hostReceipt.path,options,async(_host,token)=>{
  const current=await rootStates(host)
  if(!sameState(current.install,final.after.install)||options.allowRuntimeDataChanges!==true&&['home','electronUserData'].some(key=>!sameState(current[key],final.after[key])))fail('WINDOWS_FINALIZATION_INSTALL_ROLLBACK_DRIFT')
  const currentOS=await snapshotOS(ops,before.scope);validateSnapshotScope(currentOS,before.scope);assertOSCompatible(currentOS,before.snapshot,final.afterOS,{fixture:!!options.fixtureOps})
  const attempt=join(host.paths.transaction,'windows-rollback-'+randomUUID()),currentBackup=join(attempt,'current')
  await saveCurrentRoots(host,currentBackup,current)
  const intent={schemaVersion:1,status:'windows-finalization-rollback-starting',fixture:!!options.fixtureOps,finalization:{path:finalizationPath,sha256:sha256(await readFile(finalizationPath))},current,currentBackup,paths:host.paths}
  const intentPath=join(attempt,'intent.json');await publish(intentPath,intent)
  try{
   const bridgeSources=Object.fromEntries(['install','home','electronUserData'].map(key=>[key,join(host.paths.transaction,'shadow',key)]))
   await restoreHostRootSetInLease(final.hostReceipt.path,{sources:bridgeSources,expectedCurrent:current,desired:host.after},token)
   const rootRollback=await rollbackHostUpgradeInLease(final.hostReceipt.path,{...options,acknowledgement:HOST_ROLLBACK_ACK,allowRuntimeDataChanges:false},token)
   await applyOSSnapshot(ops,before.snapshot,before.snapshot,final.afterOS,before.scope,host,{fixture:!!options.fixtureOps})
   const output=join(attempt,'receipt.json')
   await publish(output,{...intent,status:'windows-finalization-rolled-back',hostRollback:rootRollback,osRestored:true,completedAt:new Date().toISOString()})
   return {status:'windows-finalization-rolled-back',receiptPath:output,osRestored:true,hostRollbackReceipt:rootRollback.receiptPath}
  }catch(error){
   try{await restoreRollbackStart(ops,intent,before,final,host,token);await publish(join(attempt,'recovery.json'),{...intent,status:'windows-finalization-rollback-compensated',errorCode:error.code??error.name})}catch(recovery){const combined=new AggregateError([error,recovery],'WINDOWS_FINALIZATION_ROLLBACK_RECOVERY_REQUIRED');combined.intentPath=intentPath;throw combined}
   error.intentPath=intentPath;throw error
  }
 })
}
export async function recoverOfficialWindowsFinalizationRollback(intentPath,options={}){
 if(options.acknowledgement!==HOST_ROLLBACK_ACK)fail('HOST_ROLLBACK_ACK_REQUIRED')
 intentPath=safePath(intentPath);await noLinks(intentPath);const intent=await json(intentPath)
 if(!verifyReceiptIntegrity(intent)||intent.status!=='windows-finalization-rollback-starting'||intent.fixture!==!!options.fixtureOps)fail('WINDOWS_FINALIZATION_ROLLBACK_INTENT_INVALID')
 const final=await json(intent.finalization.path),host=await hostReceipt(final.hostReceipt.path,options),ops=adapter(host,options),before=await readOSBefore(final.osBefore.path,host)
 if(!underneath(host.paths.transaction,intentPath)||!underneath(host.paths.transaction,intent.currentBackup)||canonical(intent.paths)!==canonical(host.paths)||!verifyReceiptIntegrity(final)||sha256(await readFile(intent.finalization.path))!==intent.finalization.sha256)fail('WINDOWS_FINALIZATION_ROLLBACK_INTENT_INVALID')
 validateScope(before.scope,host,!!options.fixtureOps);validateSnapshotScope(before.snapshot,before.scope);validateSnapshotScope(final.afterOS,before.scope)
 await ops.assertInstallerStopped(final.installer.path,final.installer.result?.processId);await ops.assertStopped()
 return withHostUpgradeLease(final.hostReceipt.path,options,async(_host,token)=>{await restoreRollbackStart(ops,intent,before,final,host,token);return {status:'windows-finalization-rollback-compensated',restoredRollbackStart:true}})
}

const REGISTRY_PS=String.raw`
function Read-RegTree($key,$depth) {
 if($null -eq $key){return @{exists=$false}}
 if($depth -gt 4){throw 'Registry backup depth exceeded'}
 $values=@();$names=@($key.GetValueNames());if($names.Count -gt 100){throw 'Registry backup limit exceeded'}
 foreach($name in $names){$kind=$key.GetValueKind($name).ToString();$value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($kind -eq 'Binary' -or $kind -eq 'None'){$value=[Convert]::ToBase64String([byte[]]$value)}elseif($kind -eq 'QWord'){$value=$value.ToString()};$values+=@{name=$name;kind=$kind;value=$value}}
 $children=@();$subs=@($key.GetSubKeyNames());if($subs.Count -gt 50){throw 'Registry backup limit exceeded'}
 foreach($name in $subs){$child=$key.OpenSubKey($name);try{$children+=@{name=$name;tree=(Read-RegTree $child ($depth+1))}}finally{if($child){$child.Dispose()}}}
 return @{exists=$true;values=@($values|Sort-Object name);children=@($children|Sort-Object name)}
}
function Write-RegTree($key,$tree) {
 foreach($name in @($key.GetValueNames())){if(-not @($tree.values|Where-Object {$_.name -ceq $name}).Count){$key.DeleteValue($name,$false)}}
 foreach($name in @($key.GetSubKeyNames())){if(-not @($tree.children|Where-Object {$_.name -ceq $name}).Count){$key.DeleteSubKeyTree($name,$false)}}
 foreach($row in $tree.values){$kind=([Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$row.kind));$value=$row.value;switch($row.kind){'Binary' {$value=[Convert]::FromBase64String($value)} 'None' {$value=[Convert]::FromBase64String($value)} 'DWord' {$value=[int]$value} 'QWord' {$value=[long]$value} 'MultiString' {$value=[string[]]$value}};$key.SetValue([string]$row.name,$value,$kind)}
 foreach($row in $tree.children){$child=$key.CreateSubKey($row.name);try{Write-RegTree $child $row.tree}finally{$child.Dispose()}}
}
`
async function powershell(body,payload){const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64'),script=`$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; ${REGISTRY_PS}\n$taskData=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json); ${body}`,args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];const result=await run('powershell.exe',args,{windowsHide:true,maxBuffer:4194304,timeout:30000});return JSON.parse(result.stdout.replace(/^\uFEFF/u,'').trim()||'null')}
function windowsOps(){return {
 async assertStopped(){await assertAllDesktopInstancesStopped()},
 async readRegistry(scope){return powershell("$rows=@();foreach($row in $taskData){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey(([Enum]::Parse([Microsoft.Win32.RegistryHive],[string]$row.hive)),([Enum]::Parse([Microsoft.Win32.RegistryView],[string]$row.view)));$key=$base.OpenSubKey($row.subkey);try{$rows+=@{hive=$row.hive;view=$row.view;subkey=$row.subkey;tree=(Read-RegTree $key 0)}}finally{if($key){$key.Dispose()};$base.Dispose()}};ConvertTo-Json -InputObject @($rows) -Depth 40 -Compress",scope)},
 async restoreRegistry(rows){await powershell("foreach($row in $taskData){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey(([Enum]::Parse([Microsoft.Win32.RegistryHive],[string]$row.hive)),([Enum]::Parse([Microsoft.Win32.RegistryView],[string]$row.view)));try{if($row.tree.exists){$key=$base.CreateSubKey($row.subkey);try{Write-RegTree $key $row.tree}finally{$key.Dispose()}}else{$key=$base.OpenSubKey($row.subkey);if($key){$key.Dispose();$base.DeleteSubKeyTree($row.subkey,$false)}}}finally{$base.Dispose()}};'null'",rows)},
 async signature(path){return powershell("Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $taskData.path;@{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint;subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress",{path})},
 async runInstaller(path,args,settings){return new Promise(resolveResult=>{const child=execFile(path,args,{windowsHide:true,windowsVerbatimArguments:true,timeout:settings.timeoutMs,maxBuffer:65536},error=>resolveResult({exitCode:error?typeof error.code==='number'?error.code:null:0,processId:child.pid,unknown:!!error&&typeof error.code!=='number'}))})},
 async assertInstallerStopped(path,pid){await powershell("$rows=@(Get-CimInstance Win32_Process);$ids=@();if($taskData.pid){$ids+=([int]$taskData.pid)};$found=@($rows|Where-Object {$_.ExecutablePath -eq $taskData.path -or $_.ProcessId -in $ids -or $_.Name -match '(?i)uninstall.*deepseek'});for($i=0;$i -lt 8;$i++){$children=@($rows|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids});if(-not $children.Count){break};$ids+=@($children|ForEach-Object {$_.ProcessId});$found+=@($children)};if($found.Count){throw 'Official installer process remains active'};'null'",{path,pid})},
}}

export async function inspectOfficialWindowsRegistry(){if(process.platform!=='win32')fail('WINDOWS_FINALIZATION_WINDOWS_REQUIRED');return windowsOps().readRegistry(defaultScope().registry)}
export async function inspectOfficialWindowsSignature(path){if(process.platform!=='win32')fail('WINDOWS_FINALIZATION_WINDOWS_REQUIRED');path=safePath(path);await noLinks(path);await regular(path);return windowsOps().signature(path)}
/** Native .NET typed-value round trip on a fresh test key; no product writes. */
export async function probeWindowsRegistryRoundTrip(){
 if(process.platform!=='win32')fail('WINDOWS_FINALIZATION_WINDOWS_REQUIRED')
 const subkey=`Software\\airules-dsh-harness-overlay\\tests\\${randomUUID()}`
 const value=await powershell("$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);$key=$null;try{if($base.OpenSubKey($taskData.subkey)){throw 'Test registry key already exists'};$key=$base.CreateSubKey($taskData.subkey);$tree=@{exists=$true;values=@(@{name='';kind='String';value='Капитан Дизель 船长'},@{name='binary';kind='Binary';value='AQID'},@{name='dword';kind='DWord';value=42},@{name='expand';kind='ExpandString';value='%TEMP%\\fixture'},@{name='multi';kind='MultiString';value=@('one','two')},@{name='qword';kind='QWord';value='9223372036854775807'});children=@(@{name='child';tree=@{exists=$true;values=@(@{name='value';kind='String';value='child'});children=@()}})};Write-RegTree $key $tree;$before=Read-RegTree $key 0;$key.SetValue('extra','must disappear');$bad=$key.CreateSubKey('extraChild');$bad.Dispose();Write-RegTree $key $tree;$after=Read-RegTree $key 0;@{before=$before;after=$after}|ConvertTo-Json -Depth 40 -Compress}finally{if($key){$key.Dispose()};$base.DeleteSubKeyTree($taskData.subkey,$false);$base.Dispose()}",{subkey})
 if(canonical(value.before)!==canonical(value.after)||value.before.values.find(row=>row.name==='')?.value!=='Капитан Дизель 船长')fail('WINDOWS_FINALIZATION_REGISTRY_ROUNDTRIP_FAILED')
 return {passed:true,typedValues:6,childTree:true,extraValuesRemoved:true,testKeyRemoved:true}
}
