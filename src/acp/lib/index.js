import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import * as native from '@deepseek-ai/dsh-acp'
import AcpPermissionPolicy from '@zaimokuza/dsh-acp-adapter/permission-policy'
import { createDesktopAcpController } from './controller.js'
import { createAcpControlHandler, ACP_CONTROL_PATH } from './control.js'
import { installOutboundPolicy } from './outbound.js'

export const name = 'airules-acp-control'
export const inject = [...native.inject, 'agentDefaultModel', 'dshHomePath']

export async function apply(ctx) {
  await ctx.plugin(AcpPermissionPolicy)
  installOutboundPolicy(ctx)
  const controller = createDesktopAcpController({
    home: ctx.dshHomePath('airules-acp'),
    clientPath: fileURLToPath(new URL('./connect.mjs', import.meta.url)),
    async mount(socket) {
      const { provider, model } = ctx.agentDefaultModel.currentSelection()
      const fiber = ctx.plugin({ name: 'airules-acp-inbound-session', apply(child) {
        // Native ACP routes only approvals owned by the connected agents.
        const bridge = child.extend({ on: (event, listener, options) => child.on(event, listener, event === 'approval/request' ? { prepend: true } : options) })
        return native.apply(bridge, { provider, model, stream: ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket)) })
      } })
      try { await fiber.await() } catch (error) { await fiber.dispose(); throw error }
      return () => fiber.dispose()
    },
  })
  ctx.effect(() => () => controller.dispose())
  ctx.inject(['webServer', 'connection'], ready => ready.effect(() => ready.webServer.register({
    kind: 'exact', path: ACP_CONTROL_PATH, handler: createAcpControlHandler(controller, { connection: ready.connection }),
  })))
  await controller.initialize()
}
