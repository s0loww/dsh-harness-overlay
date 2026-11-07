import { createRequire } from 'node:module'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
import { createSpecializedService } from './core.mjs'
import { executeBridge } from '../runners/runner.mjs'
import { bundledRunnerTemplate } from './bridge.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { specializedHandler, CONTROL_API } from './control.js'

export const name = 'airules-dsh-onec-specialized'
export const inject = ['sandboxPolicy', 'sandbox', 'subprocess', 'agents', 'agentPresets', 'approval', 'dshHomePath']
export const Config = z.object({ trustedRunnerDigests: z.array(z.string()).default([]), nodePath: z.string().default(''), powerShellPath: z.string().default('') })
export async function apply(ctx, config) {
  const require = createRequire(import.meta.url)
  const workflow = dirname(require.resolve('airules-dsh-workflows/package.json'))
  const [{ createNativeProcessAdapter }, { loadRuntime }] = await Promise.all([
    import(pathToFileURL(join(workflow, 'lib/native-process.js'))), import(pathToFileURL(join(workflow, 'lib/runtime.js'))),
  ])
  const core = await loadRuntime(), services = new Map()
  const bundled = await bundledRunnerTemplate()
  const effectiveTrustedDigests = [...new Set([bundled.sha256, ...config.trustedRunnerDigests])]
  const scope = exec => {
    const agent = exec?.agent, session = agent?.session
    if (!session?.id || !isAbsolute(session.header?.cwd ?? '') || ctx.agents.get(session.id) !== agent || ctx.agentPresets.composedPreset(agent.ctx) !== '1c-airules') throw new Error('SPECIALIZED_ACTIVE_ONEC_SESSION_REQUIRED')
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || resolve(policy.workspaceRoot) !== resolve(session.header.cwd)) throw new Error('SPECIALIZED_NATIVE_POLICY_REQUIRED')
    return { root: resolve(session.header.cwd), agent, policy }
  }
  const authorize = async ({ plan, execution }) => {
    const current = scope(execution)
    if (!['workspace-write', 'danger-full-access'].includes(current.policy.mode)) return false
    if (!(plan.runner.sha256 === bundled.sha256 && plan.runner.driverConfigPath)) {
      const command = plan.runner.kind === 'node' ? config.nodePath : config.powerShellPath
      if (!isAbsolute(command || '') || !await stat(command).then(row => row.isFile(), () => false)) throw new Error(plan.runner.kind === 'node' ? 'SPECIALIZED_NODE_PATH_REQUIRED' : 'SPECIALIZED_POWERSHELL_PATH_REQUIRED')
    }
    execution.signal?.throwIfAborted()
    if (!plan.approvalRequired) return true
    // Actual pinned public API: dsh-user-approval ApprovalService.request(req).
    // It fails closed without an answerer and requires an open native turn.
    const decision = await ctx.approval.request({ agent: current.agent, toolName: 'airules_onec_specialized', callId: execution.callId,
      reason: `1C ${plan.domain}/${plan.operation}; plan ${plan.planDigest}; ${plan.fixture ? 'fixture runner' : 'project runner'}; force ${plan.runnerRequest?.force === true}; objects ${(plan.runnerRequest?.explicitObjectList ?? []).join(', ')}; effects ${plan.effects.join(', ')}`,
      signal: execution.signal })
    return decision === 'allowed-once' && scope(execution).policy.mode === current.policy.mode
  }
  const executeProcess = async ({ projectRoot, runner, fingerprintPaths = [], requestPath, resultPath, runId, signal, timeoutMs, execution }) => {
    const current = scope(execution)
    if (resolve(projectRoot) !== current.root || !['workspace-write', 'danger-full-access'].includes(current.policy.mode)) throw new Error('SPECIALIZED_NATIVE_PERMISSION_REQUIRED')
    if (runner.sha256 === bundled.sha256 && runner.driverConfigPath) {
      const deadline = new AbortController(), combined = AbortSignal.any([signal, ...(execution.signal ? [execution.signal] : []), deadline.signal])
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      const aggregate = { exitCode: 0, signal: null, timedOut: false, aborted: false, outputLimitExceeded: false, stdoutBytes: 0, stderrBytes: 0, startError: null, terminationConfirmed: true }
      try {
        await executeBridge({ requestPath, resultPath, root: projectRoot, processRunner: async call => {
          const active = scope(execution)
          if (!['workspace-write', 'danger-full-access'].includes(active.policy.mode)) throw new Error('BRIDGE_NATIVE_PERMISSION_CHANGED')
          const stdout = [], stderr = []
          // Observe real native streams only in memory for the known parser.
          // The existing adapter still owns confinement, caps and termination.
          const observed = { sandboxPolicy: ctx.sandboxPolicy, sandbox: ctx.sandbox, subprocess: { spawn(spec) {
            const handle = ctx.subprocess.spawn(spec)
            let retained = 0
            for (const [stream, chunks] of [[handle.stdout, stdout], [handle.stderr, stderr]]) stream.on('data', chunk => { const data = Buffer.from(chunk); if (retained + data.length <= 1024 * 1024) chunks.push(data); retained += data.length })
            return handle
          } } }
          const adapter = createNativeProcessAdapter({ ctx: observed, agent: execution.agent, callId: execution.callId, signal: combined, id: 'onec-bundled-bridge',
            operations: { execute: { command: call.command, args: () => call.args, workingDirectory: () => call.cwd,
              fingerprintPaths, inputSchema: { type: 'object', additionalProperties: false }, validator: 'process-exit', effects: ['readsSource', 'startsProcess', 'writesFilesystem'] } },
            core, nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature } })
          const output = await adapter.execute('execute', {}, { cwd: projectRoot, runId, stepId: 'specialized-bridge', sourceDigest: runner.sha256, timeoutMs, signal: combined })
          const data = output.data
          aggregate.stdoutBytes += data.stdoutBytes; aggregate.stderrBytes += data.stderrBytes
          aggregate.terminationConfirmed = aggregate.terminationConfirmed && data.terminationConfirmed
          aggregate.timedOut ||= data.timedOut || deadline.signal.aborted; aggregate.aborted ||= data.aborted && !deadline.signal.aborted
          aggregate.outputLimitExceeded ||= data.outputLimitExceeded
          aggregate.startError ??= data.startError
          if (data.exitCode !== 0 || data.aborted || data.timedOut || data.outputLimitExceeded || data.startError || !data.terminationConfirmed) { aggregate.exitCode = data.exitCode; throw new Error('BRIDGE_NATIVE_PROCESS_FAILED') }
          return { exitCode: data.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
        } })
      } catch (error) { aggregate.exitCode = aggregate.exitCode === 0 ? 1 : aggregate.exitCode; aggregate.bridgeError = /^BRIDGE_[A-Z0-9_]+$/u.test(error.message ?? '') ? error.message : 'BRIDGE_EXECUTION_FAILED' }
      finally { clearTimeout(timer) }
      return aggregate
    }
    const command = runner.kind === 'node' ? config.nodePath : config.powerShellPath
    if (!isAbsolute(command || '')) throw new Error(runner.kind === 'node' ? 'SPECIALIZED_NODE_PATH_REQUIRED' : 'SPECIALIZED_POWERSHELL_PATH_REQUIRED')
    const script = resolve(projectRoot, runner.path)
    if (createHash('sha256').update(await readFile(script)).digest('hex') !== runner.sha256) throw new Error('SPECIALIZED_RUNNER_DIGEST_MISMATCH')
    const adapter = createNativeProcessAdapter({ ctx, agent: execution.agent, callId: execution.callId, signal, id: 'onec-specialized',
      operations: { execute: { command, args: () => runner.kind === 'node' ? [script, '--request', requestPath, '--result', resultPath] : ['-NoProfile', '-NonInteractive', '-File', script, '-RequestPath', requestPath, '-ResultPath', resultPath],
        fingerprintPaths: [script, ...fingerprintPaths], inputSchema: { type: 'object', additionalProperties: false }, validator: 'process-exit', effects: ['readsSource', 'startsProcess', 'writesFilesystem'] } },
      core, nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature } })
    await adapter.fingerprint()
    const output = await adapter.execute('execute', {}, { cwd: projectRoot, runId, stepId: 'specialized', sourceDigest: runner.sha256, timeoutMs, signal })
    return output.data
  }
  ctx.provide('airulesOnecSpecialized', {
    machineConfigView: Object.freeze({ trustedRunnerDigests: Object.freeze([...config.trustedRunnerDigests]), bundledRunnerSha256: bundled.sha256, nodePath: config.nodePath, powerShellPath: config.powerShellPath }),
    async act(args, execution) {
      const current = scope(execution), key = `${current.agent.id}\0${current.root}`
      if (!services.has(key)) services.set(key, createSpecializedService({ projectRoot: current.root,
        evidenceRoot: ctx.dshHomePath(`onec-specialized/${createHash('sha256').update(key).digest('hex')}/plans`),
        reconciliationRoot: ctx.dshHomePath('onec-specialized-reconciliation'),
        trustedRunnerDigests: effectiveTrustedDigests, trustedPowerShellPath: config.powerShellPath, authorize, executeProcess }))
      const service = await services.get(key)
      const { action, ...parameters } = args
      if (!['status', 'history', 'diff', 'plan', 'run', 'result', 'cancel', 'validatePlan'].includes(action)) throw new Error('SPECIALIZED_ACTION_INVALID')
      if (action === 'run' && !['workspace-write', 'danger-full-access'].includes(current.policy.mode)) throw new Error('SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
      const result = await service[action](parameters, execution)
      if (action === 'status') for (const row of result.domains) {
        if (row.execution !== 'configured' || row.runnerSha256 === bundled.sha256 && row.driverConfigPath) continue
        const command = row.runnerKind === 'node' ? config.nodePath : config.powerShellPath
        if (!isAbsolute(command || '') || !await stat(command).then(value => value.isFile(), () => false)) { row.execution = 'unavailable'; row.reason = row.runnerKind === 'node' ? 'SPECIALIZED_NODE_PATH_REQUIRED' : 'SPECIALIZED_POWERSHELL_PATH_REQUIRED' }
      }
      return result
    },
  })
  ctx.inject(['webServer', 'connection', 'fs'], ready => {
    ready.effect(() => ready.webServer.register({kind:'exact',path:CONTROL_API,handler:specializedHandler(ready,{createUserMessage})}))
  })
}
