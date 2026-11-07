import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analyzeUiCordis, mergeUiCordis, validateUiCordisFragment } from '../installer/official-ui/ui-cordis.mjs'

test('unified provider UI upgrades the exact old owned block and retains foreign neighbours', async () => {
  const old = await readFile(new URL('../dist/airules-ui-overlay-0.1.0-dev5/cordis.ui.fragment.yml', import.meta.url), 'utf8')
  const next = await readFile(new URL('../dist/airules-ui-overlay-0.1.0-dev9/cordis.ui.fragment.yml', import.meta.url), 'utf8')
  validateUiCordisFragment(old); validateUiCordisFragment(next)
  const neighbour = '\n- id: unrelated\n  config:\n    enabled: true\n'
  assert.equal(analyzeUiCordis(old + neighbour, next).action, 'replace')
  const result = mergeUiCordis(old + neighbour, next, { replaceCollision: true }).text
  assert.ok(result.endsWith(neighbour))
  assert.equal(analyzeUiCordis(result, next).action, 'noop')
  assert.equal(analyzeUiCordis(old.replace('    - id: tokenledger', '    - id: unknown\n      name: unknown\n    - id: tokenledger'), next).action, 'refuse')
})
