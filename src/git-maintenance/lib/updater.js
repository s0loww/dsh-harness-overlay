import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const HARNESS_REPOSITORY = 'https://github.com/s0loww/dsh-harness-overlay.git'
export const RELEASE_MANIFEST = '.dsh-release.json'
const HASH = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const MAX_ZIP = 512 * 1024 * 1024, MAX_EXPANDED = 1024 * 1024 * 1024
const fail = code => { throw Error(code) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => JSON.stringify(name) + ':' + canonical(value[name])).join(',') + '}' : JSON.stringify(value)
const transactionSeal = (value, token) => { const { seal, ...body } = value; return createHmac('sha256', token).update(canonical(body)).digest('hex') }
const pendingState = value => ['waiting-for-desktop-exit', 'waiting-for-rollback-exit'].includes(value)
function pendingTokenValid(record, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false
  const expectedHash = Buffer.from(String(record.tokenHash ?? '')), actualHash = Buffer.from(sha(token)), expectedSeal = Buffer.from(String(record.seal ?? '')), actualSeal = Buffer.from(transactionSeal(record, token))
  return expectedHash.length === actualHash.length && expectedSeal.length === actualSeal.length && timingSafeEqual(expectedHash, actualHash) && timingSafeEqual(expectedSeal, actualSeal)
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value)
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(name => !allowed.includes(name))) fail('UPDATE_MANIFEST_INVALID') }
function portable(value) {
  if (typeof value !== 'string' || !value || value.length > 400 || isAbsolute(value) || /[\\:"<>|?*\x00-\x1f\x7f]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('UPDATE_PATH_INVALID')
  return value
}
function under(root, value) { const path = resolve(root, portable(value)), rel = relative(resolve(root), path); if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) fail('UPDATE_PATH_INVALID'); return path }
async function guard(path, { directory = false, missing = false } = {}) {
  let at = resolve(path); const parts = []
  while (true) { parts.unshift(at); const parent = dirname(at); if (parent === at) break; at = parent }
  for (const part of parts) {
    try { const info = await lstat(part); if (info.isSymbolicLink() || key(await realpath(part)) !== key(part) || (part !== resolve(path) && !info.isDirectory()) || (part === resolve(path) && (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))) fail('UPDATE_PATH_INVALID') }
    catch (error) { if (error.code === 'ENOENT' && missing) return; throw error }
  }
}
async function boundedFile(path, limit = 256 * 1024) { await guard(path); const info = await lstat(path); if (info.size > limit) fail('UPDATE_SIZE_LIMIT'); const bytes = await readFile(path); if (bytes.length > limit) fail('UPDATE_SIZE_LIMIT'); await guard(path); return bytes }
async function saveJson(path, value, { exclusive = false } = {}) {
  await guard(dirname(path), { directory: true, missing: true }); await mkdir(dirname(path), { recursive: true }); await guard(dirname(path), { directory: true })
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); if (bytes.length > 512 * 1024) fail('UPDATE_SIZE_LIMIT')
  if (exclusive) { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return }
  await guard(path, { missing: true }); const temp = path + '.' + randomUUID() + '.tmp'; await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await guard(dirname(path), { directory: true }); await rename(temp, path)
}
function repository(value = HARNESS_REPOSITORY) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(value)
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) fail('UPDATE_REPOSITORY_INVALID')
  return { url: `https://github.com/${match[1]}/${match[2]}.git`, owner: match[1], name: match[2] }
}
export function validateRelease(value, { expectedRepository = HARNESS_REPOSITORY, expectedCommit } = {}) {
  keys(value, ['schemaVersion', 'kind', 'version', 'commit', 'repository', 'hostVersion', 'paths', 'manifests', 'asset'])
  if (value.schemaVersion !== 1 || value.kind !== 'airules-dsh-release' || !VERSION.test(value.version ?? '') || !COMMIT.test(value.commit ?? '') || typeof value.repository !== 'string' || value.hostVersion !== '0.2.2-rc.1' || repository(value.repository).url !== repository(expectedRepository).url || (expectedCommit !== undefined && value.commit !== expectedCommit)) fail('UPDATE_MANIFEST_INVALID')
  keys(value.paths, ['uiArtifactRoot', 'policyArtifactRoot', 'releaseLockPath', 'candidateRoot'])
  for (const name of ['uiArtifactRoot', 'policyArtifactRoot', 'releaseLockPath']) portable(value.paths[name])
  if (value.paths.candidateRoot !== undefined) portable(value.paths.candidateRoot)
  keys(value.manifests, ['ui', 'policy', 'releaseLock'])
  for (const name of ['ui', 'policy', 'releaseLock']) if (!HASH.test(value.manifests[name] ?? '')) fail('UPDATE_MANIFEST_INVALID')
  if (value.asset !== undefined) {
    keys(value.asset, ['name', 'url', 'sha256', 'bytes'])
    const source = repository(expectedRepository), prefix = `https://github.com/${source.owner}/${source.name}/releases/download/`
    if (value.asset.name !== 'airules-dsh-release.zip' || typeof value.asset.url !== 'string' || !value.asset.url.startsWith(prefix) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9._-]+\/airules-dsh-release\.zip$/u.test(value.asset.url) || !HASH.test(value.asset.sha256 ?? '') || !Number.isSafeInteger(value.asset.bytes) || value.asset.bytes < 22 || value.asset.bytes > MAX_ZIP) fail('UPDATE_ASSET_INVALID')
  }
  return structuredClone(value)
}

async function responseBytes(response, limit, signal) {
  if (!response.ok) fail(response.status === 404 ? 'UPDATE_RELEASE_NOT_PUBLISHED' : 'UPDATE_DOWNLOAD_FAILED')
  const declared = Number(response.headers?.get?.('content-length') ?? 0); if (declared > limit) fail('UPDATE_SIZE_LIMIT')
  const chunks = []; let bytes = 0
  if (response.body?.getReader) { const reader = response.body.getReader(); try { while (true) { signal?.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) { await reader.cancel(); fail('UPDATE_SIZE_LIMIT') } chunks.push(Buffer.from(part.value)) } } finally { reader.releaseLock() } }
  else { const part = Buffer.from(await response.arrayBuffer()); if (part.length > limit) fail('UPDATE_SIZE_LIMIT'); chunks.push(part) }
  signal?.throwIfAborted(); return Buffer.concat(chunks)
}
export async function discoverGithubRelease({ repository: repo = HARNESS_REPOSITORY, fetch: fetcher = globalThis.fetch, signal } = {}) {
  const source = repository(repo), options = { signal, redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'airules-dsh-updater' } }
  const response = await fetcher(`https://api.github.com/repos/${source.owner}/${source.name}/releases/latest`, options)
  const latest = JSON.parse((await responseBytes(response, 512 * 1024, signal)).toString('utf8'))
  if (latest.draft || latest.prerelease || !Array.isArray(latest.assets)) fail('UPDATE_RELEASE_INVALID')
  const asset = latest.assets.find(row => row.name === 'airules-dsh-release.json')
  if (!asset) fail('UPDATE_RELEASE_ASSETS_REQUIRED')
  const prefix = `https://github.com/${source.owner}/${source.name}/releases/download/`
  if (!asset.browser_download_url?.startsWith(prefix) || asset.size > 256 * 1024) fail('UPDATE_ASSET_INVALID')
  // GitHub release downloads redirect to a GitHub-owned asset CDN; only metadata
  // URLs themselves are accepted from the configured repository.
  const meta = await fetcher(asset.browser_download_url, { ...options, redirect: 'follow' })
  return validateRelease(JSON.parse((await responseBytes(meta, 256 * 1024, signal)).toString('utf8')), { expectedRepository: source.url })
}

const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0 })
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0 }
/** Strict non-ZIP64, store/deflate release ZIP reader; no links or zip-slip. */
export function readReleaseZip(input, { maxExpanded = MAX_EXPANDED } = {}) {
  const bytes = Buffer.from(input); if (bytes.length > MAX_ZIP || bytes.length < 22) fail('UPDATE_ZIP_INVALID')
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('UPDATE_ZIP_INVALID')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16)
  if (count < 1 || count === 65535 || count > 25000 || bytes.readUInt16LE(end + 8) !== count || offset + size !== end) fail('UPDATE_ZIP_INVALID')
  const result = [], names = new Set(); let at = offset, expanded = 0
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail('UPDATE_ZIP_INVALID')
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), checksum = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24), n = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), disk = bytes.readUInt16LE(at + 34), external = bytes.readUInt32LE(at + 38), local = bytes.readUInt32LE(at + 42)
    if (flags & 1 || ![0, 8].includes(method) || disk || at + 46 + n + extra + comment > end || [compressed, length, local].includes(0xffffffff)) fail('UPDATE_ZIP_INVALID')
    const nameBytes = bytes.subarray(at + 46, at + 46 + n), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes), directory = name.endsWith('/'), path = portable(directory ? name.slice(0, -1) : name), mode = external >>> 16
    if (mode && ![0, 0x8000, 0x4000].includes(mode & 0xf000) || names.has(path.toLowerCase()) || path.split('/').some(part => /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('UPDATE_ZIP_PATH_INVALID')
    names.add(path.toLowerCase()); expanded += length
    if (length > 128 * 1024 * 1024 || expanded > maxExpanded || directory && length !== 0 || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail('UPDATE_SIZE_LIMIT')
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + localName).equals(nameBytes) || start + compressed > offset) fail('UPDATE_ZIP_INVALID')
    const packed = bytes.subarray(start, start + compressed), data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(length, 1) })
    if (data.length !== length || crc32(data) !== checksum) fail('UPDATE_ZIP_INTEGRITY_INVALID')
    if (!directory) result.push({ path, bytes: Buffer.from(data) })
    at += 46 + n + extra + comment
  }
  if (at !== end) fail('UPDATE_ZIP_INVALID')
  const files = new Set(result.map(row => row.path.toLowerCase()))
  for (const row of result) { const parts = row.path.toLowerCase().split('/'); for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join('/'))) fail('UPDATE_ZIP_PATH_INVALID') }
  return result
}
export async function downloadGithubRelease({ manifest, root, fetch: fetcher = globalThis.fetch, signal, expectedRepository = HARNESS_REPOSITORY }) {
  manifest = validateRelease(manifest, { expectedRepository }); if (!manifest.asset) fail('UPDATE_RELEASE_ASSETS_REQUIRED')
  if (!isAbsolute(root ?? '')) fail('UPDATE_PATH_INVALID')
  await guard(root, { directory: true, missing: true }); await mkdir(root, { recursive: true }); await guard(root, { directory: true })
  const destination = join(root, `${manifest.version}-${manifest.commit.slice(0, 12)}`)
  try { await lstat(destination); fail('UPDATE_RELEASE_ALREADY_CACHED') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const response = await fetcher(manifest.asset.url, { signal, redirect: 'follow', headers: { 'user-agent': 'airules-dsh-updater' } }), bytes = await responseBytes(response, manifest.asset.bytes, signal)
  if (bytes.length !== manifest.asset.bytes || sha(bytes) !== manifest.asset.sha256) fail('UPDATE_ASSET_INTEGRITY_INVALID')
  const entries = readReleaseZip(bytes), inner = entries.find(row => row.path === RELEASE_MANIFEST)
  if (!inner || inner.bytes.length > 256 * 1024) fail('UPDATE_MANIFEST_INVALID')
  const parsed = validateRelease(JSON.parse(inner.bytes.toString('utf8')), { expectedRepository, expectedCommit: manifest.commit })
  if (canonical({ ...parsed, asset: undefined }) !== canonical({ ...manifest, asset: undefined })) fail('UPDATE_MANIFEST_MISMATCH')
  const staging = join(root, '.download-' + randomUUID()); await mkdir(staging)
  try {
    for (const row of entries) { signal?.throwIfAborted(); const target = under(staging, row.path); await mkdir(dirname(target), { recursive: true }); await guard(dirname(target), { directory: true }); await writeFile(target, row.bytes, { flag: 'wx', mode: 0o600 }) }
    await inspectRelease({ root: staging, expectedRepository, expectedCommit: manifest.commit }); signal?.throwIfAborted(); await guard(root, { directory: true }); await rename(staging, destination)
  } catch (error) {
    // Only our fresh, canonical direct child can be recursively cleaned up.
    if (dirname(resolve(staging)) === resolve(root) && /^\.download-[a-f0-9-]{36}$/u.test(relative(resolve(root), resolve(staging)))) { try { await guard(staging, { directory: true }); await rm(staging, { recursive: true, force: true }) } catch {} }
    throw error
  }
  return inspectRelease({ root: destination, expectedRepository, expectedCommit: manifest.commit })
}
export async function inspectRelease({ root, expectedRepository = HARNESS_REPOSITORY, expectedCommit }) {
  root = resolve(root); await guard(root, { directory: true }); const bytes = await boundedFile(join(root, RELEASE_MANIFEST)), manifest = validateRelease(JSON.parse(bytes.toString('utf8')), { expectedRepository, expectedCommit })
  const paths = Object.fromEntries(Object.entries(manifest.paths).map(([name, value]) => [name, under(root, value)]))
  for (const name of ['uiArtifactRoot', 'policyArtifactRoot', 'candidateRoot']) if (paths[name]) await guard(paths[name], { directory: true })
  for (const [path, hash] of [[join(paths.uiArtifactRoot, 'ui-overlay-manifest.json'), manifest.manifests.ui], [join(paths.policyArtifactRoot, 'official-policy-manifest.json'), manifest.manifests.policy], [paths.releaseLockPath, manifest.manifests.releaseLock]]) if (sha(await boundedFile(path, 8 * 1024 * 1024)) !== hash) fail('UPDATE_MANIFEST_HASH_MISMATCH')
  return { root, manifest, identity: sha(bytes), ...paths }
}

export function createUpdaterService({ root, installer, verifyScope = async () => {}, waitStopped, restart, onArmed, now = Date.now }) {
  if (!isAbsolute(root) || typeof installer?.plan !== 'function' || typeof installer?.apply !== 'function' || typeof installer?.rollback !== 'function') fail('UPDATE_CONFIGURATION_INVALID')
  root = resolve(root); let busy = false; const prepared = new Map()
  const check = async execution => { execution?.signal?.throwIfAborted(); await verifyScope(execution); execution?.signal?.throwIfAborted() }
  const targetValid = target => { keys(target, ['installRoot', 'profileRoot', 'previousReceiptPath']); for (const name of ['installRoot', 'profileRoot']) if (!isAbsolute(target[name] ?? '')) fail('UPDATE_TARGET_INVALID'); if (target.previousReceiptPath !== undefined && !isAbsolute(target.previousReceiptPath)) fail('UPDATE_TARGET_INVALID'); return structuredClone(target) }
  const file = (kind, id) => { if (!validId(id)) fail('UPDATE_ID_INVALID'); return join(root, kind, id + '.json') }
  async function readState(kind, id) { return JSON.parse((await boundedFile(file(kind, id), 512 * 1024)).toString('utf8')) }
  async function transitionLock(id) {
    const path = file('transition-locks', id); await guard(dirname(path), { directory: true, missing: true }); await mkdir(dirname(path), { recursive: true }); await guard(dirname(path), { directory: true })
    try { await writeFile(path, 'transition-' + process.pid, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code === 'EEXIST') fail('UPDATE_TRANSACTION_BUSY'); throw error }
    return async () => { try { await guard(path); await unlink(path) } catch {} }
  }
  async function beginMutation(record, token, state) {
    const unlock = await transitionLock(record.id)
    try { const latest = await readState('transactions', record.id); if (latest.state === 'cancelled') fail('UPDATE_TRANSACTION_CANCELLED'); if (canonical(latest) !== canonical(record) || !pendingState(latest.state) || !pendingTokenValid(latest, token)) fail('UPDATE_TRANSACTION_CHANGED'); record.state = state; await saveJson(file('transactions', record.id), record) } finally { await unlock() }
  }
  async function inspect(record) { const release = await inspectRelease({ root: record.releaseRoot, expectedRepository: record.repository, expectedCommit: record.commit }); if (release.identity !== record.releaseIdentity) fail('UPDATE_RELEASE_CHANGED'); return release }
  const publicPlan = record => ({ planId: record.id, version: record.version, commit: record.commit, hostVersion: record.hostVersion, expiresAt: record.expiresAt, signature: record.signature, changes: record.changes, status: record.status })
  async function prepare(input, execution) {
    await check(execution); const target = targetValid(input.target), release = await inspectRelease({ root: input.releaseRoot, expectedRepository: input.repository, expectedCommit: input.expectedCommit }); await check(execution)
    const id = randomUUID(), result = await installer.plan({ release, target, id, signal: execution?.signal }); await check(execution)
    if (result.status !== 'ready' || !HASH.test(result.signature ?? '')) fail('UPDATE_PLAN_BLOCKED')
    const record = { schemaVersion: 1, id, releaseRoot: release.root, releaseIdentity: release.identity, repository: release.manifest.repository, commit: release.manifest.commit, version: release.manifest.version, hostVersion: release.manifest.hostVersion, target, signature: result.signature, installerOptions: result.options, changes: result.changes ?? [], createdAt: now(), expiresAt: now() + 30 * 60 * 1000, status: 'prepared' }
    if (!plain(record.installerOptions)) fail('UPDATE_INSTALLER_OPTIONS_REQUIRED')
    await check(execution); await saveJson(file('plans', id), record, { exclusive: true }); prepared.set(id, sha(canonical(record))); return publicPlan(record)
  }
  async function queue({ planId, authorization }, execution) {
    if (busy) fail('UPDATE_BUSY'); busy = true
    try { await check(execution); const record = await readState('plans', planId); if (!prepared.has(planId) || prepared.get(planId) !== sha(canonical(record))) fail('UPDATE_PLAN_REVIEW_REQUIRED'); if (record.status !== 'prepared' || record.expiresAt < now()) fail('UPDATE_PLAN_EXPIRED'); if (authorization?.planId !== planId || authorization?.execute !== true || Object.keys(authorization).some(name => !['planId', 'execute'].includes(name))) fail('UPDATE_AUTHORIZATION_REQUIRED')
      const release = await inspect(record), current = await installer.plan({ release, target: record.target, id: record.id, options: record.installerOptions, signal: execution?.signal }); await check(execution)
      if (current.status !== 'ready' || current.signature !== record.signature) fail('UPDATE_PLAN_CHANGED')
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), transaction = { ...record, id, planId, operation: 'apply', state: 'waiting-for-desktop-exit', tokenHash: sha(token), queuedAt: now(), result: null }
      transaction.seal = transactionSeal(transaction, token)
      await saveJson(file('transactions', id), transaction, { exclusive: true }); await saveJson(file('plans', planId), { ...record, status: 'queued', transactionId: id }); prepared.delete(planId); await check(execution); return { transactionId: id, token, state: transaction.state, version: record.version }
    } finally { busy = false }
  }
  async function queueRollback({ transactionId, authorization }, execution) {
    if (busy) fail('UPDATE_BUSY'); busy = true
    try {
      await check(execution); const original = await readState('transactions', transactionId)
      if (!original.result?.receiptPath || !['applied', 'verified', 'restarted-startup-unverified', 'applied-verification-failed'].includes(original.state)) fail('UPDATE_ROLLBACK_UNAVAILABLE')
      if (authorization?.transactionId !== transactionId || authorization?.rollback !== true || Object.keys(authorization).some(name => !['transactionId', 'rollback'].includes(name))) fail('UPDATE_AUTHORIZATION_REQUIRED')
      await inspect(original); const receiptHash = sha(await boundedFile(original.result.receiptPath, 8 * 1024 * 1024)); await check(execution)
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), transaction = { ...original, id, operation: 'rollback', originalTransactionId: transactionId, originalState: original.state, state: 'waiting-for-rollback-exit', rollbackReceiptHash: receiptHash, tokenHash: sha(token), queuedAt: now(), expiresAt: now() + 30 * 60 * 1000 }
      delete transaction.error; delete transaction.finishedAt; transaction.seal = transactionSeal(transaction, token)
      await saveJson(file('transactions', id), transaction, { exclusive: true }); await saveJson(file('transactions', transactionId), { ...original, state: 'rollback-queued', rollbackTransactionId: id }); await check(execution)
      return { transactionId: id, token, state: transaction.state, version: transaction.version }
    } finally { busy = false }
  }
  async function cancelPending({ transactionId, token }) {
    // Exact transaction authority is enough to reduce activity, including after
    // the original native scope was revoked. This intentionally does not call
    // verifyScope or share the long-lived worker busy flag.
    const unlock = await transitionLock(transactionId)
    try {
      const record = await readState('transactions', transactionId)
      if (!pendingState(record.state)) fail('UPDATE_CANCEL_TOO_LATE')
      if (!pendingTokenValid(record, token)) fail('UPDATE_TRANSACTION_INVALID')
      record.state = 'cancelled'; record.finishedAt = now(); delete record.tokenHash; delete record.seal
      await saveJson(file('transactions', transactionId), record)
      if (record.operation === 'rollback') { const original = await readState('transactions', record.originalTransactionId); if (original.state === 'rollback-queued' && original.rollbackTransactionId === transactionId) await saveJson(file('transactions', original.id), { ...original, state: record.originalState }) }
      return { transactionId, state: 'cancelled', version: record.version }
    } finally { await unlock() }
  }
  async function executePending({ transactionId, token }, execution) {
    if (busy) fail('UPDATE_BUSY'); busy = true
    let record, lockPath, locked = false
    try {
      record = await readState('transactions', transactionId)
      if (!pendingTokenValid(record, token) || !pendingState(record.state) || !['apply', 'rollback'].includes(record.operation) || (record.operation === 'rollback') !== (record.state === 'waiting-for-rollback-exit') || record.expiresAt < now()) fail('UPDATE_TRANSACTION_INVALID')
      lockPath = file('locks', transactionId); await guard(dirname(lockPath), { directory: true, missing: true }); await mkdir(dirname(lockPath), { recursive: true }); await guard(dirname(lockPath), { directory: true })
      try { await writeFile(lockPath, 'worker-' + process.pid, { flag: 'wx', mode: 0o600 }); locked = true } catch (error) { if (error.code === 'EEXIST') fail('UPDATE_WORKER_ALREADY_RUNNING'); throw error }
      if (typeof onArmed === 'function') await onArmed({ transactionId, operation: record.operation, version: record.version })
      // Worker authority is the exact one-shot transaction, not a now-disposed
      // agent. waitStopped must use the existing exact executable process guard.
      execution?.signal?.throwIfAborted(); if (typeof waitStopped !== 'function') fail('UPDATE_WAIT_STOPPED_REQUIRED'); await waitStopped(record.target, execution?.signal)
      if (record.expiresAt < now()) fail('UPDATE_TRANSACTION_EXPIRED')
      const latest = await readState('transactions', transactionId); if (canonical(latest) !== canonical(record)) fail('UPDATE_TRANSACTION_CHANGED')
      const release = await inspect(record)
      if (record.operation === 'rollback') {
        if (sha(await boundedFile(record.result?.receiptPath, 8 * 1024 * 1024)) !== record.rollbackReceiptHash) fail('UPDATE_ROLLBACK_RECEIPT_CHANGED')
        execution?.signal?.throwIfAborted(); await beginMutation(record, token, 'rolling-back')
        const options = { ...record.installerOptions, receiptPath: record.result.receiptPath }, result = await installer.rollback(options)
        if (typeof installer.verifyRollback === 'function') await installer.verifyRollback(result, options)
        record.state = 'rolled-back'; record.finishedAt = now(); delete record.tokenHash; delete record.seal; await saveJson(file('transactions', transactionId), record)
        const original = await readState('transactions', record.originalTransactionId); await saveJson(file('transactions', record.originalTransactionId), { ...original, state: 'rolled-back', rollbackTransactionId: transactionId })
        if (typeof restart === 'function') { await restart(record.target); record.state = 'rollback-restarted-startup-unverified'; await saveJson(file('transactions', transactionId), record) }
        return { transactionId, state: record.state, receiptPath: result.receiptPath ?? record.result.receiptPath, version: record.version }
      }
      const current = await installer.plan({ release, target: record.target, id: record.planId, options: record.installerOptions, signal: execution?.signal })
      if (current.status !== 'ready' || current.signature !== record.signature) fail('UPDATE_PLAN_CHANGED')
      execution?.signal?.throwIfAborted(); await beginMutation(record, token, 'applying')
      const result = await installer.apply(current.options ?? record.installerOptions)
      record.state = 'applied'; record.result = { receiptPath: result.receiptPath }; delete record.tokenHash; delete record.seal; await saveJson(file('transactions', transactionId), record)
      if (typeof installer.verify === 'function') await installer.verify(result, current.options ?? record.installerOptions)
      record.state = 'verified'; record.finishedAt = now(); await saveJson(file('transactions', transactionId), record)
      if (typeof restart === 'function') { await restart(record.target); record.state = 'restarted-startup-unverified'; await saveJson(file('transactions', transactionId), record) }
      return { transactionId, state: record.state, receiptPath: record.result.receiptPath, version: record.version }
    } catch (error) {
      let wasCancelled = false
      if (record && locked) { try { wasCancelled = (await readState('transactions', transactionId)).state === 'cancelled' } catch {} }
      if (record && locked && !wasCancelled) {
        const notStarted = ['waiting-for-desktop-exit', 'waiting-for-rollback-exit'].includes(record.state)
        if (!record.result?.receiptPath && typeof installer.recover === 'function') { try { const recovered = await installer.recover(record.installerOptions); if (recovered?.receiptPath) record.result = { receiptPath: recovered.receiptPath } } catch {} }
        record.state = notStarted ? record.operation === 'rollback' ? 'rollback-not-applied' : 'not-applied' : record.operation === 'rollback' ? 'rollback-failed-or-unknown' : record.result?.receiptPath ? 'applied-verification-failed' : 'apply-failed-or-unknown'; record.error = /^[A-Z][A-Z0-9_]{2,100}$/u.test(error.message) ? error.message : 'UPDATE_FAILED'; delete record.tokenHash; delete record.seal; await saveJson(file('transactions', transactionId), record)
        if (notStarted && record.operation === 'rollback') { const original = await readState('transactions', record.originalTransactionId); if (original.rollbackTransactionId === transactionId) await saveJson(file('transactions', original.id), { ...original, state: record.originalState }) }
      }
      throw error
    } finally { busy = false; if (locked) { try { await guard(lockPath); await unlink(lockPath) } catch {} } }
  }
  async function rollback({ transactionId, authorization }, execution) {
    if (busy) fail('UPDATE_BUSY'); busy = true
    try { await check(execution); const record = await readState('transactions', transactionId); if (!record.result?.receiptPath || !['applied', 'verified', 'restarted-startup-unverified', 'applied-verification-failed'].includes(record.state)) fail('UPDATE_ROLLBACK_UNAVAILABLE'); if (authorization?.transactionId !== transactionId || authorization?.rollback !== true) fail('UPDATE_AUTHORIZATION_REQUIRED')
      if (typeof waitStopped !== 'function') fail('UPDATE_WAIT_STOPPED_REQUIRED'); await waitStopped(record.target, execution?.signal); await check(execution)
      await inspect(record); const result = await installer.rollback({ ...record.installerOptions, receiptPath: record.result.receiptPath }); record.state = 'rolled-back'; record.finishedAt = now(); await saveJson(file('transactions', transactionId), record); return { transactionId, state: record.state, receiptPath: result.receiptPath ?? record.result.receiptPath }
    } finally { busy = false }
  }
  async function status() { await guard(root, { directory: true, missing: true }); let names; try { names = await readdir(join(root, 'transactions')) } catch (error) { if (error.code === 'ENOENT') return { transactions: [] }; throw error }; const rows = []; for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).sort().slice(-50)) { const row = await readState('transactions', name.slice(0, -5)); rows.push({ transactionId: row.id, operation: row.operation ?? 'apply', originalTransactionId: row.originalTransactionId ?? null, version: row.version, commit: row.commit, state: row.state, receiptPath: row.result?.receiptPath ?? null, error: row.error ?? null, queuedAt: row.queuedAt }) } return { transactions: rows.sort((a, b) => b.queuedAt - a.queuedAt) } }
  return { prepare, queue, queueRollback, cancelPending, executePending, rollback, status }
}

export async function createWorkerJob({ root, engineRoot, transactionId, token }) {
  if (!isAbsolute(root ?? '') || !isAbsolute(engineRoot ?? '') || !validId(transactionId) || !/^[A-Za-z0-9_-]{43}$/u.test(token ?? '')) fail('UPDATE_WORKER_JOB_INVALID')
  const job = { schemaVersion: 1, root: resolve(root), engineRoot: resolve(engineRoot), transactionId, token }, path = join(root, 'jobs', transactionId + '.json')
  await saveJson(path, job, { exclusive: true }); return { path, sha256: sha(await boundedFile(path)), transactionId }
}

/** The engine must be a previously installed/pinned local runtime. Never pass a
 * freshly fetched Git checkout here as executable installer code. */
export async function createOfficialInstallerAdapter({ engineRoot, prepareCandidate } = {}) {
  if (!isAbsolute(engineRoot ?? '')) fail('UPDATE_ENGINE_REQUIRED')
  const load = path => import(pathToFileURL(join(engineRoot, path)).href)
  const [{ buildLivePromotionPlan, PROMOTION_BACKUPS_ROOT, LIVE_ACKNOWLEDGEMENT }, { applyLivePromotion }, { rollbackLivePromotion }, { verifyOfficialDesktop }, { sameState, targetState }, { verifyReceiptIntegrity }] = await Promise.all([load('installer/official-live/common.mjs'), load('installer/official-live/apply.mjs'), load('installer/official-live/rollback.mjs'), load('src/targets/official-desktop/target.mjs'), load('installer/fs-state.mjs'), load('installer/receipt.mjs')])
  return {
    async plan({ release, target, id, options, signal }) {
      const candidateRoot = options?.candidateRoot ?? release.candidateRoot ?? (typeof prepareCandidate === 'function' ? await prepareCandidate(release, target, { signal }) : fail('UPDATE_CERTIFIED_CANDIDATE_REQUIRED'))
      const selected = { installRoot: target.installRoot, profileRoot: target.profileRoot, backupRoot: options?.backupRoot ?? join(PROMOTION_BACKUPS_ROOT, 'git-update-' + id), candidateRoot, uiArtifactRoot: release.uiArtifactRoot, policyArtifactRoot: release.policyArtifactRoot, releaseLockPath: release.releaseLockPath, ...(target.previousReceiptPath ? { previousReceiptPath: target.previousReceiptPath, allowOwnedFragmentMigration: true } : {}) }
      const plan = await buildLivePromotionPlan(selected)
      return { status: plan.status, signature: plan.signature, options: selected, changes: plan.operations.map(row => ({ target: row.targetRelative, type: row.type, package: row.package ?? null, before: row.before?.type, after: row.after?.type })) }
    },
    apply: options => applyLivePromotion({ ...options, acknowledgement: LIVE_ACKNOWLEDGEMENT }),
    rollback: options => rollbackLivePromotion({ ...options, acknowledgement: LIVE_ACKNOWLEDGEMENT }),
    async recover(options) { const receiptPath = join(options.backupRoot, 'receipt.json'); try { const receipt = JSON.parse((await boundedFile(receiptPath, 8 * 1024 * 1024)).toString('utf8')); if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'applied' || key(receipt.installRoot) !== key(options.installRoot) || key(receipt.profileRoot) !== key(options.profileRoot) || key(receipt.backupRoot) !== key(options.backupRoot)) return null; return { receiptPath } } catch { return null } },
    async verify(result, options) { await verifyOfficialDesktop({ installRoot: options.installRoot, releaseLockPath: options.releaseLockPath }); for (const row of result.receipt.operations) if (!sameState(await targetState(join(options.profileRoot, row.target)), row.after)) fail('UPDATE_INSTALLED_BYTES_MISMATCH') },
    async verifyRollback(result, options) { await verifyOfficialDesktop({ installRoot: options.installRoot, releaseLockPath: options.releaseLockPath }); const receipt = result.receipt ?? JSON.parse((await boundedFile(options.receiptPath, 8 * 1024 * 1024)).toString('utf8')); if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'rolled-back') fail('UPDATE_ROLLBACK_VERIFY_FAILED'); for (const row of receipt.operations) if (!sameState(await targetState(join(options.profileRoot, row.target)), row.before)) fail('UPDATE_ROLLBACK_VERIFY_FAILED') },
  }
}
