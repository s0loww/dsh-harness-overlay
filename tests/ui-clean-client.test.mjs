import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { assertCleanClientPayload, UiStageError } from '../scripts/stage-ui-overlay.mjs'

const REPO = resolve(import.meta.dirname, '..')
const PATCHED_HASHES = new Map([
  ['dsh-auto-collapse', '7960915bd2e2dc1cfeb1df61088fde8f73bd9fce3aaf07950cae7822f0c89ff9'],
  ['dsh-sleep-send', '7c53df7378f4ad31c7fea84ccd7c0fed212d37c1017753b3c98336b27dd0170c'],
  ['dsh-turn-navigator', 'fe1fb90cb69458f0b636c98892c4b2c9c9bced2bcdab4df425a649d208b4068f'],
])

async function packageRows() {
  const packageSet = JSON.parse(await readFile(resolve(REPO, 'src/ui-overlay/ui-package-set.json'), 'utf8'))
  return packageSet.publicPackages.filter(row => PATCHED_HASHES.has(row.name))
}

test('clean official target pins upstream npm payloads for the three bundle-patched clients', async () => {
  const rows = await packageRows()
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.match(row.registryIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
    assert.match(row.cleanClient.path, /(?:^|\/)client\.js$/u)
    assert.match(row.cleanClient.sha256, /^[0-9a-f]{64}$/u)
    assert.notEqual(row.cleanClient.sha256, PATCHED_HASHES.get(row.name))
    assert.equal(row.mount, true)
  }
})

test('official staging rejects the known Oleg bundle-patched client hashes', async () => {
  for (const row of await packageRows()) {
    assert.throws(
      () => assertCleanClientPayload(row, PATCHED_HASHES.get(row.name), 'projectPresetUi dsh-1c-bundle'),
      error => error instanceof UiStageError && error.code === 'UI_STAGE_CLEAN_CLIENT_HASH_MISMATCH',
      row.name,
    )
  }
})

test('official staging accepts only a matching clean lock without bundle-only service markers', async () => {
  for (const row of await packageRows()) {
    assert.equal(assertCleanClientPayload(row, row.cleanClient.sha256, 'function apply(ctx) {}'), row.cleanClient.path)
    assert.throws(
      () => assertCleanClientPayload(row, row.cleanClient.sha256, 'projectPresetUi'),
      error => error instanceof UiStageError && error.code === 'UI_STAGE_BUNDLE_CLIENT_REJECTED',
      row.name,
    )
  }
})
