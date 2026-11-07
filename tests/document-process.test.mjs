import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
const source = (await readFile(new URL('../src/document-workbench/lib/process.js', import.meta.url), 'utf8'))
 .replace(/import .* from '@deepseek-ai\/dsh-subprocess'/u, "const scrubbedParentEnv = () => ({ PATH: 'native', API_TOKEN: 'secret', PYTHONPATH: 'untrusted' })")
 .replace(/import .* from '@deepseek-ai\/dsh-sandbox'/u, "const classifyRunnerFailure = () => undefined, matchesSignature = (_code, text, rules) => rules.some(rule => text.includes(rule))")
const { runNative } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
function fixture({ mode = 'workspace-write', pending = false, denied = false, policyChange = false, unconfirmed = false } = {}) {
 const session = { id: 'fixture', header: { id: 'fixture', cwd: process.cwd() } }, agent = { session }, calls = []
 let policy = { mode, sessionId: session.id, workspaceRoot: session.header.cwd }
 const ctx = { sandboxPolicy: { resolve: () => ({ ...policy }) }, sandbox: { async confine(argv) { calls.push('confine'); if (policyChange) policy.mode = 'danger-full-access'; return { argv: ['confined', ...argv], denialSignatures: ['denied'], runnerFailureRules: [] } } },
 subprocess: { spawn(spec) {
  calls.push(spec); const stdout = new PassThrough(), stderr = new PassThrough(); let finish, exited = false
  const done = new Promise(resolve => { finish = code => { if (exited) return; exited = true; stdout.end(); stderr.end(); resolve({ exitCode: code }) } })
  const handle = { stdout, stderr, done, terminate() { calls.push('terminate'); finish(null) }, waitForExit: async () => { await done; return !unconfirmed } }
  if (!pending) queueMicrotask(() => { if (denied) stderr.write('denied'); else stdout.write('fixture-only'); finish(denied ? 1 : 0) })
  return handle
 } } }
 return { ctx, agent, calls }
}
test('native confinement and environment scrubbing preserve session mode', async () => {
 const f = fixture(); assert.equal((await runNative(f.ctx, f.agent, ['node', '--version'])).stdout, 'fixture-only')
 assert.equal(f.calls[0], 'confine'); assert.deepEqual(f.calls[1].argv, ['confined', 'node', '--version'])
 assert.equal(f.calls[1].env.API_TOKEN, undefined); assert.equal(f.calls[1].env.PYTHONPATH, undefined)
})
test('read-only writing and changing policy fail before spawning', async () => {
 const f = fixture({ mode: 'read-only' }); await assert.rejects(runNative(f.ctx, f.agent, ['node'], { writes: true }), /WORKSPACE_WRITE_REQUIRED/); assert.equal(f.calls.length, 0)
 const changing = fixture({ policyChange: true }); await assert.rejects(runNative(changing.ctx, changing.agent, ['node']), /DOCUMENT_POLICY_CHANGED/); assert.deepEqual(changing.calls, ['confine'])
})
test('native denials do not expose stderr and timeout terminates owned range', async () => {
 const denied = fixture({ denied: true }); await assert.rejects(runNative(denied.ctx, denied.agent, ['node']), /^Error: DOCUMENT_SANDBOX_DENIED$/u)
 const timeout = fixture({ pending: true }); await assert.rejects(runNative(timeout.ctx, timeout.agent, ['node'], { timeoutMs: 10 }), /DOCUMENT_PROCESS_TIMEOUT/); assert.ok(timeout.calls.includes('terminate'))
})

test('unconfirmed managed process termination remains a distinct error', async () => {
 const f = fixture({ pending: true, unconfirmed: true })
 await assert.rejects(runNative(f.ctx, f.agent, ['node'], { timeoutMs: 10 }), /^Error: DOCUMENT_TERMINATION_UNCONFIRMED$/u)
 assert.ok(f.calls.includes('terminate'))
})
