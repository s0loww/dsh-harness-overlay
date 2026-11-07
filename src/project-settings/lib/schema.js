export const FIELDS = [
  ['INFOBASE_NAME', 'Информационная база', 'Имя базы'],
  ['INFOBASE_KIND', 'Информационная база', 'Тип базы', ['file', 'server']],
  ['INFOBASE_PATH', 'Информационная база', 'Путь файловой базы / строка серверного подключения'],
  ['INFOBASE_ENVIRONMENT', 'Информационная база', 'Назначение базы', ['unknown', 'test', 'dev', 'production']],
  ['IB_USER', 'Информационная база', 'Пользователь'],
  ['IB_PASSWORD', 'Информационная база', 'Пароль', null, true],
  ['IB_UNLOCK_CODE', 'Информационная база', 'Код доступа /UC', null, true],
  ['INFOBASE_PUBLISH_URL', 'Информационная база', 'URL веб-публикации'],
  ['PLATFORM_VERSION', 'Платформа и исходники', 'Версия платформы / режим совместимости'],
  ['PLATFORM_PATH', 'Платформа и исходники', 'Каталог платформы 1С'],
  ['USE_EDT', 'Платформа и исходники', 'Формат среды разработки', ['false', 'true']],
  ['EXPORT_PATH', 'Платформа и исходники', 'Каталог выгрузки конфигурации'],
  ['EXTENSIONS_PATH', 'Платформа и исходники', 'Каталог расширений'],
  ['EXTENSION_NAME', 'Объекты и расширения', 'Основное расширение'],
  ['EXTENSION_NAMES', 'Объекты и расширения', 'Имена расширений через запятую'],
  ['PREFIX', 'Объекты и расширения', 'Префикс новых объектов'],
  ['NEW_OBJECTS_IN', 'Объекты и расширения', 'Новые объекты', ['main_configuration', 'extension']],
  ['NEW_OBJECT_POSITION', 'Объекты и расширения', 'Позиция нового объекта', ['end', 'byName']],
  ['COMPANY', 'Авторство', 'Компания'],
  ['DEVELOPER', 'Авторство', 'Разработчик'],
  ['COMMENT_OPEN', 'Авторство', 'Начало комментария изменения'],
  ['COMMENT_CLOSE', 'Авторство', 'Конец комментария изменения'],
].map(([key, group, label, choices = null, secret = false]) => ({ key, group, label, choices, secret }))
export const GROUPS = [...new Set(FIELDS.map(field => field.group))]
export function validateUpdates(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length > FIELDS.length) throw new Error('UPDATES_INVALID')
  for (const [key, value] of Object.entries(updates)) {
    const field = FIELDS.find(item => item.key === key)
    if (!field || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error('VALUE_INVALID')
    if (field.choices && value !== '' && !field.choices.includes(value)) throw new Error('VALUE_INVALID')
    if (key === 'INFOBASE_PATH' && /\b(?:pwd|password)\s*=/iu.test(value)) throw new Error('PASSWORD_USE_SEPARATE_FIELD')
    if (key === 'INFOBASE_PUBLISH_URL' && value) {
      let url
      try { url = new URL(value) } catch { throw new Error('VALUE_INVALID') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('VALUE_INVALID')
    }
  }
  return updates
}
