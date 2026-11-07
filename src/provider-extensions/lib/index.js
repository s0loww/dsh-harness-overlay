import { fileURLToPath } from 'node:url'
import { createDriverController } from './controller.js'
import { publishProfile } from './runtime.js'
import { createDriverHandler,CONTROL_PATH } from './control.js'
export const name='airules-dsh-provider-extensions'
export const inject=['configEditor','dshHomePath']
export function apply(ctx){
  const controller=createDriverController({home:ctx.dshHomePath('provider-drivers'),node:process.execPath,launcher:fileURLToPath(new URL('./launch.mjs',import.meta.url)),
    publish:(spec,profile)=>publishProfile(ctx.configEditor,spec,profile),
    enabled:spec=>ctx.configEditor.entries().some(entry=>entry.options.name==='@zaimokuza/dsh-acp-adapter'&&!!entry.options.config?.agents?.[spec.profile]),
  })
  ctx.effect(()=>()=>controller.close())
  ctx.inject(['webServer','connection'],ready=>ready.effect(()=>ready.webServer.register({kind:'exact',path:CONTROL_PATH,handler:createDriverHandler(controller,{connection:ready.connection})})))
}
