import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

/** Exact022 nested invocation. Batch input cannot carry parent/root correlation.
 * Use the exported native pipeline so approval, guards, scope and revocation run
 * for the original Agent and parent token, through final native normalization. */
export async function executeNativeTool(ctx,input){
  if(!ctx?.tools||!input||typeof input.callId!=='string'||typeof input.name!=='string')throw Error('NATIVE_NESTED_EXECUTION_REQUIRED')
  if(input.parent!==undefined&&typeof input.parent!=='symbol')throw Error('NATIVE_NESTED_PARENT_REQUIRED')
  const selected=ctx.tools.selectExecutor(input.agent)
  const signal=input.signal??new AbortController().signal
  if(input.parent===undefined){
    const batch=await ctx.tools.execute({calls:[{id:input.callId,name:input.name,arguments:JSON.stringify(input.arguments??{})}],agent:input.agent,signal,...(input.toolSet===undefined?{}:{toolSet:input.toolSet})})
    const row=batch.results?.[0]
    if(!row||row.callId!==input.callId)throw Error('NATIVE_SINGLE_BATCH_RESULT_INVALID')
    return row.result
  }
  const pipeline=new ToolExecutionPipeline(ctx)
  const prepared=await pipeline.prepare({...input,signal})
  if(prepared.kind==='dispatch'&&ctx.tools.selectExecutor(input.agent)!==selected)throw Error('NATIVE_NESTED_EXECUTOR_CHANGED')
  const outcome=prepared.kind==='dispatch'?await pipeline.dispatch(prepared.exec):prepared
  return pipeline.complete(prepared.exec,outcome)
}
