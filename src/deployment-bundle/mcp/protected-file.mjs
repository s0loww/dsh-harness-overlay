import {randomUUID} from 'node:crypto'
import {openSync,closeSync,writeFileSync,fsyncSync,renameSync,existsSync,unlinkSync} from 'node:fs'
import {dirname,basename,join} from 'node:path'
import {execFileSync} from 'node:child_process'

/** Installer-owned atomic file. Restrict the empty temporary file before secrets. */
export function writeProtectedFile(path,text){
 const temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');let fd
 try{
  fd=openSync(temporary,'wx',0o600)
  if(process.platform==='win32'){
   const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/u)?.[0]
   if(!sid)throw Error('DEPLOY_MCP_PRIVATE_ACL_FAILED')
   try{execFileSync('icacls.exe',[temporary,'/inheritance:r','/grant:r',`*${sid}:(F)`,'*S-1-5-18:(F)'],{stdio:'ignore',windowsHide:true})}catch{throw Error('DEPLOY_MCP_PRIVATE_ACL_FAILED')}
  }
  writeFileSync(fd,text,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path)
 }finally{if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary)}
}
