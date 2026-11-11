import {randomBytes,timingSafeEqual} from 'node:crypto'
import {readFile,realpath,lstat} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join,resolve,sep,extname} from 'node:path'
import {createConfigStore,MODELS,DEFAULT_PHRASES,phaseForEvent} from './core.js'
export const name='airules-dsh-live2d-companion'
export const inject=['webServer','connection','dshHomePath']
export const API='/airules/live2d'
const ASSETS=fileURLToPath(new URL('../assets/',import.meta.url))
const MIME={'.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.moc3':'application/octet-stream','.txt':'text/plain; charset=utf-8'}
export function createController(ctx,store,{assets=ASSETS}={}){
 const token=randomBytes(32).toString('base64url'),clients=new Set(),states=new Map();let closed=false
 function publish(session,event){const row=phaseForEvent(session,event);if(!row)return;if(states.size>=128&&!states.has(row.sessionId))states.delete(states.keys().next().value);states.set(row.sessionId,row.phase);for(const client of clients){if(client.sessionId!==row.sessionId)continue;try{client.response.write('data: '+JSON.stringify({phase:row.phase})+'\n\n')}catch{clients.delete(client)}}}
 async function handler(request,response){
  const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value))}
  try{
   if(closed)return send(503,{ok:false,error:'LIVE2D_CLOSED'})
   if(!ctx.connection||ctx.connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
   const url=new URL(request.url,'http://localhost'),path=url.pathname
   if(path===API+'/configuration'){
    if(request.method==='GET')return send(200,{ok:true,...store.read(),models:Object.keys(MODELS),phraseCatalog:DEFAULT_PHRASES,csrfToken:token})
    if(request.method!=='POST')return send(405,{ok:false,error:'METHOD_REJECTED'})
    const supplied=Buffer.from(String(request.headers['x-airules-csrf']??'')),expected=Buffer.from(token)
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{ok:false,error:'CSRF_REQUIRED'})
    if(!String(request.headers['content-type']??'').startsWith('application/json'))throw Error('LIVE2D_BODY_INVALID')
    let count=0;const chunks=[];for await(const chunk of request){count+=Buffer.byteLength(chunk);if(count>65536)throw Error('LIVE2D_BODY_INVALID');chunks.push(Buffer.from(chunk))}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||Object.keys(input).some(k=>!['config','expectedRevision'].includes(k)))throw Error('LIVE2D_BODY_INVALID')
    return send(200,{ok:true,...store.save(input.config,input.expectedRevision),models:Object.keys(MODELS),phraseCatalog:DEFAULT_PHRASES,csrfToken:token})
   }
   if(request.method!=='GET')return send(405,{ok:false,error:'METHOD_REJECTED'})
   if(path===API+'/events'){
    const sessionId=url.searchParams.get('sessionId');if(!sessionId||sessionId.length>200||!/^[-a-zA-Z0-9_:.]+$/u.test(sessionId))throw Error('LIVE2D_SESSION_INVALID')
    if(clients.size>=16)return send(429,{ok:false,error:'LIVE2D_CLIENT_LIMIT'})
    response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.write('data: '+JSON.stringify({phase:states.get(sessionId)??'idle'})+'\n\n')
    const client={sessionId,response,cleanup:null};clients.add(client);const heartbeat=setInterval(()=>{try{response.write(': keepalive\n\n')}catch{cleanup()}},25000);heartbeat.unref?.();function cleanup(){clearInterval(heartbeat);clients.delete(client)}client.cleanup=cleanup;response.on('close',cleanup);request.on('aborted',cleanup);return
   }
   if(!path.startsWith(API+'/assets/'))return send(404,{ok:false,error:'NOT_FOUND'})
   const rel=decodeURIComponent(path.slice((API+'/assets/').length));if(!rel||rel.includes('\\')||rel.includes(':')||rel.split('/').some(p=>!p||p==='.'||p==='..')||!['model','vendor'].includes(rel.split('/')[0]))return send(404,{ok:false,error:'NOT_FOUND'})
   const root=await realpath(assets),file=resolve(root,rel);if(!file.startsWith(root+sep))return send(404,{ok:false,error:'NOT_FOUND'})
   const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>25*1024*1024||await realpath(file)!==file)return send(404,{ok:false,error:'NOT_FOUND'})
   const contentType=MIME[extname(file)];if(!contentType)return send(404,{ok:false,error:'NOT_FOUND'})
   const bytes=await readFile(file);response.writeHead(200,{'content-type':contentType,'content-length':String(bytes.length),'cache-control':'no-cache','x-content-type-options':'nosniff'});response.end(bytes)
  }catch(error){if(response.headersSent){response.end();return}const code=/^LIVE2D_[A-Z_]+$/u.test(error.message)?error.message:'LIVE2D_UNAVAILABLE';send(code==='LIVE2D_CONFIG_STALE'?409:400,{ok:false,error:code})}
 }
 function dispose(){closed=true;for(const client of clients){client.cleanup?.();try{client.response.end()}catch{}}clients.clear();states.clear()}
 return{handler,publish,dispose}
}
export function apply(ctx){
 const controller=createController(ctx,createConfigStore(join(ctx.dshHomePath('live2d-companion'),'settings.json')))
 ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:API,handler:controller.handler}))
 ctx.on('session/event',controller.publish,{global:true})
 ctx.effect(()=>()=>controller.dispose())
}
