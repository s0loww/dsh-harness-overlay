import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat,realpath,readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises'
import {resolve,relative,isAbsolute,dirname,join,sep} from 'node:path'

export class DeploymentError extends Error {constructor(code,details={}){super(code);this.code=code;Object.assign(this,details)}}
export const fail=(code,details)=>{throw new DeploymentError(code,details)}
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export const canonical=value=>JSON.stringify(value,(_key,row)=>plain(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row)
export const pathKey=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value)
export const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
export function absolute(value,label='DEPLOY_PATH_REQUIRED'){
 if(typeof value!=='string'||!isAbsolute(value)||/[\x00-\x1f\x7f]/u.test(value)||resolve(value)===resolve(value,sep))fail(label)
 return resolve(value)
}
export function safeRelative(root,value){
 if(typeof value!=='string'||!value||value.length>2048||value.includes('\\')||/[<>:"|?*\x00-\x1f\x7f]/u.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/u.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p)))fail('DEPLOY_RELATIVE_PATH_INVALID')
 const target=resolve(root,...value.split('/')),rel=relative(resolve(root),target)
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('DEPLOY_RELATIVE_PATH_INVALID')
 return target
}
export function below(root,path){const rel=relative(resolve(root),resolve(path));return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)}
export async function guard(path,{allowMissing=true}={}){
 const target=resolve(path),chain=[];let at=target
 while(true){chain.unshift(at);const parent=dirname(at);if(parent===at)break;at=parent}
 for(const current of chain)try{const info=await lstat(current);if(info.isSymbolicLink()||pathKey(await realpath(current))!==pathKey(current)||info.isFile()&&info.nlink!==1)fail('DEPLOY_LINK_REJECTED');if(current!==target&&!info.isDirectory())fail('DEPLOY_PATH_INVALID')}
 catch(error){if(error.code==='ENOENT'&&allowMissing)return;throw error}
}
export async function kind(path){await guard(path);try{const s=await lstat(path);return s.isFile()?'file':s.isDirectory()?'directory':'other'}catch(e){if(e.code==='ENOENT')return'missing';throw e}}
export async function hashFile(path){await guard(path,{allowMissing:false});const info=await lstat(path);if(!info.isFile())fail('DEPLOY_FILE_REQUIRED');const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);await guard(path,{allowMissing:false});const after=await lstat(path);if(after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs)fail('DEPLOY_FILE_CHANGED');return{bytes:info.size,sha256:hash.digest('hex')}}
export async function state(path){const type=await kind(path);if(type==='missing')return{type};if(type!=='file')return{type};return{type,...await hashFile(path)}}
export const same=(a,b)=>canonical(a)===canonical(b)
export async function json(path,{missing=null,maxBytes=16*1024*1024}={}){await guard(path);try{const info=await lstat(path);if(!info.isFile()||info.size>maxBytes)fail('DEPLOY_JSON_INVALID');const bytes=await readFile(path);if(bytes.length>maxBytes)fail('DEPLOY_JSON_INVALID');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,''));if(!plain(value))fail('DEPLOY_JSON_INVALID');return value}catch(error){if(error.code==='ENOENT')return missing;if(error instanceof SyntaxError)fail('DEPLOY_JSON_INVALID');throw error}}
export async function writeAtomic(path,bytes,{expected}={}){
 await guard(path);await mkdir(dirname(path),{recursive:true});await guard(path)
 const temp=path+'.'+randomUUID()+'.tmp'
 try{if(expected&&!same(await state(path),expected))fail('DEPLOY_TARGET_CHANGED');await writeFile(temp,bytes,{flag:'wx',mode:0o600});await guard(path);if(expected&&!same(await state(path),expected))fail('DEPLOY_TARGET_CHANGED');await rename(temp,path)}finally{await unlink(temp).catch(()=>{})}
}
export async function writeJson(path,value,options){return writeAtomic(path,Buffer.from(JSON.stringify(value,null,2)+'\n'),options)}
export function seal(value){const record={...value};delete record.integritySha256;return{...record,integritySha256:sha(canonical(record))}}
export function validSeal(value){return plain(value)&&/^[a-f0-9]{64}$/u.test(value.integritySha256??'')&&seal(value).integritySha256===value.integritySha256}
export const boundedCode=error=>/^[A-Z][A-Z0-9_]{2,100}$/u.test(error?.code??error?.message??'')?(error.code??error.message):'DEPLOY_OPERATION_FAILED'
