import { readFile, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyDriver, prepareEnvironment, generationArgs, driverOf } from './runtime.js'

// Wrapper is launched by the ordinary native ACP transport. No subprocess at import.
export async function launch(manifestPath){
  if(!isAbsolute(manifestPath??''))throw new Error('DRIVER_MANIFEST_REQUIRED')
  const info=await lstat(manifestPath)
  if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('DRIVER_MANIFEST_INVALID')
  const value=JSON.parse(await readFile(manifestPath,'utf8'));driverOf(value.id)
  const config=await verifyDriver(value.config), env=await prepareEnvironment(join(dirname(manifestPath),value.id),value.id)
  const child=spawn(config.command,generationArgs(value.id,config),{cwd:process.cwd(),env,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false})
  process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.on('data',()=>{})
  child.stdin.on('error',()=>{});child.once('error',()=>{process.exitCode=1;process.stdin.destroy()})
  const stop=()=>child.kill();process.once('SIGINT',stop);process.once('SIGTERM',stop)
  child.once('exit',code=>{process.exitCode=code??1;process.stdin.destroy();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)})
  return child
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  launch(process.argv[process.argv.indexOf('--manifest')+1]).catch(()=>{process.stderr.write('DSH provider runtime could not start. Verify its configured executable and digest.\n');process.exitCode=1})
}
