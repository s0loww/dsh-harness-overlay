import{readFile}from'node:fs/promises'
import{isAbsolute,join,resolve}from'node:path'
import{fileURLToPath}from'node:url'
import{readReleaseLock,DEFAULT_RELEASE_LOCK}from'../src/targets/official-desktop/target.mjs'
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)))
export const DEFAULT_NATIVE_MODULES=join(ROOT,'var/asar-extract-rc5/dsh/node_modules')
/** Local source/lock identity only. No credential or account reads. */
export async function resolveNativeHostOptions({nativeModules,releaseLockPath=DEFAULT_RELEASE_LOCK}={}){
 if(typeof releaseLockPath!=='string'||!isAbsolute(releaseLockPath))throw Error('EXPLICIT_RELEASE_LOCK_PATH_REQUIRED')
 const lock=await readReleaseLock(releaseLockPath)
 if(!['0.2.1-rc.5','0.2.2-rc.1'].includes(lock.hostVersion))throw Error('LIVE_HOST_VERSION_UNSUPPORTED')
 if(lock.hostVersion==='0.2.2-rc.1'&&nativeModules===undefined)throw Error('LIVE_HOST_NATIVE_MODULES_REQUIRED')
 const modules=nativeModules??DEFAULT_NATIVE_MODULES
 if(typeof modules!=='string'||!isAbsolute(modules))throw Error('EXPLICIT_NATIVE_MODULES_REQUIRED')
 for(const name of ['dsh','dsh-agent','dsh-agent-loop','dsh-tools']){
  const pkg=JSON.parse(await readFile(join(modules,'@deepseek-ai',name,'package.json'),'utf8'))
  if(pkg.name!=='@deepseek-ai/'+name||pkg.version!==lock.hostVersion)throw Error('LIVE_HOST_NATIVE_VERSION_MISMATCH')
 }
 return{hostVersion:lock.hostVersion,nativeModules:resolve(modules),releaseLockPath:resolve(releaseLockPath)}
}
/** Route changes must precede 022 step preparation and tool admission. */
export function installAcceptanceModelSelection({scope,agent,route,hostVersion,installModelSelection}){
 if(hostVersion==='0.2.2-rc.1'){
  if(typeof agent?.model?.select!=='function')throw Error('NATIVE_AGENT_MODEL_SELECTION_REQUIRED')
  agent.model.select({provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort})
  return installModelSelection(scope)
 }
 if(hostVersion!=='0.2.1-rc.5')throw Error('LIVE_HOST_VERSION_UNSUPPORTED')
 return installModelSelection(scope,{current:route,assembled:undefined})
}
export function assertAcceptancePreStep(payload,route){
 const selection=payload.modelSelection
 if(selection?.provider!==route.provider||selection?.model!==route.model||selection?.reasoningEffort!==route.reasoningEffort)throw Error('LIVE_PRESTEP_ROUTE_DRIFT')
}
