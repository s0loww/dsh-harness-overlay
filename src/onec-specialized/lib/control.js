import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateSpecializedBinding } from './core.mjs'
import { bundledRunnerTemplate } from './bridge.mjs'
export const CONTROL_API='/airules/onec-specialized'
const bindingPath='.dsh/onec-specialized.json'
function scope(ctx,id,writing=false){
  const agent=ctx.agents.get(id),session=agent?.session
  if(!session||ctx.agentPresets.composedPreset(agent.ctx)!=='1c-airules')throw new Error('SPECIALIZED_OPEN_ONEC_SESSION_REQUIRED')
  const policy=ctx.sandboxPolicy.resolve({session})
  if(!['read-only','workspace-write','danger-full-access'].includes(policy.mode)||resolve(policy.workspaceRoot)!==resolve(session.header.cwd))throw new Error('SPECIALIZED_SCOPE_REQUIRED')
  if(writing&&policy.mode==='read-only')throw new Error('SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
  return {agent,root:resolve(session.header.cwd),policy}
}
async function checkedBinding(ctx,current){
  if(await realpath(current.root)!==current.root)throw new Error('SPECIALIZED_LINK_REFUSED')
  for(const path of [join(current.root,'.dsh'),join(current.root,bindingPath)]){
    try{const info=await lstat(path);if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)throw new Error('SPECIALIZED_LINK_REFUSED')}catch(error){if(error.code!=='ENOENT')throw error}
  }
  return ctx.fs.resolve(join(current.root,bindingPath))
}
async function runnerTarget(ctx,current,template){
  if(await realpath(current.root)!==current.root)throw new Error('SPECIALIZED_LINK_REFUSED')
  let at=current.root
  for(const part of template.path.split('/')){
    at=join(at,part)
    try{const info=await lstat(at);if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)throw new Error('SPECIALIZED_LINK_REFUSED')}catch(error){if(error.code!=='ENOENT')throw error}
  }
  return ctx.fs.resolve(at)
}
export async function bindingView(ctx,current){
  const target=await checkedBinding(ctx,current),before=await ctx.fs.stat(target)
  if(!before)return {version:null,text:'{\n  "schemaVersion": 1\n}\n',exists:false}
  if(before.type!=='file'||before.size>65536)throw new Error('SPECIALIZED_BINDING_LIMIT')
  const bytes=await ctx.fs.readBytes(target,undefined,65536),after=await ctx.fs.stat(target)
  if(before.version!==after?.version)throw new Error('SPECIALIZED_BINDING_STALE')
  return {version:after.version,text:Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,''),exists:true,bom:bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf,crlf:Buffer.from(bytes).includes(Buffer.from('\r\n'))}
}
async function inputOf(request){let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>98304)throw new Error('SPECIALIZED_BODY_LIMIT')}return JSON.parse(text||'{}')}
export function specializedHandler(ctx,{createUserMessage}){
  const csrf=randomUUID()
  return async(request,response)=>{
    const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value))}
    try{
      if(!ctx.connection||ctx.connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
      if(!['GET','POST'].includes(request.method))return send(405,{ok:false,error:'METHOD_NOT_ALLOWED'})
      const input=request.method==='GET'?Object.fromEntries(new URL(request.url,'http://localhost').searchParams):await inputOf(request)
      if(request.method==='POST'&&request.headers?.['x-airules-csrf']!==csrf)return send(403,{ok:false,error:'CSRF_REQUIRED'})
      if(request.method==='GET'&&input.action!==undefined&&input.action!=='status')return send(405,{ok:false,error:'SPECIALIZED_POST_REQUIRED'})
      const current=scope(ctx,input.sessionId,['save-binding','install-runner'].includes(input.action)),execution={agent:current.agent,callId:`specialized-ui-${randomUUID()}`,signal:new AbortController().signal}
      await request[Symbol.for('airules.project-request')]?.assertScope({...current,id:input.sessionId})
      if(input.action==='install-runner'){
        const template=await bundledRunnerTemplate(),target=await runnerTarget(ctx,current,template),old=await ctx.fs.stat(target)
        if((old?.version??null)!==input.expectedVersion)throw new Error('SPECIALIZED_BINDING_STALE')
        if(old&&(old.type!=='file'||old.size>1024*1024))throw new Error('SPECIALIZED_RUNNER_FILE_REJECTED')
        await request[Symbol.for('airules.project-request')]?.verify()
        await ctx.fs.writeText(target,template.source,old?{kind:'replaceIfVersion',version:old.version}:{kind:'createIfAbsent'},execution.signal,current.policy)
      }
      if(input.action==='save-binding'){
        if(typeof input.text!=='string'||Buffer.byteLength(input.text)>65536)throw new Error('SPECIALIZED_BINDING_LIMIT')
        const config=JSON.parse(input.text.replace(/^\uFEFF/,''));validateSpecializedBinding(config)
        const old=await bindingView(ctx,current);if(old.version!==input.expectedVersion)throw new Error('SPECIALIZED_BINDING_STALE')
        const newline=old.crlf?'\r\n':'\n',content=(old.bom?'\uFEFF':'')+JSON.stringify(config,null,2).replace(/\n/g,newline)+newline
        await request[Symbol.for('airules.project-request')]?.verify()
        await ctx.fs.writeText(await checkedBinding(ctx,current),content,old.exists?{kind:'replaceIfVersion',version:old.version}:{kind:'createIfAbsent'},execution.signal,current.policy)
      }
      if(input.action==='run-in-chat'){
        if(current.agent.status!=='idle')throw new Error('SPECIALIZED_CHAT_BUSY')
        if(!/^[a-f0-9]{64}$/.test(input.planDigest??''))throw new Error('SPECIALIZED_PLAN_REQUIRED')
        await ctx.airulesOnecSpecialized.act({action:'validatePlan',planDigest:input.planDigest},execution)
        const requestId=randomUUID()
        current.agent.followup(createUserMessage({content:[{type:'text',text:`Выполни согласованный сохранённый план через airules_onec_specialized: ${JSON.stringify({action:'run',planDigest:input.planDigest,requestId})}. Сохрани native approvals и права. Получи связанный результат и сообщи фактический исход; иные планы и реальный деплой не запускай.`}],source:{kind:'user'}}))
        return send(200,{ok:true,submitted:true,requestId})
      }
      let result
      if(['plan','history','diff','result','cancel'].includes(input.action)){
        if(request.method!=='POST')throw new Error('SPECIALIZED_POST_REQUIRED')
        const {sessionId,expectedVersion,text,csrfToken,...args}=input
        result=await ctx.airulesOnecSpecialized.act(args,execution)
      }
      let status
      try{status=await ctx.airulesOnecSpecialized.act({action:'status'},execution)}
      catch(error){status={domains:[],activeRuns:[],inspectionError:/^[A-Z0-9_]+$/.test(error.code??error.message??'')?error.code??error.message:'SPECIALIZED_CONFIGURATION_UNAVAILABLE'}}
      const template=await bundledRunnerTemplate(),runnerInfo=await ctx.fs.stat(await runnerTarget(ctx,current,template))
      return send(200,{ok:true,csrfToken:csrf,status,binding:await bindingView(ctx,current),machine:ctx.airulesOnecSpecialized.machineConfigView,runnerTemplate:{path:template.path,driverConfigPath:template.driverConfigPath,sha256:template.sha256,version:runnerInfo?.version??null,exists:!!runnerInfo},workspace:{writable:current.policy.mode!=='read-only',mode:current.policy.mode},...(result===undefined?{}:{result})})
    }catch(error){return send(error.code==='FS_STALE_VERSION'||error.message==='SPECIALIZED_BINDING_STALE'?409:400,{ok:false,error:/^[A-Z0-9_]+$/.test(error.code??error.message??'')?error.code??error.message:'SPECIALIZED_UI_UNAVAILABLE'})}
  }
}
