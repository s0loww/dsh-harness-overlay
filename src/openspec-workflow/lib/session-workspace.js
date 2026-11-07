import { isAbsolute, resolve } from 'node:path'

function fail(code, userMessage) {
  const error = new Error(code)
  error.code = code
  error.userMessage = userMessage
  throw error
}

// sessions.get sees only attached Agents. The native sidebar also lists cold
// persisted sessions; stat reads their header without reading history or resuming
// the Agent (and supports newly created, not-yet-materialized sessions).
export async function resolveSessionHeader(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
    fail('SESSION_INVALID', 'Выберите сеанс рабочей области в левой панели.')
  }
  // Сервисы соседних Cordis-плагинов доступны без обязательного inject только
  // через get(). В headless их может не быть — это явная ошибка сеанса ниже.
  const optional = (name) => { try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] } catch { return undefined } }
  let header = optional('sessions')?.get(sessionId)?.header
  if (!header) {
    const persistence = optional('sessionPersistence')
    if (typeof persistence?.stat !== 'function') {
      fail('SESSION_UNAVAILABLE', 'Хранилище сеансов пока недоступно. Обновите панель после подключения к DSH.')
    }
    try { header = (await persistence.stat(sessionId))?.header }
    catch {
      fail('SESSION_UNAVAILABLE', 'Не удалось прочитать выбранный сеанс. Обновите панель; если ошибка повторится, откройте другой сеанс рабочей области.')
    }
    if (!header) fail('SESSION_NOT_FOUND', 'Выбранный сеанс больше не найден. Выберите другой сеанс или создайте новый в нужной рабочей области.')
    if (header.id !== sessionId) fail('SESSION_UNAVAILABLE', 'Не удалось подтвердить выбранный сеанс. Обновите список сеансов и выберите его заново.')
  }
  if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) {
    fail('SESSION_WORKSPACE_UNAVAILABLE', 'У выбранного сеанса нет рабочей папки. Создайте новый сеанс в нужной рабочей области.')
  }
  return header
}

export async function resolveSessionWorkspace(ctx, sessionId) {
  return resolve((await resolveSessionHeader(ctx, sessionId)).cwd)
}
