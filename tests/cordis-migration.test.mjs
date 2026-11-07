import test from 'node:test'
import assert from 'node:assert/strict'
import YAML from '../installer/vendor/yaml/dist/index.js'
import { migrateCordisFragments } from '../installer/official-live/cordis-migration.mjs'

const old = '- insert:\n    - id: preset-test\n      name: original\n      config:\n        note: old\n        plugins:\n          - id: original-tool\n            name: original-tool\n'
const next = old.replace('        plugins:\n', '        enabled: true\n        plugins:\n') + '          - id: added-tool\n            name: added-tool\n'
const run = (current, before = old, after = next) => migrateCordisFragments(current, [{ oldFragment: before, newFragment: after }])
test('owned fragment migration preserves foreign bytes and disjoint user settings', () => {
  const foreign = '- id: user-preferences\n  config: { preferred: "user" } # leave exactly\n'
  const current = '\uFEFF# user header\n' + old.replace('note: old', 'note: user-custom') + foreign
  const result = run(current)
  assert.ok(result.startsWith('\uFEFF# user header\n'))
  assert.ok(result.endsWith(foreign))
  const rows = YAML.parse(result)
  assert.equal(rows[0].insert[0].config.note, 'user-custom')
  assert.equal(rows[0].insert[0].config.enabled, true)
  assert.deepEqual(rows[0].insert[0].config.plugins.map(row => row.id), ['original-tool', 'added-tool'])
})
test('unchanged fragments preserve current config byte for byte', () => {
  const current = old.replace(/\n/g, '\r\n') + '# tail\r\n'
  assert.equal(run(current, old, old), current)
})
test('simultaneous conflicting edits fail without overwriting user choice', () => {
  assert.throws(() => run(old.replace('note: old', 'note: user'), old, old.replace('note: old', 'note: release')), /LIVE_CORDIS_MIGRATION_CONFLICT/)
})
test('duplicate ownership, new id collisions, aliases and unsafe tags are refused', () => {
  assert.throws(() => run(old + old), /CONFLICT/)
  assert.throws(() => run(old + '- insert:\n    - id: added-tool\n      name: foreign\n', old, old + '    - id: added-tool\n      name: added-tool\n'), /CONFLICT/)
  assert.throws(() => run(old + '- id: alias\n  config: &alias [*alias]\n'), /CONFLICT/)
  assert.throws(() => run(old + '- id: tag\n  config: !unexpected value\n'), /CONFLICT/)
})
test('native js tags remain opaque data and never execute during migration', () => {
  const tagged = old.replace('note: old', 'note: !!js "globalThis.__migrationExecuted = true"')
  const result = run(tagged, tagged, tagged.replace('name: original\n', 'name: original-next\n'))
  assert.equal(globalThis.__migrationExecuted, undefined)
  assert.match(result, /!!js/)
  assert.match(result, /name: original-next/)
})
