import {join} from 'node:path'
import {randomBytes,timingSafeEqual} from 'node:crypto'
import {createSettingsStore} from './settings.js'
import {createKeepAwake,nativeInhibitor} from './keep-awake.js'
import {createVisionService,imageModelInfo} from './vision.js'
export const name='airules-dsh-runtime-utilities'
export const inject=['agents','agentPresets','sandboxPolicy','approval','fs','attachments','sessionQuery','llm','subprocess','dshHomePath','webServer','connection']
export const API='/airules/runtime-utilities'
export function createController(ctx,{settings,awake,vision}){
 const token=randomBytes(32).toString('base64url');let refreshGeneration=0
 const refresh=async()=>{const generation=++refreshGeneration,{config}=await settings.read();if(generation!==refreshGeneration)return;await awake.update(config.keepAwake,ctx.agents.list().filter(agent=>agent.status==='running').map(agent=>agent.session.id))}
 async function catalog(){
  const providers=ctx.llm.listProviders(),models=[],unavailable=[];let truncated=providers.length>32
  const settled=await Promise.all(providers.slice(0,32).map(async provider=>{let timer;try{return{provider,models:await Promise.race([ctx.llm.listModels(provider.id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CATALOG_TIMEOUT')),8000)})])}}catch{return{provider,error:true}}finally{clearTimeout(timer)}}))
  for(const result of settled){if(result.error){unavailable.push(result.provider.id);continue}if(result.models.length>1000)truncated=true;for(const model of result.models.slice(0,1000)){if(!model.inputModalities?.includes('image'))continue;if(models.length>=256){truncated=true;break}models.push({provider:result.provider.id,id:model.id,label:model.name??model.id})}}
  return{models,unavailable,truncated,note:unavailable.length?'Часть провайдеров не ответила; доступен ручной выбор точной модели.':truncated?'Каталог ограничен; доступен ручной выбор точной модели.':''}
 }
 async function act(input){
  if(input.action==='configuration')return{...await settings.read(),awake:awake.status()}
  if(input.action==='models')return catalog()
  if(input.action!=='save'||Object.keys(input).some(k=>!['action','config','expectedRevision'].includes(k)))throw Error('UTILITIES_INPUT_INVALID')
  const result=await settings.save(input.config,input.expectedRevision,async config=>{if(config.vision.enabled)await imageModelInfo(ctx.llm,config.vision,new AbortController().signal)})
  vision.cancelAll();await refresh();return{...result,awake:awake.status()}
 }
 async function handler(request,response){
  const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body))}
  if(ctx.connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
  try{let input;if(request.method==='GET'){const url=new URL(request.url,'http://localhost');input={action:url.searchParams.get('action')??'configuration'};if(!['configuration','models'].includes(input.action))throw Error('UTILITIES_METHOD_REQUIRED')}
   else if(request.method==='POST'){const supplied=Buffer.from(String(request.headers['x-airules-csrf']??'')),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{ok:false,error:'UTILITIES_CSRF_REQUIRED'});let bytes=0,chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>16384)throw Error('UTILITIES_BODY_LIMIT');chunks.push(Buffer.from(chunk))}input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
   else return send(405,{ok:false,error:'UTILITIES_METHOD_REQUIRED'})
   return send(200,{ok:true,...await act(input),csrfToken:token})
  }catch(error){const code=/^(?:UTILITIES_|VISION_)[A-Z0-9_]+$/u.test(error.message)?error.message:'UTILITIES_REQUEST_FAILED';send(400,{ok:false,error:code})}
 }
 return{act,handler,refresh}
}
export async function apply(ctx){
 const settings=createSettingsStore(join(ctx.dshHomePath('runtime-utilities'),'config.json'))
 const awake=createKeepAwake({start:nativeInhibitor(ctx.subprocess)}),vision=createVisionService(ctx,{settings}),controller=createController(ctx,{settings,awake,vision})
 ctx.provide('airulesRuntimeUtilities',{describe:vision.describe})
 ctx.on('agent/status',()=>{void controller.refresh().catch(()=>{})},{global:true})
 ctx.on('agent/disposed',()=>{void controller.refresh().catch(()=>{})},{global:true})
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:API,handler:controller.handler}))
 ctx.effect(()=>{void controller.refresh().catch(()=>{});return async()=>{vision.cancelAll();await awake.dispose()}})
}

