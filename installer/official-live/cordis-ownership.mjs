import {readFile} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {targetState,sameState,sha256} from '../fs-state.mjs'
import {verifyReceiptIntegrity} from '../receipt.mjs'
import {verifyUiArtifact} from '../official-ui/common.mjs'
import {verifyPolicyArtifact} from '../official-policy/common.mjs'
import {mergeUiCordis} from '../official-ui/ui-cordis.mjs'
import {mergePolicyCordis} from '../official-policy/policy-cordis.mjs'
import {migrateCordisFragments} from './cordis-migration.mjs'
import {reverseCordisChanges} from './cordis-preservation.mjs'
import {assertPromotionPaths} from './common.mjs'
const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url))),SNAPSHOT='after/cordis.patch.yml'
const fail=()=>{throw Object.assign(Error('LIVE_CORDIS_PRESERVATION_CONFLICT'),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})}
const stateOf=bytes=>({type:'file',bytes:bytes.length,sha256:sha256(bytes)})
const match=(actual,expected)=>{if(!sameState(actual,expected))fail()}
async function artifacts(uiRoot,policyRoot,identity){
 const ui=await verifyUiArtifact(uiRoot),policy=await verifyPolicyArtifact(policyRoot)
 for(const [name,row]of [['ui',ui],['policy',policy]])if(identity?.[name]?.id!==row.manifest.artifact.id||identity[name].version!==row.manifest.artifact.version||identity[name].manifestSha256!==row.manifestSha256)fail()
 const uiManifest=JSON.parse(await readFile(join(ui.root,'official-ui-manifest.json'),'utf8'))
 return{ui,policy,uiFragment:await readFile(join(ui.root,uiManifest.cordisFragment),'utf8'),policyFragment:await readFile(join(policy.root,'cordis.policy.fragment.yml'),'utf8')}
}
/** Trusted B/A bytes are checked against immutable operation states. No receipt
 * ownership hash is rewritten to accommodate a user's current C document. */
export async function cordisPreservationPlan({receipt,receiptPath,uiArtifactRoot,policyArtifactRoot,current}){
 if(!verifyReceiptIntegrity(receipt))fail()
 const paths=assertPromotionPaths({installRoot:receipt.installRoot,profileRoot:receipt.profileRoot,backupRoot:receipt.backupRoot})
 if(!receiptPath||resolve(receiptPath)!==join(paths.backup,'receipt.json'))fail()
 const row=receipt.operations?.find(row=>row.target==='cordis.patch.yml')
 if(!row||row.type!=='merge-cordis'||row.after?.type!=='file'||!['missing','file'].includes(row.before?.type))fail()
 const expectedBackup=row.before.type==='missing'?null:'before/cordis.patch.yml';if(row.backup!==expectedBackup)fail()
 let before=Buffer.alloc(0)
 if(expectedBackup){const path=join(receipt.backupRoot,expectedBackup);match(await targetState(path),row.before);before=await readFile(path);match(stateOf(before),row.before)}
 let installed
 if(receipt.cordisAfterSnapshot!==undefined){if(receipt.cordisAfterSnapshot!==SNAPSHOT)fail();const path=join(receipt.backupRoot,SNAPSHOT);match(await targetState(path),row.after);installed=await readFile(path)}
 else{
  const next=await artifacts(uiArtifactRoot,policyArtifactRoot,receipt.artifacts)
  if(!receipt.previousPromotion)installed=Buffer.from(mergePolicyCordis(mergeUiCordis(before.toString('utf8'),next.uiFragment).text,next.policyFragment).text)
  else if(!receipt.previousPromotion.managedFragmentMigration)installed=before
  else{
   const path=resolve(String(receipt.previousPromotion.receiptPath??'')),scope=join(ROOT,'var/live-promotion-backups'),rel=relative(scope,path)
   if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||!rel.endsWith(sep+'receipt.json'))fail()
   const bytes=await readFile(path);if(sha256(bytes)!==receipt.previousPromotion.receiptSha256)fail();const previous=JSON.parse(bytes)
   if(!verifyReceiptIntegrity(previous))fail()
   const ids=previous.artifacts;if(![ids?.ui?.version,ids?.policy?.version].every(v=>typeof v==='string'&&/^[a-z0-9.-]+$/u.test(v)))fail()
   const old=await artifacts(join(ROOT,'dist','airules-ui-overlay-'+ids.ui.version),join(ROOT,'dist','airules-official-policy-'+ids.policy.version),ids)
   installed=Buffer.from(migrateCordisFragments(before.toString('utf8'),[{oldFragment:old.uiFragment,newFragment:next.uiFragment},{oldFragment:old.policyFragment,newFragment:next.policyFragment}]))
  }
 }
 match(stateOf(installed),row.after)
 const observed=Buffer.isBuffer(current)?current:Buffer.from(current),merged=reverseCordisChanges({before,installed,current:observed})
 return{...merged,observedState:stateOf(observed),restoredState:stateOf(merged.text),installedState:row.after,usedSnapshot:receipt.cordisAfterSnapshot===SNAPSHOT}
}
