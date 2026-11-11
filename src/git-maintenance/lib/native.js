import {randomUUID} from 'node:crypto'
import {resolve,isAbsolute} from 'node:path'
const fail=code=>{throw Error(code)}
export function createNativeMaintenance(ctx,{scrubbedParentEnv}={}){
 const controllers=new Set()
 async function scope(input,{writing=false,full=false,active=false}={}){
  if(!ctx.airulesProjects)fail('MAINTENANCE_PROJECT_SERVICE_REQUIRED')
  if(typeof input?.projectId!=='string'||!input.projectId||!input.sessionId)fail('PROJECT_EXECUTOR_PIN_REQUIRED')
  return ctx.airulesProjects.resolveInput(input,{writing,full,active,presets:['1c-airules','python-airules','sysadmin-airules']})
 }
 async function verifyScope(value,{writing=false,signal}={}){
  signal?.throwIfAborted();const fresh=await scope({projectId:value.projectId,sessionId:value.sessionId},{writing})
  if(fresh.agent!==value.agent||resolve(fresh.root)!==resolve(value.root)||JSON.stringify(fresh.policy)!==JSON.stringify(value.policy)||fresh.preset!==value.preset)fail('MAINTENANCE_SCOPE_CHANGED')
  return fresh
 }
 async function execution(input,reason,{uiInitiated=false}={}){
  const selected=await scope(input,{writing:true,full:true,active:true}),controller=new AbortController(),id='maintenance-'+randomUUID();controllers.add(controller)
  const result={scope:selected,agent:selected.agent,callId:id,signal:controller.signal,verify:()=>verifyScope(selected,{writing:true,signal:controller.signal}),dispose(){controllers.delete(controller);controller.abort()}}
  try{if(!uiInitiated){const decision=await ctx.approval.request({agent:selected.agent,callId:id,toolName:'airules_git_maintenance',reason,signal:controller.signal});await result.verify();if(decision!=='allowed-once')fail('MAINTENANCE_APPROVAL_REQUIRED')}await result.verify();return result}catch(error){result.dispose();throw error}
 }
 async function run(argv,options={}){
  const execution=options.execution;if(!execution?.scope||typeof execution.verify!=='function')fail('MAINTENANCE_NATIVE_EXECUTION_REQUIRED')
  await execution.verify();if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'||x.includes('\0'))||!isAbsolute(options.cwd))fail('MAINTENANCE_COMMAND_INVALID')
  if(typeof scrubbedParentEnv!=='function')fail('MAINTENANCE_NATIVE_ENV_REQUIRED')
  const env=scrubbedParentEnv();for(const [k,v]of Object.entries(options.env??{})){if(!/^(?:GIT_|GCM_|PYTHON)/u.test(k)||typeof v!=='string'||/[\r\n\0]/u.test(v))fail('MAINTENANCE_ENV_INVALID');env[k]=v}
  env.GIT_TERMINAL_PROMPT='0';env.GCM_INTERACTIVE='Never';env.PYTHONUTF8='1';env.PYTHONDONTWRITEBYTECODE='1';delete env.PYTHONPATH
  const deadline=new AbortController(),timeoutMs=Math.min(300000,Math.max(1000,options.timeoutMs??90000)),timer=setTimeout(()=>deadline.abort(),timeoutMs),signal=AbortSignal.any([execution.signal,deadline.signal,...(options.signal?[options.signal]:[])])
  const limit=Math.min(16*1024*1024,Math.max(4096,options.outputLimit??1024*1024));let handle,overflow=false,size=0;const output=[]
  try{const file=await ctx.subprocess.resolveExecutable(argv[0],env,signal);await execution.verify();let command=[file,...argv.slice(1)];if(execution.scope.policy.mode!=='danger-full-access'){const confined=await ctx.sandbox.confine(command,execution.scope.policy,signal);if(!confined?.argv?.length)fail('MAINTENANCE_CONFINEMENT_REQUIRED');command=confined.argv}await execution.verify()
   handle=ctx.subprocess.spawn({argv:command,cwd:options.cwd,env,signal,graceMs:500,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}})
   handle.stdout.on('data',chunk=>{const data=Buffer.from(chunk);size+=data.length;if(size<=limit)output.push(data);else{overflow=true;void handle.terminate()}});handle.stderr.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>limit){overflow=true;void handle.terminate()}})
   const done=await handle.done,exited=await handle.waitForExit(signal);await execution.verify();signal.throwIfAborted();if(overflow||exited!==true)fail('MAINTENANCE_COMMAND_LIMIT');return{code:done.exitCode,stdout:Buffer.concat(output).toString('utf8'),stderr:''}
  }catch(error){if(handle)try{await handle.terminate();await handle.waitForExit(AbortSignal.timeout(2000))}catch{};throw Error(/^(?:MAINTENANCE_|PROJECT_)[A-Z_]+$/u.test(error.message)?error.message:'MAINTENANCE_COMMAND_FAILED')}finally{clearTimeout(timer)}
 }
 return{scope,verifyScope,execution,run,dispose(){for(const controller of controllers)controller.abort();controllers.clear()}}
}
