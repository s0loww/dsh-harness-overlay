import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { API } from './control.js'
import { createMemoryWorkspace } from './workspace.js'
import { createProcessingManager } from './processing-runtime.js'
import { DEFAULT_PROCESSING } from './processing.js'
import { createNativeProcessing } from './processing-native.js'
import { createModelKeyStore } from './model-key.js'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'airules-dsh-memory-workspace'
export const inject = ['webServer', 'connection', 'agents', 'agentPresets', 'sandboxPolicy', 'approval', 'dshHomePath', 'tools','fs','subprocess','sandbox','credentials']
export async function apply(ctx) {
  const home=ctx.dshHomePath('memory-workspace'),configPath=join(home,'config.json'),bindingPath=join(home,'processing-binding.json'),backupRoot=join(home,'processing-backups')
  let previous
  try{previous=JSON.parse(await readFile(configPath,'utf8'))}catch{}
  const keyStore=createModelKeyStore(ctx.credentials,credentialKey(name,'cognee-openrouter'))
  const native=createNativeProcessing(ctx,{bindingPath,backupRoot})
  const processingManager=createProcessingManager({profilePath:join(home,'processing.json'),bindingPath,statePath:join(home,'processing-state.json'),backupRoot,...native,getOpenRouterKey:()=>keyStore.resolve(),defaultProfile:{...DEFAULT_PROCESSING,allowed:previous?.localProcessing===true}})
  const controller = createMemoryWorkspace(ctx, { configPath, createUserMessage,processingManager,keyStore })
  ctx.provide('airulesMemory', controller)
  ctx.on('tools/pre-execute',controller.gate)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: controller.handler }))
  ctx.effect(()=>{const cancel=new AbortController();void processingManager.inspect({signal:cancel.signal}).catch(()=>{});return()=>cancel.abort()})
}
