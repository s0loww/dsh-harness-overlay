import {credentialKey}from'@deepseek-ai/dsh-credentials'
import {LlmAdapter,LlmError,isAgentLoopRequest,resolveRetryPolicy}from'@deepseek-ai/dsh-llm'
import {join}from'node:path'
import {createController}from'./controller.js'
import {createAdapter}from'./adapter.js'
import {installAccess}from'./access.js'
import {createHandler,CONTROL_PATH}from'./control.js'
import {PROVIDER}from'./catalog.js'
export const name='airules-cursor-provider'
export const inject=['llm','credentials','dshHomePath','agents','agentPresets','sandboxPolicy']
export function apply(ctx){
  const root=ctx.dshHomePath('airules-cursor-provider');let registration
  const controller=createController({credentials:ctx.credentials,key:credentialKey(name,'subscription'),configPath:join(root,'runtime.json'),changed:()=>registration?.replace([PROVIDER])})
  const authorize=installAccess(ctx,isAgentLoopRequest)
  const adapter=createAdapter({Base:LlmAdapter,LlmError,controller,authorize,runsRoot:join(root,'runs'),retryPolicy:resolveRetryPolicy({mode:'normal',maxRetries:0},'Cursor retryPolicy')})
  ctx.effect(()=>{registration=ctx.llm.registerAdapter([PROVIDER],adapter);return()=>{controller.close();registration();registration=undefined}})
  ctx.inject(['webServer','connection'],ready=>ready.effect(()=>ready.webServer.register({kind:'exact',path:CONTROL_PATH,handler:createHandler(controller,{connection:ready.connection})})))
}
