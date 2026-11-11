import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createOfficialDeploymentAdapters} from '../src/deployment-bundle/lib/official-adapter.mjs'
test('native overlay adapter enables owned fragment migration only with a previous receipt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-adapter-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'installer/official-live'),{recursive:true});await writeFile(join(root,'installer/official-live/apply.mjs'),'export async function applyLivePromotion(options){return options}\n');await writeFile(join(root,'installer/official-live/common.mjs'),"export const LIVE_ACKNOWLEDGEMENT='FIXTURE_ACK'\n")
 const adapter=createOfficialDeploymentAdapters(),ctx={engineRoot:root,bundleRoot:root,installRoot:join(root,'install'),profileRoot:join(root,'profile'),backupRoot:join(root,'backup'),candidateRoot:join(root,'candidate'),manifest:{paths:{uiArtifact:'dist/ui',policyArtifact:'dist/policy',releaseLock:'release.lock.json'}}}
 const fresh=await adapter.applyOverlay(ctx);assert.equal(fresh.allowOwnedFragmentMigration,false);assert.equal(fresh.previousReceiptPath,undefined)
 const previousReceiptPath=join(root,'previous.json'),update=await adapter.applyOverlay({...ctx,previousReceiptPath});assert.equal(update.allowOwnedFragmentMigration,true);assert.equal(update.previousReceiptPath,previousReceiptPath);assert.equal(update.acknowledgement,'FIXTURE_ACK')
})
