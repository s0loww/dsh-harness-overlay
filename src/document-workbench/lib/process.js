import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
const LIMIT = 10 * 1024 * 1024
export async function runNative(ctx, agent, argv, { signal, timeoutMs = 120000, writes = false } = {}) {
  const session = agent?.session, policy = ctx.sandboxPolicy.resolve({ session })
  if (!session || session.header.id !== session.id || policy.sessionId !== session.id || policy.workspaceRoot !== session.header.cwd || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) throw new Error('DOCUMENT_NATIVE_SESSION_REQUIRED')
  if (writes && policy.mode === 'read-only') throw new Error('WORKSPACE_WRITE_REQUIRED')
  const abort = new AbortController(), forward = () => abort.abort(signal.reason), chunks = [], errors = []; let size = 0, errorSize = 0, handle
  if (signal?.aborted) abort.abort(signal.reason); else signal?.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => abort.abort(new Error('DOCUMENT_PROCESS_TIMEOUT')), timeoutMs)
  try {
    const facts = policy.mode === 'danger-full-access' ? null : await ctx.sandbox.confine(argv, policy, abort.signal)
    abort.signal.throwIfAborted()
    if (facts && (!Array.isArray(facts.argv) || !facts.argv.length || !facts.argv.every(value => typeof value === 'string' && !value.includes('\0')))) throw new Error('DOCUMENT_SANDBOX_INVALID')
    const current = ctx.sandboxPolicy.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot || agent.session !== session) throw new Error('DOCUMENT_POLICY_CHANGED')
    const env = Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([key]) => !/KEY|PASSWORD|TOKEN|SECRET|^DSH_|NODE_OPTIONS|PYTHONPATH/iu.test(key)))
    env.PYTHONUTF8 = '1'
    handle = ctx.subprocess.spawn({ argv: facts?.argv ?? argv, cwd: policy.workspaceRoot, env, graceMs: 1000, signal: abort.signal, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    handle.stdout.on('data', data => { const bytes = Buffer.from(data); size += bytes.length; if (size > LIMIT) abort.abort(new Error('DOCUMENT_OUTPUT_LIMIT')); else chunks.push(bytes) })
    handle.stderr.on('data', data => { const bytes = Buffer.from(data); errorSize += bytes.length; if (errorSize > LIMIT) abort.abort(new Error('DOCUMENT_OUTPUT_LIMIT')); else errors.push(bytes) })
    handle.stdout.on('error', () => abort.abort(new Error('DOCUMENT_STREAM_FAILED')))
    handle.stderr.on('error', () => abort.abort(new Error('DOCUMENT_STREAM_FAILED')))
    const result = await cancellable(handle.done, abort.signal)
    if (await cancellable(handle.waitForExit(abort.signal), abort.signal) !== true) throw new Error('DOCUMENT_TERMINATION_UNCONFIRMED')
    abort.signal.throwIfAborted()
    const stderr = Buffer.concat(errors).toString('utf8')
    if (facts && (classifyRunnerFailure(result.exitCode, stderr, facts.runnerFailureRules) !== undefined || matchesSignature(result.exitCode, stderr, facts.denialSignatures))) throw new Error('DOCUMENT_SANDBOX_DENIED')
    if (result.exitCode !== 0) throw new Error(['DOCUMENT_OCR_REQUIRED', 'DOCUMENT_ENCRYPTED', 'DOCUMENT_EMPTY', 'DOCUMENT_TEXT_LIMIT', 'DOCUMENT_FILE_LIMIT', 'DOCUMENT_CONVERSION_FAILED'].includes(stderr.trim()) ? stderr.trim() : 'DOCUMENT_PROCESS_FAILED')
    return { stdout: Buffer.concat(chunks).toString('utf8'), exitCode: result.exitCode }
  } catch (error) {
    if (handle) {
      try { Promise.resolve(handle.terminate()).catch(() => {}) } catch {}
      let confirmed = false
      try { confirmed = await bounded(handle.waitForExit(), 10000) === true } catch {}
      if (!confirmed) throw new Error('DOCUMENT_TERMINATION_UNCONFIRMED')
    }
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward) }
}

function cancellable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    const listener = () => reject(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', listener))
  })
}
async function bounded(promise, ms) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DOCUMENT_TERMINATION_UNCONFIRMED')), ms) })]) }
  finally { clearTimeout(timer) }
}
