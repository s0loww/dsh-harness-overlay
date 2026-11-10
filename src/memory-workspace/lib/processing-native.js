import { readFile, lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { validateProcessingBinding, validateProcessingCommand } from './processing-runtime.js'
import { activeScope } from './control.js'
const fail=code=>{throw new Error(code)}
const stamp=scope=>JSON.stringify([scope.root,scope.agent.session.header.origin??'lead',scope.policy])
/** App-owned fixed read probes; mutations additionally require a live full-access lead and native approval. */
export function createNativeProcessing(ctx,{bindingPath,backupRoot,platform=process.platform}={}){
  const approved=new WeakSet(),scopes=new WeakMap()
  function guard(execution){
    if(!execution?.agent||typeof execution.callId!=='string'||typeof execution.token!=='symbol')fail('PROCESSING_NATIVE_EXECUTION_REQUIRED')
    execution.signal?.throwIfAborted()
    const scope=activeScope(ctx,execution.agent.session?.id,{writing:true,global:true,execution})
    const before=scopes.get(execution)
    if(before&&(before.agent!==scope.agent||before.stamp!==stamp(scope)))fail('PROCESSING_SCOPE_CHANGED')
    if(!before)scopes.set(execution,{agent:scope.agent,stamp:stamp(scope)})
    return scope
  }
  async function authorize(execution,summary){
    const scope=guard(execution),decision=await ctx.approval.request({agent:scope.agent,callId:execution.callId,toolName:'airules_memory',reason:`Apply saved Cognee model profile: embeddings ${summary.profile.embeddings.provider}/${summary.profile.embeddings.model}; extraction ${summary.profile.extraction.provider}/${summary.profile.extraction.model}; ${summary.restart?'may restart local memory container':'verify current local runtime'}; ${summary.externalApi?'external model API may process future selected memory content':'local processing'}; no 1C deployment.`,signal:execution.signal})
    guard(execution);if(decision==='allowed-once')approved.add(execution);return decision
  }
  async function runner(spec,execution){
    const mutating=['recreate','protect-private'].includes(spec?.operation)
    if(mutating){guard(execution);if(!approved.has(execution))fail('PROCESSING_NATIVE_APPROVAL_REQUIRED')}
    else if(!['inspect-cache','inspect-server'].includes(spec?.operation))fail('PROCESSING_COMMAND_INVALID')
    else if(execution?.agent)guard(execution)
    const entry=await lstat(bindingPath)
    if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1||entry.size>8192)fail('PROCESSING_BINDING_INVALID')
    const binding=validateProcessingBinding(JSON.parse(await readFile(bindingPath,'utf8')))
    validateProcessingCommand(spec,binding,{backupRoot})
    if(mutating){guard(execution);if(!isAbsolute(spec.cwd)||resolve(spec.cwd)!==resolve(binding.composeDir))fail('PROCESSING_COMMAND_INVALID')}
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),spec.operation==='recreate'?90000:30000)
    const signal=execution?.signal?AbortSignal.any([execution.signal,deadline.signal]):deadline.signal
    let handle
    try{
      const env={...scrubbedParentEnv()};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION'])delete env[key]
      const file=await ctx.subprocess.resolveExecutable(spec.file,env,signal)
      let argv=[file,...(spec.file==='docker'?['--host',platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock']:[]),...spec.args]
      // Match native SandboxBashExecutor: full access runs without the ACL/bwrap
      // wrapper; confined policies require the native confinement provider.
      if(execution?.agent){const scope=guard(execution);if(scope.policy.mode!=='danger-full-access'){const confined=await ctx.sandbox.confine(argv,scope.policy,signal);guard(execution);if(!Array.isArray(confined?.argv)||!confined.argv.length)fail('PROCESSING_NATIVE_CONFINEMENT_REQUIRED');argv=confined.argv}}
      signal.throwIfAborted()
      handle=ctx.subprocess.spawn({argv,cwd:spec.cwd,env,signal,graceMs:500,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}})
      const chunks=[];let bytes=0,overflow=false
      handle.stdout.on('data',chunk=>{const row=Buffer.from(chunk);bytes+=row.length;if(bytes<=256*1024)chunks.push(row);else{overflow=true;void handle.terminate()}})
      handle.stderr.on('data',()=>{})
      const done=await handle.done,stopped=await handle.waitForExit(signal)
      if(execution?.agent)guard(execution)
      if(overflow||stopped!==true||done.exitCode!==0)fail('PROCESSING_NATIVE_COMMAND_FAILED')
      return{code:0,stdout:Buffer.concat(chunks).toString('utf8')}
    }catch(error){if(handle)try{await handle.terminate();await handle.waitForExit(AbortSignal.timeout(1500))}catch{};throw new Error(/^(?:PROCESSING_|MEMORY_)[A-Z_]+$/u.test(error?.message??'')?error.message:'PROCESSING_NATIVE_COMMAND_FAILED')}
    finally{clearTimeout(timer)}
  }
  return{guard,authorize,runner}
}
