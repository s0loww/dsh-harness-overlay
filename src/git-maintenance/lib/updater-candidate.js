import {cp,lstat,mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
const fail=code=>{throw Error(code)}
/** Trusted local engine only. Release input contains data/assets, not executables
 * for this preparation step. Candidate isolation and certification are reused. */
export async function prepareUpdateCandidate({engineRoot,release,target,signal,run}){
 const load=path=>import(pathToFileURL(join(engineRoot,path)).href)
 const [{createOfficialCandidate},{applyOfficialUi},{applyOfficialPolicy},{preflightCandidate,launchCandidateSmoke},{runCandidateLayerCycle},{directoryState,sameState}]=await Promise.all([load('scripts/create-official-candidate.mjs'),load('installer/official-ui/apply.mjs'),load('installer/official-policy/apply.mjs'),load('scripts/smoke-official-candidate.mjs'),load('scripts/cycle-official-candidate.mjs'),load('installer/fs-state.mjs')])
 const id=String(release.identity??'');if(!/^[a-f0-9]{64}$/u.test(id))fail('UPDATE_RELEASE_INVALID')
 const candidateRoot=join(engineRoot,'var/candidate','git-release-'+id.slice(0,24)),marker=join(candidateRoot,'maintenance-certified.json')
 signal?.throwIfAborted()
 const roots={}
 for(const [key,name,prefix]of [['uiArtifactRoot','ui-overlay-manifest.json','airules-ui-overlay-'],['policyArtifactRoot','official-policy-manifest.json','airules-official-policy-']]){
  signal?.throwIfAborted();const input=release[key],manifest=JSON.parse(await readFile(join(input,name),'utf8')),version=manifest.artifact?.version;if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(version??''))fail('UPDATE_RELEASE_INVALID')
  const destination=join(engineRoot,'dist',prefix+version);await mkdir(join(engineRoot,'dist'),{recursive:true})
  try{await lstat(destination);if(!sameState(await directoryState(input),await directoryState(destination)))fail('UPDATE_ARTIFACT_VERSION_COLLISION')}catch(error){if(error.code!=='ENOENT')throw error;await cp(input,destination,{recursive:true,errorOnExist:true,force:false});if(!sameState(await directoryState(input),await directoryState(destination)))fail('UPDATE_ARTIFACT_COPY_MISMATCH')}
  roots[key]=destination
 }
 const common={candidateRoot,...roots,releaseLockPath:release.releaseLockPath}
 signal?.throwIfAborted()
 try{const record=JSON.parse(await readFile(marker,'utf8'));if(record.releaseIdentity!==id)fail('UPDATE_CANDIDATE_CHANGED');await preflightCandidate(common);return candidateRoot}catch(error){if(error.code!=='ENOENT')throw error}
 // Never adopt a partially prepared candidate as certified.
 try{await lstat(candidateRoot);fail('UPDATE_CANDIDATE_INCOMPLETE')}catch(error){if(error.code!=='ENOENT')throw error}
 await createOfficialCandidate({sourceRoot:target.installRoot,candidateRoot,releaseLockPath:release.releaseLockPath})
 signal?.throwIfAborted();await applyOfficialUi({candidateRoot,artifactRoot:roots.uiArtifactRoot,releaseLockPath:release.releaseLockPath})
 signal?.throwIfAborted();await applyOfficialPolicy({candidateRoot,artifactRoot:roots.policyArtifactRoot,releaseLockPath:release.releaseLockPath})
 signal?.throwIfAborted()
 // Existing scripts are executed through the authenticated native runner in the
 // host; the sealed update worker may use the same fixed trusted engine after exit.
 if(typeof runCandidateLayerCycle==='function')await runCandidateLayerCycle(common)
 else if(run){const outcome=await run(['node',join(engineRoot,'scripts/cycle-official-candidate.mjs'),'--candidate-root',candidateRoot,'--ui-artifact',release.uiArtifactRoot,'--policy-artifact',release.policyArtifactRoot,'--release-lock',release.releaseLockPath,'--execute'],{cwd:engineRoot,signal,timeoutMs:300000,outputLimit:1024*1024});if(outcome.code!==0)fail('UPDATE_CANDIDATE_CYCLE_FAILED')}
 else fail('UPDATE_CANDIDATE_CYCLE_REQUIRED')
 signal?.throwIfAborted();await launchCandidateSmoke({...common,visible:true,timeoutMs:12000});await preflightCandidate(common)
 await writeFile(marker,JSON.stringify({schemaVersion:1,releaseIdentity:id},null,2)+'\n',{flag:'wx',mode:0o600});return candidateRoot
}
