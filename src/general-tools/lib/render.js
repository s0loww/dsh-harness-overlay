import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inside, safePath } from './style.js'

const ROOT = fileURLToPath(new URL('../runtime/mermaid/', import.meta.url))
const hash = data => createHash('sha256').update(data).digest('hex')
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const fail = code => { throw new Error(code) }
export async function resolveNode(configured = '') {
  if (typeof configured !== 'string' || !isAbsolute(configured)) fail('NODE_RUNTIME_UNAVAILABLE')
  const actual = await realpath(configured).catch(() => fail('NODE_RUNTIME_UNAVAILABLE'))
  if (!(await lstat(actual)).isFile()) fail('NODE_RUNTIME_UNAVAILABLE')
  return actual
}
export async function bundledNode(ctx, exec, configured = '') {
  if (configured) return resolveNode(configured)
  if (!exec?.agent?.session || typeof exec.callId !== 'string' || typeof exec.token !== 'symbol' ||
      !ctx.tools?.get('load_workspace_dependencies', exec.agent)) fail('BUNDLED_RUNTIME_REQUIRED')
  exec.signal?.throwIfAborted()
  const result = await ctx.tools.execute({ name: 'load_workspace_dependencies', agent: exec.agent,
    callId: `${exec.callId}:mermaid-runtime`, rootCallId: exec.rootCallId ?? exec.callId,
    parent: exec.token, arguments: {}, signal: exec.signal })
  exec.signal?.throwIfAborted()
  if (result?.isError !== false || typeof result.value?.node !== 'string') fail('BUNDLED_RUNTIME_REQUIRED')
  return resolveNode(result.value.node)
}
function bounded(promise, signal, ms = 5000) {
  return new Promise((accept, reject) => {
    let timer
    const abort = () => finish(reject, new Error('RENDER_ABORTED'))
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value) }
    timer = setTimeout(() => finish(reject, new Error('NATIVE_PROCESS_UNCONFIRMED')), ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    Promise.resolve(promise).then(value => finish(accept, value), error => finish(reject, error))
  })
}
function validateArgs(args) {
  if (!args || Object.keys(args).some(key => !['input', 'outDir', 'theme'].includes(key)) || typeof args.input !== 'string' || !args.input || typeof args.outDir !== 'string' || !args.outDir || !['craft-light', 'craft-dark'].includes(args.theme ?? 'craft-light')) fail('RENDER_INPUT_INVALID')
  for (const key of ['input', 'outDir']) if (args[key].length > 4096 || args[key].includes('\0')) fail('RENDER_INPUT_INVALID')
}
function processEnv(parent) {
  const result = Object.create(null)
  for (const [key, value] of Object.entries(parent)) if (typeof value === 'string' && !/KEY|PASSWORD|SECRET|TOKEN/iu.test(key) && !/^(?:DSH_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_)/iu.test(key)) result[key] = value
  return result
}
export async function runNative(ctx, { argv, cwd, policy, session, agent, signal, helpers, timeoutMs = 60000 }) {
  let handle, timedOut = false, stdout = [], stderr = [], total = 0
  const controller = new AbortController(), cancel = () => controller.abort(signal.reason)
  if (signal?.aborted) throw new Error('RENDER_ABORTED')
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const facts = policy.mode === 'danger-full-access' ? null : await bounded(ctx.sandbox.confine(argv, policy, controller.signal), controller.signal, timeoutMs)
    if (facts && (!Array.isArray(facts.argv) || !facts.argv.length || facts.argv.some(value => typeof value !== 'string' || !value || value.includes('\0')) || typeof facts.enforcement !== 'string' || !facts.enforcement || !Array.isArray(facts.denialSignatures) || !Array.isArray(facts.runnerFailureRules))) fail('NATIVE_SANDBOX_UNAVAILABLE')
    controller.signal.throwIfAborted()
    const fresh = ctx.sandboxPolicy.resolve({ session })
    if (agent?.session !== session || fresh.mode !== policy.mode || fresh.sessionId !== policy.sessionId || fresh.workspaceRoot !== policy.workspaceRoot) fail('NATIVE_POLICY_CHANGED')
    handle = ctx.subprocess.spawn({ argv: facts?.argv ?? argv, cwd, env: processEnv(helpers.scrubbedParentEnv()), graceMs: 1000, signal: controller.signal, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    if (!handle?.done?.then || typeof handle.waitForExit !== 'function' || typeof handle.terminate !== 'function') fail('NATIVE_PROCESS_UNAVAILABLE')
    for (const [stream, chunks] of [[handle.stdout, stdout], [handle.stderr, stderr]]) {
      if (!stream || typeof stream.on !== 'function') fail('NATIVE_PROCESS_UNAVAILABLE')
      stream.on('error', () => controller.abort())
      stream.on('data', chunk => { const data = Buffer.from(chunk); total += data.length; if (total <= 512 * 1024) chunks.push(data); else controller.abort() })
    }
    const done = await bounded(handle.done, controller.signal, timeoutMs)
    const stopped = await bounded(handle.waitForExit(controller.signal), controller.signal)
    if (stopped !== true) fail('NATIVE_PROCESS_UNCONFIRMED')
    if (controller.signal.aborted || total > 512 * 1024) fail(timedOut ? 'RENDER_TIMEOUT' : signal?.aborted ? 'RENDER_ABORTED' : 'RENDER_OUTPUT_LIMIT')
    const text = Buffer.concat(stderr).toString('utf8')
    if (facts && (helpers.classifyRunnerFailure(done.exitCode, text, facts.runnerFailureRules) !== undefined || helpers.matchesSignature(done.exitCode, text, facts.denialSignatures))) fail('NATIVE_SANDBOX_DENIED')
    return { exitCode: done.exitCode, stdout: Buffer.concat(stdout).toString('utf8') }
  } catch (error) {
    if (handle) { try { await bounded(handle.terminate()) } catch {}; try { await bounded(handle.waitForExit()) } catch {} }
    if (timedOut) fail('RENDER_TIMEOUT')
    if (signal?.aborted) fail('RENDER_ABORTED')
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}
export async function renderForAgent(ctx, args, exec, { nodePath = '', runtimeRoot = ROOT, helpers, run = runNative } = {}) {
  validateArgs(args)
  const agent = exec?.agent, session = agent?.session
  if (!session || session.id !== session.header?.id || !isAbsolute(session.header.cwd ?? '')) fail('ACTIVE_AGENT_REQUIRED')
  const policy = ctx.sandboxPolicy.resolve({ session }), root = await realpath(session.header.cwd)
  if (!['workspace-write', 'danger-full-access'].includes(policy?.mode)) fail('WORKSPACE_WRITE_REQUIRED')
  if (policy.sessionId !== session.id || !same(await realpath(policy.workspaceRoot), root)) fail('NATIVE_POLICY_MISMATCH')
  const input = resolve(root, args.input), parent = resolve(root, args.outDir)
  if (!inside(root, input) || !inside(root, parent) || extname(input).toLowerCase() !== '.mmd') fail('PATH_REJECTED')
  await safePath(root, input); await safePath(root, parent)
  const stat = await lstat(input)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 || !same(await realpath(input), input)) fail('RENDER_INPUT_INVALID')
  const source = await readFile(input)
  if (source.includes(0) || !Buffer.from(source.toString('utf8')).equals(source)) fail('RENDER_INPUT_INVALID')
  const folder = join(parent, `mermaid-${randomUUID()}`)
  await mkdir(parent, { recursive: true }); await safePath(root, parent)
  await mkdir(folder); await safePath(root, folder)
  const snapshot = join(folder, 'diagram.mmd')
  await writeFile(snapshot, source, { flag: 'wx', mode: 0o600 })
  const node = await bundledNode(ctx, exec, nodePath), script = join(runtimeRoot, 'scripts/runtime/render.mjs')
  const result = await run(ctx, { argv: [node, script, '--input', snapshot, '--out-dir', folder, '--theme', args.theme ?? 'craft-light', '--json'], cwd: root, policy, session, agent, signal: exec.signal, helpers })
  let report; try { report = JSON.parse(result.stdout) } catch { fail('RENDER_REPORT_INVALID') }
  if (result.exitCode !== 0 || report.valid !== true) return { ok: false, error: 'RENDER_FAILED', diagnostics: (report.errors ?? []).slice(0, 4).map(value => String(value).slice(0, 512)), sourceDigest: hash(source) }
  const png = join(folder, 'diagram.png'), normalized = join(folder, 'diagram.normalized.mmd')
  for (const path of [png, normalized]) { await safePath(root, path); const stat = await lstat(path); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) fail('RENDER_ARTIFACT_INVALID') }
  if (!same(resolve(report.artifacts?.png ?? ''), png) || !same(resolve(report.artifacts?.source ?? ''), normalized)) fail('RENDER_REPORT_INVALID')
  const pngBytes = await readFile(png)
  if (!pngBytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('RENDER_ARTIFACT_INVALID')
  return { ok: true, renderer: 'beautiful-mermaid', rendererVersion: '1.1.3', theme: args.theme ?? 'craft-light', input, sourceDigest: hash(source), artifacts: { source: normalized, png }, pngDigest: hash(pngBytes), raster: report.raster, warnings: report.warnings ?? [], visualReview: 'required' }
}
