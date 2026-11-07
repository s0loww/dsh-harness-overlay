import { inspectFile, inventory } from './core.js'
import { projectSession } from './session.js'
import { createWorkbench, workbenchHandler, WORKBENCH_API } from './workbench.js'

export const name = 'airules-dsh-onec-panels'
export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy', 'jobs', 'tools', 'dshHomePath']
export const API = '/airules/onec-panels'
export async function sessionRoot(ctx, sessionId) {
  return (await projectSession(ctx, sessionId)).root
}
export function handlerFor(ctx) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
    try {
      if (ctx.connection?.requestRejection(request) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (!ctx.connection) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })
      if (request.method !== 'GET') return send(405, { ok: false, error: 'READ_ONLY_API' })
      const url = new URL(request.url, 'http://localhost')
      const root = await sessionRoot(ctx, url.searchParams.get('sessionId'))
      const path = url.searchParams.get('path')
      if (path && path.length > 2048) return send(400, { ok: false, error: 'PATH_REJECTED' })
      const result = path ? await inspectFile(root, path) : await inventory(root)
      return send(200, { ok: true, ...result })
    } catch { return send(400, { ok: false, error: 'ONEC_INSPECTION_UNAVAILABLE', message: 'Не удалось прочитать метаданные. Выберите сеанс 1c-airules с доступной рабочей папкой и проверьте путь/ограничения XML.' }) }
  }
}
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handlerFor(ctx) }))
  const workbench=createWorkbench(ctx,{configPath:ctx.dshHomePath('onec-workbench/background.json')})
  ctx.provide('airulesOnecWorkbench',workbench)
  ctx.on('tools/result',(exec,result)=>workbench.graphs.capture(exec,result),{global:true})
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:WORKBENCH_API,handler:workbenchHandler(ctx,workbench)}))
}
