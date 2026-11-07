import { createMobileAccessController } from './controller.js'
import { createMobileAccessHandler, MOBILE_ACCESS_PATH } from './control.js'

export const name = 'airules-mobile-access'
export const inject = ['webServer', 'credentials', 'connection', 'dshHomePath']

export function apply(ctx) {
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath !== 'function') throw new Error('MOBILE_HOME_UNAVAILABLE')
  const controller = createMobileAccessController({ home: homePath(), context: ctx })
  ctx.effect(() => () => controller.dispose())
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: MOBILE_ACCESS_PATH, handler: createMobileAccessHandler(controller, { connection: ctx.connection }) }))
  // Initializes only local state. Defaults never start a public listener.
  return controller.initialize().then(() => {})
}
