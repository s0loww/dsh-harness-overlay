import { createHash,randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, lstat, realpath, rename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export const DRIVERS=Object.freeze([
  Object.freeze({id:'google',profile:'airules-google',name:'Google Gemini · Antigravity ACP'}),
  Object.freeze({id:'muse',profile:'airules-muse',name:'Meta Muse · ACP'}),
])
const forbidden=new Set(['cmd','cmd.exe','powershell','powershell.exe','pwsh','pwsh.exe','bash','bash.exe','sh','sh.exe','npx','npx.cmd','npm','npm.cmd','pnpm','pnpm.cmd'])
export function driverOf(id){const spec=DRIVERS.find(row=>row.id===id);if(!spec)throw new Error('DRIVER_REJECTED');return spec}
export function validateDriver(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['command','sha256','args'].includes(k)))throw new Error('DRIVER_CONFIG_INVALID')
  if(typeof value.command!=='string'||!isAbsolute(value.command)||/[\u0000-\u001f\u007f]/u.test(value.command)||forbidden.has(basename(value.command).toLowerCase()))throw new Error('DRIVER_EXECUTABLE_REQUIRED')
  if(typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256))throw new Error('DRIVER_DIGEST_REQUIRED')
  if(!Array.isArray(value.args)||value.args.length>24||value.args.some(arg=>typeof arg!=='string'||arg.length>1024||/[\u0000-\u001f\u007f]/u.test(arg)))throw new Error('DRIVER_ARGUMENTS_INVALID')
  return {command:resolve(value.command),sha256:value.sha256,args:[...value.args]}
}
export async function verifyDriver(value){
  const config=validateDriver(value), info=await lstat(config.command)
  const canonical=path=>process.platform==='win32'?path.toLowerCase():path
  if(!info.isFile()||info.isSymbolicLink()||canonical(resolve(await realpath(config.command)))!==canonical(config.command))throw new Error('DRIVER_EXECUTABLE_REJECTED')
  const hash=createHash('sha256');for await(const chunk of createReadStream(config.command))hash.update(chunk)
  if(hash.digest('hex')!==config.sha256)throw new Error('DRIVER_DIGEST_MISMATCH')
  return config
}
export function isolatedEnvironment(directory,id,source=process.env){
  driverOf(id);if(!isAbsolute(directory))throw new Error('DRIVER_HOME_REQUIRED')
  const inherited=Object.fromEntries(Object.entries(source).filter(([key])=>/^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|LANG|LC_.*)$/iu.test(key)))
  const home=join(directory,'home')
  return {...inherited,HOME:home,USERPROFILE:home,HOMEDRIVE:parse(home).root.slice(0,2),HOMEPATH:home.slice(2),
    XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data'),XDG_CACHE_HOME:join(directory,'cache'),XDG_STATE_HOME:join(directory,'state'),
    APPDATA:join(directory,'appdata'),LOCALAPPDATA:join(directory,'localappdata'),TEMP:join(directory,'temp'),TMP:join(directory,'temp'),
    ...(id==='google'?{GEMINI_HOME:directory,AGY_ACP_FORCE_FILE_STORAGE:'1'}:{MUSE_EXPERIMENTAL_ACP:'on',MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',NO_COLOR:'1'})}
}
export async function prepareEnvironment(directory,id){
  const env=isolatedEnvironment(directory,id)
  await mkdir(directory,{recursive:true,mode:0o700})
  if((await lstat(directory)).isSymbolicLink())throw new Error('DRIVER_HOME_REJECTED')
  if(process.platform==='win32'){
    const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/u)?.[0]
    if(!sid)throw new Error('DRIVER_LOCAL_ACL_FAILED')
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)(F)`,'*S-1-5-18:(OI)(CI)(F)'],{stdio:'ignore',windowsHide:true})
  }
  for(const key of ['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA','TEMP'])await mkdir(env[key],{recursive:true,mode:0o700})
  return env
}
export function generationArgs(id,config){return driverOf(id).id==='muse'?['acp','--provider','meta','--no-session-log','--disable-write','--disable-shell']:config.args}
/** Local disconnect only: retain a protected backup; never guess a vendor logout RPC. */
export async function detachMuseHome(home){
  if(!isAbsolute(home))throw new Error('DRIVER_HOME_REQUIRED')
  const directory=join(home,'muse')
  try {
    const info=await lstat(directory)
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('DRIVER_HOME_REJECTED')
    const canonical=path=>process.platform==='win32'?path.toLowerCase():path
    if(canonical(dirname(await realpath(directory)))!==canonical(await realpath(home)))throw new Error('DRIVER_HOME_REJECTED')
    await rename(directory,join(home,`muse-disconnected-${randomUUID()}`))
  } catch(error){if(error.code!=='ENOENT')throw error}
}
export function makeProfile(id,{node,launcher,manifest}){
  const spec=driverOf(id)
  return {name:spec.name,command:node,args:[launcher,'--manifest',manifest],env:{ELECTRON_RUN_AS_NODE:'1'},loginHint:'Выполните отдельный вход в карточке провайдера DSH'}
}

/** One installed ACP registry owns all routes; preserve unrelated user profiles. */
export async function publishProfile(editor,spec,profile){
  const entries=editor.entries().filter(entry=>entry.options.name==='@zaimokuza/dsh-acp-adapter')
  if(entries.length!==1)throw new Error('DRIVER_ACP_REGISTRY_REQUIRED')
  await editor.edit(entries[0],current=>{
    const agents={...(current.agents??{})}
    if(profile)agents[spec.profile]=profile;else delete agents[spec.profile]
    return {...current,agents,toolApprovalDefault:current.toolApprovalDefault??'ask'}
  })
}
