import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createNativeProcessAdapter } from './native-process.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
const IDENTITIES = ['recoveryId', 'runId', 'targetId', 'planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest']
const REPORT_FIELDS = ['schemaVersion', ...IDENTITIES, 'executorStopped', 'outcome', 'observedAt']
const fail = code => { throw new Error(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const callId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/u.test(value)
function portable(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || isAbsolute(value)
    || /[\x00-\x1f:*?"<>|]/u.test(value) || value.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')) fail('RECOVERY_LOCAL_PATH_INVALID')
  return value.replaceAll('\\', '/')
}
function configure(config, core) {
  if (!plain(config) || Object.keys(config).some(key => !['projectId', 'id', 'runnerPath', 'reviewedDigest', 'files', 'timeoutMs'].includes(key))
    || !ID.test(config.projectId ?? '') || !ID.test(config.id ?? '') || !SHA.test(config.reviewedDigest ?? '')
    || !Array.isArray(config.files) || !config.files.length || config.files.length > 64) fail('RECOVERY_LOCAL_CONFIG_INVALID')
  core.canonical(config)
  const runnerPath = portable(config.runnerPath), files = config.files.map(portable).sort()
  const aliases = files.map(path => process.platform === 'win32' ? path.toLowerCase() : path)
  if (!/\.ps1$/iu.test(runnerPath) || files.some(path => !/\.(?:ps1|psm1|json)$/iu.test(path))
    || new Set(aliases).size !== files.length || !files.includes(runnerPath)) fail('RECOVERY_LOCAL_CONFIG_INVALID')
  const timeoutMs = config.timeoutMs ?? 1800000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) fail('RECOVERY_TIMEOUT_INVALID')
  return { projectId: config.projectId, id: config.id, runnerPath, reviewedDigest: config.reviewedDigest, files, timeoutMs }
}
async function checkedDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('RECOVERY_LOCAL_DIRECTORY_INVALID')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), resolve(path))) fail('RECOVERY_LOCAL_DIRECTORY_INVALID')
  return realpath(path)
}
async function absentReportDirectory(root, relativePath) {
  let cursor = root
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment)
    let info
    try { info = await lstat(cursor) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(cursor), resolve(cursor))) fail('RECOVERY_LOCAL_REPORT_PATH_INVALID')
  }
  fail('RECOVERY_LOCAL_REPORT_PREEXISTING')
}

/**
 * A machine-reviewed project runner, independent of MCP. No shell or project-supplied argv.
 * reviewedDigest = core.digest({files:[{path: normalizedRelativePath,digest:sha256(bytes)}] sorted by path}).
 * The reviewed .ps1 must accept exactly the fixed -Workflow* arguments below; independently
 * prove the original executor AND previous recovery attempts stopped; restore/verify its
 * own bound target/backup idempotently by recoveryId; then create WorkflowReportPath.
 * Report: {schemaVersion:1,recoveryId,runId,targetId,planDigest,sourceDigest,
 * targetFingerprint,providerDigest,executorStopped:true,outcome:'not-applied'|'restored',observedAt:UnixMilliseconds}.
 * It creates the report directory itself through native sandbox permissions. The host never
 * creates project report directories or changes target data directly.
 */
export function createLocalRecoveryProvider({ ctx, scope, config, core, execution, mode, active, nativeHelpers, pwshPath }) {
  const settings = configure(config, core)
  if (!scope || !callId(scope.id) || typeof scope.root !== 'string' || !isAbsolute(scope.root)
    || !active || typeof active.has !== 'function') fail('RECOVERY_LOCAL_SCOPE_REQUIRED')
  const effects = ['readsSource', 'startsProcess', 'writesFilesystem', 'connectsTarget', 'writesTargetData', 'changesMetadata', 'destructiveRecovery']
  async function closure() {
    const root = await checkedDirectory(scope.root), files = [], paths = []
    let total = 0
    for (const path of settings.files) {
      const absolute = await core.projectPath(root, path), info = await lstat(absolute)
      if (info.nlink !== 1) fail('RECOVERY_LOCAL_CLOSURE_INVALID')
      const bytes = await core.safeRead(root, absolute, 2 * 1024 * 1024)
      total += bytes.length
      if (total > 8 * 1024 * 1024 || (await lstat(absolute)).nlink !== 1) fail('RECOVERY_LOCAL_CLOSURE_INVALID')
      files.push({ path, digest: hash(bytes) }); paths.push(absolute)
    }
    if (core.digest({ files }) !== settings.reviewedDigest) fail('RECOVERY_LOCAL_REVIEW_REQUIRED')
    return { root, files, paths, script: await core.projectPath(root, settings.runnerPath) }
  }
  function native(info) {
    if (typeof pwshPath !== 'string' || !isAbsolute(pwshPath) || !/^(?:pwsh|powershell)(?:\.exe)?$/iu.test(basename(pwshPath))) fail('RECOVERY_POWERSHELL_REQUIRED')
    const agent = execution?.agent ?? { session: { id: scope.id, header: { id: scope.id, cwd: scope.root } } }
    return createNativeProcessAdapter({ ctx, agent, callId: execution?.callId ?? 'recovery-fingerprint-only', signal: execution?.signal,
      id: settings.id, core, nativeHelpers, operations: { restore: {
        command: pwshPath, inputSchema: { type: 'object', additionalProperties: false },
        validator: 'process-exit', effects: ['readsSource', 'startsProcess', 'writesFilesystem'], fingerprintPaths: info.paths,
        args(_inputs, context) {
          const recovery = context.recoveryContext
          if (!recovery) fail('RECOVERY_LOCAL_CONTEXT_REQUIRED')
          return ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', info.script,
            ...IDENTITIES.flatMap(key => [`-Workflow${key[0].toUpperCase()}${key.slice(1)}`, recovery[key]]),
            '-WorkflowReportPath', recovery.reportPath]
        },
      } } })
  }
  const provider = { effects, timeoutMs: settings.timeoutMs,
    async fingerprint() {
      const info = await closure()
      return core.digest({ config: settings, mode, closure: settings.reviewedDigest, native: await native(info).fingerprint(),
        module: hash(await readFile(new URL(import.meta.url))) })
    },
    async reconcile(context) {
      if (mode !== 'enabled') fail('ACTUAL_DEPLOY_DISABLED')
      if (!scope.writable || !execution?.agent || execution.agent.session?.id !== scope.id || !callId(execution.callId)
        || execution.rootCallId !== undefined && !callId(execution.rootCallId)
        || execution.signal !== undefined && !(execution.signal instanceof AbortSignal)) fail('RECOVERY_ACTIVE_AGENT_REQUIRED')
      if (active.has(context?.runId)) fail('RECOVERY_EXECUTOR_STILL_ACTIVE')
      if (context?.originalResult?.projectId !== settings.projectId) fail('RECOVERY_PROJECT_MISMATCH')
      if (!UUID.test(context.recoveryId ?? '') || !ID.test(context.runId ?? '') || !ID.test(context.targetId ?? '')
        || context.originalTarget?.id !== context.targetId || ['planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest'].some(key => !SHA.test(context[key] ?? ''))
        || context.signal !== undefined && !(context.signal instanceof AbortSignal)) fail('RECOVERY_LOCAL_CONTEXT_INVALID')
      const signals = [context.signal, execution.signal].filter(Boolean)
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      signal?.throwIfAborted()
      const artifactRoot = await checkedDirectory(context.artifactDir), workspace = await checkedDirectory(scope.root)
      const artifactRelative = relative(workspace, artifactRoot)
      if (!isAbsolute(artifactRelative) && artifactRelative !== '..' && !artifactRelative.startsWith(`..${sep}`)) fail('RECOVERY_PRIVATE_ARTIFACT_REQUIRED')
      const before = await provider.fingerprint()
      if (before !== context.providerDigest) fail('RECOVERY_PROVIDER_CHANGED')
      const info = await closure(), attempt = randomUUID()
      const directory = `.airules/recovery-reports/${context.recoveryId}/${attempt}`
      await absentReportDirectory(info.root, directory)
      const reportPath = join(info.root, ...directory.split('/'), 'result.json')
      const recoveryContext = Object.freeze({ ...Object.fromEntries(IDENTITIES.map(key => [key, context[key]])), reportPath })
      const startedAt = Date.now()
      const result = await native(info).execute('restore', {}, { cwd: info.root, runId: context.recoveryId,
        stepId: 'restore-local', timeoutMs: context.timeoutMs ?? provider.timeoutMs, signal, recoveryContext })
      signal?.throwIfAborted()
      const process = result.data
      if (process.exitCode !== 0 || process.signal !== null || !process.terminationConfirmed || process.startError
        || process.timedOut || process.aborted || process.outputLimitExceeded) fail('RECOVERY_LOCAL_PROCESS_FAILED')
      const file = await core.projectPath(info.root, relative(info.root, reportPath).split(sep).join('/'))
      if ((await lstat(file)).nlink !== 1) fail('RECOVERY_LOCAL_REPORT_INVALID')
      const bytes = await core.safeRead(info.root, file, 65536)
      let report
      try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')); core.canonical(report) }
      catch { fail('RECOVERY_LOCAL_REPORT_INVALID') }
      if (!plain(report) || Object.keys(report).some(key => !REPORT_FIELDS.includes(key)) || report.schemaVersion !== 1
        || IDENTITIES.some(key => report[key] !== context[key]) || report.executorStopped !== true
        || !['not-applied', 'restored'].includes(report.outcome) || !Number.isSafeInteger(report.observedAt)
        || report.observedAt < startedAt || report.observedAt > Date.now()) fail('RECOVERY_LOCAL_REPORT_INVALID')
      if (await provider.fingerprint() !== before) fail('RECOVERY_PROVIDER_CHANGED')
      signal?.throwIfAborted()
      const proofBytes = Buffer.from(JSON.stringify(report)), path = `proof-local-${randomUUID()}.json`
      await writeFile(join(context.artifactDir, path), proofBytes, { flag: 'wx', mode: 0o600 })
      return { ...report, artifact: { path, digest: hash(proofBytes), bytes: proofBytes.length } }
    } }
  return provider
}
