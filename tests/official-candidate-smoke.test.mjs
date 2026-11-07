import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  assertCandidatePath,
  assertCordisIds,
  assertNoLiveReferences,
  CandidateSmokeError,
  validatePackage,
} from '../scripts/smoke-official-candidate.mjs'

const REPO = resolve(import.meta.dirname, '..')

test('candidate smoke accepts only a direct candidate child', () => {
  const candidate = resolve(REPO, 'var/candidate/fixture-01')
  assert.equal(assertCandidatePath(candidate), candidate)
  for (const unsafe of [
    resolve(REPO, 'var/candidate'),
    resolve(REPO, 'var/candidate/fixture-01/nested'),
    'C:/Users/S0lo/.dsh',
  ]) assert.throws(() => assertCandidatePath(unsafe), CandidateSmokeError)
})

test('candidate smoke requires every staged Cordis id exactly once', () => {
  const ui = '- insert:\n    - id: ui-a\n      name: package-a\n'
  const policy = '- insert:\n    - id: policy-a\n      name: package-b\n'
  assert.deepEqual(assertCordisIds(`${ui}${policy}`, [ui, policy]), ['ui-a', 'policy-a'])
  assert.throws(() => assertCordisIds(`${ui}${ui}${policy}`, [ui, policy]), error => error.code === 'CORDIS_ID_COUNT_INVALID')
})

test('candidate smoke rejects live profile and install references', () => {
  assert.doesNotThrow(() => assertNoLiveReferences([['candidate', 'var/candidate/fixture-01/home']]))
  for (const value of [
    'C:\\Users\\S0lo\\.dsh\\profiles\\desktop',
    'C:\\Users\\S0lo\\AppData\\Local\\Programs\\DeepSeek Harness',
  ]) assert.throws(() => assertNoLiveReferences([['fixture', value]]), error => error.code === 'LIVE_REFERENCE_DETECTED')
})

test('launcher is hidden by default and visible mode is explicit opt-in', async () => {
  const launcher = await readFile(resolve(REPO, 'scripts/launch-official-candidate.ps1'), 'utf8')
  const smoke = await readFile(resolve(REPO, 'scripts/smoke-official-candidate.mjs'), 'utf8')
  assert.match(launcher, /\[switch\]\$Visible/u)
  assert.match(launcher, /if \(\$Visible\) \{ \$arguments \+= '--visible' \}/u)
  assert.match(smoke, /windowsHide: !visible/u)
  assert.match(smoke, /DSH_HOME: preflight\.homeRoot/u)
  assert.match(smoke, /DSH_TELEMETRY: 'off'/u)
  assert.match(smoke, /--user-data-dir=\$\{preflight\.userDataRoot\}/u)
  assert.match(smoke, /visible \? 'passed-visible-startup' : 'passed-hidden-startup'/u)
  assert.match(smoke, /args\.visible \? 'visible' : 'hidden'/u)
})

test('package preflight accepts only the exact manifest-based rulepack exception', async t => {
  const profile = await mkdtemp(resolve(tmpdir(), 'candidate-profile-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const root = resolve(profile, 'node_modules/airules-dsh-rulepack')
  await mkdir(root, { recursive: true })
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'test.1' } }))
  assert.deepEqual(await validatePackage(profile, 'airules-dsh-rulepack'), {
    name: 'airules-dsh-rulepack', version: 'test.1', identity: 'manifest.json#package', clientExport: null,
  })
  await mkdir(resolve(profile, 'node_modules/not-rulepack'), { recursive: true })
  await assert.rejects(validatePackage(profile, 'not-rulepack'), error => error.code === 'PACKAGE_JSON_INVALID')
})

test('package preflight resolves an exact nested dependency before profile-level fallback', async t => {
  const profile = await mkdtemp(resolve(tmpdir(), 'candidate-profile-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const root = resolve(profile, 'node_modules/editor')
  const nested = resolve(root, 'node_modules/dependency')
  await mkdir(nested, { recursive: true })
  await writeFile(resolve(root, 'index.js'), '')
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'editor', version: '1.0.0', main: 'index.js', dependencies: { dependency: '1.0.0' } }))
  await writeFile(resolve(nested, 'package.json'), JSON.stringify({ name: 'dependency', version: '1.0.0' }))
  const result = await validatePackage(profile, 'editor')
  assert.equal(result.name, 'editor')
  assert.equal(result.identity, 'package.json')
})
