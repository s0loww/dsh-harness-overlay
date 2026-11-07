import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { TelegramBridge } from '../vendor/dsh-telegram/lib/bridge.js'
import { protectTelegramToken, unprotectTelegramToken } from './telegram-secret.js'
import { createLocalHttpGuard, readLimitedBody } from './local-http-security.js'

export const TELEGRAM_CONTROL_PATH = '/airules/telegram-control'
export const TELEGRAM_CREDENTIAL = credentialKey('airules-telegram', 'settings')
const emptyState = () => ({ version: 1, ciphertext: '', ownerId: null, botId: null, autoStart: false, binding: null })
const messages = {
  PLATFORM: 'Telegram использует защиту токена Windows DPAPI и пока доступен только в Windows.',
  CONFIG: 'Сначала сохраните токен бота и один числовой Telegram ID в настройках.',
  OWNER: 'Укажите один положительный числовой Telegram ID владельца.',
  TOKEN: 'Проверьте формат токена, полученного от BotFather.',
  SAVE: 'Не удалось сохранить настройки Telegram. Проверьте доступ на запись и повторите.',
  LOAD: 'Не удалось прочитать настройки Telegram. Сохраните токен и владельца заново.',
  DECRYPT: 'Не удалось расшифровать токен для этого пользователя Windows. Сохраните токен заново.',
  CONNECT: 'Не удалось подключиться к Telegram. Проверьте токен, интернет и повторите.',
  AUTH: 'Telegram отклонил токен бота. Сохраните действующий токен из BotFather.',
  CONFLICT: 'Этот бот уже подключён другим процессом. Отключите другой DSH или используйте отдельного бота.',
  SESSION: 'Сохранённый чат удалён, архивирован или недоступен. Откройте нужный чат и привяжите его в настройках.',
  BIND: 'Не удалось привязать выбранный чат. Откройте существующую сессию DSH и повторите.',
  STOP: 'Не удалось полностью отключить Telegram. Перезапустите DSH.',
  INPUT: 'Некорректное действие или параметры Telegram.',
}
const problem = code => Object.assign(new Error(messages[code] ?? messages.INPUT), { telegramCode: code })
export const telegramPublicError = error => messages[error?.telegramCode] ?? messages.INPUT
const validOwner = value => Number.isSafeInteger(value) && value > 0
const validToken = value => typeof value === 'string' && value.length <= 512 && /^\d+:[A-Za-z0-9_-]+$/.test(value)

function fromRecord(record) {
  if (record === undefined) return emptyState()
  const p = record?.kind === 'grant' ? record.payload : null
  if (!p || p.version !== 1 || typeof p.ciphertext !== 'string' || typeof p.autoStart !== 'boolean'
    || (p.ownerId !== null && !validOwner(p.ownerId)) || (p.botId !== null && !validOwner(p.botId))) throw problem('LOAD')
  if (p.binding !== null && (!p.binding || typeof p.binding.sessionId !== 'string' || typeof p.binding.workspaceId !== 'string'
    || !validOwner(p.binding.ownerId) || !validOwner(p.binding.botId))) throw problem('LOAD')
  return { ...emptyState(), ...p }
}

/** Owns one configured bot and one exact Desktop-session binding. */
export function createTelegramController(ctx, options = {}) {
  const platformAvailable = (options.platform ?? process.platform) === 'win32'
  const Bridge = options.Bridge ?? TelegramBridge
  const protect = options.protect ?? protectTelegramToken, unprotect = options.unprotect ?? unprotectTelegramToken
  const credentials = options.credentials ?? ctx.credentials
  let state = emptyState(), legacyToken = '', saved = false, bridge, disposed = false, status = 'stopped', error = null
  let operation = Promise.resolve(), writing = Promise.resolve(), initialization
  const snapshot = () => ({ available: platformAvailable, status: platformAvailable ? status : 'unavailable', active: !!bridge, autoStart: state.autoStart, configured: !!(state.ciphertext || legacyToken) && validOwner(state.ownerId),
    tokenStored: saved && !!state.ciphertext, ownerId: state.ownerId, binding: state.binding ? { workspaceId: state.binding.workspaceId, workspaceTitle: state.binding.workspaceTitle, sessionId: state.binding.sessionId } : null, error: platformAvailable ? error : messages.PLATFORM })
  const serialize = work => (operation = operation.then(work, work))
  const persist = update => (writing = writing.catch(() => {}).then(async () => {
    try {
      const next = await credentials.modifyRecord(TELEGRAM_CREDENTIAL, current => ({ kind: 'grant', payload: update(saved ? fromRecord(current) : state) }))
      state = fromRecord(next); saved = true
    } catch { throw problem('SAVE') }
  }))
  const transportError = cause => problem(cause?.code === 401 || cause?.code === 404 ? 'AUTH' : cause?.code === 409 ? 'CONFLICT' : 'CONNECT')
  async function stopNow() {
    const previous = bridge
    bridge = undefined
    try { await previous?.stop(); status = 'stopped'; error = null }
    catch { status = 'error'; error = messages.STOP; throw problem('STOP') }
    return snapshot()
  }
  async function startNow(sessionId) {
    if (disposed) throw problem('CONNECT')
    if (!snapshot().configured) throw problem('CONFIG')
    if (bridge && status === 'running') {
      if (sessionId) { try { await bridge.connectCurrent(state.ownerId, sessionId) } catch { throw problem('BIND') } }
      return snapshot()
    }
    if (bridge) await stopNow()
    status = 'starting'; error = null
    let candidate
    try {
      let token
      try { token = state.ciphertext ? await unprotect(state.ciphertext) : legacyToken } catch { throw problem('DECRYPT') }
      if (!validToken(token)) throw problem('DECRYPT')
      const ownerId = state.ownerId
      candidate = new Bridge(ctx, { token, allowedUserIds: [ownerId], allowAllUsers: false,
        preset: '1c-airules',
        onBindingChanged: async (chatId, binding) => {
          if (disposed || chatId !== ownerId || state.ownerId !== ownerId) return
          const next = binding ? { ...binding, ownerId, botId: state.botId } : null
          if (saved) await persist(current => ({ ...current, binding: next }))
          else state = { ...state, binding: next }
        },
        onConnectionState: (phase, code) => {
          if (disposed || bridge !== candidate) return
          status = phase; error = phase === 'error' ? transportError({ code }).message : null
        },
      })
      let identity
      try { identity = await candidate.verifyBot() } catch (cause) { throw transportError(cause) }
      if (!validOwner(identity?.id) || identity.is_bot !== true) throw problem('AUTH')
      const binding = state.binding && state.binding.botId === identity.id && state.binding.ownerId === ownerId ? state.binding : null
      if (saved && (state.botId !== identity.id || state.binding !== binding)) await persist(current => ({ ...current, botId: identity.id, binding }))
      else state = { ...state, botId: identity.id, binding }
      if (sessionId) { try { await candidate.connectCurrent(ownerId, sessionId) } catch { throw problem('BIND') } }
      else if (state.binding) { try { await candidate.restoreBinding(ownerId, state.binding) } catch { throw problem('SESSION') } }
      bridge = candidate
      candidate.start()
      status = 'running'; error = null
      return snapshot()
    } catch (cause) {
      if (bridge === candidate) bridge = undefined
      await candidate?.stop().catch(() => {})
      status = 'error'; error = cause?.telegramCode ? cause.message : messages.CONNECT
      throw cause?.telegramCode ? cause : problem('CONNECT')
    }
  }
  async function save(input) {
    if (!['string', 'number'].includes(typeof input.ownerId)) throw problem('OWNER')
    const ownerId = Number(input.ownerId)
    if (!validOwner(ownerId) || (typeof input.ownerId === 'string' && !/^[1-9]\d*$/.test(input.ownerId))) throw problem('OWNER')
    if (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') throw problem('INPUT')
    if (input.token !== undefined && typeof input.token !== 'string') throw problem('TOKEN')
    const supplied = input.token?.trim() ?? ''
    if (supplied && !validToken(supplied)) throw problem('TOKEN')
    let ciphertext = state.ciphertext
    if (supplied || (!ciphertext && legacyToken)) {
      try { ciphertext = await protect(supplied || legacyToken) } catch { throw problem('SAVE') }
    }
    if (!ciphertext) throw problem('CONFIG')
    const changed = ownerId !== state.ownerId || !!supplied
    if (changed) await stopNow()
    await persist(current => ({ ...current, ciphertext, ownerId, autoStart: input.autoStart ?? current.autoStart,
      ...(changed ? { binding: null, botId: null } : {}) }))
    legacyToken = ''
    error = null
    return snapshot()
  }
  async function initialize() {
    if (!platformAvailable) return snapshot()
    try {
      const record = await credentials.readRecord(TELEGRAM_CREDENTIAL)
      state = fromRecord(record); saved = record !== undefined
      if (state.autoStart) await startNow()
    } catch (cause) { status = 'error'; error = cause?.telegramCode ? cause.message : messages.LOAD }
    return snapshot()
  }
  const ready = () => initialization ??= initialize()
  return {
    snapshot, initialize: ready,
    async dispatch(input) {
      if (!platformAvailable) throw problem('PLATFORM')
      await ready()
      return serialize(async () => {
        if (disposed || !input || typeof input !== 'object') throw problem('INPUT')
        switch (input.action) {
          case 'save': return save(input)
          case 'start': return startNow()
          case 'stop': return stopNow()
          case 'connect':
            if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256) throw problem('BIND')
            return startNow(input.sessionId)
          case 'disconnect':
            if (bridge) await bridge.disconnectCurrent(state.ownerId)
            else if (saved) await persist(current => ({ ...current, binding: null }))
            else state.binding = null
            return snapshot()
          case 'setAutoStart':
            if (typeof input.autoStart !== 'boolean') throw problem('INPUT')
            if (!saved && legacyToken) throw problem('CONFIG')
            await persist(current => ({ ...current, autoStart: input.autoStart }))
            return snapshot()
          case 'forget':
            await stopNow()
            await persist(() => emptyState())
            legacyToken = ''
            return snapshot()
          default: throw problem('INPUT')
        }
      })
    },
    dispose: async () => { await ready(); return serialize(async () => { disposed = true; await stopNow(); await writing.catch(() => {}) }) },
  }
}

export function createTelegramControlHandler(controller, security = createLocalHttpGuard(), connection) {
  return async (request, response) => {
    const send = (code, body) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
    // Stock Desktop uses dsh-app://, admitted by the native connection service.
    // It still needs our per-process CSRF token for every POST.
    let allowed
    if (connection) {
      const rejection = connection.requestRejection(request)
      allowed = rejection === undefined
        ? { ok: request.method === 'GET' || security.matchesToken(request), code: 'CSRF_REQUIRED' }
        : { ok: false, code: 'NATIVE_CONNECTION_REQUIRED' }
    } else allowed = security.authorize(request)
    if (!allowed.ok) return send(403, { ok: false, error: allowed.code })
    if (!['GET', 'POST'].includes(request.method)) return send(405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
    try {
      await controller.initialize()
      if (request.method === 'POST') await controller.dispatch(JSON.parse(await readLimitedBody(request, 4096)))
      return send(200, { ok: true, ...controller.snapshot(), csrfToken: security.token })
    } catch (cause) {
      return send(cause?.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { ok: false, ...controller.snapshot(), message: telegramPublicError(cause), csrfToken: security.token })
    }
  }
}

