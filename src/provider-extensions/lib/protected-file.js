import { randomUUID } from 'node:crypto'
import { openSync,writeFileSync,fsyncSync,closeSync,renameSync,existsSync,unlinkSync } from 'node:fs'
import { join,dirname,basename } from 'node:path'
import { execFileSync } from 'node:child_process'
export function writeProtectedFile(path,value){
  const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);let fd
  try {
    fd=openSync(temporary,'wx',0o600)
    if(process.platform==='win32'){
      const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/u)?.[0]
      if(!sid)throw new Error('DRIVER_LOCAL_ACL_FAILED')
      execFileSync('icacls.exe',[temporary,'/inheritance:r','/grant:r',`*${sid}:(F)`,'*S-1-5-18:(F)'],{stdio:'ignore',windowsHide:true})
    }
    writeFileSync(fd,JSON.stringify(value)+'\n','utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path)
  } finally {if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary)}
}
