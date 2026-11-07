import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applyReleasePatchFile, assertPatchMatchesBaseline, validateReleasePatch } from '../src/release-patch.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('declares one pinned 1c-airules preset patch with no runtime-state targets', async () => {
  const [spec, baseline] = await Promise.all([
    readFile(new URL('../patches/20261103-134539/project-preset-1c-airules.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../upstream/release.lock.json', import.meta.url), 'utf8').then(JSON.parse),
  ])
  assert.equal(assertPatchMatchesBaseline(spec, baseline), spec)
  assert.deepEqual(spec.preset, { id: '1c-airules', label: '1С' })
  assert.equal(spec.files.length, 7)
  assert.ok(spec.files.every(file => !file.target.includes('.desktop-local') && !file.target.includes('.dsh-1c')))
  assert.deepEqual(Object.fromEntries(spec.files.map(file => [file.target, file.resultSha256])), {
    'scripts/repair-agent-preset.mjs': '9e5ea3d3eb3b4824b8427f0b99e8f7918d805e1bf97fd022e818d662fea38297',
    'dsh-1c-bundle/lib/project-presets.js': '197f259f82ce84a94d1a2c8d2f1cd5cdd683ccaaaf1518b20b1b09173ea04871',
    'dsh-1c-bundle/lib/developer-experience.js': 'b8a0fb5f5523a89a0c1f4a0d0a2e1026ba387c8018f403fdc997cb5ca27bfc7f',
    'dsh-1c-bundle/lib/client.js': '9c41037b85c0ac014b976fb2146830016e8eaa28e36e2d3d5e241e7d7450a4e9',
    'dsh-1c-bundle/lib/project-wizard.js': 'af6948f4991eea58c13bfbc0b1d26af35f078e4a72cb3d4b7e2d306f683c4d6d',
    'dsh-1c-bundle/node_modules/dsh-1c-project-wizard/lib/client.js': 'c9fbde17fc37778d2148254888190b8ce062ebdeee99d063819885b0466a021e',
    'dsh-1c-bundle/vendor/project-wizard/lib/client.js': 'c9fbde17fc37778d2148254888190b8ce062ebdeee99d063819885b0466a021e',
  })
})

test('patch semantics expose one 1C label, retain legacy ids and scope airules', async () => {
  const spec = JSON.parse(await readFile(new URL('../patches/20261103-134539/project-preset-1c-airules.json', import.meta.url), 'utf8'))
  const replacementText = target => spec.files.find(file => file.target === target).replacements.map(operation => operation.to).join('\n')
  const presets = replacementText('dsh-1c-bundle/lib/project-presets.js')
  assert.match(presets, /id: '1c-airules', label: '1С'/u)
  assert.match(presets, /id: '1c-lite'.*id: '1c-full'.*id: '1c-only'/su)
  assert.match(presets, /preset \?\? '1c-airules'/u)
  assert.match(presets, /full, airules: preset === '1c-airules'/u)
  assert.match(presets, /airulesTools.*airules_rule.*airules_role.*airules_verification/su)
  assert.match(presets, /skill\.provider === 'airules-rulepack'.*features\.airules/su)
  const repair = replacementText('scripts/repair-agent-preset.mjs')
  assert.match(repair, /'1c-airules'.*persona\.config\.prefix/su)
  assert.match(repair, /default: '1c-airules'/u)
  const api = replacementText('dsh-1c-bundle/lib/developer-experience.js')
  assert.match(api, /preset: '1c-airules', openspec: false, atlassian: false/u)
  const wizard = replacementText('dsh-1c-bundle/lib/project-wizard.js')
  assert.match(wizard, /\['1c-airules', '1c-lite'\]/u)
  assert.match(wizard, /preset: input\.preset/u)
})

test('exact patch engine verifies source, replacement cardinality and result', () => {
  const source = Buffer.from('alpha\r\nbeta\r\n')
  const result = Buffer.from('alpha\r\ngamma\r\n')
  const file = {
    target: 'lib/example.js',
    sourceSha256: hash(source),
    resultSha256: hash(result),
    replacements: [{ from: 'beta', to: 'gamma', count: 1 }],
  }
  assert.deepEqual(applyReleasePatchFile(source, file), result)
  assert.throws(() => applyReleasePatchFile(Buffer.from('changed'), file), /SOURCE_HASH_MISMATCH/u)
  assert.throws(() => applyReleasePatchFile(source, { ...file, replacements: [{ ...file.replacements[0], count: 2 }] }), /MATCH_COUNT_MISMATCH/u)
})

test('rejects runtime-state and duplicate patch targets', () => {
  const base = {
    schemaVersion: 1,
    id: 'project-preset-1c-airules',
    releaseId: 'r1',
    preset: { id: '1c-airules', label: '1С' },
    files: [{
      target: 'lib/example.js', sourceSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64),
      replacements: [{ from: 'a', to: 'b', count: 1 }],
    }],
  }
  assert.equal(validateReleasePatch(base), base)
  assert.throws(() => validateReleasePatch({ ...base, files: [{ ...base.files[0], target: '.desktop-local/state' }] }), /RUNTIME_STATE_FORBIDDEN/u)
  assert.throws(() => validateReleasePatch({ ...base, files: [base.files[0], base.files[0]] }), /DUPLICATE_TARGET/u)
})
