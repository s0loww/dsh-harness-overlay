import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {guard,kind,hashFile,json,safeRelative,same,fail,validSeal} from './fs.mjs'
import {queryNativeDesktopProcesses,validDesktopProcessRows} from '../../../installer/official-live/process-query.mjs'
const execute=promisify(execFile)
const psQuote=value=>"'"+String(value).replaceAll("'","''")+"'"
async function load(engine,path){return import(pathToFileURL(join(engine,...path.split('/'))).href)}
function artifactRoots(ctx){return{uiArtifactRoot:safeRelative(ctx.bundleRoot,ctx.manifest.paths.uiArtifact),policyArtifactRoot:safeRelative(ctx.bundleRoot,ctx.manifest.paths.policyArtifact),releaseLockPath:safeRelative(ctx.bundleRoot,ctx.manifest.paths.releaseLock)}}
/** Default adapters execute only the pinned signed official installer and the
 * reviewed local engine. Component adapters are injected by the bundle launcher. */
export function createOfficialDeploymentAdapters({platform=process.platform,executeImpl=execute}={}){
 return{
  async inspectOfficial(ctx){
   if(await kind(ctx.installRoot)==='missing')return{installed:false,compatible:false}
   const asar=join(ctx.installRoot,'resources','app.asar'),exe=join(ctx.installRoot,'DeepSeek Harness.exe')
   if(await kind(asar)==='missing'&&await kind(exe)==='missing')return{installed:false,compatible:false}
   // Inspect with the package engine already covered by the verified incoming
   // inventory, never a possibly drifted cached module before cache repair.
   try{const sourceEngine=safeRelative(ctx.sourceBundleRoot,ctx.manifest.paths.engine),{verifyOfficialDesktop}=await load(sourceEngine,'src/targets/official-desktop/target.mjs'),result=await verifyOfficialDesktop({installRoot:ctx.installRoot,releaseLockPath:ctx.releaseLockPath});return{installed:true,compatible:result.lock.hostVersion===ctx.manifest.hostVersion,hostVersion:result.lock.hostVersion}}
   catch{return{installed:true,compatible:false}}
  },
  async assertStopped(ctx){
   if(platform!=='win32')return
   let rows
   try{rows=await queryNativeDesktopProcesses({executeImpl})}
   catch{fail('DEPLOY_PROCESS_CHECK_UNAVAILABLE')}
   if(!Array.isArray(rows))rows=[rows]
   if(!validDesktopProcessRows(rows))fail('DEPLOY_PROCESS_CHECK_UNAVAILABLE')
   const key=value=>resolve(value).toLowerCase();if(rows.some(row=>key(row.ExecutablePath)===key(join(ctx.installRoot,'DeepSeek Harness.exe'))))fail('DEPLOY_DSH_RUNNING')
  },
  async installOfficial(ctx){
   if(platform!=='win32')fail('DEPLOY_WINDOWS_REQUIRED')
   const expected=ctx.manifest.files[ctx.manifest.paths.officialInstaller],signature=ctx.manifest.signatures?.officialInstaller
   if(!signature||!/^[A-Fa-f0-9]{40}$/u.test(signature.thumbprint??''))fail('DEPLOY_OFFICIAL_SIGNATURE_REQUIRED')
   if(!same(await hashFile(ctx.installerPath),expected))fail('DEPLOY_OFFICIAL_INSTALLER_CHANGED')
   const privateRoot=join(ctx.transaction,'official-installer-source');await mkdir(privateRoot,{recursive:true});await guard(privateRoot)
   const path=join(privateRoot,'setup.exe');await copyFile(ctx.installerPath,path);await guard(path)
   if(!same(await hashFile(path),expected))fail('DEPLOY_OFFICIAL_INSTALLER_CHANGED')
   let signed
   try{signed=JSON.parse((await executeImpl('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$s=Get-AuthenticodeSignature -LiteralPath ${psQuote(path)}; [pscustomobject]@{status=[string]$s.Status;thumbprint=[string]$s.SignerCertificate.Thumbprint;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout.trim())}catch{fail('DEPLOY_OFFICIAL_SIGNATURE_UNAVAILABLE')}
   if(signed.status!=='Valid'||signed.thumbprint.toUpperCase()!==signature.thumbprint.toUpperCase()||signature.subject&&signed.subject!==signature.subject)fail('DEPLOY_OFFICIAL_SIGNATURE_MISMATCH')
   if(!same(await hashFile(path),expected))fail('DEPLOY_OFFICIAL_INSTALLER_CHANGED')
   await executeImpl(path,['--updated','/S','/currentuser','/D='+ctx.installRoot],{windowsHide:true,windowsVerbatimArguments:true,timeout:240000,maxBuffer:1024*1024,signal:ctx.signal})
   return{status:'installed',installerSha256:expected.sha256}
  },
  async prepareCandidate(ctx){
   const{createOfficialCandidate}=await load(ctx.engineRoot,'scripts/create-official-candidate.mjs'),{applyOfficialUi}=await load(ctx.engineRoot,'installer/official-ui/apply.mjs'),{applyOfficialPolicy}=await load(ctx.engineRoot,'installer/official-policy/apply.mjs'),{runCandidateLayerCycle}=await load(ctx.engineRoot,'scripts/cycle-official-candidate.mjs'),{preflightCandidate,launchCandidateSmoke}=await load(ctx.engineRoot,'scripts/smoke-official-candidate.mjs')
   const candidateRoot=join(ctx.engineRoot,'var/candidate','deployment-'+ctx.deploymentId),roots=artifactRoots(ctx),common={candidateRoot,...roots}
   ctx.signal?.throwIfAborted();await createOfficialCandidate({sourceRoot:ctx.installRoot,candidateRoot,releaseLockPath:roots.releaseLockPath})
   await applyOfficialUi({candidateRoot,artifactRoot:roots.uiArtifactRoot,releaseLockPath:roots.releaseLockPath});await applyOfficialPolicy({candidateRoot,artifactRoot:roots.policyArtifactRoot,releaseLockPath:roots.releaseLockPath})
   ctx.signal?.throwIfAborted();await runCandidateLayerCycle(common)
   if(ctx.configureCandidateExtras)await ctx.configureCandidateExtras({...ctx,purpose:'candidate',candidateRoot,dshHome:join(candidateRoot,'home'),profileRoot:join(candidateRoot,'home/profiles/desktop')})
   await launchCandidateSmoke({...common,visible:true,timeoutMs:12000});await preflightCandidate(common)
   return candidateRoot
  },
  async applyOverlay(ctx){const{applyLivePromotion}=await load(ctx.engineRoot,'installer/official-live/apply.mjs'),{LIVE_ACKNOWLEDGEMENT}=await load(ctx.engineRoot,'installer/official-live/common.mjs');return applyLivePromotion({installRoot:ctx.installRoot,profileRoot:ctx.profileRoot,backupRoot:ctx.backupRoot,candidateRoot:ctx.candidateRoot,...artifactRoots(ctx),previousReceiptPath:ctx.previousReceiptPath,allowOwnedFragmentMigration:Boolean(ctx.previousReceiptPath),acknowledgement:LIVE_ACKNOWLEDGEMENT})},
  async verifyOverlay(ctx){const{targetState,sameState}=await load(ctx.engineRoot,'installer/fs-state.mjs'),{verifyReceiptIntegrity}=await load(ctx.engineRoot,'installer/receipt.mjs'),receipt=await json(ctx.receiptPath);if(!verifyReceiptIntegrity(receipt)||receipt.status!=='applied'||resolve(receipt.installRoot)!==resolve(ctx.installRoot)||resolve(receipt.profileRoot)!==resolve(ctx.profileRoot))fail('DEPLOY_OVERLAY_RECEIPT_INVALID');const drift=[];for(const row of receipt.operations)if(!sameState(await targetState(safeRelative(ctx.profileRoot,row.target)),row.after))drift.push(row.target);return{status:drift.length?'FAIL':'PASS',owned:receipt.operations.length,drift}},
  async rollbackOverlay(ctx){const{rollbackLivePromotion}=await load(ctx.engineRoot,'installer/official-live/rollback.mjs'),{LIVE_ACKNOWLEDGEMENT}=await load(ctx.engineRoot,'installer/official-live/common.mjs');return rollbackLivePromotion({installRoot:ctx.installRoot,profileRoot:ctx.profileRoot,receiptPath:ctx.receiptPath,...artifactRoots(ctx),acknowledgement:LIVE_ACKNOWLEDGEMENT})},
 }
}
