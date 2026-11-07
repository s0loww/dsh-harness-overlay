import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

const MAX_OUTPUT = 1024 * 1024
const CLEANUP_MS = 10000
const MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const ALLOWED_EFFECTS = new Set(['readsSource', 'startsProcess', 'writesFilesystem'])
const fail = code => new Error(code)
const aborted = () => fail('NATIVE_WORKFLOW_ABORTED')
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Native services/helpers are injected by the DSH plugin; this module never spawns locally. */
export function createNativeProcessAdapter({ ctx, agent, callId, signal, id, version = '1.0.0', operations, core, nativeHelpers }) {
  if (!ctx?.sandboxPolicy?.resolve || !ctx?.subprocess?.spawn || !ctx?.sandbox?.confine ||
      !core?.validateDescriptor || !core?.validateSchema || !core?.digest || !core?.PROCESS_RESULT_SCHEMA ||
      typeof nativeHelpers?.scrubbedParentEnv !== 'function' || typeof nativeHelpers?.classifyRunnerFailure !== 'function' ||
      typeof nativeHelpers?.matchesSignature !== 'function') throw fail('NATIVE_WORKFLOW_SERVICES_REQUIRED')
  const session = agent?.session
  if (!session || typeof session.id !== 'string' || !session.id || session.header?.id !== session.id ||
      typeof session.header?.cwd !== 'string' || !isAbsolute(session.header.cwd) || typeof callId !== 'string' || !callId) throw fail('NATIVE_WORKFLOW_SESSION_REQUIRED')
  assertSignal(signal)
  const registered = new Map(), described = Object.create(null)
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) throw fail('NATIVE_WORKFLOW_OPERATIONS_REQUIRED')
  for (const [name, config] of Object.entries(operations)) {
    if (!config || typeof config.command !== 'string' || !isAbsolute(config.command) || config.command.includes('\0') ||
        typeof config.args !== 'function' || config.workingDirectory !== undefined && typeof config.workingDirectory !== 'function' || config.validator !== 'process-exit' || !Array.isArray(config.effects) ||
        config.effects.some(effect => !ALLOWED_EFFECTS.has(effect))) throw fail('NATIVE_WORKFLOW_OPERATION_REJECTED')
    const paths = [...(config.fingerprintPaths ?? [])]
    if (paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw fail('NATIVE_WORKFLOW_FINGERPRINT_REJECTED')
    const inputSchema = structuredClone(config.inputSchema)
    registered.set(name, { command: config.command, args: config.args, workingDirectory: config.workingDirectory, paths, inputSchema, effects: [...config.effects] })
    described[name] = { inputSchema, resultSchema: structuredClone(core.PROCESS_RESULT_SCHEMA),
      effects: [...config.effects], validator: 'process-exit',
      ...(config.resourcesRequired === undefined ? {} : { resourcesRequired: config.resourcesRequired }) }
  }
  const descriptor = freeze(core.validateDescriptor({ protocolVersion: 1, id, version, operations: described }))
  return {
    descriptor,
    async fingerprint() {
      const files = new Map()
      for (const config of registered.values()) for (const path of [config.command, ...config.paths]) {
        if (!files.has(path)) files.set(path, await fingerprintFile(path))
      }
      return core.digest({ descriptor, moduleHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
        files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
        builders: [...registered].map(([name, config]) => [name, config.args.toString(), config.workingDirectory?.toString() ?? null]) })
    },
    async execute(operation, inputs, context = {}) {
      const config = registered.get(operation)
      if (!config) throw fail('NATIVE_WORKFLOW_OPERATION_UNKNOWN')
      try { core.validateSchema(config.inputSchema, inputs) } catch { throw fail('NATIVE_WORKFLOW_INPUT_INVALID') }
      assertSignal(context.signal)
      if (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < 100 || context.timeoutMs > 3600000) throw fail('NATIVE_WORKFLOW_TIMEOUT_REQUIRED')
      if (agent.session !== session || session.header?.id !== session.id || typeof context.cwd !== 'string' || !isAbsolute(context.cwd)) throw fail('NATIVE_WORKFLOW_SESSION_MISMATCH')
      let cwd, root, policy
      try {
        cwd = await realpath(context.cwd)
        root = await realpath(session.header.cwd)
        policy = ctx.sandboxPolicy.resolve({ session })
        if (!(await stat(cwd)).isDirectory() || !samePath(cwd, root) || !MODES.has(policy?.mode) ||
            policy.sessionId !== session.id || typeof policy.workspaceRoot !== 'string' ||
            !samePath(await realpath(policy.workspaceRoot), root)) throw fail('NATIVE_WORKFLOW_POLICY_MISMATCH')
      } catch { throw fail('NATIVE_WORKFLOW_POLICY_MISMATCH') }
      if (signal?.aborted || context.signal?.aborted) return { data: { exitCode: null, signal: null, timedOut: false, aborted: true,
        outputLimitExceeded: false, stdoutBytes: 0, stderrBytes: 0, startError: null, terminationConfirmed: true }, mutationState: 'not-applied' }
      if (config.workingDirectory) {
        try {
          const requested = config.workingDirectory(structuredClone(inputs), Object.freeze({ ...context, cwd }))
          if (typeof requested !== 'string' || !isAbsolute(requested) || requested.includes('\0')) throw fail('NATIVE_WORKFLOW_WORKING_DIRECTORY_INVALID')
          const childCwd = await realpath(requested), rel = relative(root, childCwd)
          if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await stat(childCwd)).isDirectory()) throw fail('NATIVE_WORKFLOW_WORKING_DIRECTORY_INVALID')
          cwd = childCwd
        } catch { throw fail('NATIVE_WORKFLOW_WORKING_DIRECTORY_INVALID') }
      }
      let command, args
      try {
        command = await realpath(config.command)
        if (!(await stat(command)).isFile() || (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command))) throw fail('NATIVE_WORKFLOW_COMMAND_INVALID')
        args = config.args(structuredClone(inputs), Object.freeze({ ...context, cwd }))
        if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw fail('NATIVE_WORKFLOW_ARGUMENTS_INVALID')
      } catch { throw fail('NATIVE_WORKFLOW_ARGUMENTS_INVALID') }
      return executeNative({ ctx, session, agent, signal, context, cwd, argv: [command, ...args], policy, config, nativeHelpers })
    },
  }
}

async function executeNative({ ctx, session, agent, signal, context, cwd, argv, policy, config, nativeHelpers }) {
  const data = { exitCode: null, signal: null, timedOut: false, aborted: false,
    outputLimitExceeded: false, stdoutBytes: 0, stderrBytes: 0, startError: null, terminationConfirmed: true }
  const controller = new AbortController(), removers = [], streamListeners = []
  let handle, facts, spawnAttempted = false, stage = 'prepare'
  const stderr = Buffer.alloc(MAX_OUTPUT)
  let stderrUsed = 0
  const stop = () => controller.abort()
  for (const outer of [signal, context.signal]) {
    if (!outer) continue
    const listener = () => { data.aborted = true; stop() }
    if (outer.aborted) listener()
    else { outer.addEventListener('abort', listener, { once: true }); removers.push(() => outer.removeEventListener('abort', listener)) }
  }
  const timer = setTimeout(() => { data.timedOut = true; stop() }, context.timeoutMs)
  try {
    if (controller.signal.aborted) throw aborted()
    if (policy.mode !== 'danger-full-access') {
      stage = 'confine'
      facts = await cancellable(Promise.resolve().then(() => ctx.sandbox.confine(argv, policy, controller.signal)), controller.signal)
      if (!Array.isArray(facts?.argv) || !facts.argv.length || !facts.argv[0] || facts.argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
          typeof facts.enforcement !== 'string' || !facts.enforcement || !Array.isArray(facts.denialSignatures) || !Array.isArray(facts.runnerFailureRules)) throw fail('NATIVE_WORKFLOW_CONFINEMENT_INVALID')
    }
    controller.signal.throwIfAborted()
    // A mode/session change during confinement preparation never widens this pending call.
    stage = 'policy'
    const current = ctx.sandboxPolicy.resolve({ session })
    if (agent.session !== session || current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot || current.sessionId !== policy.sessionId) throw fail('NATIVE_WORKFLOW_POLICY_CHANGED')
    const env = safeEnvironment(nativeHelpers.scrubbedParentEnv())
    stage = 'spawn'
    spawnAttempted = true
    handle = ctx.subprocess.spawn({ argv: facts?.argv ?? argv, cwd, env, graceMs: 1000,
      signal: controller.signal, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    data.terminationConfirmed = false
    if (!handle?.done?.then || typeof handle.terminate !== 'function' || typeof handle.waitForExit !== 'function' ||
        typeof handle.stdout?.on !== 'function' || typeof handle.stderr?.on !== 'function') throw fail('NATIVE_WORKFLOW_HANDLE_INVALID')
    for (const [stream, key] of [[handle.stdout, 'stdoutBytes'], [handle.stderr, 'stderrBytes']]) {
      const listener = chunk => {
        if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) { data.startError = 'NATIVE_STREAM_FAILED'; stop(); return }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        data[key] = Math.min(Number.MAX_SAFE_INTEGER, data[key] + bytes.length)
        if (key === 'stderrBytes' && stderrUsed < MAX_OUTPUT) {
          const retained = Math.min(bytes.length, MAX_OUTPUT - stderrUsed)
          bytes.copy(stderr, stderrUsed, 0, retained)
          stderrUsed += retained
        }
        if (data[key] > MAX_OUTPUT) { data.outputLimitExceeded = true; stop() }
      }
      const onError = () => { data.startError = 'NATIVE_STREAM_FAILED'; stop() }
      stream.on('data', listener)
      stream.on('error', onError)
      streamListeners.push(() => { stream.off('data', listener); stream.off('error', onError) })
    }
    stage = 'running'
    const result = await cancellable(handle.done, controller.signal)
    if ((result.exitCode !== null && !Number.isInteger(result.exitCode)) || (result.signal !== null && typeof result.signal !== 'string')) throw fail('NATIVE_WORKFLOW_RESULT_INVALID')
    data.exitCode = result.exitCode
    data.signal = result.signal
    if (await cancellable(Promise.resolve(handle.waitForExit(controller.signal)), controller.signal) !== true) throw fail('NATIVE_WORKFLOW_TERMINATION_UNCONFIRMED')
    data.terminationConfirmed = true
    if (facts && nativeHelpers.classifyRunnerFailure(data.exitCode, stderr.subarray(0, stderrUsed).toString('utf8'), facts.runnerFailureRules) !== undefined) data.startError = 'NATIVE_SANDBOX_UNAVAILABLE'
    else if (facts && nativeHelpers.matchesSignature(data.exitCode, stderr.subarray(0, stderrUsed).toString('utf8'), facts.denialSignatures)) data.startError = 'NATIVE_SANDBOX_DENIED'
  } catch {
    if (handle) {
      try { Promise.resolve(handle.terminate()).catch(() => {}) } catch {}
      try { data.terminationConfirmed = await bounded(Promise.resolve(handle.waitForExit()), CLEANUP_MS) === true } catch { data.terminationConfirmed = false }
      Promise.resolve(handle.done).catch(() => {})
    } else if (spawnAttempted) data.terminationConfirmed = false
    if (!data.aborted && !data.timedOut && !data.outputLimitExceeded && !data.startError) {
      data.startError = stage === 'confine' ? 'NATIVE_SANDBOX_UNAVAILABLE' : ['prepare', 'policy'].includes(stage) ? 'NATIVE_POLICY_REJECTED' : 'NATIVE_PROCESS_FAILED'
    }
  } finally {
    clearTimeout(timer)
    removers.forEach(remove => remove())
    streamListeners.forEach(remove => remove())
    if (handle && !data.terminationConfirmed) {
      handle.stdout?.on?.('error', () => {}); handle.stderr?.on?.('error', () => {})
      handle.stdout?.destroy?.(); handle.stderr?.destroy?.()
    }
    stderr.fill(0)
  }
  return { data, mutationState: spawnAttempted && config.effects.includes('writesFilesystem') ? 'unknown' : 'not-applied' }
}

function safeEnvironment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('NATIVE_WORKFLOW_ENVIRONMENT_INVALID')
  const env = Object.create(null)
  for (const [key, value] of Object.entries(input)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/iu.test(key) || key.toUpperCase().startsWith('DSH_')) continue
    if (typeof value !== 'string' || key.includes('\0') || value.includes('\0')) throw fail('NATIVE_WORKFLOW_ENVIRONMENT_INVALID')
    env[key] = value
  }
  return env
}

function assertSignal(signal) {
  if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw fail('NATIVE_WORKFLOW_SIGNAL_INVALID')
}
function cancellable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(aborted()) }
  return new Promise((resolve, reject) => {
    const listener = () => { signal.removeEventListener('abort', listener); reject(aborted()) }
    signal.addEventListener('abort', listener, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', listener))
  })
}
async function bounded(promise, timeoutMs) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('NATIVE_WORKFLOW_CLEANUP_TIMEOUT')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function fingerprintFile(path) {
  const actual = await realpath(path), before = await stat(actual)
  if (!before.isFile() || before.size > 1024 * 1024 * 1024) throw fail('NATIVE_WORKFLOW_FINGERPRINT_INVALID')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(actual)) hash.update(chunk)
  const after = await stat(actual)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw fail('NATIVE_WORKFLOW_FINGERPRINT_CHANGED')
  return { identity: actual, sha256: hash.digest('hex') }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
