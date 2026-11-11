import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createComponentAdapters } from '../src/deployment-bundle/components.mjs'
import { seal, state } from '../src/deployment-bundle/lib/fs.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airules-cognee-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = { stateRoot: join(root, 'state'), dshHome: join(root, 'home'), bundleRoot: join(root, 'bundle'), deploymentId: randomUUID(), manifest: { components: { cognee: { assets: 'payload/cognee', port: 18180 } } } }
  const home = join(ctx.dshHome, 'memory-workspace'); await mkdir(home, { recursive: true })
  return { root, ctx, home }
}
async function existing(home, endpoint = 'http://127.0.0.1:18180') {
  await writeFile(join(home, 'config.json'), JSON.stringify({ enabled: true, endpoint, localProcessing: true }))
  await writeFile(join(home, 'auth.json'), JSON.stringify({ apiKey: 'fixture-existing-key' }))
}
test('reuse refuses a remote endpoint before any request or installation', async t => {
  const { ctx, home } = await fixture(t); await existing(home, 'https://example.org')
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  let requests = 0, installs = 0
  globalThis.fetch = async () => { requests++; throw Error('not allowed') }
  const adapter = createComponentAdapters({ cognee: { install: async () => { installs++ } } })
  await assert.rejects(adapter.configureCognee(ctx), error => error.code === 'DEPLOY_EXISTING_COGNEE_CONFIG_INVALID' && error.notAttempted === true)
  assert.equal(requests, 0); assert.equal(installs, 0)
})
test('reuse validates the existing key without reading datasets or copying credentials', async t => {
  const { ctx, home } = await fixture(t); await existing(home)
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const paths = []
  globalThis.fetch = async (url, options) => { paths.push(new URL(url).pathname); if (String(url).endsWith('/health')) return new Response('{"status":"ready"}'); assert.equal(options.headers['X-Api-Key'], 'fixture-existing-key'); return new Response('{}', { status: 401 }) }
  const adapter = createComponentAdapters({ cognee: {} })
  await assert.rejects(adapter.configureCognee(ctx), error => error.code === 'DEPLOY_EXISTING_COGNEE_AUTH_INVALID' && error.notAttempted === true)
  assert.deepEqual(paths, ['/health', '/api/v1/auth/me'])
  globalThis.fetch = async url => new Response(String(url).endsWith('/health') ? '{"status":"ready"}' : '{}')
  const before = await readFile(join(home, 'auth.json'), 'utf8')
  const reused = await adapter.configureCognee(ctx)
  assert.equal(reused.owned, false); assert.equal(reused.status, 'reused')
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), before)
})
test('partial pre-existing profile is preserved without starting another backend', async t => {
  const { ctx, home } = await fixture(t)
  await writeFile(join(home, 'auth.json'), '{"apiKey":"existing-partial-key"}')
  let calls = 0
  const adapter = createComponentAdapters({ cognee: { install: async () => { calls++ } } })
  await assert.rejects(adapter.configureCognee(ctx), error => error.code === 'DEPLOY_MEMORY_PARTIAL_CONFIGURATION' && error.notAttempted === true)
  assert.equal(calls, 0); assert.match(await readFile(join(home, 'auth.json'), 'utf8'), /existing-partial-key/u)
})
async function failingInstall(stateRoot) {
  const memoryHome = join(stateRoot, 'memory-workspace'); await mkdir(memoryHome, { recursive: true })
  await writeFile(join(stateRoot, 'receipt.json'), '{}')
  await writeFile(join(memoryHome, 'auth.json'), '{"apiKey":"fresh-fixture-key"}')
  await writeFile(join(memoryHome, 'processing-binding.json'), '{"schemaVersion":1}')
  // Missing processing.json triggers a failure after the first two owned writes.
  return { memoryHome }
}
test('interrupted profile copy stops only its owned backend and removes exact copied bytes', async t => {
  const { ctx, home } = await fixture(t); let stops = 0
  const adapter = createComponentAdapters({ cognee: { install: ({ stateRoot }) => failingInstall(stateRoot), stop: async () => { stops++; return { stopped: true } } } })
  await assert.rejects(adapter.configureCognee(ctx), error => error.notAttempted === true && !!error.componentReceipt)
  assert.equal(stops, 1)
  for (const name of ['auth.json', 'processing-binding.json', 'processing.json', 'config.json']) await assert.rejects(access(join(home, name)))
  const receipt = JSON.parse(await readFile(join(ctx.stateRoot, 'components/cognee-receipts', ctx.deploymentId + '.json'), 'utf8'))
  assert.equal(receipt.status, 'failed-restored')
  assert.doesNotMatch(JSON.stringify(receipt), /fresh-fixture-key/u)
})
test('unknown stop outcome retains recoverable component receipt and credentials', async t => {
  const { ctx, home } = await fixture(t)
  const adapter = createComponentAdapters({ cognee: { install: ({ stateRoot }) => failingInstall(stateRoot), stop: async () => { throw Error('unknown') } } })
  await assert.rejects(adapter.configureCognee(ctx), error => error.notAttempted !== true && error.componentReceipt.owned === true)
  assert.match(await readFile(join(home, 'auth.json'), 'utf8'), /fresh-fixture-key/u)
  const receipt = JSON.parse(await readFile(join(ctx.stateRoot, 'components/cognee-receipts', ctx.deploymentId + '.json'), 'utf8'))
  assert.equal(receipt.status, 'interrupted'); assert.ok(receipt.recoveryFailures.includes('DEPLOY_COGNEE_STOP_UNKNOWN'))
})
test('rollback rejects a resealed receipt targeting an unrelated file before stopping anything', async t => {
  const { ctx, root } = await fixture(t), stateRoot = join(ctx.stateRoot, 'components/cognee', ctx.deploymentId), receiptPath = join(ctx.stateRoot, 'components/cognee-receipts', ctx.deploymentId + '.json')
  const outside = join(root, 'unrelated.txt'); await writeFile(outside, 'keep')
  await mkdir(join(ctx.stateRoot, 'components/cognee-receipts'), { recursive: true })
  await writeFile(receiptPath, JSON.stringify(seal({ schemaVersion: 1, kind: 'deployment-cognee-binding', stateRoot, owned: true, files: [{ target: outside, after: await state(outside) }] })))
  let stops = 0
  const adapter = createComponentAdapters({ cognee: { stop: async () => { stops++ } } })
  await assert.rejects(adapter.rollbackCognee({ ...ctx, componentReceipt: { owned: true, stateRoot, receiptPath } }), /DEPLOY_COGNEE_RECEIPT_INVALID/u)
  assert.equal(stops, 0); assert.equal(await readFile(outside, 'utf8'), 'keep')
})
