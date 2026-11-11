import {cp,lstat,mkdir,readFile,writeFile,realpath} from 'node:fs/promises'
import {join,dirname,resolve,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {scrubbedParentEnv} from '@deepseek-ai/dsh-subprocess'
const fail=code=>{throw Error(code)}
const key=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value)
async function guard(path,{file=false}={}){let at=resolve(path);const rows=[];while(true){rows.unshift(at);const parent=dirname(at);if(parent===at)break;at=parent}for(const target of rows)try{const info=await lstat(target),last=key(target)===key(path);if(info.isSymbolicLink()||key(await realpath(target))!==key(target)||(last&&file?!info.isFile()||info.nlink!==1:!info.isDirectory()))fail('UPDATE_WORKER_RUNTIME_CHANGED')}catch(error){if(error.code==='ENOENT')return;throw error}}
/** A fixed, approved application updater must outlive its parent. Ordinary Git
 * and Python commands use the native managed runner; only this sealed one-shot
 * worker has a detached lifetime, after a reviewed authenticated GUI action
 * with native full-access authority (or native approval for non-UI callers). */
export async function launchUpdateWorker(ctx,{job,node='node',home,execution}){
 await execution.verify();if(!execution.scope.globalWritable||!execution.scope.active||!/^[a-f0-9]{64}$/u.test(job.sha256))fail('UPDATE_WORKER_AUTHORITY_REQUIRED')
 if(!isAbsolute(home)||!isAbsolute(job.path)||!/^[-a-f0-9]{36}$/u.test(job.transactionId))fail('UPDATE_WORKER_JOB_INVALID')
 const directory=join(home,'worker-runtime',job.sha256);await guard(directory);await mkdir(directory,{recursive:true});await guard(directory)
 const packageFile=join(directory,'package.json'),packageBytes=Buffer.from('{"type":"module"}\n');await guard(packageFile,{file:true});try{if(!(await readFile(packageFile)).equals(packageBytes))fail('UPDATE_WORKER_RUNTIME_CHANGED')}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(packageFile,packageBytes,{flag:'wx',mode:0o600})}
 for(const name of ['updater.js','update-worker.mjs','updater-candidate.js']){const source=fileURLToPath(new URL('./'+name,import.meta.url)),destination=join(directory,name);await guard(destination,{file:true});try{await lstat(destination);if(!(await readFile(source)).equals(await readFile(destination)))fail('UPDATE_WORKER_RUNTIME_CHANGED')}catch(error){if(error.code!=='ENOENT')throw error;await execution.verify();await cp(source,destination,{errorOnExist:true,force:false});await guard(destination,{file:true})}}
 const env=scrubbedParentEnv(),file=await ctx.subprocess.resolveExecutable(node,env,execution.signal);await execution.verify()
 const child=spawn(file,[join(directory,'update-worker.mjs'),'--job',job.path,'--sha256',job.sha256],{cwd:directory,env,windowsHide:true,detached:true,stdio:'ignore'});let failed=false;child.on('error',()=>{failed=true});child.unref()
 const readyPath=join(home,'updates/jobs',job.transactionId+'.ready.json'),deadline=Date.now()+6000
 while(Date.now()<deadline){await execution.verify();if(failed||child.exitCode!==null)fail('UPDATE_WORKER_START_FAILED');try{const data=JSON.parse(await readFile(readyPath,'utf8'));if(data.schemaVersion===1&&data.transactionId===job.transactionId&&data.pid===child.pid)return{started:true}}catch(error){if(error.code!=='ENOENT')throw error}await new Promise(accept=>setTimeout(accept,150))}
 fail('UPDATE_WORKER_NOT_CONFIRMED')
}
