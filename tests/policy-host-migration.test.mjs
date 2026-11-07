import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzePolicyCordis, mergePolicyCordis } from '../installer/official-policy/policy-cordis.mjs'

const fragment = host => `- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n- insert:\n${host}    - id: airules-onec-bsl-editor\n      name: dsh-bsl-editor\n- id: agent-preset-registry\n  config:\n    default: 1c-airules\n`
const old = fragment('    - id: airules-openspec\n      name: dsh-openspec-workflow\n')
const next = fragment('    - id: airules-openspec\n      name: dsh-openspec-workflow\n    - id: airules-telegram\n      name: airules-dsh-telegram\n')

test('dedicated known host integrations are replaceable and idempotent', () => {
  assert.equal(analyzePolicyCordis(old, next).replaceable, true)
  assert.equal(analyzePolicyCordis(old, old).action, 'noop')
  const ui = '- insert:\n    - id: ui-preserved\n      name: ui-preserved\n'
  const merged = mergePolicyCordis(ui + old, next, { replaceCollisions: true }).text
  assert.ok(merged.startsWith(ui))
  assert.equal(merged.split('id: airules-openspec').length - 1, 1)
  assert.equal(merged.split('id: airules-telegram').length - 1, 1)
})

test('a foreign neighbour or duplicated host id still prevents replacement', () => {
  const foreign = old.replace('    - id: airules-onec-bsl-editor', '    - id: foreign-plugin\n      name: foreign\n    - id: airules-onec-bsl-editor')
  const duplicate = old.replace('    - id: airules-onec-bsl-editor', '    - id: airules-openspec\n      name: dsh-openspec-workflow\n    - id: airules-onec-bsl-editor')
  for (const current of [foreign, duplicate]) {
    assert.equal(analyzePolicyCordis(current, next).replaceable, false)
    assert.throws(() => mergePolicyCordis(current, next, { replaceCollisions: true }), /POLICY_CORDIS_AMBIGUOUS/)
  }
})
