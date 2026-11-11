import { createHash } from 'node:crypto'
import { readFile, lstat, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createUpdaterService, createOfficialInstallerAdapter } from './updater.js'

const fail = code => { throw Error(code) }
const SHA = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9-]{36}$/u
const key = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
export async function readWorkerJob(path, expectedHash) {
  if (!isAbsolute(path ?? '') || !SHA.test(expectedHash ?? '')) fail('UPDATE_WORKER_JOB_INVALID')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192 || key(await realpath(path)) !== key(path)) fail('UPDATE_WORKER_JOB_INVALID')
  const bytes = await readFile(path), after = await lstat(path)
  if (bytes.length > 8192 || after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.isSymbolicLink() || createHash('sha256').update(bytes).digest('hex') !== expectedHash) fail('UPDATE_WORKER_JOB_CHANGED')
  const job = JSON.parse(bytes.toString('utf8'))
  if (!job || Array.isArray(job) || Object.keys(job).some(name => !['schemaVersion', 'root', 'engineRoot', 'transactionId', 'token'].includes(name)) || job.schemaVersion !== 1 || !isAbsolute(job.root ?? '') || !isAbsolute(job.engineRoot ?? '') || !UUID.test(job.transactionId ?? '') || !/^[A-Za-z0-9_-]{43}$/u.test(job.token ?? '') || key(path) !== key(join(job.root, 'jobs', job.transactionId + '.json'))) fail('UPDATE_WORKER_JOB_INVALID')
  return job
}
export async function waitForDesktopExit(target, { engineRoot, signal, timeoutMs = 15 * 60 * 1000, intervalMs = 1000, check } = {}) {
  if (!isAbsolute(target?.installRoot ?? '') || !isAbsolute(engineRoot ?? '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) fail('UPDATE_WORKER_TARGET_INVALID')
  const assertStopped = check ?? (await import(pathToFileURL(join(engineRoot, 'installer/official-live/process-guard.mjs')).href)).assertDesktopStopped
  const deadline = Date.now() + timeoutMs
  while (true) {
    signal?.throwIfAborted()
    try { await assertStopped(target.installRoot); return }
    catch (error) { if ((error.code ?? error.message) !== 'LIVE_DSH_STILL_RUNNING') throw error }
    if (Date.now() >= deadline) fail('UPDATE_DESKTOP_EXIT_TIMEOUT')
    await new Promise((accept, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason ?? Error('UPDATE_ABORTED')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); accept() }, Math.min(intervalMs, deadline - Date.now()))
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }
}
async function restartDesktop(target) {
  if (!isAbsolute(target?.installRoot ?? '')) fail('UPDATE_WORKER_TARGET_INVALID')
  await new Promise((accept, reject) => {
    const child = spawn(join(target.installRoot, 'DeepSeek Harness.exe'), [], { cwd: target.installRoot, windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', () => reject(Error('UPDATE_RESTART_FAILED')))
    child.once('spawn', () => { child.unref(); accept() })
  })
}
export async function runUpdateWorker(job, { installer, waitStopped, restart = restartDesktop, prepareCandidate, signal, onArmed } = {}) {
  if (!installer) {
    const prepare = prepareCandidate ?? (async (release, target) => {
      // This helper is part of the already-installed runtime, never the release
      // ZIP or remote Git tree. It must create a real certified local candidate.
      const helper = await import('./updater-candidate.js')
      return helper.prepareUpdateCandidate({ engineRoot: job.engineRoot, release, target, signal })
    })
    installer = await createOfficialInstallerAdapter({ engineRoot: job.engineRoot, prepareCandidate: prepare })
  }
  const armed = onArmed ?? (async value => { await writeFile(join(job.root, 'jobs', job.transactionId + '.ready.json'), JSON.stringify({ schemaVersion: 1, transactionId: job.transactionId, operation: value.operation, pid: process.pid, readyAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }) })
  const service = createUpdaterService({ root: job.root, installer, waitStopped: waitStopped ?? ((target, activeSignal) => waitForDesktopExit(target, { engineRoot: job.engineRoot, signal: activeSignal })), restart, onArmed: armed })
  return service.executePending({ transactionId: job.transactionId, token: job.token }, { signal })
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--job' || argv[2] !== '--sha256') fail('UPDATE_WORKER_USAGE')
  const job = await readWorkerJob(argv[1], argv[3]), result = await runUpdateWorker(job)
  process.stdout.write(JSON.stringify({ transactionId: result.transactionId, state: result.state, version: result.version }) + '\n')
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{2,100}$/u.test(error.message) ? error.message : 'UPDATE_WORKER_FAILED' }) + '\n'); process.exitCode = 1 })
