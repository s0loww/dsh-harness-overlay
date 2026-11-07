import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute, sep } from 'node:path'
import { inspectPackageClosure, stagePackageClosure } from '../scripts/stage-package-closure.mjs'

async function fixture(t, { mandatory = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'airules-native-fs-closure-'))
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root))
    assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && rel.startsWith('airules-native-fs-closure-'))
    await rm(root, { recursive: true, force: true })
  })
  const modulesRoot = join(root, 'source'), targetModulesRoot = join(root, 'staged')
  await mkdir(modulesRoot)
  const put = async (name, version, extra = {}) => {
    const path = join(modulesRoot, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, ...extra }))
    await writeFile(join(path, 'index.js'), `export const identity = '${name}@${version}'\n`)
  }
  await put('native-owner', '1.0.0', { dependencies: { 'runtime-required': '2.0.0' },
    optionalDependencies: { 'native-win': '3.0.0', 'native-linux': '3.0.0' } })
  if (mandatory) await put('runtime-required', '2.0.0')
  await put('native-win', '3.0.0')
  return { modulesRoot, targetModulesRoot, roots: { 'native-owner': '1.0.0' }, selection: { 'native-owner': ['native-win'] } }
}

test('closure still rejects a missing optional package unless a platform selection is explicit', async t => {
  const f = await fixture(t)
  await assert.rejects(inspectPackageClosure(f), /CLOSURE_DEPENDENCY_MISSING: native-linux/)
  await assert.rejects(inspectPackageClosure({ ...f, optionalDependencySelection: {} }), /CLOSURE_DEPENDENCY_MISSING: native-linux/)
})

test('explicit platform selection is locked and stages exact selected identity plus mandatory dependencies', async t => {
  const f = await fixture(t)
  const lock = await inspectPackageClosure({ ...f, optionalDependencySelection: f.selection })
  assert.deepEqual(lock.optionalDependencySelection, f.selection)
  assert.deepEqual(lock.packages.map(row => [row.name, row.version]), [
    ['native-owner', '1.0.0'], ['native-win', '3.0.0'], ['runtime-required', '2.0.0'],
  ])
  assert.deepEqual(await stagePackageClosure({ ...f, lock }), lock)
  assert.deepEqual(await inspectPackageClosure({ modulesRoot: f.targetModulesRoot, roots: f.roots, optionalDependencySelection: f.selection }), lock)
  const manifest = JSON.parse(await readFile(join(f.targetModulesRoot, 'native-win/package.json'), 'utf8'))
  assert.equal(manifest.name, 'native-win')
  assert.equal(manifest.version, '3.0.0')
  await assert.rejects(readFile(join(f.targetModulesRoot, 'native-linux/package.json')), { code: 'ENOENT' })
  await writeFile(join(f.modulesRoot, 'native-win/index.js'), 'source drift\n')
  await assert.rejects(stagePackageClosure({ ...f, targetModulesRoot: join(f.targetModulesRoot, 'again'), lock }), /CLOSURE_LOCK_MISMATCH/)
})

test('optional selection refuses unknown, unused and malformed names instead of silently ignoring them', async t => {
  const f = await fixture(t)
  await assert.rejects(inspectPackageClosure({ ...f, optionalDependencySelection: { 'native-owner': ['not-declared'] } }), /CLOSURE_OPTIONAL_SELECTION_UNKNOWN/)
  await assert.rejects(inspectPackageClosure({ ...f, optionalDependencySelection: { ...f.selection, 'not-visited': ['native-win'] } }), /CLOSURE_OPTIONAL_SELECTION_UNUSED/)
  for (const selection of [null, [], { 'native-owner': [] }, { 'native-owner': ['native-win', 'native-win'] }, { 'native-owner': ['../escape'] }]) {
    await assert.rejects(inspectPackageClosure({ ...f, optionalDependencySelection: selection }), /CLOSURE_OPTIONAL_SELECTION_INVALID/)
  }
})

test('platform selection cannot hide missing mandatory dependencies or a substituted binary package identity', async t => {
  const missing = await fixture(t, { mandatory: false })
  await assert.rejects(inspectPackageClosure({ ...missing, optionalDependencySelection: missing.selection }), /CLOSURE_DEPENDENCY_MISSING: runtime-required/)
  const substituted = await fixture(t)
  await writeFile(join(substituted.modulesRoot, 'native-win/package.json'), JSON.stringify({ name: 'other-binary', version: '3.0.0' }))
  await assert.rejects(inspectPackageClosure({ ...substituted, optionalDependencySelection: substituted.selection }), /CLOSURE_DEPENDENCY_IDENTITY_INVALID: native-win/)
})
