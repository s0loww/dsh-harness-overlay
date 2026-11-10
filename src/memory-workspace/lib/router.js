import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { selectBackends } from './policy.js'
const fail=code=>{throw new Error(code)}
const sha=value=>createHash('sha256').update(value).digest('hex')
const code=error=>/^[A-Z][A-Z0-9_]{2,100}$/u.test(error?.message??'')?error.message:'MEMORY_BACKEND_UNAVAILABLE'
const written=result=>['uploaded','stored'].includes(result?.state)
function safeReceipt(result){
  const output={}
  for(const key of ['backend','state','id','recordId','documentId','document_id','dataset','datasetId','namespace','contentHash','operationId','scopeEvidence']) if(typeof result?.[key]==='string')output[key]=result[key].slice(0,512)
  for(const key of ['indexed','needsProcessing','repeated'])if(typeof result?.[key]==='boolean'||result?.[key]===null)output[key]=result[key]
  if(typeof result?.receipt?.taskId==='string')output.receipt={taskId:result.receipt.taskId.slice(0,128)}
  return output
}
/** Separate transport receipts; never stores note text or credentials. */
export function createRoutingJournal(path){
  let busy=false
  async function load(){
    try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>1024*1024)fail('MEMORY_ROUTING_JOURNAL_INVALID');const value=JSON.parse(await readFile(path,'utf8'))
      if(value.schemaVersion!==1||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||Object.keys(value.entries).length>1000)fail('MEMORY_ROUTING_JOURNAL_INVALID')
      for(const[id,row]of Object.entries(value.entries))if(!/^[a-f0-9]{64}$/u.test(id)||!row||!['outcome-unknown','stored'].includes(row.state)||row.state==='stored'&&!written(row.result))fail('MEMORY_ROUTING_JOURNAL_INVALID')
      return value
    }catch(error){if(error.code==='ENOENT')return{schemaVersion:1,entries:{}};throw error}
  }
  async function mutate(fn){
    if(busy)fail('MEMORY_ROUTING_JOURNAL_BUSY');busy=true
    const lock=path+'.lock',temp=path+'.'+randomUUID()+'.tmp';let locked=false
    try{await mkdir(dirname(path),{recursive:true});const parent=await lstat(dirname(path));if(parent.isSymbolicLink())fail('MEMORY_ROUTING_JOURNAL_INVALID')
      try{await writeFile(lock,'memory-routing',{flag:'wx',mode:0o600});locked=true}catch(error){if(error.code==='EEXIST')fail('MEMORY_ROUTING_JOURNAL_BUSY');throw error}
      const state=await load(),result=fn(state)
      if(Object.keys(state.entries).length>1000)fail('MEMORY_ROUTING_JOURNAL_LIMIT')
      await writeFile(temp,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});await rename(temp,path);return structuredClone(result)
    }finally{busy=false;await rm(temp,{force:true});if(locked)await rm(lock,{force:true})}
  }
  return{async claim(id){if(!/^[a-f0-9]{64}$/u.test(id))fail('MEMORY_ROUTING_ID_INVALID');return mutate(state=>{if(state.entries[id])return{claimed:false,...state.entries[id]};state.entries[id]={state:'outcome-unknown'};return{claimed:true,state:'outcome-unknown'}})},async settle(id,result){if(!written(result))fail('MEMORY_ROUTING_RECEIPT_INVALID');return mutate(state=>{if(!state.entries[id])fail('MEMORY_ROUTING_RECEIPT_REQUIRED');state.entries[id]={state:'stored',result:safeReceipt(result)};return state.entries[id]})}}
}
export function createMemoryRouter({policyFor,verify,preflight,cognee,memoria,approve,journal}){
  return{async act(input,execution,scope){
    const snapshot=await policyFor(scope,execution?.signal),policy=snapshot.effective
    if(input.expectedPolicyRevision!==undefined&&input.expectedPolicyRevision!==snapshot.revision)fail('MEMORY_POLICY_STALE')
    const selected=selectBackends(policy,input)
    const current=async()=>{await verify(scope,execution?.signal);if((await policyFor(scope,execution?.signal)).revision!==snapshot.revision)fail('MEMORY_POLICY_STALE');await verify(scope,execution?.signal)}
    const invoke=async (backend,operationId,destinationIdentity)=>{
      await current()
      const result=await(backend==='cognee'?cognee:memoria)({...input,...(operationId?{operationId,destinationIdentity}:{})},execution,scope,policy)
      await current();return result
    }
    if(input.action==='remember'){
      if(input.confirm!==true)fail('MEMORY_CONFIRM_REQUIRED')
      if(!execution?.agent||typeof execution.token!=='symbol'||typeof execution.callId!=='string'||!execution.callId)fail('MEMORY_NATIVE_EXECUTION_REQUIRED')
      if(typeof input.text!=='string'||!input.text.trim()||input.text.length>32000||input.title!==undefined&&(typeof input.title!=='string'||input.title.length>120))fail('MEMORY_INPUT_INVALID')
      // Resolve every destination and its project mapping before any send.
      const identities={}
      for(const backend of selected){identities[backend]=await preflight(backend,input,execution,scope,policy);if(typeof identities[backend]!=='string'||!identities[backend])fail('MEMORY_DESTINATION_ID_REQUIRED');await current()}
      await approve(input,execution,scope,selected);await current()
      const backends={};let stopped=false
      for(const backend of selected){
        if(stopped){backends[backend]={status:'not-attempted'};continue}
        const namespace=backend==='memoria'?policy.memoria?.namespace:'project-dataset'
        const operationId=sha(JSON.stringify([scope.dataset,backend,identities[backend],namespace,input.title??'Заметка DSH',input.kind??'fact',input.text]))
        await current()
        if(await preflight(backend,input,execution,scope,policy)!==identities[backend])fail('MEMORY_DESTINATION_CHANGED')
        await current()
        const claimed=await journal.claim(operationId)
        if(!claimed.claimed){
          backends[backend]={status:claimed.state==='stored'?'ok':'failed',result:{...(claimed.result??{state:'outcome-unknown'}),backend,operationId,repeated:true}}
          if(claimed.state!=='stored')stopped=true
          continue
        }
        try{
          const result=await invoke(backend,operationId,identities[backend])
          if(!written(result)){backends[backend]={status:'failed',result:{backend,state:'outcome-unknown',operationId,indexed:false}};stopped=true;continue}
          await journal.settle(operationId,{...result,backend,operationId})
          backends[backend]={status:'ok',result:{...result,backend,operationId}}
        }catch(error){backends[backend]={status:'failed',error:code(error),result:{backend,state:'outcome-unknown',operationId,indexed:false}};stopped=true}
      }
      if(selected.length===1)return{...(backends[selected[0]].result??{}),backend:selected[0],...(backends[selected[0]].error?{error:backends[selected[0]].error}:{}),policyRevision:snapshot.revision}
      return{mode:policy.mode,status:Object.values(backends).every(row=>row.status==='ok')?'complete':'partial',backends,policyRevision:snapshot.revision}
    }
    if(input.action==='process'){
      if(input.confirm!==true||!execution)fail('MEMORY_CONFIRM_REQUIRED')
      await preflight('cognee',input,execution,scope,policy);await approve(input,execution,scope,selected);await current()
    }
    if(selected.length===1)return{...await invoke(selected[0]),backend:selected[0],policyRevision:snapshot.revision}
    const entries=await Promise.all(selected.map(async backend=>{try{return[backend,{status:'ok',result:await invoke(backend)}]}catch(error){return[backend,{status:'unavailable',error:code(error)}]}}))
    await current()
    const backends=Object.fromEntries(entries),good=entries.filter(([,row])=>row.status==='ok')
    const results=input.action==='recall'?good.flatMap(([backend,row])=>(row.result.results??[]).slice(0,input.topK??8).map(hit=>({...hit,backend}))):undefined
    return{mode:policy.mode,status:good.length===entries.length?'complete':good.length?'partial':'unavailable',backends,...(results?{results}:{}),policyRevision:snapshot.revision}
  }}
}
