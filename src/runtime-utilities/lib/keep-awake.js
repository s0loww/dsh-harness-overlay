import {join} from 'node:path'
// One temporary, process/thread-owned inhibitor. No display flag or power-plan mutation.
export const INHIBITOR_SCRIPT=`$ErrorActionPreference='Stop'; Add-Type -Namespace AirulesNative -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; $flags=[uint32]'0x80000001'; $release=[uint32]'0x80000000'; $stdin=[Console]::OpenStandardInput(); $buffer=New-Object byte[] 1; $read=$stdin.ReadAsync($buffer,0,1); try { while($true){if([AirulesNative.Power]::SetThreadExecutionState($flags)-eq 0){throw 'INHIBITOR_START_FAILED'};if($read.Wait(15000)){break}} }finally{[AirulesNative.Power]::SetThreadExecutionState($release)|Out-Null}`
export function inhibitorSpec({platform=process.platform,systemRoot=process.env.SystemRoot??'C:/Windows',cwd=process.cwd()}={}){
 const argv=platform==='win32'?[join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-Command',INHIBITOR_SCRIPT]:platform==='darwin'?['/usr/bin/caffeinate','-i']:platform==='linux'?['systemd-inhibit','--what=sleep','--mode=block','--who=DSH','--why=Active DSH task','--','/bin/cat']:null
 if(!argv)throw Error('INHIBITOR_PLATFORM_UNSUPPORTED')
 return{argv,cwd,env:{},stdio:{stdin:'pipe',stdout:'ignore',stderr:'ignore'},graceMs:1000}
}
export function nativeInhibitor(subprocess,options={}){
 if(typeof subprocess?.spawn!=='function')throw Error('INHIBITOR_NATIVE_SUBPROCESS_REQUIRED')
 return async()=>{
  const spec=inhibitorSpec(options),handle=subprocess.spawn(spec)
  if(!handle||!handle.done||typeof handle.terminate!=='function'||typeof handle.waitForExit!=='function')throw Error('INHIBITOR_HANDLE_INVALID')
  let released=false
  return{done:handle.done,async release(){if(released)return;released=true;try{handle.stdin?.end()}catch{};const timer=setTimeout(()=>{Promise.resolve(handle.terminate()).catch(()=>{})},1000);timer.unref?.();try{if(options.platform==='darwin'||process.platform==='darwin')await handle.terminate();await handle.waitForExit()}finally{clearTimeout(timer)}}}
 }
}
export function createKeepAwake({start}){
 let wanted=false,closed=false,current=null,queue=Promise.resolve(),failed=false,state='idle',owners=[]
 function reconcile(){queue=queue.then(async()=>{if((closed||!wanted)&&current){const previous=current;current=null;state='releasing';await previous.release();state='idle'}if(!wanted){failed=false;return}if(closed||current||failed)return;state='starting';try{const lease=await start();if(closed||!wanted){await lease.release();state='idle';return}current=lease;state='active';Promise.resolve(lease.done).then(()=>{if(current===lease){current=null;failed=wanted;state=wanted?'unavailable':'idle'}},()=>{if(current===lease){current=null;failed=wanted;state=wanted?'unavailable':'idle'}})}catch{failed=true;state='unavailable'}}).catch(()=>{failed=true;state='unavailable'});return queue}
 return{update(enabled,activeIds){owners=[...new Set(activeIds)];wanted=enabled&&owners.length>0;return reconcile()},status(){return{state,active:!!current,activeTasks:owners.length,screensMaySleep:true}},async dispose(){closed=true;wanted=false;owners=[];await reconcile()}}
}

