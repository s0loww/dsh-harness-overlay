import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('MCP Manager registers complete Russian UI with correct isolated store and native security hint', async () => {
  const source = await readFile(new URL('../src/mcp-manager/lib/client.js', import.meta.url), 'utf8')
  let plugin
  const sandbox = { window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => {
      if (name === 'react') return { createElement: () => null }
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
      throw new Error(`unexpected dependency: ${name}`)
    })
  } } } }
  vm.runInNewContext(source, sandbox)
  assert.equal(sandbox.module, undefined, 'CJS compatibility object must stay factory-local')
  assert.equal(sandbox.exports, undefined)
  const dictionaries = {}, sections = []
  plugin.apply({
    locale: {
      bind: () => key => dictionaries.ru?.[key] ?? dictionaries.en?.[key] ?? key,
      register(namespace, languages) {
        assert.equal(namespace, 'mcpManager')
        Object.assign(dictionaries, languages)
        return () => {}
      },
    },
    effect: action => action(),
    slots: { inject(_slot, register) { register() }, register(section) { sections.push(section); return () => {} } },
  })
  assert.deepEqual(Object.keys(dictionaries.ru).sort(), Object.keys(dictionaries.en).sort())
  for (const [key, value] of Object.entries(dictionaries.en)) {
    const placeholders = text => [...text.matchAll(/\{([^}]+)\}/gu)].map(match => match[1]).sort()
    assert.deepEqual(placeholders(dictionaries.ru[key]), placeholders(value), key)
  }
  assert.match(dictionaries.ru.intro, /\$DSH_HOME\/airules-mcp-servers\.json/u)
  assert.match(dictionaries.en.intro, /\$DSH_HOME\/airules-mcp-servers\.json/u)
  assert.match(dictionaries.ru.tokenHint, /авторизацией DSH и CSRF/u)
  assert.match(dictionaries.ru.tokenHint, /не токен подключаемого MCP/u)
  assert.equal(dictionaries.ru.title, 'Менеджер MCP-серверов')
  assert.equal(sections[0].name, 'settings.section')
})
