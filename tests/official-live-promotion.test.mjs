import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { applyLivePromotion, stagePackage } from '../installer/official-live/apply.mjs'
import { assertPromotionPaths, directoryStateWithNested, exactSubset, liveProfileStageRoot, LIVE_ACKNOWLEDGEMENT, PROMOTION_BACKUPS_ROOT } from '../installer/official-live/common.mjs'
import { directoryState, sameState, targetState } from '../installer/fs-state.mjs'
import { rollbackLivePromotion } from '../installer/official-live/rollback.mjs'

const REPO = resolve(import.meta.dirname, '..')

test('live promotion paths require explicit isolated roots and a direct backup child', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-live-promotion-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const install = join(fixture, 'install'), profile = join(fixture, 'profile')
  await mkdir(install); await mkdir(profile)
  const backup = join(PROMOTION_BACKUPS_ROOT, `fixture-${process.pid}`)
  assert.deepEqual(assertPromotionPaths({ installRoot: install, profileRoot: profile, backupRoot: backup }), {
    install: resolve(install), profile: resolve(profile), backup: resolve(backup),
  })
  assert.throws(() => assertPromotionPaths({ installRoot: install, profileRoot: join(install, 'profile'), backupRoot: backup }), error => error.code === 'LIVE_ROOTS_OVERLAP')
  assert.throws(() => assertPromotionPaths({ installRoot: install, profileRoot: profile, backupRoot: join(backup, 'nested') }), error => error.code === 'LIVE_BACKUP_NOT_DIRECT_CHILD')
  assert.throws(() => assertPromotionPaths({ installRoot: install, profileRoot: profile, backupRoot: profile }), error => error.code === 'LIVE_BACKUP_OVERLAPS_TARGET')
})

test('apply and rollback reject mutation before filesystem work without exact acknowledgement', async () => {
  await assert.rejects(applyLivePromotion({}), error => error.code === 'LIVE_ACKNOWLEDGEMENT_REQUIRED')
  await assert.rejects(rollbackLivePromotion({}), error => error.code === 'LIVE_ACKNOWLEDGEMENT_REQUIRED')
  assert.equal(LIVE_ACKNOWLEDGEMENT, 'I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_MODIFIES_ITS_PROFILE')
})

test('promotion is certification-gated and candidate installers remain live-fail-closed', async () => {
  const common = await readFile(resolve(REPO, 'installer/official-live/common.mjs'), 'utf8')
  const candidateCommon = await readFile(resolve(REPO, 'installer/official-ui/common.mjs'), 'utf8')
  assert.match(common, /passed-visible-startup/u)
  assert.match(common, /CERTIFICATION_VISIBLE_SMOKE_REQUIRED/u)
  assert.match(common, /targetRelative: `node_modules\/\$\{row\.name\}`/u)
  assert.match(common, /targetRelative: 'cordis\.patch\.yml'/u)
  assert.match(candidateCommon, /LIVE_PATH_FORBIDDEN/u)
  assert.match(candidateCommon, /overlap\(root, LIVE_INSTALL\) \|\| overlap\(root, LIVE_HOME\)/u)
})

test('shared dependency no-op accepts only an exact artifact subset with declaration/map extras', () => {
  const file = (sha256, bytes = 1) => ({ sha256, bytes })
  const source = { type: 'directory', files: { 'package.json': file('a'), 'lib/index.js': file('b') } }
  const compatible = { type: 'directory', files: { ...source.files, 'lib/index.d.ts': file('c'), 'lib/index.d.cts': file('d'), 'lib/index.js.map': file('e') } }
  assert.equal(exactSubset(source, compatible), true)
  assert.equal(exactSubset(source, { ...compatible, files: { ...compatible.files, 'README.md': file('e') } }), false)
  assert.equal(exactSubset(source, { ...compatible, files: { ...compatible.files, 'lib/index.js': file('changed') } }), false)
})

test('storage-domain composite state nests exact zod without replacing top-level zod', async () => {
  const parent = { type: 'directory', files: { 'package.json': { sha256: 'a', bytes: 1 }, 'lib/index.js': { sha256: 'b', bytes: 1 } } }
  const zod = { type: 'directory', files: { 'package.json': { sha256: 'c', bytes: 1 }, 'index.js': { sha256: 'd', bytes: 1 } } }
  const combined = directoryStateWithNested(parent, 'zod', zod)
  assert.deepEqual(Object.keys(combined.files), ['lib/index.js', 'node_modules/zod/index.js', 'node_modules/zod/package.json', 'package.json'])
  const common = await readFile(resolve(REPO, 'installer/official-live/common.mjs'), 'utf8')
  const apply = await readFile(resolve(REPO, 'installer/official-live/apply.mjs'), 'utf8')
  const rollback = await readFile(resolve(REPO, 'installer/official-live/rollback.mjs'), 'utf8')
  assert.match(common, /copy-directory-with-nested-dependency/u)
  assert.match(common, /if \(row\.name === NESTED_ZOD\) continue/u)
  assert.match(apply, /operation\.nestedDependency\.source/u)
  assert.match(rollback, /LIVE_RECEIPT_DEPENDENCY_RESOLUTION_INVALID/u)
})

test('composite staging writes zod only below storage-domain and verifies the combined state', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-live-composite-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const storage = join(fixture, 'storage'), zod = join(fixture, 'zod'), stage = join(fixture, 'stage-storage')
  await mkdir(join(storage, 'lib'), { recursive: true }); await mkdir(zod)
  await writeFile(join(storage, 'package.json'), '{"name":"@deepseek-ai/dsh-storage-domain","version":"0.2.1-rc.5"}')
  await writeFile(join(storage, 'lib/index.js'), 'storage')
  await writeFile(join(zod, 'package.json'), '{"name":"zod","version":"4.4.3"}')
  await writeFile(join(zod, 'index.js'), 'nested-zod')
  const after = directoryStateWithNested(await directoryState(storage), 'zod', await directoryState(zod))
  await stagePackage({ type: 'copy-directory-with-nested-dependency', source: storage, targetRelative: 'node_modules/@deepseek-ai/dsh-storage-domain', after,
    nestedDependency: { source: zod, targetRelative: 'node_modules/zod' } }, stage)
  assert.equal(sameState(await targetState(stage), after), true)
  assert.equal((await targetState(join(stage, 'node_modules/zod'))).type, 'directory')
  assert.equal((await targetState(join(fixture, 'node_modules/zod'))).type, 'missing')
})

test('apply and rollback stage below profile instead of the external backup volume', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-live-same-volume-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const applyStage = liveProfileStageRoot(profile, 'apply', '1234567890abcdef')
  const rollbackStage = liveProfileStageRoot(profile, 'rollback', 'abcdef1234567890')
  for (const stage of [applyStage, rollbackStage]) {
    assert.equal(relative(profile, stage).startsWith('..'), false)
    assert.equal(stage.startsWith(PROMOTION_BACKUPS_ROOT), false)
  }
  await mkdir(join(applyStage, 'node_modules/pkg'), { recursive: true })
  await writeFile(join(applyStage, 'node_modules/pkg/package.json'), '{}')
  const target = join(profile, 'node_modules/pkg')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await rename(join(applyStage, 'node_modules/pkg'), target)
  assert.equal((await targetState(target)).type, 'directory')
  const apply = await readFile(resolve(REPO, 'installer/official-live/apply.mjs'), 'utf8')
  const rollback = await readFile(resolve(REPO, 'installer/official-live/rollback.mjs'), 'utf8')
  assert.doesNotMatch(apply, /join\(plan\.backupRoot, ['"]stage['"]\)/u)
  assert.doesNotMatch(rollback, /join\(paths\.backup, ['"]rollback-stage['"]\)/u)
  assert.match(apply, /liveProfileStageRoot\(plan\.profileRoot, 'apply'/u)
  assert.match(rollback, /liveProfileStageRoot\(paths\.profile, 'rollback'/u)
})
