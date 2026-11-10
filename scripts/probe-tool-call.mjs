import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
/** Actual native raw-batch contract. Never runs a model or changes tool policy. */
export async function executeProbeTool(ctx,input){
 const modules=process.env.AIRULES_PROBE_NATIVE_MODULES
 if(!modules)return ctx.tools.execute(input)
 const version=JSON.parse(await readFile(join(modules,'@deepseek-ai/dsh-tools/package.json'),'utf8')).version
 if(version==='0.2.1-rc.5')return ctx.tools.execute(input)
 if(version!=='0.2.2-rc.1'||input.parent!==undefined||input.rootCallId!==undefined)throw new Error('PROBE_NATIVE_EXECUTION_CONTRACT_REJECTED')
 const batch=await ctx.tools.execute({calls:[{id:input.callId,name:input.name,arguments:JSON.stringify(input.arguments??{})}],agent:input.agent,signal:input.signal})
 if(batch.results?.length!==1)throw new Error('PROBE_NATIVE_BATCH_RESULT_REQUIRED')
 return batch.results[0].result
}
