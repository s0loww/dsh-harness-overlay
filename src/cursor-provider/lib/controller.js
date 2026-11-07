import { readFile, mkdir, writeFile, rename,rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import {randomUUID}from'node:crypto'
import { inspectRuntime, loadRuntime, fail } from './runtime.js'
import { catalogOf, PROVIDER } from './catalog.js'
async function deadline(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CURSOR_CATALOG_TIMEOUT')),30000);timer.unref?.()})])}finally{clearTimeout(timer)}}

export function createController({credentials,key,configPath,inspect=inspectRuntime,load=loadRuntime,changed=()=>{}}) {
  let config={}, epoch=0, revision=0, attempt, phase='idle', authorizeUrl='', error, inspected
  const activeRuns=new Set()
  const ready=(async()=>{try{config=JSON.parse(await readFile(configPath,'utf8'))}catch(e){if(e.code!=='ENOENT')error='CURSOR_CONFIG_INVALID'}})()
  const record=()=>credentials.readRecord(key)
  let writes=Promise.resolve()
  const save=(next,generation=epoch)=>{const work=writes.then(async()=>{if(generation!==epoch)fail('CURSOR_ACCOUNT_CHANGED');await mkdir(dirname(configPath),{recursive:true});const temp=configPath+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(next),'utf8');if(generation!==epoch)fail('CURSOR_ACCOUNT_CHANGED');await rename(temp,configPath);config=next;revision++}finally{await rm(temp,{force:true})}});writes=work.catch(()=>{});return work}
  const cancel=()=>{epoch++;revision++;attempt?.abort();attempt=undefined;authorizeUrl='';phase='idle';for(const run of activeRuns)run.abort()}
  async function snapshot(){await ready;const value=await record();return{provider:PROVIDER,connected:!!value?.payload?.apiKey,phase,error,authorizeUrl,runtime:config.runtime??null,inspected:inspected??null,models:(config.models??[]).map(({cursorModel,...row})=>row)}}
  async function refresh(){await ready;const generation=epoch,value=(await record())?.payload;if(!value?.apiKey)fail('CURSOR_LOGIN_REQUIRED');const sdk=await load(config.runtime);const models=catalogOf(await deadline(sdk.Cursor.models.list({apiKey:value.apiKey})));if(generation!==epoch)fail('CURSOR_ACCOUNT_CHANGED');await save({...config,models},generation);changed()}
  function login(){if(attempt)fail('CURSOR_LOGIN_PENDING');const current=new AbortController(),generation=epoch;attempt=current;phase='starting';error=undefined
    const timer=setTimeout(()=>{if(attempt===current){cancel();phase='error';error='CURSOR_LOGIN_TIMEOUT'}},300000);timer.unref?.()
    void(async()=>{try{
      await ready;const sdk=await load(config.runtime)
      const grant=await sdk.Cursor.auth.login({store:null,openBrowser:false,signal:current.signal,onLoginUrl(url){
        const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||!(parsed.hostname==='cursor.com'||parsed.hostname.endsWith('.cursor.com')))fail('CURSOR_AUTH_URL_REJECTED')
        if(attempt===current&&!current.signal.aborted){authorizeUrl=parsed.href;phase='waiting'}
      }})
      if(attempt!==current||generation!==epoch||current.signal.aborted)return
      if(typeof grant?.apiKey!=='string'||!grant.apiKey||!(grant.apiKeyExpiresAtMs>Date.now()))fail('CURSOR_GRANT_INVALID')
      const identity=await sdk.Cursor.me({apiKey:grant.apiKey})
      if(attempt!==current||generation!==epoch||current.signal.aborted)return
      await credentials.modifyRecord(key,()=>{if(attempt!==current||generation!==epoch||current.signal.aborted)fail('CURSOR_LOGIN_CANCELLED');return{kind:'grant',payload:{apiKey:grant.apiKey,apiKeyExpiresAtMs:grant.apiKeyExpiresAtMs,identity:{email:typeof identity?.email==='string'?identity.email.slice(0,200):undefined}}}})
      phase='connected';authorizeUrl='';attempt=undefined;await refresh()
    }catch{if(generation===epoch&&!current.signal.aborted){phase='error';error='CURSOR_LOGIN_FAILED';authorizeUrl=''}}finally{clearTimeout(timer);if(attempt===current)attempt=undefined}})()
  }
  return {ready,snapshot,refresh,
    async models(){await ready;return structuredClone(config.models??[])},
    async revision(){await ready;return revision},
    async acquire(signal,expectedRevision){await ready;signal?.throwIfAborted();if(expectedRevision!==undefined&&expectedRevision!==revision)fail('CURSOR_CONFIG_CHANGED');const generation=epoch,pin=structuredClone(config.runtime),value=(await record())?.payload
      if(!value?.apiKey||value.apiKeyExpiresAtMs<=Date.now())fail('CURSOR_LOGIN_REQUIRED')
      const sdk=await load(pin);if(generation!==epoch)fail('CURSOR_ACCOUNT_CHANGED');if(expectedRevision!==undefined&&expectedRevision!==revision)fail('CURSOR_CONFIG_CHANGED')
      const local=new AbortController();activeRuns.add(local)
      return{sdk,apiKey:value.apiKey,signal:signal?AbortSignal.any([signal,local.signal]):local.signal,release:()=>activeRuns.delete(local)}
    },
    async action(body){await ready;switch(body?.action){
      case'inspect':inspected=await inspect(body.packageRoot);return
      case'configure':if(!inspected||body.sha256!==inspected.sha256||body.packageRoot!==inspected.packageRoot)fail('CURSOR_PIN_INSPECTION_REQUIRED');cancel();await save({runtime:inspected,models:[]});inspected=undefined;changed();return
      case'login':login();return
      case'cancel':cancel();return
      case'refresh':await refresh();return
      case'logout':cancel();await credentials.deleteRecord(key);await save({...config,models:[]});changed();return
      default:fail('CURSOR_ACTION_INVALID')
    }},close:cancel}
}
