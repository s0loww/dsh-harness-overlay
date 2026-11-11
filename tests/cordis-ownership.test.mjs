import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {PROMOTION_BACKUPS_ROOT} from '../installer/official-live/common.mjs'
import {targetState} from '../installer/fs-state.mjs'
import {sealReceipt} from '../installer/receipt.mjs'
import {cordisPreservationPlan} from '../installer/official-live/cordis-ownership.mjs'
async function fixture(t,{before='[]\n',installed='- id: managed\n  value: true\n'}={}){
 const root=await mkdtemp(join(tmpdir(),'dsh-cordis-owned-')),backup=join(PROMOTION_BACKUPS_ROOT,'cordis-test-'+randomUUID());await mkdir(join(backup,'before'),{recursive:true});await mkdir(join(backup,'after'));t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(backup,{recursive:true,force:true})})
 await writeFile(join(backup,'before/cordis.patch.yml'),before);await writeFile(join(backup,'after/cordis.patch.yml'),installed)
 const receipt=sealReceipt({schemaVersion:1,status:'applied',installRoot:join(root,'install'),profileRoot:join(root,'profile'),backupRoot:backup,cordisAfterSnapshot:'after/cordis.patch.yml',operations:[{target:'cordis.patch.yml',type:'merge-cordis',backup:'before/cordis.patch.yml',before:await targetState(join(backup,'before/cordis.patch.yml')),after:await targetState(join(backup,'after/cordis.patch.yml'))}]});const receiptPath=join(backup,'receipt.json');await writeFile(receiptPath,JSON.stringify(receipt));return{root,backup,receipt,receiptPath,installed,options:{receipt,receiptPath,current:Buffer.from(installed+'- id: native\n  enabled: false\n')}}
}
test('trusted after snapshot reverses only owned addition and keeps native preferences',async t=>{const f=await fixture(t),result=await cordisPreservationPlan(f.options);assert.equal(result.text.toString(),'- id: native\n  enabled: false\n');assert.equal(result.preservedUnmanaged,true);assert.equal(result.usedSnapshot,true)})
test('snapshot with no installer delta preserves later native changes and no-edit restore keeps BOM bytes',async t=>{
 const text='\uFEFF- id: baseline\r\n  v: true\r\n',f=await fixture(t,{before:text,installed:text}),current=Buffer.from(text+'- id: native\r\n  v: false\r\n');const noDelta=await cordisPreservationPlan({...f.options,current});assert.deepEqual(noDelta.text,current);const exact=await cordisPreservationPlan({...f.options,current:Buffer.from(text)});assert.deepEqual(exact.text,Buffer.from(text))
})
test('forged snapshot, forged backup path, foreign receipt location and owned edits refuse',async t=>{
 const f=await fixture(t);await assert.rejects(cordisPreservationPlan({...f.options,current:Buffer.from('- id: managed\n  value: false\n')}),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})
 await assert.rejects(cordisPreservationPlan({...f.options,receiptPath:join(f.root,'foreign.json')}),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})
 const row=f.receipt.operations[0];for(const mutation of [{...f.receipt,cordisAfterSnapshot:'../../foreign'},{...f.receipt,operations:[{...row,backup:'../../foreign'}]}])await assert.rejects(cordisPreservationPlan({...f.options,receipt:sealReceipt(mutation)}),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})
 await writeFile(join(f.backup,'after/cordis.patch.yml'),'FORGED');await assert.rejects(cordisPreservationPlan(f.options),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})
})
