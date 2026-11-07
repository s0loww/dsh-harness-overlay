import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildSnapshot } from '../scripts/snapshot-installed.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-test-'))
  const bundle = join(root, 'dsh-1c-bundle')
  await mkdir(join(bundle, 'diagnostics'), { recursive: true })
  await mkdir(join(bundle, 'lib'), { recursive: true })
  await mkdir(join(bundle, 'node_modules', 'dsh-1c-project-wizard', 'lib'), { recursive: true })
  await mkdir(join(bundle, 'vendor', 'project-wizard', 'lib'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'RELEASE-MANIFEST.json'), JSON.stringify({
    product: 'fixture', releaseId: 'r1', bundleVersion: '1', hostVersion: '2',
    platform: 'win32-x64', fileCount: 5, totalBytes: 100,
  }))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'bundle', version: '1', license: 'MIT', dependencies: { a: '1' } }))
  await writeFile(join(bundle, 'package-lock.json'), '{}')
  await writeFile(join(bundle, 'diagnostics', 'plugin-catalog.json'), JSON.stringify({
    schema: 1, host_version: '2', counts: { plugins: 1 },
    plugins: [{ name: 'z', version: '1', resolved: 'ignored' }],
  }))
  await writeFile(join(bundle, 'lib', 'project-presets.js'), `
export const PROJECT_PRESETS = Object.freeze([
  { id: 'general', label: 'Общий', description: 'Base' },
])
export const LEGACY_PROJECT_PRESETS = Object.freeze([
  { id: 'old', label: 'Старый', description: 'Compat' },
])`)
  for (const path of [
    join(bundle, 'lib', 'developer-experience.js'),
    join(bundle, 'lib', 'client.js'),
    join(bundle, 'lib', 'project-wizard.js'),
    join(bundle, 'node_modules', 'dsh-1c-project-wizard', 'lib', 'client.js'),
    join(bundle, 'vendor', 'project-wizard', 'lib', 'client.js'),
    join(root, 'scripts', 'repair-agent-preset.mjs'),
  ]) await writeFile(path, '// fixture\n')
  return root
}

test('snapshot is deterministic and excludes source paths and plugin URLs', async () => {
  const root = await fixture()
  try {
    const first = await buildSnapshot(root)
    const second = await buildSnapshot(root)
    assert.deepEqual(first, second)
    assert.equal(first.lock.releaseId, 'r1')
    assert.equal(first.inventory.projectPresets.visible[0].id, 'general')
    assert.equal(first.inventory.pluginCatalog.plugins[0].resolved, undefined)
    assert.equal(JSON.stringify(first).includes(root), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime state paths are rejected', async () => {
  await assert.rejects(() => buildSnapshot('C:\\fixture\\.desktop-local'), /Refusing desktop-local/)
  await assert.rejects(() => buildSnapshot('C:\\fixture\\.dsh-1c'), /Refusing \.dsh-1c/)
})

