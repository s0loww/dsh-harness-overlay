import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { COGNEE_LOCK, COGNEE_IMAGE_IDS, createCogneeAdapter, renderCompose, freshServerEnvironment, verifyAssets, validateAssetManifest } from '../src/deployment-bundle/cognee/adapter.mjs'
import { validateProcessingBinding } from '../src/memory-workspace/lib/processing-runtime.js'
import { validateConfig } from '../src/memory-workspace/lib/control.js'
import { validateProcessing } from '../src/memory-workspace/lib/processing.js'

const json = value => JSON.stringify(value, null, 2)
const proxyScript = await readFile(new URL('../src/deployment-bundle/cognee/loopback-proxy.py', import.meta.url), 'utf8')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airules-cognee-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assetsRoot = join(root, 'assets'); await mkdir(assetsRoot)
  const files = []
  for (const path of ['cognee-image.tar', 'cognee-models.tar']) { const bytes = Buffer.alloc(512, path.length); await writeFile(join(assetsRoot, path), bytes); files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
  const manifest = { schemaVersion: 1, lock: COGNEE_LOCK, files }
  await writeFile(join(assetsRoot, 'assets.json'), json(manifest))
  return { root, assetsRoot, manifest }
}
async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) }) }
test('offline assets reject an edited image, extra path and wrong model revision before loading Docker', async t => {
  const { assetsRoot, manifest } = await fixture(t)
  assert.equal((await verifyAssets(assetsRoot)).files.length, 2)
  assert.throws(() => validateAssetManifest({ ...manifest, files: [...manifest.files, { path: '../auth.json', size: 512, sha256: 'a'.repeat(64) }] }), /MANIFEST_INVALID/u)
  assert.throws(() => validateAssetManifest({ ...manifest, lock: { ...COGNEE_LOCK, models: [] } }), /MANIFEST_INVALID/u)
  await writeFile(join(assetsRoot, 'cognee-image.tar'), Buffer.alloc(512, 1))
  await assert.rejects(verifyAssets(assetsRoot), /HASH_MISMATCH/u)
})
test('server secrets are generated per installation; runtime composes loopback and never pulls', () => {
  const a = freshServerEnvironment(), b = freshServerEnvironment()
  for (const name of ['DEFAULT_USER_PASSWORD', 'FASTAPI_USERS_JWT_SECRET', 'FASTAPI_USERS_RESET_PASSWORD_TOKEN_SECRET', 'FASTAPI_USERS_VERIFICATION_TOKEN_SECRET']) assert.notEqual(a[name], b[name])
  assert.equal(a.ENABLE_BACKEND_ACCESS_CONTROL, 'true')
  assert.equal(a.HF_HUB_OFFLINE, '1')
  assert.equal(a.LLM_API_KEY, undefined)
  const compose = renderCompose({ instanceId: 'portable-test-01', ownerToken: 'a'.repeat(64), port: 18180, memoryGiB: 3, offline: true, proxyScript })
  assert.match(compose, /127\.0\.0\.1:18180:8000/u); assert.match(compose, /pull_policy: never/u); assert.match(compose, /internal: true/u)
  assert.doesNotMatch(compose, /dsh_cognee_local|dsh_cognee_local_storage|D:\\|\.env:|privileged:/u)
  assert.throws(() => renderCompose({ instanceId: 'other;rm', ownerToken: 'a'.repeat(64), port: 18180 }), /IDENTITY_INVALID/u)
})
test('foreign Docker resources are refused even when the receipt has a plausible owned name', async t => {
  const { root } = await fixture(t), stateRoot = join(root, 'state'); await mkdir(stateRoot)
  const instanceId = 'ownership-test-01', container = `airules-cognee-${instanceId}`
  await writeFile(join(stateRoot, 'receipt.json'), json({ schemaVersion: 1, stateRoot, instanceId, ownerToken: 'a'.repeat(64), container, volume: container + '-storage', network: `airules-${instanceId}_default`, composeHash: 'b'.repeat(64), port: 18180, endpoint: 'http://127.0.0.1:18180' }))
  const calls = []
  const adapter = createCogneeAdapter({ run: async args => { calls.push(args); return { code: 0, stdout: json([{ Config: { Labels: { 'ru.airules.cognee.owner': 'foreign' } }, State: { Running: true } }]) } } })
  await assert.rejects(adapter.stop({ stateRoot }), /FOREIGN_RESOURCE_REFUSED/u)
  await assert.rejects(adapter.uninstall({ stateRoot, purgeData: true }), /FOREIGN_RESOURCE_REFUSED/u)
  assert.ok(calls.every(args => args[1] === 'inspect'))
})
test('fresh install produces UI-compatible paths, a new API key and no default data deletion on uninstall', async t => {
  const { root, assetsRoot } = await fixture(t), stateRoot = join(root, 'state'), listenPort = await port(), calls = []
  const resources = new Map(); let registration
  const runner = async args => {
    calls.push(args)
    if (args[0] === 'info') return { code: 0, stdout: json({ OSType: 'linux', ServerVersion: 'fixture', MemTotal: 8 * 1024 ** 3, NCPU: 4 }) }
    if (args[0] === 'compose' && args[1] === 'version') return { code: 0, stdout: '5.3.1' }
    if (args[1] === 'inspect') {
      // Classic Docker's config ID differs from the containerd manifest ID.
      if (args[0] === 'image') return { code: 0, stdout: json([{ Id: COGNEE_IMAGE_IDS[1] }]) }
      const entity = resources.get(args[0] + ':' + args[2]); return { code: entity ? 0 : 1, stdout: entity ? json([entity]) : '' }
    }
    if (args[0] === 'volume' && args[1] === 'create') { const receipt = JSON.parse(await readFile(join(stateRoot, 'receipt.json'), 'utf8')); resources.set('volume:' + receipt.volume, { Labels: { 'ru.airules.cognee.owner': receipt.ownerToken } }) }
    if (args[0] === 'compose') { const receipt = JSON.parse(await readFile(join(stateRoot, 'receipt.json'), 'utf8')); resources.set('container:' + receipt.container, { Config: { Labels: { 'ru.airules.cognee.owner': receipt.ownerToken } }, State: { Running: true } }); resources.set('network:' + receipt.network, { Labels: { 'ru.airules.cognee.owner': receipt.ownerToken } }); if (receipt.offline) { resources.set('container:' + receipt.proxy, { Config: { Labels: { 'ru.airules.cognee.owner': receipt.ownerToken } }, State: { Running: true } }); resources.set('network:' + receipt.accessNetwork, { Labels: { 'ru.airules.cognee.owner': receipt.ownerToken } }) } }
    return { code: 0, stdout: '' }
  }
  const adapter = createCogneeAdapter({ run: runner, fetchImpl: async (url, options) => {
    let value
    if (url.endsWith('/health')) value = { status: 'ready', version: '1.6.7-fixture' }
    else if (url.endsWith('/register')) { registration = JSON.parse(options.body); value = { id: 'fixture-user' } }
    else if (url.endsWith('/login')) value = { access_token: 'fixture-ephemeral-login' }
    else value = { key: 'fixture-server-generated-api-key' }
    return new Response(json(value), { headers: { 'content-type': 'application/json' } })
  } })
  const installed = await adapter.install({ stateRoot, assetsRoot, instanceId: 'install-test-01', port: listenPort, offline: true })
  assert.equal(validateConfig(JSON.parse(await readFile(installed.configPath, 'utf8'))).enabled, true)
  assert.equal(validateProcessingBinding(JSON.parse(await readFile(installed.processingBindingPath, 'utf8'))).composeDir, join(stateRoot, 'service'))
  assert.equal(validateProcessing(JSON.parse(await readFile(installed.processingPath, 'utf8'))).extraction.model, 'fastino/gliner2.5-base-v1')
  assert.equal(JSON.parse(await readFile(installed.authPath, 'utf8')).apiKey, 'fixture-server-generated-api-key')
  assert.equal(registration.is_superuser, undefined); assert.equal(registration.password.length, 64)
  assert.doesNotMatch(json(installed), /fixture-server-generated-api-key|fixture-ephemeral-login/u)
  const result = await adapter.uninstall({ stateRoot })
  assert.equal(result.dataRetained, true)
  assert.ok(calls.some(args => args[0] === 'container' && args[1] === 'rm'))
  assert.ok(!calls.some(args => ['volume', 'image'].includes(args[0]) && args[1] === 'rm'))
})
test('Docker daemon absence is a reported prerequisite, not an automatic restart or installer', async () => {
  const calls = [], adapter = createCogneeAdapter({ run: async args => { calls.push(args); return { code: 1, stdout: '' } } })
  assert.equal((await adapter.detect()).available, false)
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'info')
})
