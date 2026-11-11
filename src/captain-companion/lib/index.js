import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
export const name='airules-dsh-captain-companion'
export const inject=['webServer','connection','dshHomePath']
export const API='/airules/captain-companion'
export const DEFAULTS=Object.freeze({schemaVersion:1,enabled:true,automatic:true,intervalSeconds:180,bubbleSeconds:12,phrases:{}})
const fail=code=>{throw Error(code)}
const THEMES=new Set(['idle','start','completion','error','approval','tests','context','memory'])
export function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULTS,k))||value.schemaVersion!==1||typeof value.enabled!=='boolean'||typeof value.automatic!=='boolean'||!Number.isInteger(value.intervalSeconds)||value.intervalSeconds<30||value.intervalSeconds>1800||!Number.isInteger(value.bubbleSeconds)||value.bubbleSeconds<5||value.bubbleSeconds>30)fail('CAPTAIN_CONFIG_INVALID')
 const raw=value.phrases??{};if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!THEMES.has(key)))fail('CAPTAIN_CONFIG_INVALID')
 const phrases={};for(const [key,lines] of Object.entries(raw)){if(!Array.isArray(lines)||lines.length>12||lines.some(line=>typeof line!=='string'||line.length>240||/[\r\n\0]/u.test(line)))fail('CAPTAIN_CONFIG_INVALID');const clean=lines.map(line=>line.trim()).filter(Boolean);if(clean.length)phrases[key]=clean}
 const result={schemaVersion:1,enabled:value.enabled,automatic:value.automatic,intervalSeconds:value.intervalSeconds,bubbleSeconds:value.bubbleSeconds,phrases};if(Buffer.byteLength(JSON.stringify(result,null,2)+'\n')>32768)fail('CAPTAIN_CONFIG_INVALID');return result
}
export function createStore(path){
 let busy=false
 async function guard(){for(const p of [dirname(path),path])try{const st=await lstat(p);if(st.isSymbolicLink()||(p===path&&(!st.isFile()||st.nlink!==1||st.size>32768))||(p!==path&&!st.isDirectory()))fail('CAPTAIN_CONFIG_PATH_INVALID')}catch(error){if(error.code!=='ENOENT')throw error}}
 async function read(){await guard();try{const bytes=await readFile(path);if(bytes.length>32768)fail('CAPTAIN_CONFIG_INVALID');return{config:validate(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''))),revision:createHash('sha256').update(bytes).digest('hex')}}catch(error){if(error.code==='ENOENT')return{config:{...DEFAULTS},revision:'missing'};throw error}}
 return{read,async save(value,revision){const config=validate(value);if(busy)fail('CAPTAIN_CONFIG_BUSY');busy=true;const temp=path+'.'+randomUUID()+'.tmp';try{await guard();await mkdir(dirname(path),{recursive:true});await guard();if((await read()).revision!==revision)fail('CAPTAIN_CONFIG_STALE');await writeFile(temp,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});if((await read()).revision!==revision)fail('CAPTAIN_CONFIG_STALE');await guard();await rename(temp,path);return read()}finally{busy=false;await unlink(temp).catch(()=>{})}}}
}
export function createHandler(ctx,store){const token=randomBytes(32).toString('base64url');return async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data))}
 if(ctx.connection.requestRejection(req)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
 try{if(req.method==='GET')return send(200,{ok:true,...await store.read(),csrfToken:token});if(req.method!=='POST')return send(405,{ok:false,error:'CAPTAIN_METHOD_REQUIRED'})
 const a=Buffer.from(String(req.headers['x-airules-csrf']??'')),b=Buffer.from(token);if(a.length!==b.length||!timingSafeEqual(a,b))return send(403,{ok:false,error:'CAPTAIN_CSRF_REQUIRED'})
 if(!String(req.headers['content-type']??'').startsWith('application/json'))fail('CAPTAIN_BODY_INVALID')
 let bytes=0,chunks=[];for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>65536)fail('CAPTAIN_BODY_LIMIT');chunks.push(Buffer.from(chunk))}
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||Object.keys(data).some(k=>!['config','revision'].includes(k)))fail('CAPTAIN_BODY_INVALID')
 return send(200,{ok:true,...await store.save(data.config,data.revision),csrfToken:token})
 }catch(error){const code=/^CAPTAIN_[A-Z_]+$/u.test(error.message)?error.message:'CAPTAIN_UNAVAILABLE';send(code==='CAPTAIN_CONFIG_STALE'?409:400,{ok:false,error:code})}
}}
export function apply(ctx){const store=createStore(join(ctx.dshHomePath('captain-companion'),'config.json'));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:API,handler:createHandler(ctx,store)}))}
