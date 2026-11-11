import {createHash,randomUUID} from 'node:crypto'
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,resolve} from 'node:path'
import {DEFAULT_SOURCES,normalizeSource} from './source.js'
export const DEFAULTS=Object.freeze({schemaVersion:1,airules:{...DEFAULT_SOURCES.airules,localPath:''},harness:{...DEFAULT_SOURCES.harness,engineRoot:'',installRoot:'',profileRoot:'',previousReceiptPath:'',localReleaseRoot:''},python:'python',node:'node'})
const fail=code=>{throw Error(code)},plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
export function validateSettings(value){
 if(!plain(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULTS,k))||value.schemaVersion!==1)fail('MAINTENANCE_SETTINGS_INVALID')
 const result=structuredClone(DEFAULTS)
 for(const name of ['airules','harness']){if(!plain(value[name])||Object.keys(value[name]).some(k=>!Object.hasOwn(DEFAULTS[name],k)))fail('MAINTENANCE_SETTINGS_INVALID');result[name]={...result[name],...value[name]};normalizeSource({kind:name,repository:result[name].repository,ref:result[name].ref})}
 for(const [object,keys] of [[result.airules,['localPath']],[result.harness,['engineRoot','installRoot','profileRoot','previousReceiptPath','localReleaseRoot']]])for(const k of keys){const path=object[k];if(typeof path!=='string'||path.length>2048||/[\u0000-\u001f]/u.test(path)||path&&!isAbsolute(path))fail('MAINTENANCE_SETTINGS_PATH_INVALID');if(path)object[k]=resolve(path)}
 for(const key of ['python','node']){const command=value[key]??DEFAULTS[key];if(typeof command!=='string'||command.length>2048||/[\u0000-\u001f]/u.test(command)||command!==key&&!isAbsolute(command)||/\.(?:bat|cmd)$/iu.test(command))fail('MAINTENANCE_EXECUTABLE_INVALID');result[key]=command}
 return result
}
export function createSettingsStore(path){
 let busy=false;const hash=value=>createHash('sha256').update(value).digest('hex')
 async function guard(){for(const [target,directory]of [[dirname(path),true],[path,false]])try{const info=await lstat(target);if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()||info.nlink!==1||info.size>16384))fail('MAINTENANCE_SETTINGS_PATH_INVALID')}catch(error){if(error.code!=='ENOENT')throw error}}
 async function read(){await guard();try{const bytes=await readFile(path);if(bytes.length>16384)fail('MAINTENANCE_SETTINGS_INVALID');return{settings:validateSettings(JSON.parse(bytes.toString('utf8'))),revision:hash(bytes)}}catch(error){if(error.code==='ENOENT')return{settings:structuredClone(DEFAULTS),revision:'missing'};throw error}}
 return{read,async save(value,revision,verify=async()=>{}){const settings=validateSettings(value),bytes=Buffer.from(JSON.stringify(settings,null,2)+'\n');if(bytes.length>16384)fail('MAINTENANCE_SETTINGS_INVALID');if(busy)fail('MAINTENANCE_SETTINGS_BUSY');busy=true;const temp=path+'.'+randomUUID()+'.tmp';try{await verify();await guard();await mkdir(dirname(path),{recursive:true});await guard();if((await read()).revision!==revision)fail('MAINTENANCE_SETTINGS_STALE');await writeFile(temp,bytes,{flag:'wx',mode:0o600});await verify();if((await read()).revision!==revision)fail('MAINTENANCE_SETTINGS_STALE');await guard();await rename(temp,path);return read()}finally{busy=false;await unlink(temp).catch(()=>{})}}}
}
