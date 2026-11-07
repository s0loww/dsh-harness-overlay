import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CandidateCycleError, orderAppliedReceipts } from '../scripts/cycle-official-candidate.mjs'

const file = value => ({ type: 'file', sha256: value.repeat(64).slice(0, 64), bytes: 1 })
const missing = { type: 'missing' }

function receipt(layer, name, operations) {
  return {
    layer,
    receiptPath: `fixture/${name}/receipt.json`,
    receipt: { operations },
  }
}

test('combined cycle unwinds the complete migration chain in reverse dependency order', () => {
  const s0 = file('0'), s1 = file('1'), s2 = file('2'), s3 = file('3')
  const uiOld = receipt('ui', 'ui-old', [
    { target: 'home/profiles/desktop/cordis.patch.yml', before: s0, after: s1 },
    { target: 'ui-ready.json', before: missing, after: file('a') },
  ])
  const policyOld = receipt('policy', 'policy-old', [
    { target: 'home/profiles/desktop/cordis.patch.yml', before: s1, after: s2 },
    { target: 'policy-ready.json', before: missing, after: file('b') },
  ])
  const uiCurrent = receipt('ui', 'ui-current', [
    { target: 'home/profiles/desktop/cordis.patch.yml', before: s2, after: s2 },
    { target: 'ui-ready.json', before: file('a'), after: file('c') },
  ])
  const policyCurrent = receipt('policy', 'policy-current', [
    { target: 'home/profiles/desktop/cordis.patch.yml', before: s2, after: s3 },
    { target: 'policy-ready.json', before: file('b'), after: file('d') },
  ])
  const ordered = orderAppliedReceipts([uiOld, policyOld, uiCurrent, policyCurrent])
  assert.deepEqual(ordered.map(entry => entry.receiptPath), [
    'fixture/policy-current/receipt.json',
    'fixture/ui-current/receipt.json',
    'fixture/policy-old/receipt.json',
    'fixture/ui-old/receipt.json',
  ])
})

test('combined cycle rejects a cyclic or contradictory receipt history', () => {
  const a = receipt('ui', 'a', [{ target: 'shared', before: file('0'), after: file('1') }])
  const b = receipt('policy', 'b', [{ target: 'shared', before: file('1'), after: file('0') }])
  assert.throws(() => orderAppliedReceipts([a, b]), error => error instanceof CandidateCycleError && error.code === 'RECEIPT_DEPENDENCY_CYCLE')
})

test('combined cycle is read-only by default and re-applies UI before policy only after explicit execute', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../scripts/cycle-official-candidate.mjs'), 'utf8')
  assert.match(source, /const result = \{ execute: false \}/u)
  assert.match(source, /if \(key === '--execute'\)/u)
  assert.match(source, /if \(!args\.execute\) \{/u)
  assert.match(source, /await applyOfficialUi[\s\S]+await applyOfficialPolicy/u)
  assert.match(source, /assertCandidatePath\(candidateRoot\)/u)
  assert.match(source, /assertOwnsAfterState/u)
  assert.match(source, /OVERLAY_MARKER_REMAINS/u)
  assert.match(source, /mkdir\(dirname\(runRoot\), \{ recursive: true \}\)/u)
  assert.match(source, /await lock\?\.close\(\)[\s\S]+await rm\(lockPath, \{ force: true \}\)[\s\S]+throw error/u)
})
