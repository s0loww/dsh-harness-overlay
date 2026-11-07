import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { stageUiOverlay, UiStageError } from '../scripts/stage-ui-overlay.mjs'

const REPO = resolve(import.meta.dirname, '..')
const SOURCE_BUNDLE = 'E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle'

async function stage(t, overrides = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'airules-ui-overlay-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const artifactVersion = overrides.artifactVersion ?? 'test.1'
  const output = overrides.output ?? join(temp, `airules-ui-overlay-${artifactVersion}`)
  const manifest = await stageUiOverlay({ sourceBundle: SOURCE_BUNDLE, ...overrides, output, artifactVersion })
  return { temp, output, manifest }
}

test('stages a hash-pinned UI-only official-desktop artifact', async t => {
  const { output, manifest } = await stage(t)
  assert.equal(manifest.artifact.id, 'airules-dsh-ui-overlay')
  assert.equal(manifest.target.hostVersions[0], '0.2.1-rc.5')
  assert.ok(Object.keys(manifest.files).length > 500)
  assert.equal(manifest.operations.length, 26)
  assert.deepEqual(manifest.separation, {
    includesPolicy: false,
    includesRulepack: false,
    includesMcpBindings: false,
    includesCredentials: false,
    includesRuntimeState: false,
  })
  const packages = new Set(manifest.operations.filter(row => row.target.startsWith('node_modules/')).map(row => row.target.slice('node_modules/'.length)))
  for (const name of [
    'dsh-gui-customization', 'dsh-tokenledger', 'dock-base', 'dock-files', 'dsh-activity-pane',
    'dsh-auto-collapse', 'dsh-sleep-send', 'dsh-turn-navigator',
    'dsh-mcp-manager', 'airules-provider-limits-hud', 'airules-dsh-russian-localization',
    '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', 'zod',
    '@deepseek-ai/dsh-client-ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-models', 'airules-dsh-providers-settings',
    '@deepseek-ai/dsh-client-ui-settings-account',
  ]) assert.ok(packages.has(name), name)
  const fragment = await readFile(join(output, 'cordis.ui.fragment.yml'), 'utf8')
  assert.match(fragment, /name: airules-provider-limits-hud/u)
  assert.match(fragment, /name: airules-dsh-russian-localization/u)
  assert.doesNotMatch(fragment, /name: dsh-mcp-manager/u)
  assert.doesNotMatch(fragment, /name: @deepseek-ai\/dsh-client-ui-settings-(?:general|models)/u)
  assert.match(await readFile(join(output, 'payload/packages/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'), 'utf8'), /airules-settings-shell-rc5-v1/u)
  assert.match(await readFile(join(output, 'payload/packages/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'), 'utf8'), /exports\.airulesProviders/u)
  const effortClient = await readFile(join(output, 'payload/packages/dsh-effort-slider/lib/client.js'), 'utf8')
  assert.match(effortClient, /exports\.apply = \(\) => \{\};/u)
  assert.match(effortClient, /exports\.inject = \[\];/u)
  const effortPackage = JSON.parse(await readFile(join(output, 'payload/packages/dsh-effort-slider/package.json'), 'utf8'))
  assert.equal(effortPackage.version, '1.1.0')
  assert.match(fragment, /name: dsh-auto-collapse/u)
  assert.match(fragment, /name: dsh-sleep-send/u)
  assert.match(fragment, /name: dsh-turn-navigator/u)
  assert.doesNotMatch(fragment, /(?:https?:\/\/|authorization|bearer|api[_-]?key|mcp-servers\.json)/iu)
  assert.ok(manifest.files['payload/packages/dsh-mcp-manager/package.json'])
  assert.ok(manifest.files['official-ui-manifest.json'])
  const official = JSON.parse(await readFile(join(output, 'official-ui-manifest.json'), 'utf8'))
  assert.equal(official.target.kind, 'official-desktop')
  assert.equal(official.target.hostVersion, '0.2.1-rc.5')
  assert.equal(official.internalPatches.length, 0)
  for (const record of official.packages) assert.deepEqual(Object.keys(record).sort(), ['name', 'source'])
  for (const row of [
    ['dsh-auto-collapse', '76201ae937e6cf1f9eed70a5c8defbfa175a76ba9d96f7d1a52550b730594382'],
    ['dsh-turn-navigator', '6c3c61df2d6bbeecdb5f78244351224683e21677f90b6680e0b64e89e71dd1eb'],
  ]) {
    const record = official.packages.find(item => item.name === row[0])
    const provenance = manifest.packageProvenance.find(item => item.name === row[0])
    assert.equal(provenance.origin, 'npm-registry')
    assert.match(provenance.integrity, /^sha512-/u)
    const client = await readFile(join(output, record.source, provenance.cleanClient.path))
    assert.equal(createHash('sha256').update(client).digest('hex'), row[1])
    assert.doesNotMatch(client.toString('utf8'), /projectPresetUi/u)
  }
  const sleepRecord = official.packages.find(item => item.name === 'dsh-sleep-send')
  const sleepProvenance = manifest.packageProvenance.find(item => item.name === 'dsh-sleep-send')
  const sleepClient = await readFile(join(output, sleepRecord.source, sleepProvenance.cleanClient.path))
  const sleepSource = sleepClient.toString('utf8')
  const sleepHash = createHash('sha256').update(sleepClient).digest('hex')
  assert.equal(sleepProvenance.origin, 'npm-registry')
  assert.equal(sleepProvenance.localization.mechanism, '@deepseek-ai/dsh-client-locale register/bind')
  assert.equal(sleepProvenance.localization.sourceSha256, 'fcd378fa564d1b2b908e3017be7dd55ad4b3f30d2da26ff926d15fed5d67a5aa')
  assert.equal(sleepProvenance.localization.outputSha256, sleepHash)
  assert.notEqual(sleepHash, sleepProvenance.localization.sourceSha256)
  assert.match(sleepSource, /ctx\.locale\.register\(LOCALE_NS, \{ zh, en \}\)/u)
  assert.match(sleepSource, /ctx\.locale\.bind\(LOCALE_NS\)/u)
  assert.doesNotMatch(sleepSource, /title: "(?:定时发送配置|请先输入消息内容)"/u)
  assert.doesNotMatch(sleepSource, /projectPresetUi/u)
})

test('requires a versioned fresh output and never mutates an existing version', async t => {
  const { output } = await stage(t)
  const before = await readFile(join(output, 'ui-overlay-manifest.json'))
  await assert.rejects(
    stageUiOverlay({ sourceBundle: SOURCE_BUNDLE, output, artifactVersion: 'test.1' }),
    error => error instanceof UiStageError && error.code === 'UI_STAGE_OUTPUT_EXISTS',
  )
  assert.deepEqual(await readFile(join(output, 'ui-overlay-manifest.json')), before)
  await assert.rejects(
    stageUiOverlay({ sourceBundle: SOURCE_BUNDLE, output: join(resolve(output, '..'), 'renamed-output'), artifactVersion: 'test.2' }),
    error => error instanceof UiStageError && error.code === 'UI_STAGE_OUTPUT_VERSION_MISMATCH',
  )
  await assert.rejects(
    stageUiOverlay({ sourceBundle: SOURCE_BUNDLE }),
    error => error instanceof UiStageError && error.code === 'UI_STAGE_ARTIFACT_VERSION_REQUIRED',
  )
})

test('does not reuse one version for different inputs', async t => {
  const { temp, output } = await stage(t, { artifactVersion: 'test.reuse' })
  const before = await readFile(join(output, 'ui-overlay-manifest.json'))
  const packageSet = JSON.parse(await readFile(join(REPO, 'src/ui-overlay/ui-package-set.json'), 'utf8'))
  packageSet.publicPackages.find(row => row.name === 'dsh-tokenledger').version = '9.9.9'
  const packageSetPath = join(temp, 'different-set.json')
  await writeFile(packageSetPath, JSON.stringify(packageSet), 'utf8')
  await assert.rejects(
    stageUiOverlay({ sourceBundle: SOURCE_BUNDLE, output, artifactVersion: 'test.reuse', packageSetPath }),
    error => error instanceof UiStageError && error.code === 'UI_STAGE_OUTPUT_EXISTS',
  )
  assert.deepEqual(await readFile(join(output, 'ui-overlay-manifest.json')), before)
})

test('refuses a direct package version that is not audited', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'airules-ui-set-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const packageSet = JSON.parse(await readFile(join(REPO, 'src/ui-overlay/ui-package-set.json'), 'utf8'))
  packageSet.publicPackages.find(row => row.name === 'dsh-tokenledger').version = '9.9.9'
  const packageSetPath = join(temp, 'set.json')
  await writeFile(packageSetPath, JSON.stringify(packageSet), 'utf8')
  await assert.rejects(
    stageUiOverlay({ sourceBundle: SOURCE_BUNDLE, output: join(temp, 'airules-ui-overlay-test.invalid'), artifactVersion: 'test.invalid', packageSetPath }),
    error => error instanceof UiStageError && error.code === 'UI_STAGE_PACKAGE_VERSION_MISMATCH',
  )
})

test('does not stage user state or nested node_modules', async t => {
  const { manifest } = await stage(t)
  for (const path of Object.keys(manifest.files)) {
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env|\.desktop-local|\.dsh-1c|sessions|credentials|node_modules\/[^/]+\/node_modules)(?:\/|$)/iu)
    assert.doesNotMatch(path, /(?:\.sqlite|\.db)$/iu)
  }
})
