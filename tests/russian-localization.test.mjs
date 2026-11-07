import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { installRussianLocale, probeLocaleApi, validateLocalePayload } from '../src/ui-plugins/russian-localization/src/core.mjs'

const payload = {
  schemaVersion: 1,
  language: 'ru',
  fallback: 'en',
  namespaces: {
    common: { save: 'Сохранить' },
    settings: { title: 'Настройки' },
  },
}

function localeFixture({ languages = [{ id: 'en', label: 'English' }], failNamespace } = {}) {
  const calls = []
  const active = new Map()
  return {
    calls,
    active,
    getSnapshot() { return { active: 'en', locales: languages } },
    addLanguage(language) {
      calls.push(['addLanguage', language])
      active.set('language', language)
      return () => active.delete('language')
    },
    register(namespace, language, dictionary) {
      calls.push(['register', namespace, language, dictionary])
      if (namespace === failNamespace) throw new Error('fixture failure')
      active.set(namespace, dictionary)
      return () => active.delete(namespace)
    },
  }
}

test('uses official locale API without forcing preference or monkeypatching methods', () => {
  const locale = localeFixture()
  const originalRegister = locale.register
  const installed = installRussianLocale(locale, payload)
  assert.equal(installed.namespaces, 2)
  assert.equal(locale.register, originalRegister)
  assert.equal('setLocale' in locale, false)
  assert.deepEqual(locale.calls.map(call => call.slice(0, 3)), [
    ['addLanguage', { id: 'ru', label: 'Русский', fallback: 'en' }],
    ['register', 'common', 'ru'],
    ['register', 'settings', 'ru'],
  ])
  installed.dispose()
  assert.equal(locale.active.size, 0)
})

test('fails closed for unknown API and an existing Russian provider', () => {
  assert.deepEqual(probeLocaleApi({}).missing, ['addLanguage', 'register', 'getSnapshot'])
  assert.throws(() => installRussianLocale({}, payload), /API_UNAVAILABLE/u)
  assert.throws(() => installRussianLocale(localeFixture({ languages: [{ id: 'en' }, { id: 'RU' }] }), payload), /PROVIDER_CONFLICT/u)
})

test('rolls back every completed registration after a partial failure', () => {
  const locale = localeFixture({ failNamespace: 'settings' })
  assert.throws(() => installRussianLocale(locale, payload), /fixture failure/u)
  assert.equal(locale.active.size, 0)
})

test('validates data-only dictionaries and generated plugin provenance', async () => {
  assert.equal(validateLocalePayload(payload), payload)
  assert.throws(() => validateLocalePayload({ ...payload, namespaces: { common: { save: 1 } } }), /DICTIONARY_INVALID/u)
  const root = new URL('../src/ui-plugins/russian-localization/', import.meta.url)
  const provenance = JSON.parse(await readFile(new URL('data/provenance.json', root), 'utf8'))
  assert.equal(provenance.sourceSha256, 'de484e4ad19e95b7ed81f933933b78053c6b54e74df51e6a68c4a6442c400808')
  assert.equal(provenance.namespaces, 216)
  assert.equal(provenance.strings, 24320)
  assert.equal(provenance.localOverrides.namespaces, 1)
  assert.equal(provenance.localOverrides.strings, 39)
  const generated = JSON.parse(await readFile(new URL('data/ru.json', root), 'utf8'))
  assert.equal(generated.namespaces['dsh-sleep-send']['schedule.short'], 'Таймер')
  assert.equal(generated.namespaces['dsh-sleep-send']['schedule.settings'], 'Настройка отложенной отправки')
  const client = await readFile(new URL('lib/client.js', root), 'utf8')
  const builder = await readFile(new URL('build.mjs', root), 'utf8')
  assert.match(client, /locale\.addLanguage\(LANGUAGE\)/u)
  assert.doesNotMatch(client, /locale\.register\s*=/u)
  assert.doesNotMatch(client, /locale\.setLocale/u)
  assert.doesNotMatch(client, /\.desktop-local|mcp-servers\.json|[A-Za-z]:[\\/](?:Users|Work|AI_Projects)[\\/]/u)
  assert.doesNotMatch(builder, /[A-Za-z]:[\\/](?:Users|Work|AI_Projects)[\\/]/u)
})
