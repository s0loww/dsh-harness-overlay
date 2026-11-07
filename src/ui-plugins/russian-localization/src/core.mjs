const LANGUAGE = Object.freeze({ id: 'ru', label: 'Русский', fallback: 'en' })
const NS = /^[A-Za-z0-9@._/-]+$/u

export const CAPABILITY = Object.freeze({
  status: 'official-api',
  language: 'ru',
  fallback: 'en',
  activatesLocale: false,
  patchesRuntime: false,
  translatesHardcodedText: false,
})

export function validateLocalePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('AIRULES_LOCALE_PAYLOAD_INVALID')
  if (payload.schemaVersion !== 1 || payload.language !== 'ru' || payload.fallback !== 'en') {
    throw new Error('AIRULES_LOCALE_PAYLOAD_SCHEMA_INVALID')
  }
  if (!payload.namespaces || typeof payload.namespaces !== 'object' || Array.isArray(payload.namespaces)) {
    throw new Error('AIRULES_LOCALE_NAMESPACES_INVALID')
  }
  const rows = Object.entries(payload.namespaces)
  if (rows.length === 0) throw new Error('AIRULES_LOCALE_NAMESPACES_EMPTY')
  for (const [namespace, dictionary] of rows) {
    if (!NS.test(namespace) || !dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
      throw new Error(`AIRULES_LOCALE_NAMESPACE_INVALID: ${namespace}`)
    }
    const entries = Object.entries(dictionary)
    if (entries.length === 0 || entries.some(([key, value]) => !key || typeof value !== 'string')) {
      throw new Error(`AIRULES_LOCALE_DICTIONARY_INVALID: ${namespace}`)
    }
  }
  return payload
}

export function probeLocaleApi(locale) {
  const missing = ['addLanguage', 'register', 'getSnapshot'].filter(key => typeof locale?.[key] !== 'function')
  return Object.freeze({
    ...CAPABILITY,
    compatible: missing.length === 0,
    missing: Object.freeze(missing),
  })
}

export function installRussianLocale(locale, rawPayload) {
  const capability = probeLocaleApi(locale)
  if (!capability.compatible) throw new Error(`AIRULES_LOCALE_API_UNAVAILABLE: ${capability.missing.join(',')}`)
  const payload = validateLocalePayload(rawPayload)
  const locales = locale.getSnapshot()?.locales
  if (!Array.isArray(locales)) throw new Error('AIRULES_LOCALE_CATALOG_UNAVAILABLE')
  if (locales.some(row => String(row?.id).toLowerCase() === 'ru')) throw new Error('AIRULES_LOCALE_PROVIDER_CONFLICT: ru')

  const disposers = []
  try {
    disposers.push(locale.addLanguage(LANGUAGE))
    for (const [namespace, dictionary] of Object.entries(payload.namespaces)) {
      disposers.push(locale.register(namespace, 'ru', Object.freeze({ ...dictionary })))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
    throw error
  }
  let disposed = false
  return Object.freeze({
    capability,
    namespaces: Object.keys(payload.namespaces).length,
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose?.()
    },
  })
}
