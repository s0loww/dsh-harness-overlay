import { isAbsolute, join, resolve } from 'node:path'
import { TYPES, LIMITS, hash, projectIdentity, sourcePath, endpoint, edgeId, provenance, emptyGraph, validateGraph, filterEdges, queryFingerprint } from './core.js'
const fail=code=>{throw new Error(code)}
const pathKey=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value)
const presets=['1c-airules','python-airules','sysadmin-airules']
// Agent plugins have separate service instances; all share this process-local
// lock. Native filesystem CAS remains authoritative across processes.
const writeLocks=new Set()
export const STORE_PATH='.dsh/evidence-links.json'
export function nativeScope(ctx,exec,writing=false){
  const agent=exec?.agent,session=agent?.session,header=session?.header
  if(!session?.id||header?.id!==session.id||ctx.agents.get(session.id)!==agent||!presets.includes(ctx.agentPresets.composedPreset(agent.ctx))||!isAbsolute(header.cwd??''))fail('LINKS_NATIVE_SCOPE_REQUIRED')
  const policy=ctx.sandboxPolicy.resolve({session})
  if(!['read-only','workspace-write','danger-full-access'].includes(policy?.mode)||policy.sessionId!==session.id||!isAbsolute(policy.workspaceRoot??'')||pathKey(policy.workspaceRoot)!==pathKey(header.cwd))fail('LINKS_NATIVE_POLICY_REQUIRED')
  if(writing&&(policy.mode==='read-only'||header.origin==='subagent'))fail('LINKS_LEAD_WRITER_REQUIRED')
  return{agent,policy,root:resolve(header.cwd),projectId:projectIdentity(resolve(header.cwd)),stamp:JSON.stringify([session.id,pathKey(header.cwd),header.origin??'lead',ctx.agentPresets.composedPreset(agent.ctx),policy])}
}
/** A small reference ledger, not an external document cache or semantic index. */
export function createNativeLinks(ctx,{now=()=>new Date().toISOString()}={}){
  function verify(scope,exec,writing=false){exec.signal?.throwIfAborted();const fresh=nativeScope(ctx,exec,writing);if(fresh.agent!==scope.agent||fresh.stamp!==scope.stamp)fail('LINKS_SCOPE_CHANGED')}
  async function target(scope,exec,relativePath){
    const fs=ctx.agentPresets.serviceFor?.(scope.agent,'fs')??ctx.fs
    if(!fs?.resolve||!fs?.processPath||!fs?.lstat)fail('LINKS_NATIVE_FS_REQUIRED')
    const root=await fs.resolve(scope.root,{cwd:scope.root,signal:exec.signal});verify(scope,exec)
    if(pathKey(fs.processPath(root))!==pathKey(scope.root))fail('LINKS_PROJECT_LINK_REJECTED')
    let at=scope.root
    for(const part of relativePath.split('/')){at=join(at,part);const info=await fs.lstat(at,{cwd:scope.root,signal:exec.signal},exec.signal);verify(scope,exec);if(info?.type==='symlink')fail('LINKS_PROJECT_LINK_REJECTED')}
    const path=await fs.resolve(join(scope.root,relativePath),{cwd:scope.root,signal:exec.signal});verify(scope,exec)
    if(pathKey(fs.processPath(path))!==pathKey(join(scope.root,relativePath)))fail('LINKS_PROJECT_LINK_REJECTED')
    return{fs,path}
  }
  async function bytes(scope,exec,relativePath,max){
    const{fs,path}=await target(scope,exec,relativePath),before=await fs.stat(path,exec.signal);verify(scope,exec)
    if(!before)return null
    if(before.type!=='file'||before.size>max||typeof before.version!=='string')fail('LINKS_FILE_INVALID')
    const value=Buffer.from(await fs.readBytes(path,exec.signal,max+1));verify(scope,exec)
    const after=await fs.stat(path,exec.signal);verify(scope,exec)
    if(before.version!==after?.version||value.length>max)fail('LINKS_FILE_CHANGED')
    return{bytes:value,nativeVersion:before.version}
  }
  async function read(scope,exec){
    const value=await bytes(scope,exec,STORE_PATH,LIMITS.storeBytes)
    if(!value)return{graph:emptyGraph(scope.projectId),revision:'missing',nativeVersion:null}
    let json;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value.bytes).replace(/^\uFEFF/u,''))}catch{fail('LINKS_STORE_INVALID')}
    return{graph:validateGraph(json,scope.projectId),revision:hash(value.bytes),nativeVersion:value.nativeVersion}
  }
  async function capture(scope,exec,node){
    sourcePath(node.path)
    const value=await bytes(scope,exec,node.path,LIMITS.sourceBytes)
    if(!value)fail('LINKS_SOURCE_MISSING')
    if(node.range){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value.bytes)}catch{fail('LINKS_SOURCE_RANGE_INVALID')};if(text.includes('\0')||node.range.endLine>text.split(/\r\n|\n|\r/u).length)fail('LINKS_SOURCE_RANGE_INVALID')}
    return{hash:hash(value.bytes),size:value.bytes.length}
  }
  async function page(scope,exec,snapshot,args){
    const all=filterEdges(snapshot.graph,args),fingerprint=queryFingerprint(args);let offset=0
    if(args.cursor!==undefined){let value;try{if(typeof args.cursor!=='string'||args.cursor.length>500)throw Error();value=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'))}catch{fail('LINKS_CURSOR_INVALID')};if(value.revision!==snapshot.revision||value.filter!==fingerprint||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>all.length)fail('LINKS_CURSOR_STALE');offset=value.offset}
    const limit=args.limit??20,chosen=all.slice(offset,offset+limit),cache=new Map();let consumed=0
    async function state(node,expected){
      if(!cache.has(node.path)){
        if(cache.size>=LIMITS.queryFiles||consumed+LIMITS.sourceBytes>LIMITS.queryBytes)cache.set(node.path,{state:'unverified-budget'})
        else{try{const value=await capture(scope,exec,node);consumed+=value.size;cache.set(node.path,value)}catch{verify(scope,exec);cache.set(node.path,{state:'missing-or-inaccessible'})}}
      }
      const result=cache.get(node.path);return result.state??(result.hash===expected?'fresh':'stale')
    }
    const links=[]
    for(const edge of chosen){const from=snapshot.graph.nodes[edge.from],to=snapshot.graph.nodes[edge.to],sourceState={};for(const node of[from,to].filter(n=>n.kind==='file'))sourceState[node.nodeId]=await state(node,edge.sourceHashes[node.nodeId]);links.push({...edge,fromNode:from,toNode:to,sourceState,referenceVerification:'not-fetched'})}
    verify(scope,exec)
    return{projectId:scope.projectId,revision:snapshot.revision,total:all.length,links,...(offset+chosen.length<all.length?{nextCursor:Buffer.from(JSON.stringify({revision:snapshot.revision,filter:fingerprint,offset:offset+chosen.length})).toString('base64url')}:{})}
  }
  return{async act(args,exec){
    const allowed=['action','from','to','type','provenance','expectedRevision','confirm','linkId','nodeId','query','limit','cursor']
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed.includes(key))||!['list','query','add','remove'].includes(args.action))fail('LINKS_ARGUMENTS_INVALID')
    const writing=['add','remove'].includes(args.action),scope=nativeScope(ctx,exec,writing);verify(scope,exec,writing)
    if(!writing)return page(scope,exec,await read(scope,exec),args)
    if(typeof exec?.token!=='symbol'||typeof exec.callId!=='string'||!exec.callId||args.confirm!==true||typeof args.expectedRevision!=='string')fail('LINKS_NATIVE_APPROVAL_REQUIRED')
    if(writeLocks.has(scope.projectId))fail('LINKS_WRITE_BUSY');writeLocks.add(scope.projectId)
    try{
      const snapshot=await read(scope,exec),graph=snapshot.graph
      if(snapshot.revision!==args.expectedRevision)fail('LINKS_REVISION_CHANGED')
      let selected,details
      if(args.action==='add'){
        const from=endpoint(args.from,scope.projectId),to=endpoint(args.to,scope.projectId)
        if(from.kind!=='file'||!TYPES.includes(args.type))fail('LINKS_ARGUMENTS_INVALID')
        const id=edgeId(scope.projectId,args.type,from.nodeId,to.nodeId),timestamp=now(),sourceHashes={}
        for(const node of[from,to].filter(node=>node.kind==='file'))sourceHashes[node.nodeId]=(await capture(scope,exec,node)).hash
        selected={id,type:args.type,from:from.nodeId,to:to.nodeId,sourceHashes,provenance:provenance(args.provenance,scope.agent.session.id,timestamp),createdAt:graph.links[id]?.createdAt??timestamp,updatedAt:timestamp}
        graph.nodes[from.nodeId]=from;graph.nodes[to.nodeId]=to;graph.links[id]=selected
        details={type:selected.type,from,to,provenance:selected.provenance}
      }else{
        if(typeof args.linkId!=='string'||!Object.hasOwn(graph.links,args.linkId))fail('LINKS_NOT_FOUND')
        selected=graph.links[args.linkId];details={type:selected.type,from:graph.nodes[selected.from],to:graph.nodes[selected.to],provenance:selected.provenance};delete graph.links[args.linkId]
        const used=new Set(Object.values(graph.links).flatMap(edge=>[edge.from,edge.to]));for(const id of Object.keys(graph.nodes))if(!used.has(id))delete graph.nodes[id]
      }
      validateGraph(graph,scope.projectId);verify(scope,exec,true)
      const decision=await ctx.approval.request({agent:scope.agent,callId:exec.callId,toolName:'airules_links',reason:`${args.action} project evidence relation ${selected.id}; project ${scope.projectId}; ${JSON.stringify(details)}; metadata only, no external fetch or backend write.`,signal:exec.signal})
      verify(scope,exec,true);if(decision!=='allowed-once')fail('LINKS_APPROVAL_REQUIRED')
      if((await read(scope,exec)).revision!==snapshot.revision)fail('LINKS_REVISION_CHANGED')
      // A source edit while the user considered approval must not validate an old snapshot.
      if(args.action==='add')for(const[nodeId,expected]of Object.entries(selected.sourceHashes))if((await capture(scope,exec,graph.nodes[nodeId])).hash!==expected)fail('LINKS_SOURCE_CHANGED')
      const{fs,path}=await target(scope,exec,STORE_PATH);verify(scope,exec,true)
      await fs.writeText(path,JSON.stringify(graph,null,2)+'\n',snapshot.nativeVersion?{kind:'replaceIfVersion',version:snapshot.nativeVersion}:{kind:'createIfAbsent'},exec.signal,scope.policy)
      verify(scope,exec,true);const saved=await read(scope,exec)
      return{projectId:scope.projectId,revision:saved.revision,action:args.action,linkId:selected.id,metadataOnly:true}
    }finally{writeLocks.delete(scope.projectId)}
  }}
}
