import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath, readFile, readdir, writeFile, rename, open, unlink, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_SOURCES = Object.freeze({
  airules: Object.freeze({ repository: 'https://github.com/s0loww/airules.git', ref: 'main' }),
  harness: Object.freeze({ repository: 'https://github.com/s0loww/dsh-harness-overlay.git', ref: 'main' }),
})
const fail = code => { throw Error(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u
export function normalizeSource(input = {}) {
  if (!plain(input) || Object.keys(input).some(name => !['kind', 'repository', 'ref', 'localPath', 'allowDirty'].includes(name)) || !Object.hasOwn(DEFAULT_SOURCES, input.kind)) fail('SOURCE_INPUT_INVALID')
  const repository = input.repository ?? DEFAULT_SOURCES[input.kind].repository
  if (typeof repository !== 'string' || repository.length > 300 || !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}(?:\.git)?$/u.test(repository)) fail('SOURCE_REPOSITORY_INVALID')
  const url = new URL(repository), pieces = url.pathname.split('/').filter(Boolean)
  if (pieces.some(value => value === '.' || value === '..') || url.username || url.password || url.search || url.hash) fail('SOURCE_REPOSITORY_INVALID')
  const localPath = input.localPath === undefined || input.localPath === '' ? undefined : input.localPath
  if (localPath !== undefined && (typeof localPath !== 'string' || !isAbsolute(localPath) || /[\u0000-\u001f]/u.test(localPath))) fail('SOURCE_LOCAL_PATH_INVALID')
  const ref = input.ref ?? (localPath ? 'HEAD' : DEFAULT_SOURCES[input.kind].ref)
  if (typeof ref !== 'string' || ref.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(part => part.endsWith('.lock') || part.startsWith('.'))) fail('SOURCE_REF_INVALID')
  if (input.allowDirty !== undefined && typeof input.allowDirty !== 'boolean') fail('SOURCE_INPUT_INVALID')
  return { kind: input.kind, repository: `https://github.com/${pieces[0]}/${pieces[1].replace(/\.git$/u, '')}.git`, ref, ...(localPath ? { localPath: resolve(localPath) } : {}), allowDirty: input.allowDirty === true }
}

async function exists(path) { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function guardDirectory(path, { missing = false } = {}) {
  let at = resolve(path); const chain = []
  while (true) { chain.unshift(at); const parent = dirname(at); if (at === parent) break; at = parent }
  for (const part of chain) { const info = await exists(part); if (!info) { if (missing) continue; fail('SOURCE_PATH_INVALID') }; if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(part)) !== key(part)) fail('SOURCE_PATH_INVALID') }
}
async function regularFile(path, maximum = 2 * 1024 * 1024) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) fail('SOURCE_CACHE_INVALID'); return readFile(path) }
async function inventory(root, execution, expectedTree) {
  await guardDirectory(root); const files = {}; let total = 0, count = 0, entries = 0
  async function walk(directory, depth = 0) {
    if (depth > 64) fail('SOURCE_SIZE_LIMIT')
    for (const name of (await readdir(directory)).sort()) {
      if (++entries > 32000) fail('SOURCE_SIZE_LIMIT')
      await verify(execution); const path = join(directory, name), rel = relative(root, path).split(sep).join('/')
      if (rel === '.git') continue
      const info = await lstat(path)
      if (info.isSymbolicLink()) fail('SOURCE_LINK_REJECTED')
      if (info.isDirectory()) { await walk(path, depth + 1); continue }
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024 || ++count > 16000 || (total += info.size) > 512 * 1024 * 1024) fail('SOURCE_SIZE_LIMIT')
      const bytes = await readFile(path); await verify(execution); if (bytes.length !== info.size) fail('SOURCE_CHANGED')
      const expected = expectedTree?.get(rel)
      if (expectedTree) {
        if (!expected) fail('SOURCE_CACHE_CHANGED')
        const blob = value => createHash(expected.length === 64 ? 'sha256' : 'sha1').update(Buffer.from(`blob ${value.length}\0`)).update(value).digest('hex')
        // Git may materialize tracked LF blobs as CRLF through .gitattributes
        // (canonical airules explicitly requires this for PowerShell). Keep those
        // worktree bytes, but prove the only difference is CRLF normalization.
        const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('binary').replace(/\r\n/gu, '\n'), 'binary')
        if (blob(bytes) !== expected && blob(normalized) !== expected) fail('SOURCE_CACHE_CHANGED')
      }
      files[rel] = { bytes: bytes.length, sha256: digest(bytes) }
    }
  }
  await walk(root); if (expectedTree && Object.keys(files).length !== expectedTree.size) fail('SOURCE_CACHE_CHANGED'); return { files, digest: digest(JSON.stringify(files)), bytes: total }
}
async function verify(execution) { execution?.signal?.throwIfAborted(); await execution?.verify?.(); execution?.signal?.throwIfAborted() }

/** Only caller-supplied native process execution is used. No shell or Git hooks. */
export function createGitSourceService({ root, run, timeoutMs = 120000 } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof run !== 'function') fail('SOURCE_SERVICE_INVALID')
  root = resolve(root)
  const hooks = join(root, 'disabled-hooks'), emptyConfig = join(root, 'empty-git-config'), locks = new Set()
  const safeEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1' }
  const baseArgs = ['-c', `core.hooksPath=${hooks}`, '-c', `init.templateDir=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.longpaths=true', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.interactive=false', '-c', 'core.askPass=']
  function beneath(path) { const rel = relative(root, resolve(path)); if (!rel || isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..') fail('SOURCE_PATH_INVALID'); return resolve(path) }
  async function setup(execution) {
    await verify(execution); await guardDirectory(root, { missing: true }); await mkdir(root, { recursive: true }); await guardDirectory(root)
    for (const path of [hooks, join(root, 'locks'), join(root, 'sources'), join(root, 'snapshots')]) { await mkdir(path, { recursive: true }); await guardDirectory(path) }
    if (!await exists(emptyConfig)) await writeFile(emptyConfig, '', { flag: 'wx', mode: 0o600 })
    if ((await regularFile(emptyConfig, 1)).length !== 0 || (await readdir(hooks)).length) fail('SOURCE_CACHE_INVALID')
    await verify(execution)
  }
  async function command(args, execution, { cwd = root, network = false, allowFailure = false } = {}) {
    await verify(execution)
    let value
    try { value = await run(['git', ...baseArgs, ...args], { cwd, execution, signal: execution?.signal, timeoutMs, outputLimit: 2 * 1024 * 1024, env: network ? { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } : safeEnv }) }
    catch (error) { await verify(execution); fail(error?.name === 'AbortError' ? 'SOURCE_CANCELLED' : 'SOURCE_GIT_FAILED') }
    await verify(execution)
    if (!value || !Number.isInteger(value.code) || !allowFailure && value.code !== 0) fail('SOURCE_GIT_FAILED')
    const stdout = Buffer.isBuffer(value.stdout) ? value.stdout.toString('utf8') : String(value.stdout ?? '')
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) fail('SOURCE_OUTPUT_LIMIT')
    return { code: value.code, stdout }
  }
  const sourceId = input => digest(JSON.stringify([input.kind, input.repository, input.ref, input.localPath ? key(input.localPath) : null])).slice(0, 24)
  async function metadata(path) { try { await guardDirectory(dirname(path), { missing: true }); const value = JSON.parse((await regularFile(path)).toString('utf8')); if (!plain(value) || value.schemaVersion !== 1 || !COMMIT.test(value.commit ?? '') || !/^[a-f0-9]{64}$/u.test(value.inventoryDigest ?? '')) fail('SOURCE_CACHE_INVALID'); return value } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  async function gitBinding(snapshot, bare, commit) {
    const bytes = await regularFile(join(snapshot, '.git'), 4096), match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(bytes.toString('utf8'))
    if (!match) fail('SOURCE_CACHE_INVALID')
    const gitDirectory = resolve(snapshot, match[1]), expected = join(bare, 'worktrees') + sep
    if (!key(gitDirectory).startsWith(key(expected) + (key(expected).endsWith(sep) ? '' : sep))) fail('SOURCE_CACHE_INVALID')
    await guardDirectory(gitDirectory)
    const common = (await regularFile(join(gitDirectory, 'commondir'), 4096)).toString('utf8').trim()
    if (key(resolve(gitDirectory, common)) !== key(bare) || (await regularFile(join(gitDirectory, 'HEAD'), 256)).toString('utf8').trim() !== commit) fail('SOURCE_CACHE_CHANGED')
    return digest(bytes)
  }
  async function atomicJson(path, value) { await guardDirectory(dirname(path)); const temporary = beneath(path + '.' + randomUUID() + '.tmp'); await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); if (await exists(path)) await regularFile(path); await rename(temporary, path) }
  async function withLock(id, execution, action) {
    if (locks.has(id)) fail('SOURCE_BUSY'); locks.add(id); let handle, lockIdentity
    const path = beneath(join(root, 'locks', id + '.lock'))
    try { await setup(execution); try { handle = await open(path, 'wx', 0o600); lockIdentity = await handle.stat() } catch (error) { if (error.code === 'EEXIST') fail('SOURCE_BUSY'); throw error }; return await action() }
    finally { await handle?.close(); if (lockIdentity) try { await guardDirectory(dirname(path)); const now = await lstat(path); if (now.ino === lockIdentity.ino && now.dev === lockIdentity.dev && !now.isSymbolicLink()) await unlink(path) } catch {}; locks.delete(id) }
  }
  async function removeOwnTree(path) { beneath(path); const info = await exists(path); if (!info) return; await guardDirectory(dirname(path)); if (info.isSymbolicLink() || key(await realpath(path)) !== key(path)) fail('SOURCE_PATH_INVALID'); await rm(path, { recursive: true, force: true }) }
  async function localInfo(input, execution) {
    await guardDirectory(input.localPath)
    const resolved = (await command(['-C', input.localPath, 'rev-parse', '--show-toplevel'], execution)).stdout.trim()
    if (key(resolved) !== key(input.localPath)) fail('SOURCE_LOCAL_ROOT_INVALID')
    const commit = (await command(['-C', input.localPath, 'rev-parse', '--verify', `${input.ref}^{commit}`], execution)).stdout.trim(); if (!COMMIT.test(commit)) fail('SOURCE_COMMIT_INVALID')
    // A local config may define clean/process filters. Disable every declared driver
    // before status so merely checking a source never executes its filter command.
    const filters = await command(['-C', input.localPath, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], execution, { allowFailure: true })
    if (![0, 1].includes(filters.code)) fail('SOURCE_GIT_FAILED')
    const overrides = []
    for (const field of filters.stdout.trim().split(/\r?\n/u).filter(Boolean)) { if (!/^filter\.[A-Za-z0-9_.-]+\.(?:clean|smudge|process|required)$/u.test(field)) fail('SOURCE_LOCAL_CONFIG_INVALID'); overrides.push('-c', field + (field.endsWith('.required') ? '=false' : '=')) }
    const dirty = !!(await command([...overrides, '-C', input.localPath, 'status', '--porcelain=v1', '--untracked-files=all'], execution)).stdout.trim()
    if (dirty && !input.allowDirty) fail('SOURCE_DIRTY')
    return { commit, dirty }
  }
  async function status(raw = {}, execution) {
    const input = normalizeSource(raw); await verify(execution); await guardDirectory(root, { missing: true })
    const latest = await metadata(join(root, 'sources', sourceId(input) + '.json')); await verify(execution)
    return { kind: input.kind, repository: input.repository, ref: input.ref, source: input.localPath ? 'local' : 'git', configured: !!input.localPath, cached: !!latest, ...(latest ? { commit: latest.commit, inventoryDigest: latest.inventoryDigest } : {}), networkRequested: false }
  }
  async function prepare(raw = {}, execution) {
    const input = normalizeSource(raw), id = sourceId(input)
    return withLock(id, execution, async () => {
      let commit, dirty = false, bare
      if (input.localPath) {
        const value = await localInfo(input, execution); commit = value.commit; dirty = value.dirty
        bare = beneath(join(root, 'sources', id + '-' + commit + '.git'))
        if (!await exists(bare)) {
          const temporary = beneath(bare + '.' + randomUUID() + '.tmp')
          try { await command(['-c', 'protocol.file.allow=always', 'clone', '--bare', '--local', '--no-hardlinks', '--', input.localPath, temporary], execution); await guardDirectory(temporary); await verify(execution); await rename(temporary, bare) } catch (error) { await removeOwnTree(temporary); throw error }
        }
      } else {
        bare = beneath(join(root, 'sources', id + '.git'))
        if (!await exists(bare)) { await command(['init', '--bare', bare], execution); await guardDirectory(bare) }
        await guardDirectory(bare)
        await command(['--git-dir=' + bare, 'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--force', '--', input.repository, input.ref], execution, { network: true })
        commit = (await command(['--git-dir=' + bare, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], execution)).stdout.trim()
        if (!COMMIT.test(commit)) fail('SOURCE_COMMIT_INVALID')
      }
      await guardDirectory(bare)
      const entries = (await command(['--git-dir=' + bare, 'ls-tree', '-rz', '--full-tree', commit], execution)).stdout.split('\0').filter(Boolean), tree = new Map()
      if (entries.length > 16000) fail('SOURCE_SIZE_LIMIT')
      for (const entry of entries) {
        const parsed = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/u.exec(entry)
        if (!parsed) fail('SOURCE_LINK_REJECTED')
        const path = parsed[3]
        if (/[\u0000-\u001f\\:]/u.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) fail('SOURCE_PATH_INVALID')
        tree.set(path, parsed[2])
      }
      const snapshot = beneath(join(root, 'snapshots', id + '-' + commit)), manifestPath = snapshot + '.json'
      const existing = await exists(snapshot)
      if (existing) {
        const saved = await metadata(manifestPath); if (!saved || saved.commit !== commit || saved.repository !== input.repository) fail('SOURCE_CACHE_INVALID')
        if (saved.gitBindingDigest !== await gitBinding(snapshot, bare, commit)) fail('SOURCE_CACHE_CHANGED')
        const actual = await inventory(snapshot, execution, tree); if (actual.digest !== saved.inventoryDigest) fail('SOURCE_CACHE_CHANGED')
      } else {
        try {
          await command(['--git-dir=' + bare, 'worktree', 'add', '--force', '--detach', '--no-checkout', snapshot, commit], execution)
          await command(['-C', snapshot, 'checkout', '--force', '--detach', commit], execution)
          const actual = await inventory(snapshot, execution, tree)
          await atomicJson(manifestPath, { schemaVersion: 1, commit, repository: input.repository, inventoryDigest: actual.digest, gitBindingDigest: await gitBinding(snapshot, bare, commit), files: actual.files })
        } catch (error) { await removeOwnTree(snapshot); throw error }
      }
      // Re-read both source and snapshot after asynchronous filesystem/process work.
      if (input.localPath) { const fresh = await localInfo(input, execution); if (fresh.commit !== commit || fresh.dirty !== dirty) fail('SOURCE_CHANGED') }
      const saved = await metadata(manifestPath), actual = await inventory(snapshot, execution, tree)
      if (saved?.commit !== commit || saved.inventoryDigest !== actual.digest || saved.gitBindingDigest !== await gitBinding(snapshot, bare, commit)) fail('SOURCE_CACHE_CHANGED')
      await verify(execution)
      const result = { schemaVersion: 1, kind: input.kind, repository: input.repository, ref: input.ref, root: snapshot, commit, source: input.localPath ? 'local' : 'git', dirty, inventoryDigest: actual.digest }
      await atomicJson(join(root, 'sources', id + '.json'), result)
      return result
    })
  }
  return { status, prepare }
}
