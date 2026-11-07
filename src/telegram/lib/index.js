/** R183: one owner, saved Windows-protected token, and the current Desktop runtime. */
import { createTelegramController, createTelegramControlHandler, telegramPublicError, TELEGRAM_CONTROL_PATH } from './telegram-control.js'

export const name = 'airules-telegram'
export const inject = ['commands', 'agents', 'attachments', 'credentials', 'llm', 'sessionController', 'systemPrompt', 'workspaceRegistry']

/** Compatibility check for installations still configured with launch environment. */
export function apply(ctx, _config = {}, internals = {}) {
  const controller = createTelegramController(ctx, internals)
  const statusText = () => {
    const state = controller.snapshot()
    if (state.error) return state.error
    if (state.status !== 'running') return 'Telegram выключен. Настройка: Параметры → Telegram; /telegram on — включить.'
    const binding = state.binding ? `Сессия: ${state.binding.sessionId}.` : 'Сессия не привязана. /menu — выбрать, либо /telegram connect в DSH.'
    return `Telegram включён. Владелец: ${state.ownerId}. ${binding}`
  }
  ctx.commands.register({
    name: 'telegram', description: 'Telegram: подключить текущую сессию, состояние и отключение',
    input: { hint: '[connect|status|on|off|disconnect|help]' }, recordInput: false,
    async handler(invocation) {
      const raw = invocation.rawInput ?? invocation.input ?? ''
      const arg = String(typeof raw === 'object' ? raw.text ?? raw.args ?? '' : raw).trim()
      try {
        await controller.initialize()
        if (!arg || arg === 'status') return { kind: 'success', text: statusText() }
        if (arg === 'help') return { kind: 'success', text: 'Откройте Параметры → Telegram: сохраните токен и ID владельца, привяжите текущий чат и при необходимости включите автозапуск. /telegram off выключает связь, сохраняя привязку; disconnect очищает её. На телефоне: /menu, /status, /stop, /disconnect. Токен в чат не вводите.' }
        if (arg === 'off') { await controller.dispatch({ action: 'stop' }); return { kind: 'success', text: 'Telegram отключён. Сессия и привязка сохранены.' } }
        if (arg === 'disconnect') { await controller.dispatch({ action: 'disconnect' }); return { kind: 'success', text: 'Привязка Telegram очищена. Сессия сохранена в DSH.' } }
        if (arg === 'on') { await controller.dispatch({ action: 'start' }); return { kind: 'success', text: statusText() } }
        if (arg === 'connect') {
          await controller.dispatch({ action: 'connect', sessionId: invocation.agent?.session?.id })
          return { kind: 'success', text: `Telegram привязан к текущей сессии. Отправьте боту сообщение. ${statusText()}` }
        }
        return { kind: 'error', text: 'Команды: /telegram connect|status|on|off|disconnect|help. Токен в чат не вводите.' }
      } catch (cause) { return { kind: 'error', text: telegramPublicError(cause) } }
    },
  })
  ctx.inject?.(['webServer'], ready => {
    ready.effect(() => {
      let connection
      try { connection = ready.get?.('connection') ?? ready.connection } catch {}
      return ready.webServer.register({ kind: 'exact', path: TELEGRAM_CONTROL_PATH, handler: createTelegramControlHandler(controller, undefined, connection) })
    })
  })
  ctx.on('dispose', () => controller.dispose())
  // A slow or unavailable Telegram API must not delay Desktop startup.
  void controller.initialize()
  return controller
}

