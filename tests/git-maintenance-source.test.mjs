import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGitSourceService, DEFAULT_SOURCES, normalizeSource } from '../src/git-maintenance/lib/source.js'
const execute = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'git-source-')), source = join(root, 'source'), cache = join(root, 'cache')
  await mkdir(source)
  t.after(async () => { const rel = relative(tmpdir(), root); assert.ok(!isAbsolute(rel) && rel.startsWith('git-source-')); await rm(root, { recursive: true, force: true }) })
  async function git(...args) { return (await execute('git', args, { cwd: source, windowsHide: true })).stdout.trim() }
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Synthetic source fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(source, '.gitattributes'), '* -text\n', 'utf8'); await writeFile(join(source, 'rules.txt'), '\uFEFFfirst\r\n', 'utf8'); await git('add', '.'); await git('commit', '-m', 'initial fixture')
  const calls = []
  const run = async (argv, options) => {
    calls.push({ argv, options }); const args = argv.slice(1)
    // Only this fixture runner maps the real validated public URL to a local repo.
    const at = args.findIndex(arg => arg === DEFAULT_SOURCES.airules.repository)
    if (at >= 0) { args[at] = source; args.unshift('-c', 'protocol.file.allow=always') }
    try { const value = await execute(argv[0], args, { cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.outputLimit, signal: options.signal }); return { code: 0, stdout: value.stdout, stderr: value.stderr } }
    catch (error) { if (error.name === 'AbortError') throw error; return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
  }
  return { root, source, cache, calls, run, git, service: createGitSourceService({ root: cache, run }) }
}

test('default sources are portable, HTTPS GitHub only, and refs cannot become arguments or rev expressions', () => {
  assert.equal(normalizeSource({ kind: 'airules' }).repository, DEFAULT_SOURCES.airules.repository)
  assert.equal(normalizeSource({ kind: 'harness' }).repository, 'https://github.com/s0loww/dsh-harness-overlay.git')
  assert.equal(normalizeSource({ kind: 'airules', repository: 'https://github.com/example/fork', ref: 'release/v1' }).repository, 'https://github.com/example/fork.git')
  for (const repository of ['file:///secret', 'https://user:secret@github.com/x/y.git', 'https://github.com/x/y.git?token=secret', 'ssh://github.com/x/y.git', 'https://github.com/x/../y', 'https://evil.invalid/x/y.git']) assert.throws(() => normalizeSource({ kind: 'airules', repository }))
  for (const ref of ['--upload-pack=evil', 'main^{commit}', 'HEAD~1', 'refs/../secret', 'a.lock', 'a//b', 'a\nb']) assert.throws(() => normalizeSource({ kind: 'airules', ref }))
})

test('status is a local cache read with no Git invocation, checkout or network', async t => {
  const f = await fixture(t), value = await f.service.status({ kind: 'airules' })
  assert.equal(value.cached, false); assert.equal(value.networkRequested, false); assert.equal(f.calls.length, 0)
})

test('local clean source snapshots exact committed BOM/CRLF bytes without mutating checkout; tampering is rejected', async t => {
  const f = await fixture(t), before = await f.git('status', '--porcelain=v1'), result = await f.service.prepare({ kind: 'airules', localPath: f.source })
  assert.equal(result.commit, await f.git('rev-parse', 'HEAD')); assert.equal(result.dirty, false); assert.notEqual(result.root, f.source)
  assert.deepEqual(await readFile(join(result.root, 'rules.txt')), await readFile(join(f.source, 'rules.txt')))
  assert.equal(await f.git('status', '--porcelain=v1'), before)
  assert.equal((await f.service.status({ kind: 'airules', localPath: f.source })).commit, result.commit)
  assert.equal((await f.service.prepare({ kind: 'airules', localPath: f.source })).inventoryDigest, result.inventoryDigest)
  await writeFile(join(result.root, 'rules.txt'), 'tampered')
  await assert.rejects(f.service.prepare({ kind: 'airules', localPath: f.source }), /SOURCE_CACHE_CHANGED/)
})

test('dirty local source refuses by default; explicit committed-only snapshot preserves dirty user files', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'rules.txt'), 'uncommitted user edit')
  await assert.rejects(f.service.prepare({ kind: 'airules', localPath: f.source }), /SOURCE_DIRTY/)
  const result = await f.service.prepare({ kind: 'airules', localPath: f.source, allowDirty: true })
  assert.equal(result.dirty, true); assert.equal(await readFile(join(result.root, 'rules.txt'), 'utf8'), '\uFEFFfirst\r\n')
  assert.equal(await readFile(join(f.source, 'rules.txt'), 'utf8'), 'uncommitted user edit')
})

test('remote prepare fetches only on explicit action and pins new immutable commit snapshots', async t => {
  const f = await fixture(t), first = await f.service.prepare({ kind: 'airules' })
  assert.equal(first.source, 'git'); assert.equal(first.commit, await f.git('rev-parse', 'HEAD'))
  await writeFile(join(f.source, 'rules.txt'), 'second'); await f.git('add', '.'); await f.git('commit', '-m', 'second fixture')
  const second = await f.service.prepare({ kind: 'airules' })
  assert.notEqual(first.commit, second.commit); assert.notEqual(first.root, second.root)
  assert.equal(await readFile(join(first.root, 'rules.txt'), 'utf8'), '\uFEFFfirst\r\n'); assert.equal(await readFile(join(second.root, 'rules.txt'), 'utf8'), 'second')
  const fetches = f.calls.filter(call => call.argv.includes('fetch')); assert.equal(fetches.length, 2)
  assert.ok(fetches.every(call => call.options.env.GIT_TERMINAL_PROMPT === '0' && call.argv.includes('--no-recurse-submodules')))
  assert.ok(f.calls.filter(call => call.argv.includes('checkout')).every(call => call.options.env.GIT_CONFIG_NOSYSTEM === '1' && call.options.env.GIT_CONFIG_GLOBAL.endsWith('empty-git-config')))
})

test('local custom clean filters and checkout hooks are disabled rather than executed', async t => {
  const f = await fixture(t)
  await writeFile(join(f.source, '.gitattributes'), '* -text\n*.txt filter=mustnotexecute\n'); await f.git('add', '.gitattributes'); await f.git('commit', '-m', 'attribute fixture')
  await f.git('config', 'filter.mustnotexecute.clean', 'this-executable-must-never-run')
  await f.git('config', 'filter.mustnotexecute.required', 'true')
  const result = await f.service.prepare({ kind: 'airules', localPath: f.source })
  assert.equal(result.dirty, false)
  assert.ok(f.calls.some(call => call.argv.includes('filter.mustnotexecute.clean=')))
  assert.ok(f.calls.every(call => call.argv.some(arg => arg.startsWith('core.hooksPath='))))
})

test('bad Git outcomes are redacted and cancellation/scope revocation stop preparation', async t => {
  const f = await fixture(t)
  const bad = createGitSourceService({ root: join(f.root, 'bad'), run: async () => ({ code: 1, stdout: '', stderr: 'token=must-not-be-reported' }) })
  await assert.rejects(bad.prepare({ kind: 'airules' }), error => error.message === 'SOURCE_GIT_FAILED')
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.service.prepare({ kind: 'airules' }, { signal: abort.signal }))
  let revoked = false
  const guarded = createGitSourceService({ root: join(f.root, 'guarded'), run: async (...args) => { const value = await f.run(...args); revoked = true; return value } })
  await assert.rejects(guarded.prepare({ kind: 'airules' }, { verify() { if (revoked) throw Error('NATIVE_SCOPE_REVOKED') } }), /NATIVE_SCOPE_REVOKED/)
})

test('concurrent fetches for the same source are locked and linked cache parents are refused', async t => {
  const f = await fixture(t); let release, started
  const entered = new Promise(resolve => { started = resolve }), gate = new Promise(resolve => { release = resolve })
  let first = true
  const service = createGitSourceService({ root: f.cache, run: async (...args) => { if (first) { first = false; started(); await gate }; return f.run(...args) } })
  const pending = service.prepare({ kind: 'airules' }); await entered
  await assert.rejects(service.prepare({ kind: 'airules' }), /SOURCE_BUSY/); release(); await pending
  const outside = join(f.root, 'outside'), linked = join(f.root, 'linked'); await mkdir(outside); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedService = createGitSourceService({ root: join(linked, 'cache'), run: f.run })
  await assert.rejects(linkedService.prepare({ kind: 'airules' }), /SOURCE_PATH_INVALID/)
})

test('changing snapshot Git binding cannot impersonate a different repository', async t => {
  const f = await fixture(t), result = await f.service.prepare({ kind: 'airules', localPath: f.source })
  await rm(join(result.root, '.git')); await writeFile(join(result.root, '.git'), 'gitdir: ' + join(f.source, '.git') + '\n')
  await assert.rejects(f.service.prepare({ kind: 'airules', localPath: f.source }), /SOURCE_CACHE_INVALID|SOURCE_CACHE_CHANGED/)
})

test('explicit PowerShell CRLF attributes retain checkout bytes and BOM while proving committed blob identity', async t => {
  const f = await fixture(t)
  await writeFile(join(f.source, '.gitattributes'), '* -text\n*.ps1 text eol=crlf\n')
  await writeFile(join(f.source, 'runner.ps1'), '\uFEFFWrite-Output fixture\r\n', 'utf8')
  await f.git('add', '.'); await f.git('commit', '-m', 'PowerShell EOL fixture')
  const result = await f.service.prepare({ kind: 'airules', localPath: f.source })
  assert.equal(await readFile(join(result.root, 'runner.ps1'), 'utf8'), '\uFEFFWrite-Output fixture\r\n')
})
