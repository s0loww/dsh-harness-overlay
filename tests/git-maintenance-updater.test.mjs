import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { HARNESS_REPOSITORY, RELEASE_MANIFEST, validateRelease, inspectRelease, discoverGithubRelease, downloadGithubRelease, readReleaseZip, createUpdaterService, createWorkerJob, createOfficialInstallerAdapter } from '../src/git-maintenance/lib/updater.js'
import { readWorkerJob, runUpdateWorker, waitForDesktopExit } from '../src/git-maintenance/lib/update-worker.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function put(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-update-test-')); t.after(async () => { const rel = relative(resolve(tmpdir()), base); assert.ok(!isAbsolute(rel) && rel.startsWith('dsh-update-test-')); await rm(base, { recursive: true, force: true }) })
  const root = join(base, 'state'), releaseRoot = join(base, 'release'), target = { installRoot: join(base, 'install'), profileRoot: join(base, 'profile') }, file = join(target.profileRoot, 'owned.txt')
  await put(file, 'previous bytes\r\n'); await mkdir(target.installRoot)
  const paths = { uiArtifactRoot: 'dist/ui', policyArtifactRoot: 'dist/policy', releaseLockPath: 'locks/host.json' }, manifest = { schemaVersion: 1, kind: 'airules-dsh-release', repository: HARNESS_REPOSITORY, version: '0.16.0-update-fixture', commit: 'a'.repeat(40), hostVersion: '0.2.2-rc.1', paths, manifests: {} }
  for (const [name, path, content] of [['ui', join(paths.uiArtifactRoot, 'ui-overlay-manifest.json'), '{"ui":true}'], ['policy', join(paths.policyArtifactRoot, 'official-policy-manifest.json'), '{"policy":true}'], ['releaseLock', paths.releaseLockPath, '{"host":"0.2.2-rc.1"}']]) { await put(join(releaseRoot, path), content); manifest.manifests[name] = sha(content) }
  await put(join(releaseRoot, RELEASE_MANIFEST), JSON.stringify(manifest))
  const events = [], installer = {
    async plan({ release, target: selected, id, options }) { events.push('plan'); const before = await readFile(join(selected.profileRoot, 'owned.txt')); return { status: 'ready', signature: sha(JSON.stringify([release.identity, selected, before.toString('base64')])), options: options ?? { target: selected, backupRoot: join(base, 'backups', id) }, changes: [{ target: 'owned.txt', before: sha(before), after: sha('new bytes\n') }] } },
    async apply(options) { events.push('apply'); const path = join(options.target.profileRoot, 'owned.txt'), receiptPath = join(options.backupRoot, 'receipt.json'); await put(join(options.backupRoot, 'before'), await readFile(path)); await writeFile(path, 'new bytes\n'); await put(receiptPath, JSON.stringify({ fixture: true })); return { receiptPath } },
    async verify() { events.push('verify'); assert.equal(await readFile(file, 'utf8'), 'new bytes\n') },
    async rollback(options) { events.push('rollback'); await writeFile(file, await readFile(join(options.backupRoot, 'before'))); return { receiptPath: options.receiptPath } },
  }
  return { base, root, releaseRoot, target, file, manifest, installer, events }
}
const authorization = plan => ({ planId: plan.planId, execute: true })
const setup = (f, extra = {}) => createUpdaterService({ root: f.root, installer: f.installer, waitStopped: async () => { f.events.push('stopped') }, restart: async () => { f.events.push('restart') }, ...extra })
async function plan(f, service) { return service.prepare({ releaseRoot: f.releaseRoot, target: f.target }) }
async function queued(f, service) { const prepared = await plan(f, service); return { prepared, ...await service.queue({ planId: prepared.planId, authorization: authorization(prepared) }) } }

test('release descriptor pins repository, exact commit, host, artifact digests and portable paths', async t => {
  const f = await fixture(t), value = await inspectRelease({ root: f.releaseRoot, expectedCommit: f.manifest.commit })
  assert.equal(value.commit, undefined); assert.equal(value.manifest.commit, f.manifest.commit); assert.equal(value.uiArtifactRoot, join(f.releaseRoot, 'dist/ui'))
  for (const mutate of [m => m.commit = 'main', m => m.repository = 'https://github.com/evil/repo.git', m => m.hostVersion = '0.2.3', m => m.paths.uiArtifactRoot = '../escape', m => m.paths.releaseLockPath = 'C:/secret', m => m.manifests.ui = 'wrong', m => m.paths.arbitraryScript = 'run.js', m => delete m.repository]) { const bad = structuredClone(f.manifest); mutate(bad); assert.throws(() => validateRelease(bad)) }
  await put(join(f.releaseRoot, f.manifest.paths.releaseLockPath), 'changed'); await assert.rejects(inspectRelease({ root: f.releaseRoot }), /UPDATE_MANIFEST_HASH_MISMATCH/)
})

test('preparing and queueing never apply; exact authorization and fresh plan are mandatory', async t => {
  const f = await fixture(t), service = setup(f), prepared = await plan(f, service)
  assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n'); assert.ok(!f.events.includes('apply'))
  await assert.rejects(service.queue({ planId: prepared.planId }), /UPDATE_AUTHORIZATION_REQUIRED/)
  const pending = await service.queue({ planId: prepared.planId, authorization: authorization(prepared) })
  assert.equal(pending.state, 'waiting-for-desktop-exit'); assert.ok(!f.events.includes('apply')); assert.equal((await service.status()).transactions[0].state, pending.state)
  await assert.rejects(service.queue({ planId: prepared.planId, authorization: authorization(prepared) }), /UPDATE_PLAN_REVIEW_REQUIRED/)
})

test('detached-worker transaction applies only after exit, verifies, restarts and can roll back exact bytes', async t => {
  const f = await fixture(t), service = setup(f), pending = await queued(f, service), job = await createWorkerJob({ root: f.root, engineRoot: f.base, transactionId: pending.transactionId, token: pending.token })
  const parsed = await readWorkerJob(job.path, job.sha256), result = await runUpdateWorker(parsed, { installer: f.installer, waitStopped: async () => { f.events.push('stopped') }, restart: async () => { f.events.push('restart') } })
  assert.equal(result.state, 'restarted-startup-unverified'); assert.deepEqual(f.events.slice(-5), ['stopped', 'plan', 'apply', 'verify', 'restart']); assert.equal(await readFile(f.file, 'utf8'), 'new bytes\n')
  const status = await service.status(); assert.ok(!JSON.stringify(status).includes(pending.token)); assert.ok(!JSON.stringify(status).includes('tokenHash'))
  await service.rollback({ transactionId: pending.transactionId, authorization: { transactionId: pending.transactionId, rollback: true } }); assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n')
  await assert.rejects(service.executePending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_TRANSACTION_INVALID/)
})

test('wrong worker token, tampered transaction, changed release and changed live target cannot apply', async t => {
  const f = await fixture(t), service = setup(f), pending = await queued(f, service)
  await assert.rejects(service.executePending({ transactionId: pending.transactionId, token: 'wrong' }), /UPDATE_TRANSACTION_INVALID/)
  const transaction = join(f.root, 'transactions', pending.transactionId + '.json'), original = await readFile(transaction), changed = JSON.parse(original); changed.target.profileRoot = f.target.installRoot; await writeFile(transaction, JSON.stringify(changed))
  await assert.rejects(service.executePending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_TRANSACTION_INVALID/); await writeFile(transaction, original)
  await writeFile(f.file, 'foreign edit'); await assert.rejects(service.executePending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_PLAN_CHANGED/); assert.equal(await readFile(f.file, 'utf8'), 'foreign edit'); assert.ok(!f.events.includes('apply'))
  await writeFile(f.file, 'previous bytes\r\n'); const next = await queued(f, service); await put(join(f.releaseRoot, f.manifest.paths.releaseLockPath), 'foreign artifact'); await assert.rejects(service.executePending({ transactionId: next.transactionId, token: next.token }), /UPDATE_MANIFEST_HASH_MISMATCH/); assert.ok(!f.events.includes('apply'))
})

test('a prepared plan must be reviewed again after host restart or any plan-file edit', async t => {
  const f = await fixture(t), service = setup(f), prepared = await plan(f, service)
  await assert.rejects(setup(f).queue({ planId: prepared.planId, authorization: authorization(prepared) }), /UPDATE_PLAN_REVIEW_REQUIRED/)
  const path = join(f.root, 'plans', prepared.planId + '.json'), record = JSON.parse(await readFile(path, 'utf8')); record.target.profileRoot = f.target.installRoot; await writeFile(path, JSON.stringify(record))
  await assert.rejects(service.queue({ planId: prepared.planId, authorization: authorization(prepared) }), /UPDATE_PLAN_REVIEW_REQUIRED/)
})

test('read-only/revoked scope, expired plans, cancellation and unavailable process checks stop before apply', async t => {
  const f = await fixture(t); let allowed = true, clock = 1000
  const service = setup(f, { verifyScope: async () => { if (!allowed) throw Error('UPDATE_WRITE_REQUIRED') }, now: () => clock })
  const prepared = await plan(f, service); allowed = false; await assert.rejects(service.queue({ planId: prepared.planId, authorization: authorization(prepared) }), /UPDATE_WRITE_REQUIRED/); allowed = true; clock += 31 * 60 * 1000; await assert.rejects(service.queue({ planId: prepared.planId, authorization: authorization(prepared) }), /UPDATE_PLAN_EXPIRED/)
  const fresh = setup(f), pending = await queued(f, fresh), abort = new AbortController(); abort.abort(Error('CANCELLED'))
  await assert.rejects(fresh.executePending({ transactionId: pending.transactionId, token: pending.token }, { signal: abort.signal }), /CANCELLED/)
  const next = await queued(f, fresh)
  await assert.rejects(setup(f, { waitStopped: async () => { throw Error('LIVE_PROCESS_CHECK_UNAVAILABLE') } }).executePending({ transactionId: next.transactionId, token: next.token }), /LIVE_PROCESS_CHECK_UNAVAILABLE/)
  assert.ok(!f.events.includes('apply'))
})

test('verification failure preserves receipt and exposes explicit rollback rather than retrying apply', async t => {
  const f = await fixture(t); f.installer.verify = async () => { throw Error('UPDATE_INSTALLED_BYTES_MISMATCH') }
  const service = setup(f), pending = await queued(f, service)
  await assert.rejects(service.executePending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_INSTALLED_BYTES_MISMATCH/)
  assert.equal((await service.status()).transactions[0].state, 'applied-verification-failed'); assert.equal(f.events.filter(e => e === 'apply').length, 1)
  await service.rollback({ transactionId: pending.transactionId, authorization: { transactionId: pending.transactionId, rollback: true } }); assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n')
})

test('rollback can be queued while Desktop is running and its separate sealed worker restores exact bytes', async t => {
  const f = await fixture(t); let allowed = true
  const service = setup(f, { verifyScope: async () => { if (!allowed) throw Error('UPDATE_WRITE_REQUIRED') } }), pending = await queued(f, service)
  await service.executePending({ transactionId: pending.transactionId, token: pending.token })
  await assert.rejects(service.queueRollback({ transactionId: pending.transactionId }), /UPDATE_AUTHORIZATION_REQUIRED/)
  allowed = false; await assert.rejects(service.queueRollback({ transactionId: pending.transactionId, authorization: { transactionId: pending.transactionId, rollback: true } }), /UPDATE_WRITE_REQUIRED/); allowed = true
  const queuedRollback = await service.queueRollback({ transactionId: pending.transactionId, authorization: { transactionId: pending.transactionId, rollback: true } })
  assert.equal(queuedRollback.state, 'waiting-for-rollback-exit'); assert.equal(await readFile(f.file, 'utf8'), 'new bytes\n'); assert.ok(!f.events.includes('rollback'))
  const job = await createWorkerJob({ root: f.root, engineRoot: f.base, transactionId: queuedRollback.transactionId, token: queuedRollback.token }), parsed = await readWorkerJob(job.path, job.sha256)
  const finished = await runUpdateWorker(parsed, { installer: f.installer, waitStopped: async () => { f.events.push('stopped') }, restart: async () => { f.events.push('restart') } })
  assert.equal(finished.state, 'rollback-restarted-startup-unverified'); assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n'); assert.deepEqual(f.events.slice(-3), ['stopped', 'rollback', 'restart'])
  const ready = JSON.parse(await readFile(join(f.root, 'jobs', queuedRollback.transactionId + '.ready.json'), 'utf8')); assert.equal(ready.operation, 'rollback'); assert.ok(!JSON.stringify(ready).includes(queuedRollback.token))
  await assert.rejects(service.executePending({ transactionId: queuedRollback.transactionId, token: queuedRollback.token }), /UPDATE_TRANSACTION_INVALID/)
})

test('worker ready proof is emitted only after token verification and the cross-process transaction lock', async t => {
  const f = await fixture(t), service = setup(f), pending = await queued(f, service); let ready = 0, release
  const stopped = new Promise(resolve => { release = resolve }), first = setup(f, { onArmed: async () => { ready++ }, waitStopped: () => stopped })
  const executing = first.executePending({ transactionId: pending.transactionId, token: pending.token })
  while (!ready) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(setup(f).executePending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_WORKER_ALREADY_RUNNING/)
  assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n'); release(); await executing
})

test('cancellation reduces activity after scope revocation and stops an already armed waiting worker', async t => {
  const f = await fixture(t); let allowed = true, armed, stop
  const ready = new Promise(accept => { armed = accept }), stopped = new Promise(accept => { stop = accept })
  const service = setup(f, { verifyScope: async () => { if (!allowed) throw Error('UPDATE_WRITE_REQUIRED') } }), pending = await queued(f, service)
  const path = join(f.root, 'transactions', pending.transactionId + '.json'), before = await readFile(path)
  await assert.rejects(service.cancelPending({ transactionId: pending.transactionId, token: 'x'.repeat(43) }), /UPDATE_TRANSACTION_INVALID/); assert.deepEqual(await readFile(path), before)
  const worker = setup(f, { onArmed: async () => { armed() }, waitStopped: () => stopped }), executing = worker.executePending({ transactionId: pending.transactionId, token: pending.token }); await ready
  allowed = false
  assert.deepEqual(await service.cancelPending({ transactionId: pending.transactionId, token: pending.token }), { transactionId: pending.transactionId, state: 'cancelled', version: f.manifest.version })
  stop(); await assert.rejects(executing, /UPDATE_TRANSACTION_(?:CANCELLED|CHANGED)/)
  assert.equal((await service.status()).transactions[0].state, 'cancelled'); assert.equal(await readFile(f.file, 'utf8'), 'previous bytes\r\n'); assert.ok(!f.events.includes('apply')); assert.ok(!f.events.includes('restart'))
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(saved.tokenHash, undefined); assert.equal(saved.seal, undefined)
})

test('cancelled rollback restores the original transaction state and allows a newly reviewed rollback', async t => {
  const f = await fixture(t), service = setup(f), original = await queued(f, service); await service.executePending({ transactionId: original.transactionId, token: original.token })
  const cancelled = await service.queueRollback({ transactionId: original.transactionId, authorization: { transactionId: original.transactionId, rollback: true } })
  await service.cancelPending({ transactionId: cancelled.transactionId, token: cancelled.token })
  const statuses = (await service.status()).transactions; assert.equal(statuses.find(row => row.transactionId === original.transactionId).state, 'restarted-startup-unverified'); assert.equal(statuses.find(row => row.transactionId === cancelled.transactionId).state, 'cancelled')
  const retry = await service.queueRollback({ transactionId: original.transactionId, authorization: { transactionId: original.transactionId, rollback: true } }); assert.notEqual(retry.transactionId, cancelled.transactionId); assert.equal(retry.state, 'waiting-for-rollback-exit'); assert.equal(await readFile(f.file, 'utf8'), 'new bytes\n'); assert.ok(!f.events.includes('rollback'))
})

test('cancellation cannot overwrite an applying transaction or claim a partial install was cancelled', async t => {
  const f = await fixture(t), originalApply = f.installer.apply; let applying, finish
  const reached = new Promise(accept => { applying = accept }), gate = new Promise(accept => { finish = accept })
  f.installer.apply = async options => { applying(); await gate; return originalApply(options) }
  const service = setup(f), pending = await queued(f, service), worker = setup(f), executing = worker.executePending({ transactionId: pending.transactionId, token: pending.token }); await reached
  await assert.rejects(service.cancelPending({ transactionId: pending.transactionId, token: pending.token }), /UPDATE_CANCEL_TOO_LATE/)
  assert.equal((await service.status()).transactions[0].state, 'applying'); finish(); await executing; assert.equal(await readFile(f.file, 'utf8'), 'new bytes\n')
})

test('worker job byte hash and link guards prevent a replaced job from executing', async t => {
  const f = await fixture(t), pending = await queued(f, setup(f)), job = await createWorkerJob({ root: f.root, engineRoot: f.base, transactionId: pending.transactionId, token: pending.token })
  const edited = JSON.parse(await readFile(job.path, 'utf8')); edited.engineRoot += '-other'; await writeFile(job.path, JSON.stringify(edited)); await assert.rejects(readWorkerJob(job.path, job.sha256), /UPDATE_WORKER_JOB_CHANGED/)
  const linked = join(f.base, 'linked'); try { await symlink(f.releaseRoot, linked, process.platform === 'win32' ? 'junction' : 'dir') } catch { return }
  await assert.rejects(inspectRelease({ root: linked }), /UPDATE_PATH_INVALID/)
})

test('worker waits for exact executable to stop and never terminates it', async t => {
  const f = await fixture(t); let calls = 0
  await waitForDesktopExit(f.target, { engineRoot: f.base, intervalMs: 1, timeoutMs: 1000, check: async root => { assert.equal(root, f.target.installRoot); if (++calls < 3) throw Object.assign(Error('running'), { code: 'LIVE_DSH_STILL_RUNNING' }) } }); assert.equal(calls, 3)
  await assert.rejects(waitForDesktopExit(f.target, { engineRoot: f.base, intervalMs: 1, timeoutMs: 1, check: async () => { throw Object.assign(Error('running'), { code: 'LIVE_DSH_STILL_RUNNING' }) } }), /UPDATE_DESKTOP_EXIT_TIMEOUT/)
})

test('the actual installer adapter loads the trusted engine and requires genuine candidate certification', async t => {
  const f = await fixture(t), installer = await createOfficialInstallerAdapter({ engineRoot: resolve(import.meta.dirname, '..') }), release = await inspectRelease({ root: f.releaseRoot })
  await assert.rejects(installer.plan({ release, target: f.target, id: 'fixture' }), /UPDATE_CERTIFIED_CANDIDATE_REQUIRED/)
})

function zip(entries) {
  const crc = bytes => { let v = 0xffffffff; for (const byte of bytes) { v ^= byte; for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ v >>> 1 : v >>> 1 } return (v ^ 0xffffffff) >>> 0 }
  const chunks = [], directory = []; let offset = 0
  for (const [name, content] of entries) { const n = Buffer.from(name), data = Buffer.from(content), head = Buffer.alloc(30), central = Buffer.alloc(46); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc(data), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42); chunks.push(head, n, data); directory.push(central, n); offset += head.length + n.length + data.length }
  const table = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...chunks, table, end])
}

test('release ZIP extraction rejects traversal, aliases, device files, collisions, corruption and oversized expansion', () => {
  assert.equal(readReleaseZip(zip([['данные/a.txt', 'Unicode ✓']]))[0].bytes.toString(), 'Unicode ✓')
  for (const entries of [[['../escape', 'x']], [['C:/secret', 'x']], [['a\\b', 'x']], [['con.txt', 'x']], [['a', 'x'], ['a/b', 'y']], [['a', 'x'], ['A', 'y']]]) assert.throws(() => readReleaseZip(zip(entries)))
  const data = zip([['a', 'x']]); data[31] = 99; assert.throws(() => readReleaseZip(data), /INTEGRITY/)
  assert.throws(() => readReleaseZip(zip([['a', 'xx']]), { maxExpanded: 1 }), /UPDATE_SIZE_LIMIT/)
})

test('GitHub discovery distinguishes a source-only repo and downloads only the configured release asset', async t => {
  const f = await fixture(t), url = 'https://github.com/s0loww/dsh-harness-overlay/releases/download/fixture/airules-dsh-release.zip'
  const entries = [[RELEASE_MANIFEST, JSON.stringify(f.manifest)], [f.manifest.paths.uiArtifactRoot + '/ui-overlay-manifest.json', await readFile(join(f.releaseRoot, f.manifest.paths.uiArtifactRoot, 'ui-overlay-manifest.json'))], [f.manifest.paths.policyArtifactRoot + '/official-policy-manifest.json', await readFile(join(f.releaseRoot, f.manifest.paths.policyArtifactRoot, 'official-policy-manifest.json'))], [f.manifest.paths.releaseLockPath, await readFile(join(f.releaseRoot, f.manifest.paths.releaseLockPath))]], bytes = zip(entries), manifest = { ...f.manifest, asset: { name: 'airules-dsh-release.zip', url, bytes: bytes.length, sha256: sha(bytes) } }
  await assert.rejects(discoverGithubRelease({ fetch: async () => new Response('{}', { status: 404 }) }), /UPDATE_RELEASE_NOT_PUBLISHED/)
  await assert.rejects(discoverGithubRelease({ fetch: async () => new Response(JSON.stringify({ assets: [] })) }), /UPDATE_RELEASE_ASSETS_REQUIRED/)
  const requested = [], fetched = await discoverGithubRelease({ fetch: async address => { requested.push(address); return new Response(JSON.stringify(address.includes('api.github.com') ? { assets: [{ name: 'airules-dsh-release.json', size: 1000, browser_download_url: url.replace('.zip', '.json') }] } : manifest)) } })
  assert.equal(fetched.commit, f.manifest.commit); assert.equal(requested.length, 2)
  const downloaded = await downloadGithubRelease({ manifest: fetched, root: join(f.base, 'downloads'), fetch: async address => { assert.equal(address, url); return new Response(bytes) } }); assert.equal(downloaded.manifest.version, f.manifest.version)
  await assert.rejects(downloadGithubRelease({ manifest: { ...manifest, asset: { ...manifest.asset, sha256: 'b'.repeat(64) } }, root: join(f.base, 'corrupt'), fetch: async () => new Response(bytes) }), /UPDATE_ASSET_INTEGRITY_INVALID/)
})
