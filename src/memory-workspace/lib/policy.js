import { createHash, randomUUID } from 'node:crypto'
import { writeFile, mkdir, rename, lstat, rm, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute, relative, sep } from 'node:path'
import { validateMemoriaBinding } from './memoria.js'
export const PROJECT_POLICY_PATH = '.dsh/memory.json'
export const DEFAULT_GLOBAL_POLICY = Object.freeze({ schemaVersion: 1, mode: 'cognee', writeTarget: 'auto' })
export const DEFAULT_PROJECT_POLICY = Object.freeze({ schemaVersion: 1, mode: 'inherit', writeTarget: 'inherit' })
const modes=['cognee','memoria','both'], targets=['auto','cognee','memoria','both']
const fail=code=>{throw new Error(code)}
export const policyDigest=value=>createHash('sha256').update(value).digest('hex')
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key))
export function validatePolicy(input,{project=false}={}) {
  if(!keys(input,project?['schemaVersion','mode','writeTarget','memoria']:['schemaVersion','mode','writeTarget'])||input.schemaVersion!==1||![...modes,...(project?['inherit']:[])].includes(input.mode)||![...targets,...(project?['inherit']:[])].includes(input.writeTarget))fail('MEMORY_POLICY_INVALID')
  const policy={schemaVersion:1,mode:input.mode,writeTarget:input.writeTarget}
  if(modes.slice(0,2).includes(policy.mode)&&['cognee','memoria','both'].includes(policy.writeTarget)&&policy.mode!==policy.writeTarget)fail('MEMORY_WRITE_TARGET_DISABLED')
  if(input.memoria!==undefined) policy.memoria=validateMemoriaBinding(input.memoria)
  return policy
}
export function effectivePolicy(global,project=DEFAULT_PROJECT_POLICY){
  global=validatePolicy(global);project=validatePolicy(project,{project:true})
  return {mode:project.mode==='inherit'?global.mode:project.mode,writeTarget:project.writeTarget==='inherit'?global.writeTarget:project.writeTarget,source:project.mode==='inherit'?'global':'project',...(project.memoria?{memoria:project.memoria}:{})}
}
export function selectBackends(policy,{action,backend,kind='fact'}={}){
  const allowed=policy.mode==='both'?['memoria','cognee']:[policy.mode]
  if(backend!==undefined){if(!modes.slice(0,2).includes(backend)||!allowed.includes(backend))fail('MEMORY_BACKEND_DISABLED');if(action==='remember'&&policy.writeTarget!=='auto'&&policy.writeTarget!==backend)fail('MEMORY_WRITE_TARGET_DISABLED');return[backend]}
  if(['documents','graph','process','task'].includes(action)){if(!allowed.includes('cognee'))fail('MEMORY_BACKEND_DISABLED');return['cognee']}
  if(action==='remember'){
    let chosen=policy.writeTarget==='auto'?(allowed.length===1?allowed[0]:kind==='document'?'cognee':'memoria'):policy.writeTarget
    const result=chosen==='both'?['memoria','cognee']:[chosen]
    if(result.some(name=>!allowed.includes(name)))fail('MEMORY_WRITE_TARGET_DISABLED')
    return result
  }
  return allowed
}
/** Profile-owned preferences. No project contents or credentials are accepted. */
export function createGlobalPolicyStore(path,{validate=validatePolicy,verify=()=>{},defaultValue=DEFAULT_GLOBAL_POLICY,anchor}={}){
  let saving=false
  const key=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value)
  async function guard(authority=true){
    const check=authority?verify:()=>{}
    await check()
    if(anchor!==undefined){
      if(!isAbsolute(anchor)||!isAbsolute(path))fail('MEMORY_PROJECT_LINK_REJECTED')
      const rel=relative(resolve(anchor),resolve(path));if(rel!==PROJECT_POLICY_PATH.split('/').join(sep))fail('MEMORY_PROJECT_LINK_REJECTED')
      let at=resolve(anchor)
      for(const part of ['',...rel.split(sep)]){
        if(part)at=join(at,part)
        try{const info=await lstat(at);await check();if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)fail('MEMORY_PROJECT_LINK_REJECTED');if(key(await realpath(at))!==key(at))fail('MEMORY_PROJECT_LINK_REJECTED');await check()}
        catch(error){if(error.code!=='ENOENT'||at===resolve(anchor))throw error}
      }
    }
    await check()
  }
  async function read(){
    await guard()
    let handle
    try {
      const info=await lstat(path);await verify();if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384)fail('MEMORY_POLICY_FILE_INVALID')
      handle=await open(path,'r');await verify();const before=await handle.stat();await verify();if(!before.isFile()||before.nlink!==1||before.size>16384||before.ino!==info.ino||before.dev!==info.dev)fail('MEMORY_POLICY_FILE_INVALID')
      const buffer=Buffer.alloc(16385),{bytesRead}=await handle.read(buffer,0,buffer.length,0);await verify();const after=await handle.stat();await verify()
      if(bytesRead>16384||bytesRead!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('MEMORY_POLICY_STALE')
      const current=await lstat(path);await verify();if(current.isSymbolicLink()||current.nlink!==1||current.ino!==before.ino||current.dev!==before.dev)fail('MEMORY_POLICY_STALE')
      await guard();const bytes=buffer.subarray(0,bytesRead);return{value:validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,''))),revision:policyDigest(bytes)}
    }
    catch(error){if(error.code==='ENOENT'){await guard();return{value:validate({...defaultValue}),revision:'missing'}};throw error}
    finally{await handle?.close()}
  }
  return {read,async save(value,revision){
    value=validate(value);if(saving)fail('MEMORY_POLICY_BUSY');saving=true
    const temporary=path+'.'+randomUUID()+'.tmp',lock=path+'.lock';let locked=false
    try{
      await guard()
      await mkdir(dirname(path),{recursive:true});const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink())fail('MEMORY_POLICY_FILE_INVALID')
      await guard()
      try{await writeFile(lock,'policy-write',{flag:'wx',mode:0o600});locked=true}catch(error){if(error.code==='EEXIST')fail('MEMORY_POLICY_BUSY');throw error}
      if((await read()).revision!==revision)fail('MEMORY_POLICY_STALE')
      await guard()
      await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
      if((await read()).revision!==revision)fail('MEMORY_POLICY_STALE')
      await guard()
      await rename(temporary,path);return await read()
    }finally{saving=false;try{await guard(false);await rm(temporary,{force:true});if(locked)await rm(lock,{force:true})}catch{}}
  }}
}
/** Project policy always goes through the selected native FS and its CAS. */
export function createProjectPolicyStore({fsFor,verifyScope}){
  async function target(scope,signal){
    const fs=fsFor(scope);if(!fs?.resolve||!fs?.processPath||!fs?.lstat)fail('MEMORY_NATIVE_FS_REQUIRED')
    const key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p)
    const root=await fs.resolve(scope.root,{cwd:scope.root,signal});verifyScope(scope,signal)
    if(key(fs.processPath(root))!==key(scope.root))fail('MEMORY_PROJECT_LINK_REJECTED')
    let at=scope.root
    for(const part of PROJECT_POLICY_PATH.split('/')){at=join(at,part);const info=await fs.lstat(at,{cwd:scope.root,signal},signal);verifyScope(scope,signal);if(info?.type==='symlink')fail('MEMORY_PROJECT_LINK_REJECTED')}
    const path=await fs.resolve(join(scope.root,PROJECT_POLICY_PATH),{cwd:scope.root,signal});verifyScope(scope,signal)
    if(key(fs.processPath(path))!==key(join(scope.root,PROJECT_POLICY_PATH)))fail('MEMORY_PROJECT_LINK_REJECTED')
    return{fs,path}
  }
  async function read(scope,signal){
    const {fs,path}=await target(scope,signal),before=await fs.stat(path,signal);verifyScope(scope,signal)
    if(!before)return{value:{...DEFAULT_PROJECT_POLICY},revision:'missing',nativeVersion:null}
    if(before.type!=='file'||before.size>16384||typeof before.version!=='string')fail('MEMORY_PROJECT_POLICY_INVALID')
    const bytes=Buffer.from(await fs.readBytes(path,signal,16385));verifyScope(scope,signal)
    const after=await fs.stat(path,signal);verifyScope(scope,signal)
    if(before.version!==after?.version||bytes.length>16384)fail('MEMORY_POLICY_STALE')
    return{value:validatePolicy(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,'')),{project:true}),revision:policyDigest(bytes),nativeVersion:before.version}
  }
  const locks=new Set()
  return{read,async save(scope,value,revision,signal){
    value=validatePolicy(value,{project:true});if(!scope.writable||scope.agent?.session?.header?.origin==='subagent')fail('MEMORY_WRITE_REQUIRED')
    const key=resolve(scope.root).toLowerCase();if(locks.has(key))fail('MEMORY_POLICY_BUSY');locks.add(key)
    try{const before=await read(scope,signal);if(before.revision!==revision)fail('MEMORY_POLICY_STALE');const{fs,path}=await target(scope,signal);verifyScope(scope,signal)
      await fs.writeText(path,JSON.stringify(value,null,2)+'\n',before.nativeVersion?{kind:'replaceIfVersion',version:before.nativeVersion}:{kind:'createIfAbsent'},signal,scope.policy)
      verifyScope(scope,signal);return await read(scope,signal)
    }finally{locks.delete(key)}
  }}
}
