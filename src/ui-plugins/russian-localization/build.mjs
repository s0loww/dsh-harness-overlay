import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateLocalePayload } from './src/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const EXPECTED = Object.freeze({
  dictionary: 'de484e4ad19e95b7ed81f933933b78053c6b54e74df51e6a68c4a6442c400808',
  goodandreadyLicense: 'dc6f2fbad994189e1e1466c51173363264826fc454f0cfccdafA91a9a41b6365'.toLowerCase(),
  ragnoryokLicense: '1adb67137f56ee937175d43d4e80749241923ec2e96e0de0cc639e527431335f',
})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => `${JSON.stringify(value, null, 2)}\n`

function parseArgs(argv) {
  const result = { source: process.env.AIRULES_LOCALES_SOURCE }
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--source' || argv[i + 1] === undefined) throw new Error('USAGE: node build.mjs [--source <locales-dir>]')
    result.source = argv[i + 1]
  }
  if (!result.source) throw new Error('AIRULES_LOCALES_SOURCE_REQUIRED: use --source <locales-dir>')
  return result
}

const { source } = parseArgs(process.argv.slice(2))
const root = resolve(source)
const dictionaryBytes = await readFile(join(root, 'ru-extra.json'))
const overrideBytes = await readFile(join(here, 'data', 'overrides.ru.json'))
const goodandreadyLicense = await readFile(join(root, 'LICENSE-goodandready-dsh-russian-lang.txt'))
const ragnoryokLicense = await readFile(join(root, 'LICENSE-ragnoryok1-dsh-client-locale-ru.txt'))
if (sha256(dictionaryBytes) !== EXPECTED.dictionary) throw new Error('AIRULES_LOCALE_SOURCE_HASH_MISMATCH')
if (sha256(goodandreadyLicense) !== EXPECTED.goodandreadyLicense) throw new Error('AIRULES_LOCALE_LICENSE_HASH_MISMATCH: goodandready')
if (sha256(ragnoryokLicense) !== EXPECTED.ragnoryokLicense) throw new Error('AIRULES_LOCALE_LICENSE_HASH_MISMATCH: ragnoryok1')

const sourceDocument = JSON.parse(dictionaryBytes.toString('utf8').replace(/^\uFEFF/u, ''))
const overrideDocument = JSON.parse(overrideBytes.toString('utf8').replace(/^\uFEFF/u, ''))
if (overrideDocument.schemaVersion !== 1 || !overrideDocument.namespaces || typeof overrideDocument.namespaces !== 'object') {
  throw new Error('AIRULES_LOCALE_OVERRIDE_SCHEMA_INVALID')
}
const namespaces = { ...sourceDocument.namespaces }
for (const [namespace, dictionary] of Object.entries(overrideDocument.namespaces)) {
  namespaces[namespace] = { ...(namespaces[namespace] ?? {}), ...dictionary }
}
const payload = validateLocalePayload({
  schemaVersion: 1,
  language: 'ru',
  fallback: 'en',
  namespaces,
})
const provenance = {
  schemaVersion: 1,
  sourceRelease: '20261103-134539',
  hostVersion: '0.2.1-rc.5',
  sourceSha256: EXPECTED.dictionary,
  namespaces: Object.keys(payload.namespaces).length,
  strings: Object.values(payload.namespaces).reduce((count, dictionary) => count + Object.keys(dictionary).length, 0),
  ignoredSourceSections: ['zhRu'],
  packages: sourceDocument.source.packages,
  localOverrides: {
    file: 'data/overrides.ru.json',
    sha256: sha256(overrideBytes),
    namespaces: Object.keys(overrideDocument.namespaces).length,
    strings: Object.values(overrideDocument.namespaces).reduce((count, dictionary) => count + Object.keys(dictionary).length, 0),
  },
  officialApi: '@deepseek-ai/dsh-client-locale addLanguage/register',
}
await mkdir(join(here, 'data'), { recursive: true })
await mkdir(join(here, 'lib'), { recursive: true })
await writeFile(join(here, 'data', 'ru.json'), canonical(payload), 'utf8')
await writeFile(join(here, 'data', 'provenance.json'), canonical(provenance), 'utf8')

const embeddedPayload = JSON.stringify(payload).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
const client = `window.__ModuleLoader__.load({\n  id: "airules-dsh-russian-localization",\n  factory: (require) => {\n    var module = { exports: {} };\n    const name = "airules-dsh-russian-localization";\n    const inject = ["locale"];\n    const payload = ${embeddedPayload};\n    const LANGUAGE = Object.freeze({ id: "ru", label: "Русский", fallback: "en" });\n    function apply(ctx) {\n      const locale = ctx.locale;\n      const missing = ["addLanguage", "register", "getSnapshot"].filter(key => typeof locale?.[key] !== "function");\n      if (missing.length) throw new Error(\`AIRULES_LOCALE_API_UNAVAILABLE: \${missing.join(",")}\`);\n      const locales = locale.getSnapshot()?.locales;\n      if (!Array.isArray(locales)) throw new Error("AIRULES_LOCALE_CATALOG_UNAVAILABLE");\n      if (locales.some(row => String(row?.id).toLowerCase() === "ru")) throw new Error("AIRULES_LOCALE_PROVIDER_CONFLICT: ru");\n      const disposers = [];\n      try {\n        disposers.push(locale.addLanguage(LANGUAGE));\n        for (const [namespace, dictionary] of Object.entries(payload.namespaces)) {\n          disposers.push(locale.register(namespace, "ru", Object.freeze({ ...dictionary })));\n        }\n      } catch (error) {\n        for (const dispose of disposers.reverse()) { try { dispose?.(); } catch {} }\n        throw error;\n      }\n      ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose?.(); }, "airules: official Russian locale provider");\n    }\n    module.exports = { name, inject, apply };\n    return module.exports;\n  },\n});\n`
await writeFile(join(here, 'lib', 'client.js'), client, 'utf8')
process.stdout.write(`Built Russian locale provider: ${provenance.namespaces} namespaces, ${provenance.strings} strings\n`)
