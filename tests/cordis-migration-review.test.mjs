import test from 'node:test'
import assert from 'node:assert/strict'
import YAML from '../installer/vendor/yaml/dist/index.js'
import { migrateCordisFragments } from '../installer/official-live/cordis-migration.mjs'
const run = (current, oldFragment, newFragment) => migrateCordisFragments(current, [{ oldFragment, newFragment }])
test('review: a preceding foreign comment is preserved exactly once when the following managed block changes', () => {
  const old = '- id: managed\n  config:\n    enabled: false\n'
  const next = old.replace('false', 'true')
  const current = '- id: foreign-before\n  name: custom\n# operator note for this managed block\n' + old + '- id: foreign-after\n  name: custom\n'
  const result = run(current, old, next)
  assert.equal(result.match(/# operator note for this managed block/gu)?.length, 1, result)
})
test('review: release id-array ordering is applied with a disjoint user setting change inside one row', () => {
  const old = '- id: managed\n  config:\n    plugins:\n      - id: alpha\n        config: { note: old }\n      - id: beta\n'
  const next = '- id: managed\n  config:\n    plugins:\n      - id: beta\n      - id: alpha\n        config: { note: old }\n'
  const current = old.replace('note: old', 'note: custom')
  const result = YAML.parse(run(current, old, next))
  assert.deepEqual(result[0].config.plugins.map(row => row.id), ['beta', 'alpha'])
  assert.equal(result[0].config.plugins[1].config.note, 'custom')
})
test('review: disjoint release changes do not erase nested user comments', () => {
  const old = '- id: managed\n  config:\n    note: old\n'
  const next = old + '    enabled: true\n'
  const current = old.replace('note: old', 'note: old # local operational note')
  const result = run(current, old, next)
  assert.match(result, /# local operational note/u)
})
test('review: preset-local ids remain independent from foreign profile-root ids', () => {
  const old = '- id: managed-preset\n  name: "@deepseek-ai/dsh-agent-preset"\n  config:\n    id: example-preset\n    plugins:\n      - id: existing\n'
  const next = old + '      - id: foreign-id\n'
  const current = old + '- id: foreign-id\n  name: user-owned\n'
  const result = YAML.parse(run(current, old, next))
  assert.equal(result[0].config.plugins[1].id, 'foreign-id')
  assert.equal(result[1].id, 'foreign-id')
  assert.equal(result[1].name, 'user-owned')
})
