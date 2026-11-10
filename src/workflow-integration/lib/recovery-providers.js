import { executeNativeTool } from './native-tools.js'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeProcessAdapter } from './native-process.js'
import { parseNativeResult } from './native-mcp.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const TOOL = /^mcp__[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u
const BOOT = randomUUID(), generations = new WeakMap()
const fail = code => { throw new Error(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const callId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/u.test(value)
const effects = ['readsSource', 'writesFilesystem', 'connectsTarget', 'writesTargetData', 'destructiveRecovery']
export async function recordExecution(stateDir, info, context, output) {
  const directory = join(stateDir, 'execution-receipts', context.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const receipt = { schemaVersion: 1, runId: context.runId, stepId: context.stepId, targetId: info.targetId,
    kind: info.kind, rootDigest: info.rootDigest, stopped: output?.data?.terminationConfirmed === true,
    mutationState: output?.mutationState ?? 'unknown', finishedAt: Date.now() }
  await writeFile(join(directory, `${context.stepId}.json`), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
}
async function proof(context, facts) {
  const value = { schemaVersion: 1, ...Object.fromEntries(['recoveryId', 'runId', 'targetId', 'planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest'].map(key => [key, context[key]])),
    executorStopped: true, outcome: facts.outcome, observedAt: Date.now() }
  const bytes = Buffer.from(JSON.stringify(value))
  const path = `proof-${randomUUID()}.json`
  await writeFile(join(context.artifactDir, path), bytes, { flag: 'wx', mode: 0o600 })
  return { ...value, artifact: { path, digest: hash(bytes), bytes: bytes.length } }
}
export function createFixtureRecoveryProvider({ ctx, scope, stateDir, bindingId, targetId, core, nativeHelpers, pwshPath, execution, active }) {
  const script = fileURLToPath(new URL('./deploy-fixture.ps1', import.meta.url))
  return { effects, timeoutMs: 30000,
    async fingerprint() { return core.digest({ kind: 'builtin-fixture-recovery', targetId, bindingId, script: hash(await readFile(script)),
      module: hash(await readFile(new URL(import.meta.url))) }) },
    async reconcile(context) {
      if (!execution?.agent || execution.agent.session?.id !== scope.id || !scope.writable || !pwshPath) fail('RECOVERY_ACTIVE_AGENT_REQUIRED')
      if (active.has(context.runId)) fail('RECOVERY_EXECUTOR_STILL_ACTIVE')
      if (context.targetId !== targetId || context.originalTarget?.id !== targetId) fail('RECOVERY_TARGET_MISMATCH')
      const stages = context.originalTarget.stages
      if (!Array.isArray(stages) || !stages.length) fail('RECOVERY_STAGE_PROOF_REQUIRED')
      const rootDigest = core.digest({ root: await realpath(scope.root) })
      for (const stage of stages) {
        if (!ID.test(stage.stepId)) fail('RECOVERY_STAGE_PROOF_REQUIRED')
        const bytes = await core.safeRead(stateDir, join(stateDir, 'execution-receipts', context.runId, `${stage.stepId}.json`), 16384)
        const receipt = JSON.parse(bytes.toString('utf8'))
        if (receipt.schemaVersion !== 1 || receipt.stopped !== true || !Number.isSafeInteger(receipt.finishedAt) || receipt.finishedAt > Date.now()
          || receipt.runId !== context.runId || receipt.stepId !== stage.stepId || receipt.targetId !== targetId
          || receipt.kind !== 'deploy-fixture' || receipt.rootDigest !== rootDigest) fail('RECOVERY_EXECUTOR_STOP_UNCONFIRMED')
      }
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
        '-ResultRoot', join(scope.root, '.airules/workflow-fixture-reports'), '-ProjectId', 'recovery-fixture',
        '-RunId', context.runId, '-StepId', stages[0].stepId, '-SourceDigest', context.sourceDigest,
        '-TargetDigest', targetId.replace(/^fixture-/u, ''), '-ProfileDigest', '0'.repeat(64), '-Recovery', '-RecoveryId', context.recoveryId]
      const adapter = createNativeProcessAdapter({ ctx, agent: execution.agent, callId: execution.callId, signal: execution.signal,
        id: 'fixture-recovery', core, nativeHelpers, operations: { restore: { command: pwshPath, args: () => args,
          inputSchema: { type: 'object', additionalProperties: false }, validator: 'process-exit', effects: ['readsSource', 'startsProcess', 'writesFilesystem'], fingerprintPaths: [script] } } })
      const result = await adapter.execute('restore', {}, { cwd: scope.root, runId: context.recoveryId,
        stepId: 'restore-fixture', timeoutMs: context.timeoutMs ?? 30000, signal: context.signal })
      if (result.data.exitCode !== 0 || !result.data.terminationConfirmed || result.data.startError || result.data.timedOut || result.data.aborted) fail('RECOVERY_RESTORE_NOT_CONFIRMED')
      const reportPath = join(scope.root, '.airules/workflow-fixture-reports', `recovery-${context.recoveryId}`, 'result.json')
      const restored = JSON.parse((await core.safeRead(scope.root, reportPath, 16384)).toString('utf8').replace(/^\uFEFF/u, ''))
      if (restored.schemaVersion !== 1 || restored.recoveryId !== context.recoveryId || restored.runId !== context.runId || restored.restored !== true) fail('RECOVERY_RESTORE_NOT_CONFIRMED')
      return proof(context, { outcome: 'restored' })
    } }
}
export function createToolRecoveryProvider({ ctx, scope, config, core, execution, mode, active }) {
  if (!config || Object.keys(config).some(key => !['projectId', 'id', 'tool', 'timeoutMs'].includes(key))
    || !ID.test(config.projectId) || !ID.test(config.id) || !TOOL.test(config.tool)) fail('RECOVERY_TOOL_CONFIG_INVALID')
  const timeoutMs = config.timeoutMs ?? 1800000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) fail('RECOVERY_TIMEOUT_INVALID')
  const definition = () => { try { const value = ctx.tools.get(config.tool, execution?.agent); return value && ['object', 'function'].includes(typeof value) ? value : null } catch { return null } }
  return { effects, timeoutMs,
    async fingerprint() {
      const current = definition()
      if (current && !generations.has(current)) generations.set(current, randomUUID())
      return core.digest({ config, mode, boot: BOOT, generation: current ? generations.get(current) : 'missing', module: hash(await readFile(new URL(import.meta.url))) })
    },
    async reconcile(context) {
      if (mode !== 'enabled') fail('ACTUAL_DEPLOY_DISABLED')
      if (!scope.writable || !execution?.agent || execution.agent.session?.id !== scope.id || typeof execution.token !== 'symbol' || !definition()
        || !callId(execution.callId) || execution.rootCallId !== undefined && !callId(execution.rootCallId)
        || execution.signal !== undefined && !(execution.signal instanceof AbortSignal)) fail('RECOVERY_NATIVE_TOOL_REQUIRED')
      if (active.has(context.runId)) fail('RECOVERY_EXECUTOR_STILL_ACTIVE')
      if (context.originalResult?.projectId !== config.projectId) fail('RECOVERY_PROJECT_MISMATCH')
      const identities = Object.fromEntries(['recoveryId', 'runId', 'targetId', 'planDigest', 'sourceDigest', 'targetFingerprint', 'providerDigest'].map(key => [key, context[key]]))
      const startedAt = Date.now()
      const signals = [context.signal, execution.signal].filter(Boolean)
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      signal?.throwIfAborted()
      const raw = await executeNativeTool(ctx,{ name: config.tool, agent: execution.agent, parent: execution.token,
        callId: `${execution.callId}:recovery:${context.recoveryId}`, rootCallId: execution.rootCallId ?? execution.callId,
        arguments: { schemaVersion: 1, projectId: config.projectId, ...identities }, signal })
      signal?.throwIfAborted()
      const report = parseNativeResult(raw, core)
      if (raw?.isError || !report || Object.keys(identities).some(key => report[key] !== identities[key])
        || report.schemaVersion !== 1 || report.executorStopped !== true || !['not-applied', 'restored'].includes(report.outcome)
        || !Number.isFinite(report.observedAt) || report.observedAt < startedAt || report.observedAt > Date.now()) fail('RECOVERY_NATIVE_PROOF_INVALID')
      return proof(context, report)
    } }
}
