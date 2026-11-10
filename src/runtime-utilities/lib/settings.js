import {createHash,randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdir,rename,lstat,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
export const DEFAULT_SETTINGS=Object.freeze({schemaVersion:1,keepAwake:false,vision:{enabled:false,provider:'',model:'',maxTokens:1200}})
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
export const fail=code=>{throw new Error(code)}
export function validateSettings(value){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='keepAwake,schemaVersion,vision'||value.schemaVersion!==1||typeof value.keepAwake!=='boolean')fail('UTILITIES_CONFIG_INVALID')
 const v=value.vision
 if(!v||Object.keys(v).sort().join(',')!=='enabled,maxTokens,model,provider'||typeof v.enabled!=='boolean'||!Number.isInteger(v.maxTokens)||v.maxTokens<64||v.maxTokens>2000)fail('UTILITIES_CONFIG_INVALID')
 for(const id of[v.provider,v.model])if(typeof id!=='string'||id.length>240||/[\r\n\0]/u.test(id))fail('UTILITIES_CONFIG_INVALID')
 if(v.enabled&&(!v.provider||!v.model))fail('VISION_MODEL_REQUIRED')
 return{schemaVersion:1,keepAwake:value.keepAwake,vision:{enabled:v.enabled,provider:v.provider,model:v.model,maxTokens:v.maxTokens}}
}
export function createSettingsStore(path){
 let busy=false
 const read=async()=>{try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8192)fail('UTILITIES_CONFIG_INVALID');const bytes=await readFile(path);return{config:validateSettings(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''))),revision:digest(bytes)}}catch(error){if(error.code==='ENOENT')return{config:structuredClone(DEFAULT_SETTINGS),revision:'missing'};throw error}}
 return{read,async save(config,expectedRevision,validate){if(busy)fail('UTILITIES_CONFIG_BUSY');busy=true;const temp=path+'.'+randomUUID()+'.tmp';try{config=validateSettings(config);if((await read()).revision!==expectedRevision)fail('UTILITIES_CONFIG_STALE');await validate?.(config);if((await read()).revision!==expectedRevision)fail('UTILITIES_CONFIG_STALE');await mkdir(dirname(path),{recursive:true});await writeFile(temp,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});if((await read()).revision!==expectedRevision)fail('UTILITIES_CONFIG_STALE');await rename(temp,path);return await read()}finally{busy=false;await rm(temp,{force:true})}}}
}
