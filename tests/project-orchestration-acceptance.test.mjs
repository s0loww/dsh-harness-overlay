import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotSource, assertOriginalUnchanged, summarizeLint, assessAcceptance } from '../scripts/probe-project-orchestration.mjs'

test('real source snapshot is bounded, exact and refuses config/traversal or writeback locations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'project-acceptance-')); t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'original'); await mkdir(project)
  const original = Buffer.from('\ufeffФункция Пример() Экспорт\r\nВозврат 42;\r\nКонецФункции\r\n')
  await writeFile(join(project, 'Module.bsl'), original)
  const snapshot = await snapshotSource(project, 'Module.bsl', join(root, 'copy'))
  assert.deepEqual(await readFile(snapshot.target), original)
  await writeFile(snapshot.target, 'isolated change')
  assert.equal(await assertOriginalUnchanged(snapshot), true)
  for (const relative of ['../Module.bsl', '.env', 'nested/../Module.bsl']) await assert.rejects(snapshotSource(project, relative, join(root, 'forbidden')))
  await assert.rejects(snapshotSource(project, 'Module.bsl', join(project, 'nested')), /READ_ONLY/)
  await writeFile(join(project, 'Module.bsl'), 'concurrent original edit')
  await assert.rejects(assertOriginalUnchanged(snapshot), /SOURCE_CHANGED/)
})

test('real diagnostic evidence is retained and a deterministic tool chain is never model certification', () => {
  const summary = summarizeLint({ fileinfos: [{ metrics: { functions: 1 }, diagnostics: [{ code: 'SpaceAtStartComment' }, { code: 'MissingReturnedValueDescription' }] }] })
  assert.equal(summary.diagnostics, 2); assert.equal(summary.codes.MissingReturnedValueDescription, 1)
  assert.throws(() => summarizeLint({ fileinfos: [] }), /BOUNDED/)
  const decision = assessAcceptance({ mechanicalPassed: true, modelTurns: 0, delegatedRuns: 0 })
  assert.equal(decision.status, 'PARTIAL'); assert.equal(decision.modelOrchestration, 'NOT_RUN'); assert.equal(decision.projectVerification, 'NOT_CERTIFIED')
})
