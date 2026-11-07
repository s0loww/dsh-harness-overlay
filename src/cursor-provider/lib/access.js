import { PROVIDER } from './catalog.js'
import { fail } from './runtime.js'
const optional=(ctx,name)=>{try{return ctx?.get?.(name)??ctx?.[name]}catch{return undefined}}
export function externalAllowed(ctx,agent){
  if(!agent?.session||optional(ctx,'agents')?.get?.(agent.session.id)!==agent)return false
  const plan=optional(ctx,'agentPresets')?.serviceFor?.(agent,'planMode')??optional(agent.ctx,'planMode')??optional(ctx,'planMode')
  const state=plan?.get?.(agent)
  if((state?.pending??state?.active)!==false)return false
  const sandbox=optional(agent.ctx,'sandboxPolicy')??optional(ctx,'sandboxPolicy')
  return sandbox?.resolve?.({session:agent.session})?.mode==='danger-full-access'
}
export function installAccess(ctx,isAgentLoopRequest){
  const requests=new WeakMap(),approved=new WeakMap()
  ctx.on('agent/request',async({agent,signal},next)=>{const request=await next();if(request?.provider===PROVIDER){if(!externalAllowed(ctx,agent)||!signal)fail('CURSOR_NATIVE_BUILD_ACCESS_REQUIRED');requests.set(signal,{agent,model:request.model,sessionId:agent.session.id})}return request},{prepend:true})
  ctx.on('llm/stream',(options,next)=>{
    if(options.provider!==PROVIDER)return next()
    const grant=options.signal&&requests.get(options.signal)
    if(!isAgentLoopRequest(options)||!grant||grant.model!==options.model||grant.sessionId!==options.sessionId||!externalAllowed(ctx,grant.agent))fail('CURSOR_AGENT_LOOP_REQUIRED')
    approved.set(options.signal,grant);return next()
  },{prepend:true})
  return options=>{const grant=options.signal&&approved.get(options.signal);if(!grant||grant.active||grant.model!==options.model||grant.sessionId!==options.sessionId||!externalAllowed(ctx,grant.agent))fail('CURSOR_NATIVE_BUILD_ACCESS_REQUIRED');grant.active=true;return()=>{grant.active=false;approved.delete(options.signal)}}
}
