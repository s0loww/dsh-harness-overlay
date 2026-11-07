import { readFile,lstat,mkdir } from 'node:fs/promises'
import { join,isAbsolute } from 'node:path'
import { DRIVERS,driverOf,validateDriver,verifyDriver,prepareEnvironment,makeProfile,detachMuseHome } from './runtime.js'
import { googleLogin,googleStatus,googleLogout,museAccount } from './auth.js'
import { writeProtectedFile } from './protected-file.js'

const safeUrl=(id,value)=>{
  const url=new URL(value), allowed=id==='google'?['google.com']:['meta.com','meta.ai','facebook.com']
  if(url.protocol!=='https:'||url.username||url.password||!allowed.some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`)))throw new Error('DRIVER_AUTH_URL_REJECTED')
  return url.href
}
export function createDriverController({home,node,launcher,publish,enabled=()=>false,write=writeProtectedFile,verify=verifyDriver,
  environment=prepareEnvironment,auth={googleLogin,googleStatus,googleLogout,museAccount}}){
  if(!isAbsolute(home)||!isAbsolute(node)||!isAbsolute(launcher))throw new Error('DRIVER_PATH_REQUIRED')
  const states=new Map(DRIVERS.map(row=>[row.id,{phase:'idle',connected:false,models:[]}]))
  let queue=Promise.resolve(),closed=false
  const serial=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result}
  const manifest=id=>join(home,`${driverOf(id).id}.json`), directory=id=>join(home,driverOf(id).id)
  async function read(id){
    try {const path=manifest(id), info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('DRIVER_MANIFEST_INVALID')
      const record=JSON.parse(await readFile(path,'utf8'));if(record.id!==id)throw new Error('DRIVER_MANIFEST_INVALID');return validateDriver(record.config)
    } catch(error){if(error.code==='ENOENT')return undefined;throw error}
  }
  const stop=id=>{const state=states.get(id);state.attempt?.abort();state.prompt?.reject(new Error('DRIVER_LOGIN_CANCELLED'));delete state.prompt;delete state.attempt;delete state.notice;state.phase=state.activeAttempt?'stopping':'idle'}
  const snapshot=async()=>({providers:await Promise.all(DRIVERS.map(async spec=>{
    const state=states.get(spec.id);let config,error
    try {config=await read(spec.id)}catch {error='DRIVER_MANIFEST_INVALID'}
    return {id:spec.id,name:spec.name,configured:!!config,...(config?{config}:{}),enabled:enabled(spec),phase:state.phase,connected:state.connected,
      modelCount:state.models.length,...(state.notice?{notice:state.notice}:{}),manualCallback:!!state.prompt,...(state.error||error?{error:state.error??error}:{})}
  }))})
  async function options(id,signal){const config=await read(id);if(!config)throw new Error('DRIVER_SETUP_REQUIRED');await verify(config);const env=await environment(directory(id),id);return {config,env,directory:directory(id),signal}}
  async function check(id,signal){const opts=await options(id,signal);return id==='google'?auth.googleStatus(opts):auth.museAccount(opts)}
  return {snapshot,manifest,
    action(input){return serial(async()=>{
      if(closed)throw new Error('DRIVER_CONTROLLER_CLOSED')
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['action','provider','config','callback'].includes(key)))throw new Error('DRIVER_INPUT_REJECTED')
      const spec=driverOf(input.provider),id=spec.id,state=states.get(id)
      if(!['configure','login','cancel','callback','check','enable','disable','logout'].includes(input.action))throw new Error('DRIVER_ACTION_REJECTED')
      if(state.activeAttempt&&!['cancel','callback','disable'].includes(input.action))throw new Error('DRIVER_BUSY')
      if(input.action==='configure'){
        const config=await verify(validateDriver(input.config));await publish(spec,undefined)
        await mkdir(home,{recursive:true,mode:0o700});write(manifest(id),{id,config});state.connected=false;state.models=[];state.error=undefined
      } else if(input.action==='login'){
        const attempt=new AbortController(), opts=await options(id,attempt.signal)
        const timeout=setTimeout(()=>attempt.abort(),10*60*1000);timeout.unref?.()
        state.attempt=attempt;state.activeAttempt=attempt;state.phase='pending';state.error=undefined
        const current=()=>!closed&&state.attempt===attempt&&!attempt.signal.aborted
        const notify=value=>{if(!current())return;state.notice={url:safeUrl(id,value.url),...(typeof value.code==='string'?{code:value.code.slice(0,128)}:{})}}
        const prompt=signal=>new Promise((resolve,reject)=>{if(!current())return reject(new Error('DRIVER_LOGIN_CANCELLED'));state.prompt={resolve,reject};signal?.addEventListener('abort',()=>{delete state.prompt;reject(new Error('DRIVER_LOGIN_CANCELLED'))},{once:true})})
        state.work=Promise.resolve().then(()=>id==='google'?auth.googleLogin({...opts,notify,prompt}):auth.museAccount({...opts,notify})).then(async result=>{
          if(!current())return
          const verified=id==='google'?await auth.googleStatus(opts):result
          if(current()){state.connected=verified.connected===true;state.models=verified.models??[];state.phase=state.connected?'connected':'idle'}
        }).catch(()=>{if(!closed&&state.attempt===attempt){state.phase='error';state.error='DRIVER_AUTH_FAILED'}}).finally(()=>{clearTimeout(timeout);if(state.activeAttempt===attempt){delete state.activeAttempt;if(state.phase==='stopping')state.phase='idle'}if(state.attempt===attempt){delete state.attempt;delete state.notice;delete state.prompt}})
      } else if(input.action==='cancel'){stop(id)}
      else if(input.action==='callback'){
        if(!state.prompt||typeof input.callback!=='string'||input.callback.length>4096)throw new Error('DRIVER_CALLBACK_REJECTED')
        const url=new URL(input.callback);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('DRIVER_CALLBACK_REJECTED')
        const pending=state.prompt;delete state.prompt;pending.resolve(input.callback)
      } else if(input.action==='check'){
        const result=await check(id,AbortSignal.timeout(30000));state.connected=result.connected===true;state.models=result.models??[];state.error=undefined
      } else if(input.action==='enable'){
        const result=await check(id,AbortSignal.timeout(30000));if(!result.connected)throw new Error('DRIVER_LOGIN_REQUIRED')
        state.connected=true;state.models=result.models??[]
        await publish(spec,makeProfile(id,{node,launcher,manifest:manifest(id)}))
      } else if(input.action==='disable'){stop(id);await publish(spec,undefined)}
      else if(input.action==='logout'){
        stop(id);await publish(spec,undefined)
        if(id==='google')await auth.googleLogout({directory:directory(id)});else await detachMuseHome(home)
        state.connected=false;state.models=[];state.phase='idle';state.error=undefined
      }
      return snapshot()
    })},
    async close(){closed=true;const work=[];for(const spec of DRIVERS){const state=states.get(spec.id);stop(spec.id);if(state.work)work.push(state.work)}
      let timer;try{await Promise.race([Promise.allSettled(work),new Promise(resolve=>{timer=setTimeout(resolve,3000);timer.unref?.()})])}finally{clearTimeout(timer)}},
  }
}
