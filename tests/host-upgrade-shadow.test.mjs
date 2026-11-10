import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {buildHostUpgradePlan,stageHostUpgradeShadow,HOST_UPGRADE_ROOT,applyHostUpgrade,rollbackHostUpgrade,recoverHostUpgrade,HOST_UPGRADE_ACK,HOST_ROLLBACK_ACK,assertAllDesktopInstancesStopped,emitHostOwnershipAnchor} from '../scripts/upgrade-official-host.mjs'
import {rollbackLivePromotion} from '../installer/official-live/rollback.mjs'
import {readLiveUpdateReceipt,LIVE_ACKNOWLEDGEMENT} from '../installer/official-live/common.mjs'
import {PROMOTION_BACKUPS_ROOT} from '../installer/official-live/common.mjs'
import {POLICY_PACKAGES} from '../installer/official-policy/common.mjs'
import {targetState,canonical,sha256} from '../installer/fs-state.mjs'
import {sealReceipt,verifyReceiptIntegrity} from '../installer/receipt.mjs'

import {hostFixture as fixture} from './fixtures/host-upgrade.mjs'
async function put(path,text){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text)}

test('host upgrade read-only plan binds old receipt to old host and new host separately',async t=>{
 const f=await fixture(t),before=await targetState(f.root),plan=await buildHostUpgradePlan(f.options)
 assert.equal(plan.status,'ready-shadow-only');assert.equal(plan.oldTarget.hostVersion,'test-old');assert.equal(plan.newTarget.hostVersion,'test-new')
 assert.deepEqual(await targetState(f.root),before);assert.ok(Object.isFrozen(plan.operations))
})
test('shadow transaction protects full backups and preserves native chats, auth, MCP and user plugins',async t=>{
 const f=await fixture(t),before=await targetState(f.root),receiptBefore=await readFile(f.options.previousReceiptPath),plan=await buildHostUpgradePlan(f.options),result=await stageHostUpgradeShadow(plan)
 assert.equal(result.liveModified,false);assert.deepEqual(await targetState(f.root),before);assert.deepEqual(await readFile(f.options.previousReceiptPath),receiptBefore)
 const root=f.options.transactionRoot,shadow=join(root,'shadow')
 for(const [path,expected]of [['home/sessions/native-chat.json','NATIVE_CHAT_SENTINEL'],['home/credentials/account.json','PRIVATE_AUTH_SENTINEL'],['home/mcp.json','PROJECT_MCP_SENTINEL'],['electronUserData/Cookies','COOKIE_SENTINEL'],['home/profiles/desktop/node_modules/unowned-user-plugin/index.js','USER_PLUGIN']])assert.equal(await readFile(join(shadow,path),'utf8'),expected)
 assert.equal(await readFile(join(shadow,'home/profiles/desktop/node_modules/owned-ui/index.js'),'utf8'),'new owned-ui')
 const patch=await readFile(join(shadow,'home/profiles/desktop/cordis.patch.yml'),'utf8');assert.ok(patch.includes('value: new'));assert.ok(patch.includes('preserved custom settings'))
 const receipt=JSON.parse(await readFile(result.receiptPath,'utf8'));assert.ok(verifyReceiptIntegrity(receipt));assert.equal(receipt.status,'shadow-ready-not-applied');assert.equal(receipt.protection.kind,process.platform==='win32'?'windows-acl':'mode')
 assert.deepEqual(await targetState(join(root,'before/home')),plan.before.home)
})
test('old target mismatch and owned package drift reject before creating transaction',async t=>{
 const f=await fixture(t)
 await put(join(f.profile,'node_modules/owned-ui/index.js'),'unexpected drift')
 await assert.rejects(buildHostUpgradePlan(f.options),{code:'LIVE_UPDATE_PACKAGE_DRIFT'})
 await assert.rejects(buildHostUpgradePlan({...f.options,oldReleaseLockPath:f.options.newReleaseLockPath}),{code:'BASELINE_HASH_MISMATCH'})
})
test('concurrent source drift blocks staging, forged plan is rejected, live apply API absent',async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options)
 await assert.rejects(stageHostUpgradeShadow(JSON.parse(JSON.stringify(plan))),{code:'HOST_UPGRADE_VERIFIED_PLAN_REQUIRED'})
 await put(join(f.options.homeRoot,'sessions/new-chat.json'),'changed after plan')
 await assert.rejects(stageHostUpgradeShadow(plan),{code:'HOST_UPGRADE_SOURCE_DRIFT'})
 await assert.rejects(applyHostUpgrade(join(f.options.transactionRoot,'receipt.json'),f.options),{code:'HOST_UPGRADE_ACK_REQUIRED'})
})
test('volume root is never a full-snapshot or destructive upgrade target',async t=>{
 const f=await fixture(t)
 await assert.rejects(buildHostUpgradePlan({...f.options,oldInstallRoot:resolve('/')}),{code:'HOST_UPGRADE_VOLUME_ROOT_FORBIDDEN'})
})
test('global desktop stop guard rejects another installation as well',async()=>{
 await assert.rejects(assertAllDesktopInstancesStopped({platform:'win32',query:async()=>[{ProcessId:100,ExecutablePath:'E:/Other DeepSeek/DeepSeek Harness.exe'}]}),{code:'HOST_UPGRADE_OTHER_DESKTOP_RUNNING'})
 await assertAllDesktopInstancesStopped({platform:'win32',query:async()=>[]})
})
test('same-volume three-root apply and rollback preserve old receipt and full backup',async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan),oldReceipt=await readFile(f.options.previousReceiptPath)
 const applied=await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})
 assert.equal(applied.status,'host-applied');assert.deepEqual(await targetState(f.options.oldInstallRoot),plan.newInstallState)
 assert.equal(await readFile(join(f.profile,'node_modules/owned-ui/index.js'),'utf8'),'new owned-ui')
 const applyReceipt=JSON.parse(await readFile(applied.receiptPath,'utf8'))
 for(const row of applyReceipt.displacedRoots)assert.deepEqual(await targetState(row.path),row.state)
 const rolled=await rollbackHostUpgrade(applied.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 assert.equal(rolled.status,'host-rolled-back')
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(plan.paths[key]),plan.before[key])
 assert.deepEqual(await readFile(f.options.previousReceiptPath),oldReceipt)
})
for(const faultAt of [1,2,3,4])test(`apply failure after boundary ${faultAt} recovers every root`,async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan)
 await assert.rejects(applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK,faultAt}),{code:'HOST_UPGRADE_FIXTURE_FAULT'})
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(plan.paths[key]),plan.before[key])
 if(faultAt===4)assert.equal((await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})).status,'host-applied')
})
for(const fixtureCrashAt of [1,2,3])test(`explicit crash recovery reconciles immutable intent after root ${fixtureCrashAt}`,async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan)
 await assert.rejects(applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK,fixtureCrashAt}),{code:'HOST_UPGRADE_FIXTURE_CRASH'})
 const attempt=(await readdir(f.options.transactionRoot)).find(name=>name.startsWith('apply-')),journal=join(f.options.transactionRoot,attempt,'swap-journal.json')
 // A torn newest generation cannot hide the prior committed rename intent.
 await put(journal+'.generation-99999999.json','{"torn":')
 await recoverHostUpgrade(shadow.receiptPath,journal,{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(plan.paths[key]),plan.before[key])
})
test('rollback after native data migration needs explicit opt-in and preserves current backup',async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan),applied=await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})
 await put(join(f.options.homeRoot,'sessions/new-native-chat.json'),'NEW_POST_UPGRADE_CHAT')
 await assert.rejects(rollbackHostUpgrade(applied.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK,allowRuntimeDataChanges:'false'}),{code:'HOST_ROLLBACK_RUNTIME_OPTION_INVALID'})
 await assert.rejects(rollbackHostUpgrade(applied.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK}),{code:'HOST_ROLLBACK_CURRENT_STATE_DRIFT'})
 const rolled=await rollbackHostUpgrade(applied.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK,allowRuntimeDataChanges:true})
 assert.equal(await readFile(join(rolled.receiptPath,'../current/home/sessions/new-native-chat.json'),'utf8'),'NEW_POST_UPGRADE_CHAT')
 assert.deepEqual(await targetState(f.options.homeRoot),plan.before.home)
})
test('different transactions sharing live roots cannot interleave their swaps',async t=>{
 const f=await fixture(t),other=join(HOST_UPGRADE_ROOT,'fixture-concurrent-'+randomUUID());t.after(()=>rm(other,{recursive:true,force:true}))
 const first=await stageHostUpgradeShadow(await buildHostUpgradePlan(f.options)),second=await stageHostUpgradeShadow(await buildHostUpgradePlan({...f.options,transactionRoot:other}))
 const results=await Promise.allSettled([applyHostUpgrade(first.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK}),applyHostUpgrade(second.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})])
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
 assert.equal(results.find(row=>row.status==='rejected').reason.code,'HOST_UPGRADE_MUTATION_LOCKED')
})
test('new-target ownership anchor supports strict future ownership and next host plan; its own rollback is a no-op',async t=>{
 const f=await fixture(t,{nativeDeps:true}),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan),applied=await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})
 const ownershipBackupRoot=join(PROMOTION_BACKUPS_ROOT,'host-anchor-fixture-'+randomUUID()),nextRoot=join(HOST_UPGRADE_ROOT,'fixture-next-'+randomUUID())
 t.after(async()=>{await rm(ownershipBackupRoot,{recursive:true,force:true});await rm(nextRoot,{recursive:true,force:true})})
 const anchor=await emitHostOwnershipAnchor(applied.receiptPath,{...f.options,ownershipBackupRoot,acknowledgement:HOST_UPGRADE_ACK})
 const raw=JSON.parse(await readFile(anchor.receiptPath,'utf8'))
 assert.equal(raw.metadata.anchorOnly,true);assert.equal(raw.metadata.hostRollbackReceipt.path,applied.receiptPath)
 await readLiveUpdateReceipt({previousReceiptPath:anchor.receiptPath,paths:{install:plan.paths.install,profile:f.profile,backup:nextRoot},target:plan.newTarget,packageNames:raw.artifactPackageNames})
 const next=await buildHostUpgradePlan({...f.options,oldReleaseLockPath:f.options.newReleaseLockPath,newReleaseLockPath:f.options.oldReleaseLockPath,newInstallRoot:join(f.options.transactionRoot,'before/install'),oldUiArtifactRoot:f.options.newUiArtifactRoot,newUiArtifactRoot:f.options.oldUiArtifactRoot,oldPolicyArtifactRoot:f.options.newPolicyArtifactRoot,newPolicyArtifactRoot:f.options.oldPolicyArtifactRoot,previousReceiptPath:anchor.receiptPath,transactionRoot:nextRoot})
 assert.equal(next.oldTarget.hostVersion,'test-new')
 const before=await targetState(f.options.homeRoot)
 await rollbackLivePromotion({installRoot:plan.paths.install,profileRoot:f.profile,receiptPath:anchor.receiptPath,uiArtifactRoot:f.options.newUiArtifactRoot,policyArtifactRoot:f.options.newPolicyArtifactRoot,releaseLockPath:f.options.newReleaseLockPath,acknowledgement:LIVE_ACKNOWLEDGEMENT})
 assert.deepEqual(await targetState(f.options.homeRoot),before)
})
for(const fixtureCrashAt of [1,2,3])test(`rollback interruption after root ${fixtureCrashAt} restores new migrated state`,async t=>{
 const f=await fixture(t),plan=await buildHostUpgradePlan(f.options),shadow=await stageHostUpgradeShadow(plan),applied=await applyHostUpgrade(shadow.receiptPath,{...f.options,acknowledgement:HOST_UPGRADE_ACK})
 await put(join(f.options.homeRoot,'sessions/migrated-chat.json'),'MIGRATED_CHAT')
 const before={};for(const key of ['install','home','electronUserData'])before[key]=await targetState(plan.paths[key])
 await assert.rejects(rollbackHostUpgrade(applied.receiptPath,{...f.options,acknowledgement:HOST_ROLLBACK_ACK,allowRuntimeDataChanges:true,fixtureCrashAt}),{code:'HOST_UPGRADE_FIXTURE_CRASH'})
 const attempt=(await readdir(f.options.transactionRoot)).find(name=>name.startsWith('rollback-'))
 await recoverHostUpgrade(applied.receiptPath,join(f.options.transactionRoot,attempt,'swap-journal.json'),{...f.options,acknowledgement:HOST_ROLLBACK_ACK})
 for(const key of ['install','home','electronUserData'])assert.deepEqual(await targetState(plan.paths[key]),before[key])
})
