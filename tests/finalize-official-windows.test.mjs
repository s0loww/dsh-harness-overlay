import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {hostFixture} from './fixtures/host-upgrade.mjs'
import {buildHostUpgradePlan,stageHostUpgradeShadow,applyHostUpgrade,HOST_UPGRADE_ACK,HOST_ROLLBACK_ACK} from '../scripts/upgrade-official-host.mjs'
import {captureOSBefore,runVerifiedOfficialInstallerAndFinalize,rollbackOfficialWindowsFinalization,recoverOfficialWindowsFinalizationRollback,installerArguments,inspectOfficialWindowsSignature} from '../scripts/finalize-official-windows.mjs'
import {targetState,canonical} from '../installer/fs-state.mjs'
import {sealReceipt,verifyReceiptIntegrity} from '../installer/receipt.mjs'
const GUID='1bf39983-50d0-5fe0-9ef4-cece76f67c5e',THUMB='A'.repeat(40),clone=value=>structuredClone(value)
const put=async(path,text)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text)}
async function fixture(t,{mode='normal'}={}){
 const f=await hostFixture(t)
 await put(join(f.options.oldInstallRoot,'Uninstall DeepSeek Harness.exe'),'SIGNED_OLD_UNINSTALLER')
 await put(join(f.options.newInstallRoot,'Uninstall DeepSeek Harness.exe'),'SIGNED_OLD_UNINSTALLER')
 const plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan),applied=await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})
 const scope={registry:[{hive:'CurrentUser',view:'Registry64',subkey:`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`},{hive:'LocalMachine',view:'Registry64',subkey:`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`}],shortcuts:[join(f.root,'Desktop/DeepSeek Harness.lnk'),join(f.root,'StartMenu/DeepSeek Harness.lnk')]}
 await put(scope.shortcuts[0],'OLD_SHORTCUT')
 const makeTree=(location,version,uninstaller)=>({exists:true,values:[{name:'DisplayVersion',kind:'String',value:version},{name:'InstallLocation',kind:'String',value:location},{name:'UninstallString',kind:'String',value:`"${uninstaller}" /currentuser`}],children:[]})
 const registry=[{...scope.registry[0],tree:makeTree(f.options.oldInstallRoot,'test-old',join(f.options.oldInstallRoot,'Uninstall DeepSeek Harness.exe'))},{...scope.registry[1],tree:makeTree(join(f.root,'OtherInstallation'),'other-version',join(f.root,'OtherInstallation/uninstall.exe'))}]
 let calls=0,restoreFailure=false,signatureInvalid=false
 const ops={fixture:true,assertStopped:async()=>{},assertInstallerStopped:async()=>{}}
 // Keep the fake registry strict: production descriptors and row order are used.
 ops.readRegistry=async rows=>rows.map(row=>clone(registry.find(known=>known.hive===row.hive&&known.view===row.view&&known.subkey===row.subkey)))
 ops.signature=async()=>({status:signatureInvalid?'NotSigned':'Valid',thumbprint:THUMB,subject:'CN=Fixture DeepSeek'})
 ops.restoreRegistry=async rows=>{for(const row of rows){assert.equal(row.hive,'CurrentUser','unchanged HKLM is inventory-only');registry[0]=clone(row);if(restoreFailure){restoreFailure=false;throw Object.assign(new Error('fixture registry I/O failure'),{code:'FIXTURE_REGISTRY_IO'})}}}
 ops.runInstaller=async(path,args,settings)=>{
  calls++;assert.ok(path.includes('official-installer-source'));assert.notEqual(path,join(f.root,'official-setup.exe'))
  assert.deepEqual(args,['--updated','/S','/currentuser','/D='+f.options.oldInstallRoot]);assert.equal(settings.windowsVerbatimArguments,true)
  await put(join(f.options.oldInstallRoot,'Uninstall DeepSeek Harness.exe'),'SIGNED_NEW_OFFICIAL_UNINSTALLER');await put(join(f.options.oldInstallRoot,'new-official-notices.txt'),'NEW_OFFICIAL_NOTICE')
  registry[0].tree=makeTree(f.options.oldInstallRoot,'test-new',join(f.options.oldInstallRoot,'Uninstall DeepSeek Harness.exe'))
  await put(scope.shortcuts[0],'NEW_SHORTCUT');await put(scope.shortcuts[1],'NEW_START_MENU')
  if(mode==='data-change')await put(join(f.options.homeRoot,'sessions/installer-created.json'),'INSTALLER_CHANGED_DATA')
  if(mode==='delete-home')await rm(f.options.homeRoot,{recursive:true,force:false})
  if(mode==='bad-baseline')await put(join(f.options.oldInstallRoot,'resources/app.asar'),'WRONG_OFFICIAL_BYTES')
  return {exitCode:mode==='installer-failure'?5:0,processId:12345,unknown:false}
 }
 const installer=join(f.root,'official-setup.exe');await put(installer,'PINNED_SIGNED_FIXTURE_INSTALLER')
 const options={...f.options,fixtureOps:ops,osScope:scope,installerPath:installer,expectedSha512:createHash('sha512').update(await readFile(installer)).digest('base64'),expectedSignerThumbprint:THUMB,acknowledgement:HOST_UPGRADE_ACK}
 const before=await captureOSBefore(applied.receiptPath,options);options.osBeforePath=before.osBeforePath
 return {...f,plan,applied,options,registry,scope,get calls(){return calls},failRestoreOnce(){restoreFailure=true},badSignature(){signatureInvalid=true}}
}
test('NSIS argument vector preserves /D as literal unquoted final argument',()=>{
 const path=join(process.cwd(),'a path/DeepSeek Harness');assert.deepEqual(installerArguments(path),['--updated','/S','/currentuser','/D='+path])
 assert.throws(()=>installerArguments(path+'" --force-run'),{code:'WINDOWS_FINALIZATION_EXACT_PATH_REQUIRED'})
})
test('native Windows PowerShell signature probe ignores inherited PowerShell 7 modules', {skip:process.platform!=='win32'}, async()=>{
 const before=process.env.PSModulePath
 try{
  process.env.PSModulePath=join(process.env.ProgramFiles,'PowerShell/7/Modules')
  const signedSystemBinary=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
  const signature=await inspectOfficialWindowsSignature(signedSystemBinary)
  assert.equal(typeof signature.status,'string');assert.ok(signature.status.length)
 }finally{if(before===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=before}
})
test('signed pinned private installer finalizes registry and uninstaller without touching chats/auth',async t=>{
 const f=await fixture(t),home=await targetState(f.options.homeRoot),electron=await targetState(f.options.electronUserDataRoot)
 const result=await runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options)
 assert.equal(result.status,'windows-finalized');assert.equal(f.calls,1);assert.deepEqual(await targetState(f.options.homeRoot),home);assert.deepEqual(await targetState(f.options.electronUserDataRoot),electron)
 const receipt=JSON.parse(await readFile(result.receiptPath,'utf8'));assert.ok(verifyReceiptIntegrity(receipt));assert.ok(receipt.after.install.files['new-official-notices.txt']);assert.equal(receipt.installer.result.exitCode,0)
 const rolled=await rollbackOfficialWindowsFinalization(result.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 assert.equal(rolled.osRestored,true)
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(f.plan.paths[key]),f.plan.before[key])
 assert.equal(f.registry[0].tree.values.find(row=>row.name==='DisplayVersion').value,'test-old');assert.equal(await readFile(f.scope.shortcuts[0],'utf8'),'OLD_SHORTCUT');assert.equal((await targetState(f.scope.shortcuts[1])).type,'missing')
})
test('hash and signature mismatch refuse before launching the installer',async t=>{
 const f=await fixture(t),before=await targetState(f.options.oldInstallRoot)
 await assert.rejects(runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,{...f.options,expectedSha512:'B'.repeat(86)+'=='}),{code:'WINDOWS_FINALIZATION_INSTALLER_SHA512_MISMATCH'})
 f.badSignature();await assert.rejects(runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options),{code:'WINDOWS_FINALIZATION_INSTALLER_SIGNATURE_MISMATCH'})
 assert.equal(f.calls,0);assert.deepEqual(await targetState(f.options.oldInstallRoot),before)
})
test('a changed external installer cannot replace the pinned private execution bytes',async t=>{
 const f=await fixture(t),original=f.options.fixtureOps.signature
 f.options.fixtureOps.signature=async path=>{if(path===f.options.installerPath)await put(path,'CHANGED_AFTER_SIGNATURE');return original(path)}
 await assert.rejects(runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options),{code:'WINDOWS_FINALIZATION_INSTALLER_SHA512_MISMATCH'});assert.equal(f.calls,0)
})
test('registered old uninstaller must identify the selected root before official setup',async t=>{
 const f=await fixture(t);f.registry[0].tree.values.find(row=>row.name==='UninstallString').value='"E:\\Other\\Uninstall DeepSeek Harness.exe" /currentuser'
 // Capture a fresh legitimate-but-wrong OS snapshot to exercise root binding.
 const before=JSON.parse(await readFile(f.options.osBeforePath,'utf8'));before.snapshot.registry=clone(f.registry);await writeFile(f.options.osBeforePath,canonical(sealReceipt(before)))
 await assert.rejects(runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options),{code:'WINDOWS_FINALIZATION_OLD_UNINSTALL_COMMAND_MISMATCH'});assert.equal(f.calls,0)
})
for(const mode of ['installer-failure','data-change','delete-home','bad-baseline'])test(`failed official phase ${mode} can restore exact host, profile and OS`,async t=>{
 const f=await fixture(t,{mode});let failed
 try{await runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options)}catch(error){failed=error}
 assert.ok(failed?.receiptPath)
 await rollbackOfficialWindowsFinalization(failed.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(f.plan.paths[key]),f.plan.before[key])
 assert.equal(await readFile(join(f.options.homeRoot,'credentials/account.json'),'utf8'),'PRIVATE_AUTH_SENTINEL')
})
test('OS drift rejects rollback before any install/home rename',async t=>{
 const f=await fixture(t),result=await runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options),before={}
 for(const key of ['install','home','electronUserData'])before[key]=await targetState(f.plan.paths[key])
 f.registry[0].tree.values.push({name:'UnknownExternalChange',kind:'String',value:'not owned'})
 await assert.rejects(rollbackOfficialWindowsFinalization(result.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK}),{code:'WINDOWS_FINALIZATION_OS_ROLLBACK_DRIFT'})
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(f.plan.paths[key]),before[key])
})
test('mid-registry restore failure compensates to exact finalized roots/OS and permits retry',async t=>{
 const f=await fixture(t),result=await runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options),before={}
 for(const key of ['install','home','electronUserData'])before[key]=await targetState(f.plan.paths[key])
 f.failRestoreOnce();let failed
 try{await rollbackOfficialWindowsFinalization(result.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})}catch(error){failed=error}
 assert.equal(failed?.code,'FIXTURE_REGISTRY_IO');assert.ok(failed.intentPath)
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(f.plan.paths[key]),before[key])
 assert.equal(f.registry[0].tree.values.find(row=>row.name==='DisplayVersion').value,'test-new')
 await recoverOfficialWindowsFinalizationRollback(failed.intentPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 assert.equal((await rollbackOfficialWindowsFinalization(result.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})).osRestored,true)
})
test('combined deleted-home and mid-OS restore failure compensates the exact failed state, then retries safely',async t=>{
 const f=await fixture(t,{mode:'delete-home'});let finalFailure
 try{await runVerifiedOfficialInstallerAndFinalize(f.applied.receiptPath,f.options)}catch(error){finalFailure=error}
 const before={};for(const key of ['install','home','electronUserData'])before[key]=await targetState(f.plan.paths[key])
 f.failRestoreOnce();let rollbackFailure
 try{await rollbackOfficialWindowsFinalization(finalFailure.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})}catch(error){rollbackFailure=error}
 assert.equal(rollbackFailure?.code,'FIXTURE_REGISTRY_IO')
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(f.plan.paths[key]),before[key])
 await recoverOfficialWindowsFinalizationRollback(rollbackFailure.intentPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 await rollbackOfficialWindowsFinalization(finalFailure.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 assert.deepEqual(await targetState(f.options.homeRoot),f.plan.before.home)
})
test('fixture adapter cannot touch real shortcut paths or implicit OS scope',async t=>{
 const f=await fixture(t),bad={...f.options,osScope:{...f.scope,shortcuts:[join(process.env.USERPROFILE??process.cwd(),'Desktop/DeepSeek Harness.lnk')]}}
 await assert.rejects(captureOSBefore(f.applied.receiptPath,bad),{code:'WINDOWS_FINALIZATION_SHORTCUT_SCOPE_INVALID'})
 await assert.rejects(captureOSBefore(f.applied.receiptPath,{...f.options,osScope:undefined}),{code:'WINDOWS_FINALIZATION_FIXTURE_SCOPE_REQUIRED'})
})
