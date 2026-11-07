import { mkdir,mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROVIDER } from './catalog.js'
import { fail } from './runtime.js'

export function promptOf(options){
  const visit=value=>{if(!value||typeof value!=='object')return;if(['image','image_url','file','attachment'].includes(value.type))fail('CURSOR_TEXT_ONLY');for(const child of Object.values(value))if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child)}
  visit(options.messages)
  const prompt='Continue this DSH conversation. Use only the supplied custom tools; their results arrive on the next DSH turn. Do not inspect local files or spawn agents.\n'+JSON.stringify({system:options.system,messages:options.messages??[]})
  if(Buffer.byteLength(prompt)>4*1024*1024)fail('CURSOR_PROMPT_TOO_LARGE')
  return prompt
}
const bounded=async(work,ms)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('CURSOR_SETTLEMENT_TIMEOUT'),{code:'CURSOR_SETTLEMENT_TIMEOUT'})),ms)})])}finally{clearTimeout(timer)}}
export function createAdapter({Base,LlmError,controller,authorize,runsRoot,settlementMs=3000,retryPolicy}){
  return new class extends Base{
    providerInfo(){return{id:PROVIDER,name:'Cursor · внешний SDK'}}
    providerRetryPolicy(){return retryPolicy}
    async listModels(){return(await controller.models()).map(({cursorModel,contextEstimated,...row})=>row)}
    async resolveModel(_provider,id){const row=(await this.listModels()).find(row=>row.id===id);if(!row)fail('CURSOR_MODEL_NOT_IN_CATALOG');return row}
    async prepareCall(provider,model,signal){signal?.throwIfAborted();const revision=await controller.revision(),info=await this.resolveModel(provider,model);if(await controller.revision()!==revision)fail('CURSOR_CONFIG_CHANGED');return{model:info,stream:options=>this.stream(options,revision)}}
    async *stream(options,preparedRevision){
      const revoke=authorize(options)
      let lease,directory,agent,run,pump,cancellation,settlement,settled=false,wake,closed=false
      const queue=[],pending=[];let queuedBytes=0,index=0,activeBlock,totalBytes=0,usage,failed
      function* closeBlock(){if(activeBlock){yield{type:'block-end',index,block:activeBlock};activeBlock=undefined;index++}}
      const push=value=>{if(closed)return;const size=Buffer.byteLength(JSON.stringify(value));queuedBytes+=size;if(queue.length>=1000||queuedBytes>8*1024*1024){failed=true;wake?.();return}queue.push({value,size});wake?.();wake=undefined}
      const cancel=()=>!run?Promise.resolve():cancellation??=(async()=>{await run.cancel();pending.splice(0).forEach(resolve=>resolve({isError:true,content:[{type:'text',text:'Control returned to DSH.'}]}))})()
      const dispose=async()=>{if(agent?.[Symbol.asyncDispose])await agent[Symbol.asyncDispose]();else await agent?.close?.()}
      const cleanup=()=>settlement??=(async()=>{await cancel();await pump;await dispose();settled=true;if(directory)await rm(directory,{recursive:true,force:true})})()
      const abort=()=>{void cancel().catch(()=>{});push({abort:true})}
      try{
        const revision=preparedRevision??await controller.revision(),prompt=promptOf(options),model=(await controller.models()).find(row=>row.id===options.model)
        if(!model)fail('CURSOR_MODEL_NOT_IN_CATALOG')
        lease=await controller.acquire(options.signal,revision);lease.signal.throwIfAborted();lease.signal.addEventListener('abort',abort,{once:true})
        await mkdir(runsRoot,{recursive:true});directory=await mkdtemp(join(runsRoot,'run-'))
        const customTools=Object.create(null)
        for(const tool of options.tools??[]){if(typeof tool.name!=='string'||Object.hasOwn(customTools,tool.name))fail('CURSOR_TOOL_SCHEMA');customTools[tool.name]={description:tool.description,inputSchema:tool.parameters,execute(args){
          if(closed||lease.signal.aborted)return Promise.resolve({isError:true,content:[{type:'text',text:'DSH request closed.'}]})
          const promise=new Promise(resolve=>pending.push(resolve));push({tool:{type:'tool-call',id:'cursor-'+randomUUID(),name:tool.name,arguments:JSON.stringify(args)}});return promise
        }}}
        agent=await lease.sdk.Agent.create({apiKey:lease.apiKey,model:structuredClone(model.cursorModel),tools:Object.keys(customTools).length?['mcp']:[],disallowedTools:['task'],mcpServers:{},agents:{},local:{cwd:directory,dirs:[],settingSources:[],store:new lease.sdk.JsonlLocalAgentStore(join(directory,'state')),customTools,enableAgentRetries:false}})
        lease.signal.throwIfAborted();run=await agent.send(prompt)
        pump=(async()=>{try{for await(const event of run.stream()){
          if(event.type==='assistant')for(const content of event.message?.content??[])if(content.type==='text'&&typeof content.text==='string')push({text:content.text})
          if(event.type==='thinking'&&typeof event.text==='string')push({thinking:event.text})
        }const result=await run.wait();usage=result?.usage;if(result?.status!=='finished')push({error:true});push({done:true})}catch{push({error:true})}})()
        while(true){
          if(failed)fail('CURSOR_STREAM_LIMIT')
          lease.signal.throwIfAborted()
          if(!queue.length){await new Promise(resolve=>{wake=resolve});continue}
          const item=queue.shift();queuedBytes-=item.size;const event=item.value
          if(event.abort)lease.signal.throwIfAborted()
          if(event.error)fail('CURSOR_SDK_STREAM_FAILED')
          if(event.text||event.thinking){const type=event.text?'text':'reasoning',text=event.text??event.thinking;totalBytes+=Buffer.byteLength(text);if(totalBytes>8*1024*1024)fail('CURSOR_STREAM_LIMIT');if(activeBlock?.type!==type){yield*closeBlock();activeBlock={type,text:''};yield{type:'block-start',index,blockType:type}}activeBlock.text+=text;yield{type:type==='text'?'text-delta':'reasoning-delta',index,text}}
          if(event.tool){
            // Native scheduler receives nothing executable until SDK termination is confirmed.
            closed=true;await bounded(cleanup(),settlementMs)
            yield*closeBlock()
            yield{type:'block-start',index,blockType:'tool-call'};yield{type:'tool-call-delta',index,id:event.tool.id,name:event.tool.name,argumentsDelta:event.tool.arguments};yield{type:'block-end',index,block:event.tool};yield{type:'finish',reason:{kind:'tool-calls'}};return
          }
          if(event.done){
            yield*closeBlock()
            const normalized={};for(const [target,source]of Object.entries({inputTokens:'inputTokens',outputTokens:'outputTokens',cacheReadTokens:'cacheReadTokens',cacheWriteTokens:'cacheWriteTokens'})){const value=usage?.[source];if(Number.isSafeInteger(value)&&value>=0)normalized[target]=value}
            if(Object.keys(normalized).length)yield{type:'usage',usage:normalized}
            yield{type:'finish',reason:{kind:'stop'}};return
          }
        }
      }catch(error){throw new LlmError(lease?.signal.aborted?'Запрос Cursor отменён.':'Cursor: запрос не выполнен. Проверьте настройки внешнего SDK и нативный доступ BUILD.',lease?.signal.aborted?'ABORTED':/^CURSOR_[A-Z_]+$/.test(error?.code??'')?error.code:'CURSOR_SDK_ERROR')}
      finally{closed=true;lease?.signal.removeEventListener('abort',abort);if(!settled){const work=cleanup();try{await bounded(work,settlementMs)}catch{void work.catch(()=>{} /* Keep an active SDK workspace for diagnosis; never delete it prematurely. */)}}lease?.release();revoke()}
    }
  }()
}
