import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from '../installer/vendor/yaml/dist/index.js'
import { NATIVE_FS_COMPAT_BLOCK, validatePolicyFragment, analyzePolicyCordis, mergePolicyCordis } from '../installer/official-policy/policy-cordis.mjs'
import { migrateCordisFragments } from '../installer/official-live/cordis-migration.mjs'

const policy3 = `- insert:
    - id: preset-1c-airules
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: 1c-airules
        releaseValue: old
        userValue: initial
- insert:
    - id: airules-onec-bsl-editor
      name: dsh-bsl-editor
- id: agent-preset-registry
  config:
    default: 1c-airules
`
const compatInsert = '    - id: airules-native-fs\n      name: airules-dsh-native-fs\n'
const withCompatInsert = source => source.replace('    - id: airules-onec-bsl-editor\n', compatInsert + '    - id: airules-onec-bsl-editor\n')
const policy4 = `${withCompatInsert(policy3)}${NATIVE_FS_COMPAT_BLOCK}\n`
const userRow = '- id: user-plugin\n  name: user-owned\n  config:\n    value: keep-me\n'
const migrate = (current, before, after) => migrateCordisFragments(current, [{ oldFragment: before, newFragment: after }])
const conflict = callback => assert.throws(callback, error => error.code === 'LIVE_CORDIS_MIGRATION_CONFLICT')

test('complete shipping host block upgrades from policy37 to native-fs policy39 without admitting foreign ids', async () => {
  // Maintained source contains the complete host insert used by policy37,
  // including workflows and wave-2 skills; no ignored artifact is required.
  const full = await readFile(new URL('../src/official-preset/cordis.patch.yml', import.meta.url), 'utf8')
  for (const id of ['airules-workflows', 'airules-agent-import', 'airules-skills', 'airules-general-tools', 'airules-documents', 'airules-onec-capabilities']) assert.ok(full.includes(`    - id: ${id}\n`))
  const next = `${withCompatInsert(full.trimEnd())}\n${NATIVE_FS_COMPAT_BLOCK}\n`
  assert.equal(analyzePolicyCordis(full, next).action, 'replace')
  const migrated = mergePolicyCordis(userRow + full, next, { replaceCollisions: true }).text
  assert.ok(migrated.startsWith(userRow))
  assert.equal(analyzePolicyCordis(migrated, next).action, 'noop')
  const anchor = '    - id: airules-workflows\n'
  for (const insertion of ['    - id: foreign-plugin\n      name: foreign-plugin\n', '    - id: airules-workflows\n      name: duplicate\n']) {
    const unsafe = full.replace(anchor, insertion + anchor)
    assert.equal(analyzePolicyCordis(unsafe, next).reason, 'POLICY_CORDIS_AMBIGUOUS')
    assert.throws(() => mergePolicyCordis(unsafe, next, { replaceCollisions: true }), /POLICY_CORDIS_AMBIGUOUS/)
  }
})

test('policy accepts historical three blocks and only the coupled native disable plus compat insert', () => {
  assert.equal(validatePolicyFragment(policy3).length, 3)
  assert.equal(validatePolicyFragment(policy4).length, 4)
  for (const suffix of ['  config: {}\n', '  disabled: false\n', '  inject: []\n']) {
    assert.throws(() => validatePolicyFragment(policy4 + suffix), /POLICY_CORDIS_FRAGMENT_INVALID/)
  }
  assert.throws(() => validatePolicyFragment(policy4.replace('name: airules-dsh-native-fs', 'name: @deepseek-ai/dsh-fs-local')), /POLICY_CORDIS_FRAGMENT_INVALID/)
  assert.throws(() => validatePolicyFragment(policy4 + '- id: arbitrary\n  name: arbitrary\n'), /POLICY_CORDIS_FRAGMENT_INVALID/)
  for (const unpaired of [policy3 + NATIVE_FS_COMPAT_BLOCK + '\n', withCompatInsert(policy3),
    policy4.replace(compatInsert, compatInsert + '      config: {}\n'),
    policy4.replace(NATIVE_FS_COMPAT_BLOCK, '- id: fs-sandbox\n  name: airules-dsh-native-fs'),
  ]) assert.throws(() => validatePolicyFragment(unpaired), /POLICY_CORDIS_FRAGMENT_INVALID/)
})

test('native public composition proves name assertion is not replacement and disable plus insert selects exactly one provider', async () => {
  const { composeEntries } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  const base = [{ insert: [{ id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' }, { id: 'agent-preset-registry', name: 'native-registry' }] }]
  const badWarnings = []
  const bad = composeEntries([base, [{ id: 'fs-sandbox', name: 'airules-dsh-native-fs' }]], warning => badWarnings.push(warning))
  assert.equal(badWarnings.length, 1)
  assert.match(badWarnings[0], /name mismatch/)
  assert.equal(bad.find(row => row.id === 'fs-sandbox').name, '@deepseek-ai/dsh-fs-sandbox')
  assert.notEqual(bad.find(row => row.id === 'fs-sandbox').disabled, true)
  const warnings = []
  const composed = composeEntries([base, YAML.parse(policy4)], warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  assert.equal(composed.find(row => row.id === 'fs-sandbox').disabled, true)
  const active = composed.filter(row => ['@deepseek-ai/dsh-fs-sandbox', 'airules-dsh-native-fs'].includes(row.name) && row.disabled !== true)
  assert.deepEqual(active.map(row => [row.id, row.name]), [['airules-native-fs', 'airules-dsh-native-fs']])
  assert.equal(base[0].insert[0].disabled, undefined)
})

test('candidate policy migration owns the alias and classifies its safe removal for rollback', () => {
  assert.equal(analyzePolicyCordis(policy4, policy4).action, 'noop')
  assert.equal(analyzePolicyCordis(policy3, policy4).action, 'replace')
  assert.throws(() => mergePolicyCordis(policy3, policy4), /POLICY_CORDIS_COLLISION/)
  const upgraded = mergePolicyCordis(userRow + policy3, policy4, { replaceCollisions: true }).text
  assert.ok(upgraded.startsWith(userRow))
  assert.equal((upgraded.match(/id: fs-sandbox/g) ?? []).length, 1)
  assert.equal(analyzePolicyCordis(upgraded, policy3).action, 'replace')
  const restored = mergePolicyCordis(upgraded, policy3, { replaceCollisions: true }).text
  assert.ok(restored.startsWith(userRow))
  assert.ok(!restored.includes('id: fs-sandbox'))
})

test('candidate merge refuses an existing user filesystem override, including nested insert and extra fields', () => {
  for (const custom of [
    '- id: fs-sandbox\n  name: custom-provider\n',
    '- { "id": fs-sandbox, name: custom-provider }\n',
    '- insert:\n    - id: fs-sandbox\n      name: custom-provider\n',
    '- id: user-group\n  group: true\n  config:\n    - id: airules-native-fs\n      name: custom-provider\n',
    `${NATIVE_FS_COMPAT_BLOCK}\n  disabled: true\n`,
  ]) {
    const current = policy3 + custom
    assert.equal(analyzePolicyCordis(current, policy4).reason, 'POLICY_CORDIS_AMBIGUOUS')
    assert.throws(() => mergePolicyCordis(current, policy4, { replaceCollisions: true }), /POLICY_CORDIS_AMBIGUOUS/)
  }
})

test('live three-to-four migration preserves unrelated rows, user deltas and comments', () => {
  const current = `# user preface\n${userRow}${policy3.replace('userValue: initial', 'userValue: custom # retained choice')}`
  const next = policy4.replace('releaseValue: old', 'releaseValue: next')
  const migrated = migrate(current, policy3, next)
  assert.ok(migrated.startsWith(`# user preface\n${userRow}`))
  assert.match(migrated, /releaseValue: next/)
  assert.match(migrated, /userValue: custom # retained choice/)
  assert.equal((migrated.match(/id: fs-sandbox/g) ?? []).length, 1)
  assert.ok(migrated.endsWith(`${NATIVE_FS_COMPAT_BLOCK}\n`))
})

test('live filesystem addition refuses all preexisting provider rows rather than overwriting them', () => {
  for (const custom of [
    '- id: fs-sandbox\n  name: custom-provider\n',
    '- { "id": fs-sandbox, name: custom-provider }\n',
    `${NATIVE_FS_COMPAT_BLOCK}\n`,
    '- insert:\n    - id: fs-sandbox\n      name: custom-provider\n',
    '- id: airules-native-fs\n  name: custom-provider\n',
    '- id: user-group\n  group: true\n  config:\n    - id: airules-native-fs\n      name: custom-provider\n',
  ]) conflict(() => migrate(policy3 + custom, policy3, policy4))
})

test('live four-to-three rollback removes only the unchanged owned alias and preserves user data', () => {
  const current = `${userRow}${policy4.replace('userValue: initial', 'userValue: custom').replace(NATIVE_FS_COMPAT_BLOCK, '# keep this independent note\n' + NATIVE_FS_COMPAT_BLOCK)}`
  const migrated = migrate(current, policy4, policy3)
  assert.ok(migrated.startsWith(userRow))
  assert.match(migrated, /userValue: custom/)
  assert.match(migrated, /# keep this independent note/)
  assert.ok(!migrated.includes('id: fs-sandbox'))
  for (const custom of [
    policy4.replace('name: airules-dsh-native-fs', 'name: custom-provider'),
    policy4 + '  config: {}\n',
    policy3,
    policy4 + `${NATIVE_FS_COMPAT_BLOCK}\n`,
  ]) conflict(() => migrate(custom, policy4, policy3))
})

test('live cardinality exception does not permit arbitrary additions or provider configuration', () => {
  const arbitrary = `${policy3}- id: arbitrary\n  name: arbitrary\n`
  conflict(() => migrate(policy3, policy3, arbitrary))
  conflict(() => migrate(policy4, policy4, `${policy4}- id: arbitrary\n  name: arbitrary\n`))
  conflict(() => migrate(policy3, policy3, policy4 + '  inject: []\n'))
  const two = policy3.slice(0, policy3.indexOf('- id: agent-preset-registry'))
  conflict(() => migrate(two, two, policy3))
})

test('live native filesystem addition preserves CRLF without duplicating leading comments', () => {
  const current = (`# before\n${userRow}${policy3}`).replaceAll('\n', '\r\n')
  const migrated = migrate(current, policy3, policy4)
  assert.equal((migrated.match(/# before/g) ?? []).length, 1)
  assert.ok(!migrated.replaceAll('\r\n', '').includes('\n'))
  assert.ok(migrated.endsWith(`${NATIVE_FS_COMPAT_BLOCK.replaceAll('\n', '\r\n')}\r\n`))
})
