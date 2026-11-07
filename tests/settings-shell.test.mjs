import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { groupSections, activeSection, visibleRows } from '../src/settings-shell/navigation.mjs'
import { patchSettingsShell, MARKER } from '../src/settings-shell/patch.mjs'
const source = readFileSync(new URL('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', import.meta.url), 'utf8')
test('group real section ledger rows without invented pages and retain unknown extensions', () => {
  const rows = [{id:'unrecognized',label:'External'}, {id:'models',label:'Models'}, {id:'general',label:'General'}, {id:'airules-onec-project',label:'Project'}, {id:'airules-mcp-manager',label:'MCP'}]
  const groups = groupSections(rows)
  assert.deepEqual(groups.map(group => group.label), ['Основное', 'Проект 1С', 'Модели и агенты', 'Инструменты и MCP', 'Другие расширения'])
  assert.equal(groups.flatMap(group => group.rows).length, rows.length)
  assert.equal(groups.at(-1).rows[0].id, 'unrecognized')
})
test('unified provider aliases disappear only when real unified section exists; old deep links still work', () => {
  const rows = [{id:'account'}, {id:'models'}, {id:'kimi'}, {id:'general'}]
  assert.equal(visibleRows(rows).length, 4)
  assert.equal(activeSection(rows, 'models'), 'models')
  rows.push({id:'airules-providers-settings'})
  assert.deepEqual(visibleRows(rows).map(row => row.id), ['general', 'airules-providers-settings'])
  assert.equal(activeSection(rows, 'models'), 'airules-providers-settings')
  assert.equal(activeSection(rows, 'kimi'), 'airules-providers-settings')
  assert.equal(activeSection(rows, 'missing'), 'general')
})
test('pinned adaptation preserves native modal/actions/onboarding/content and is idempotent', () => {
  const patched = patchSettingsShell(source)
  new Script(patched)
  assert.ok(patched.includes(MARKER))
  assert.equal(patchSettingsShell(patched), patched)
  for (const anchor of ['useModalLayer)(panel, true, onClose)', '"data-shortcut-modal": "settings"', 'renderSlot("settings.action", {})', 'renderSlot("settings.section", { close: onClose }, { only: active })', 'createSettingsShellStore()', 'shellInstance.actions.open()', 'renderSlot("settings.onboarding", {']) assert.ok(patched.includes(anchor), anchor)
  assert.ok(patched.includes('role: "group", "aria-label": group.label'))
  assert.throws(() => patchSettingsShell(source.replace('function SettingsPanel', 'function OtherPanel')), /BASELINE_CHANGED/u)
})

test('skills and import replacements retain old deep links and context grouping', () => {
  const native = [{id:'skills',label:'Skills'}, {id:'dsh-movein',label:'Import'}]
  assert.equal(visibleRows(native).length, 2)
  const rows = [...native, {id:'airules-skills'}, {id:'airules-agent-import'}]
  assert.deepEqual(visibleRows(rows).map(row => row.id), ['airules-skills', 'airules-agent-import'])
  assert.equal(activeSection(rows, 'skills'), 'airules-skills')
  assert.equal(activeSection(rows, 'dsh-movein'), 'airules-agent-import')
  assert.deepEqual(groupSections(rows).map(group => group.label), ['Контекст и история'])
})

test('extended provider sections remain available alone and route into the unified page when installed',()=>{
 const rows=[{id:'airules-api-plans'},{id:'airules-provider-drivers'}]
 assert.deepEqual(visibleRows(rows).map(row=>row.id),rows.map(row=>row.id))
 rows.push({id:'airules-providers-settings'})
 assert.deepEqual(visibleRows(rows).map(row=>row.id),['airules-providers-settings'])
 for(const id of ['airules-api-plans','airules-provider-drivers'])assert.equal(activeSection(rows,id),'airules-providers-settings')
})
