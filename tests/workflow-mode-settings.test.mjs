import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readMode, writeMode } from '../src/workflow-integration/lib/mode-settings.js'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-mode-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'settings.json') }
}
test('executor feature preference persists independently of profile patch layers and is reloaded', async t => {
  const f = await fixture(t)
  assert.equal((await readMode(f.path)).mode, 'fixture-only')
  await writeMode(f.path, 'enabled')
  assert.deepEqual(await readMode(f.path), { mode: 'enabled', issue: null })
  await writeMode(f.path, 'fixture-only')
  assert.equal((await readMode(f.path)).mode, 'fixture-only')
  await assert.rejects(writeMode(f.path, 'arbitrary'), /DEPLOY_MODE_INVALID/u)
  assert.equal((await readMode(f.path)).mode, 'fixture-only')
})
test('corrupt or oversized preference fails closed without enabling execution', async t => {
  const f = await fixture(t)
  await writeMode(f.path, 'enabled')
  const content = JSON.parse(await readFile(f.path, 'utf8'))
  await writeFile(f.path, JSON.stringify({ ...content, digest: 'wrong' }))
  assert.deepEqual(await readMode(f.path, 'enabled'), { mode: 'disabled', issue: 'MODE_SETTINGS_INVALID' })
  await writeFile(f.path, 'x'.repeat(5000))
  assert.equal((await readMode(f.path)).mode, 'disabled')
})
test('preference writer refuses a symlink instead of changing its destination', async t => {
  const f = await fixture(t), other = join(f.root, 'destination.json')
  await writeFile(other, 'untouched')
  try { await symlink(other, f.path, 'file') } catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error }
  await assert.rejects(writeMode(f.path, 'enabled'), /MODE_SETTINGS_INVALID/u)
  assert.equal(await readFile(other, 'utf8'), 'untouched')
})
