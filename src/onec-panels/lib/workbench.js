import { executeNativeTool } from './native-tools.js'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { projectSession } from './session.js'

export const WORKBENCH_API = '/airules/onec-workbench'
const bounded = (value, max=240) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0,max) : ''
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const idOf = value => bounded(typeof value === 'object' && value ? value.node_id ?? value.id ?? value.key : value)
export function normalizeGraph(response) {
  if (!response || response.isError) throw new Error('GRAPH_RESPONSE_REQUIRED')
  let value=response.structuredContent ?? response
  if (Array.isArray(value.content)) {
    const text=value.content.filter(part=>part.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n')
    if (Buffer.byteLength(text)>1024*1024) throw new Error('GRAPH_RESPONSE_TOO_LARGE')
    value=JSON.parse(text)
  }
  const data=value.data ?? value, graph=data.graph ?? data.subgraph ?? data
  if (!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length>10000||graph.edges.length>50000) throw new Error('GRAPH_SHAPE_REQUIRED')
  const nodes=graph.nodes.slice(0,120).map(node=>({id:idOf(node),label:bounded(node.name??node.label??node.qualified_name??node.properties?.name??idOf(node)),type:bounded(node.type??node.kind,80)}))
  const ids=new Set(nodes.map(node=>node.id)); if (nodes.some(node=>!node.id)||ids.size!==nodes.length) throw new Error('GRAPH_IDENTITIES_REQUIRED')
  const supplied=graph.edges.slice(0,400).map(edge=>({from:idOf(edge.source??edge.source_id??edge.from??edge.from_ref),to:idOf(edge.target??edge.target_id??edge.to??edge.to_ref),label:bounded(edge.type??edge.kind??edge.relationship_type,120)}))
  const edges=supplied.filter(edge=>ids.has(edge.from)&&ids.has(edge.to))
  return {nodes,edges,sourceNodes:graph.nodes.length,sourceEdges:graph.edges.length,
    truncated:graph.nodes.length>120||graph.edges.length>400||edges.length<supplied.length||value.truncated===true||data.truncated===true||value.exhaustive===false||data.exhaustive===false,
    degraded:value.degraded===true||data.degraded===true,cursor:bounded(value.next_cursor??value.cursor??data.next_cursor??data.cursor,500)}
}
export function createGraphStore({now=()=>Date.now()}={}) {
  const rows=new Map()
  return {
    capture(exec,result) {
      if (!exec.name?.startsWith('mcp__')||result.isError) return false
      const session=exec.agent?.session, root=session?.header?.cwd
      if (!session?.id||!isAbsolute(root??'')) return false
      let graph;try{graph=normalizeGraph(result.value)}catch{return false}
      rows.delete(session.id)
      rows.set(session.id,{...graph,sessionId:session.id,root:resolve(root),tool:bounded(exec.name,180),callId:bounded(exec.callId,180),capturedAt:now(),project:bounded(exec.arguments?.projectId??exec.arguments?.project_id??exec.arguments?.project)})
      while(rows.size>30)rows.delete(rows.keys().next().value)
      return true
    },
    get(id,root) {const row=rows.get(id);if(!row||row.root!==resolve(root)||now()-row.capturedAt>1800000)return null;const {root:_root,...view}=row;return structuredClone(view)},
  }
}
export function backgroundConfig(value={}) {
  const names=value.readOnlyTools??[],timeoutMs=value.timeoutMs??1800000
  if(!Array.isArray(names)||names.length>50||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!/^mcp__[A-Za-z0-9_-]{1,160}$/u.test(name))||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw new Error('BACKGROUND_CONFIG_INVALID')
  return {readOnlyTools:[...names].sort(),timeoutMs}
}
export function createWorkbench(ctx,{configPath}) {
  const graphs=createGraphStore(),csrfToken=randomUUID();let settingsQueue=Promise.resolve()
  const readConfig=async()=>{try{const stat=await lstat(configPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('BACKGROUND_CONFIG_FILE_REJECTED');return backgroundConfig(JSON.parse(await readFile(configPath,'utf8')))}catch(error){if(error.code==='ENOENT')return backgroundConfig();throw error}}
  const configuration=async()=>{const value=await readConfig();return {...value,revision:digest(value)}}
  const save=(value,expectedRevision)=>{
    const task=settingsQueue.then(async()=>{const old=await configuration();if(expectedRevision!==old.revision)throw new Error('BACKGROUND_CONFIG_STALE');const next=backgroundConfig(value);await mkdir(dirname(configPath),{recursive:true});const temporary=`${configPath}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx'});await rename(temporary,configPath);return configuration()});settingsQueue=task.catch(()=>{});return task
  }
  return {graphs,csrfToken,configuration,save,
    jobs(sessionId){return (ctx.jobs?.list(sessionId)??[]).filter(job=>job.owner===sessionId).slice(-100).map(job=>({id:job.id,kind:bounded(job.kind,60),status:job.status,startedAt:job.startedAt,finishedAt:job.finishedAt??null,progress:bounded(job.progress,400)}))},
    async background(args,exec){
      if(!exec.agent?.id||args.tool===exec.name)throw new Error('BACKGROUND_OWNER_REQUIRED')
      await projectSession(ctx,exec.agent.id)
      const config=await readConfig();if(!config.readOnlyTools.includes(args.tool)||!ctx.tools.get(args.tool,exec.agent))throw new Error('BACKGROUND_TOOL_NOT_REVIEWED')
      if(!args.arguments||typeof args.arguments!=='object'||Array.isArray(args.arguments)||Buffer.byteLength(JSON.stringify(args.arguments))>65536)throw new Error('BACKGROUND_ARGUMENTS_REJECTED')
      const controller=new AbortController();let jobTimer
      const jobId=ctx.jobs.start({kind:'airules-mcp',label:args.tool,owner:exec.agent.id,outputLimitBytes:65536,
        toolCall:{name:exec.name,callId:exec.callId},run:handle=>{
          jobTimer=setTimeout(()=>controller.abort(new Error('BACKGROUND_TIMEOUT')),config.timeoutMs);jobTimer.unref?.()
          const done=Promise.resolve().then(()=>executeNativeTool(ctx,{name:args.tool,arguments:args.arguments,agent:exec.agent,callId:`airules-background-${randomUUID()}`,rootCallId:exec.rootCallId??exec.callId,parent:exec.token,signal:controller.signal})).then(result=>{
            const serialized=JSON.stringify(result.value??null);const output=serialized.length>60000?serialized.slice(0,60000)+'\n[output truncated]':serialized
            handle.append(output);return {status:controller.signal.aborted?'killed':result.isError?'failed':'completed',detail:controller.signal.aborted?'Cancelled or timed out':result.isError?'MCP reported failure':'MCP completed',result:output}
          },()=>({status:controller.signal.aborted?'killed':'failed',detail:controller.signal.aborted?'Cancelled or timed out':'MCP failed'})).finally(()=>clearTimeout(jobTimer))
          return {done,cancel(){controller.abort(new Error('BACKGROUND_CANCELLED'))}}
        }})
      return {jobId,status:'running',resultTool:'job_output',owner:exec.agent.id}
    },
  }
}
async function body(request) {let text='';for await(const part of request){text+=part;if(Buffer.byteLength(text)>16384)throw new Error('BODY_LIMIT')}return JSON.parse(text||'{}')}
export function workbenchHandler(ctx,service) {
  return async(request,response)=>{
    const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value))}
    try{
      if(!ctx.connection||ctx.connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
      if(!['GET','POST'].includes(request.method))return send(405,{ok:false,error:'METHOD_NOT_ALLOWED'})
      const input=request.method==='GET'?Object.fromEntries(new URL(request.url,'http://localhost').searchParams):await body(request)
      if(request.method==='POST'&&request.headers?.['x-airules-csrf']!==service.csrfToken)return send(403,{ok:false,error:'CSRF_REQUIRED'})
      if(input.action==='configuration'){
        const config=request.method==='POST'?await service.save(input.config,input.expectedRevision):await service.configuration()
        return send(200,{ok:true,csrfToken:service.csrfToken,config})
      }
      const scope=await projectSession(ctx,input.sessionId)
      if(request.method==='POST'){
        if(input.action!=='cancel'||input.confirm!==true||typeof input.jobId!=='string')throw new Error('CONFIRMED_CANCEL_REQUIRED')
        const job=service.jobs(input.sessionId).find(row=>row.id===input.jobId)
        if(!job||!['running','stopping'].includes(job.status))throw new Error('OWNED_RUNNING_JOB_REQUIRED')
        ctx.jobs.kill(input.jobId,input.sessionId,'User requested cancellation')
      }
      return send(200,{ok:true,csrfToken:service.csrfToken,graph:service.graphs.get(input.sessionId,scope.root),jobs:service.jobs(input.sessionId)})
    }catch(error){return send(400,{ok:false,error:/^[A-Z_]+$/.test(error.message)?error.message:'WORKBENCH_UNAVAILABLE'})}
  }
}
