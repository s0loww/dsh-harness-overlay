import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { readProject, BINDING_PATH } from './project.js'
import { createNativeProcessAdapter } from './native-process.js'
import { createNativeMcpProvider } from './native-mcp.js'
import { discoverSetup, previewSetup } from './setup.js'
import { createDeployProcessAdapter, validateDeployEvidence } from './deploy-process.js'
import { fixtureDeployment } from './deploy-fixture.js'
import { createFixtureRecoveryProvider, createToolRecoveryProvider, recordExecution } from './recovery-providers.js'
import { bindingRevision, saveSetup } from './save-setup.js'
import { workflowSession } from './session.js'
import { createLocalRecoveryProvider } from './local-recovery.js'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const CHECK_OPERATIONS = new Set(['doctor', 'analyze'])
const emptySchema = { type: 'object', additionalProperties: false }
const fail = code => { throw new Error(code) }
const principalOf = scope => `session-${createHash('sha256').update(scope.id).digest('hex')}`
const safe = error => /^[A-Z][A-Z0-9_:-]{0,95}$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'RUNNER_INSPECTION_UNAVAILABLE'
export async function findPowerShell(configured) {
  if (configured) return isAbsolute(configured) && await stat(configured).then(value => value.isFile(), () => false) ? configured : null
  const names = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean).slice(0, 128)) {
    if (!isAbsolute(directory)) continue
    for (const name of names) { const path = join(directory, name); try { if ((await stat(path)).isFile()) return path } catch {} }
  }
  return null
}

export function createWorkflowService({ ctx, runtime: core, stateDir, config = {}, nativeHelpers, reviewedDigests = [], onModeChange }) {
  if (!isAbsolute(stateDir)) fail('PRIVATE_STATE_REQUIRED')
  const trusted = new Set([...reviewedDigests, ...(config.trustedRunnerDigests ?? [])])
  if ([...trusted].some(value => !/^[a-f0-9]{64}$/u.test(value))) fail('TRUSTED_RUNNER_DIGEST_INVALID')
  const active = new Map()
  let deployMode = config.deployMode ?? 'fixture-only', activeRequests = 0, modeChangePending = false
  if (!['disabled', 'fixture-only', 'enabled'].includes(deployMode)) fail('DEPLOY_MODE_INVALID')
  if (!Array.isArray(config.recoveryTools ?? []) || (config.recoveryTools ?? []).length > 32) fail('RECOVERY_TOOL_CONFIG_INVALID')
  for (const entry of config.recoveryTools ?? []) {
    if (!entry || !ID.test(entry.projectId ?? '') || !ID.test(entry.id ?? '') || typeof entry.tool !== 'string'
      || Object.keys(entry).some(key => !['projectId', 'id', 'tool', 'timeoutMs'].includes(key))) fail('RECOVERY_TOOL_CONFIG_INVALID')
  }
  if (!Array.isArray(config.recoveryCommands ?? []) || (config.recoveryCommands ?? []).length > 32) fail('RECOVERY_LOCAL_CONFIG_INVALID')
  const fixtureProviderId = bindingId => `fixture-${bindingId.length <= 110 ? bindingId : `${bindingId.slice(0, 80)}-${core.digest(bindingId).slice(0, 16)}`}`
  const recoveryRegistration = async (scope, execution, projectId, targets, pwshPath) => {
    const providers = {}, rows = []
    for (const [bindingId, targetId] of Object.entries(targets)) {
      const id = fixtureProviderId(bindingId)
      providers[id] = createFixtureRecoveryProvider({ ctx, scope, stateDir, bindingId, targetId, core, nativeHelpers,
        pwshPath, execution, active })
      rows.push({ id, kind: 'fixture', available: !!pwshPath, reason: pwshPath ? null : 'POWERSHELL_NOT_FOUND' })
    }
    for (const entry of config.recoveryTools ?? []) {
      if (entry.projectId !== projectId) continue
      if (Object.hasOwn(providers, entry.id)) fail('RECOVERY_PROVIDER_COLLISION')
      providers[entry.id] = createToolRecoveryProvider({ ctx, scope, config: entry, core, execution, mode: deployMode, active })
      let registered = false
      try { const value = ctx.tools?.get?.(entry.tool, execution?.agent); registered = !!value && ['object', 'function'].includes(typeof value) } catch {}
      rows.push({ id: entry.id, kind: 'mcp', available: deployMode === 'enabled' && registered,
        reason: deployMode !== 'enabled' ? 'ACTUAL_DEPLOY_DISABLED' : registered ? null : 'RECOVERY_NATIVE_TOOL_REQUIRED' })
    }
    for (const entry of config.recoveryCommands ?? []) {
      if (!entry || typeof entry.projectId !== 'string') fail('RECOVERY_LOCAL_CONFIG_INVALID')
      if (entry.projectId !== projectId) continue
      if (Object.hasOwn(providers, entry.id)) fail('RECOVERY_PROVIDER_COLLISION')
      const provider = createLocalRecoveryProvider({ ctx, scope, config: entry, core, execution, mode: deployMode, active, nativeHelpers, pwshPath })
      providers[entry.id] = provider
      let reason = deployMode === 'enabled' ? null : 'ACTUAL_DEPLOY_DISABLED'
      try { await provider.fingerprint() } catch (error) { reason = safe(error) }
      rows.push({ id: entry.id, kind: 'local', available: !reason, reason })
    }
    return { providers, rows }
  }
  const ownedJournal = async (scope, runId) => {
    if (!ID.test(runId)) fail('RUN_ID_INVALID')
    const report = JSON.parse((await core.safeRead(stateDir, join(stateDir, 'runs', runId, 'result.json'), 1024 * 1024)).toString('utf8'))
    if (report.principal !== principalOf(scope) || report.runId !== runId || !ID.test(report.planId)) fail('NOT_AUTHORIZED')
    const plan = JSON.parse((await core.safeRead(stateDir, join(stateDir, 'plans', `${report.planId}.json`), 1024 * 1024)).toString('utf8'))
    const { planDigest, ...content } = plan
    if (core.digest(content) !== planDigest || planDigest !== report.planDigest || plan.principal !== report.principal
      || resolve(plan.inputs.root) !== await realpath(scope.root) || plan.projectId !== report.projectId) fail('RECOVERY_PROJECT_MISMATCH')
    return { report, plan }
  }
  const historicalHost = async (scope, runId, execution) => {
    const { report, plan } = await ownedJournal(scope, runId)
    const root = await realpath(scope.root), fixtureId = `fixture-${core.digest({ fixture: true, root })}`
    const targets = Object.fromEntries(plan.inputs.steps.flatMap(step => step.resources ?? [])
      .filter(row => row.id === fixtureId && ID.test(row.ref ?? '')).map(row => [row.ref, row.id]))
    const pwshPath = await findPowerShell(config.powerShellPath)
    const recovery = await recoveryRegistration(scope, execution, report.projectId, targets, pwshPath)
    const host = new core.WorkflowHost({ stateDir, recoveryProviders: recovery.providers, allowTargetMutations: true,
      authorize: async request => request.principal === principalOf(scope) && (request.action === 'result'
        || request.action === 'recover' && scope.writable && execution?.agent?.session?.id === scope.id && !active.has(runId)) })
    return { report, host, recoveryRows: recovery.rows }
  }
  async function prepare(scope, execution) {
    const project = await readProject(scope, core)
    if (!project.configured) return { project, rows: [], host: null }
    const adapters = {}, rows = [], resources = {}, fixtureTargets = {}
    const pwshPath = await findPowerShell(config.powerShellPath)
    let host
    const owned = adapter => {
      const execute = adapter.execute.bind(adapter)
      adapter.execute = async (operation, inputs, context) => {
        if (!execution?.agent || execution.agent.session?.id !== scope.id) fail('ACTIVE_AGENT_REQUIRED')
        active.set(context.runId, { host, principal: principalOf(scope), root: project.root })
        const cancel = () => { void host.cancel({ runId: context.runId, principal: principalOf(scope) }).catch(() => {}) }
        execution.signal?.addEventListener('abort', cancel, { once: true })
        if (execution.signal?.aborted) cancel()
        try {
          const output = await execute(operation, inputs, context)
          if (operation === 'deploy-apply') await recordExecution(stateDir, {
            targetId: output?.data?.targetId, kind: project.runners[adapter.descriptor.id]?.kind,
            rootDigest: core.digest({ root: await realpath(project.root) }),
          }, context, output)
          return output
        }
        finally { execution.signal?.removeEventListener('abort', cancel) }
      }
      return adapter
    }
    const deploymentAdapter = (id, operations, deployment) => createDeployProcessAdapter({ ctx,
      agent: execution?.agent ?? { session: { id: scope.id, header: { id: scope.id, cwd: scope.root } } },
      callId: execution?.callId ?? 'plan-only', signal: execution?.signal, id,
      operations, deployment, core, nativeHelpers })
    for (const [id, binding] of Object.entries(project.runners)) {
      if (!ID.test(id)) fail('RUNNER_ID_INVALID')
      try {
        if (binding.kind === 'deploy-fixture') {
          const fixture = await fixtureDeployment(scope, binding, project.data.projectId, core, pwshPath)
          const enabled = deployMode !== 'disabled' && !!pwshPath
          if (pwshPath) adapters[id] = owned(deploymentAdapter(id, { 'deploy-apply': fixture.operation }, fixture.deployment))
          resources[id] = { id: fixture.deployment.target.id, environment: 'test' }
          fixtureTargets[id] = fixture.deployment.target.id
          rows.push({ id, kind: 'deploy-fixture', status: enabled ? 'configured' : 'unavailable', target: resources[id],
            operations: [{ id: 'deploy-apply', label: 'Заглушка деплоя', enabled,
              status: enabled ? 'configured' : 'disabled', reason: enabled ? null : pwshPath ? 'DEPLOY_MODE_DISABLED' : 'POWERSHELL_NOT_FOUND',
              effects: fixture.operation.effects }] })
          continue
        }
        const info = await core.inspectRunnerBinding({ root: project.root, binding })
        const approved = trusted.has(info.closureDigest)
        const operations = {}, visible = []
        let deployTarget
        for (const [operation, metadata] of Object.entries(info.operations)) {
          const isCheck = CHECK_OPERATIONS.has(operation)
          const enabled = metadata.supported && metadata.configured && approved && !!pwshPath && isCheck
          visible.push({ id: operation, label: operation, enabled, effects: metadata.effects,
            reason: !metadata.supported ? 'RUNNER_OPERATION_UNSUPPORTED' : !metadata.configured ? 'OPERATION_SETTINGS_REQUIRED'
              : !isCheck ? 'EXECUTION_NOT_IMPLEMENTED' : !approved ? 'RUNNER_REVIEW_REQUIRED' : !pwshPath ? 'POWERSHELL_NOT_FOUND' : null,
            status: !metadata.supported ? 'unsupported' : !metadata.configured ? 'not-configured' : !isCheck ? 'disabled' : !approved ? 'needs-review' : !pwshPath ? 'unavailable' : 'configured' })
          if (!isCheck || !metadata.supported || !metadata.configured || !pwshPath) continue
          const compiled = core.compileRunnerCommand({ runnerKind: binding.kind, operation, root: project.root,
            runnerPath: binding.runnerPath, ...(binding.profilePath ? { profilePath: binding.profilePath } : {}), pwshPath })
          operations[operation] = { command: compiled.command, args: () => [...compiled.args],
            inputSchema: emptySchema, validator: 'process-exit', effects: metadata.effects,
            fingerprintPaths: info.fingerprintPaths.map(path => resolve(project.root, path)) }
        }
        if (Object.keys(operations).length) {
          // Planning needs descriptors and fingerprints, never a live agent or approval.
          const agent = execution?.agent ?? { session: { id: scope.id, header: { id: scope.id, cwd: scope.root } } }
          const adapter = createNativeProcessAdapter({ ctx, agent, callId: execution?.callId ?? 'plan-only',
            signal: execution?.signal, id, operations, core, nativeHelpers })
          const originalFingerprint = adapter.fingerprint.bind(adapter)
          adapter.fingerprint = async () => core.digest({ native: await originalFingerprint(), runner: info.fingerprint,
            commandSet: Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, operation.args()])),
            runtime: core.runtimeDigest ?? 'injected-test-runtime', service: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') })
          const original = adapter.execute.bind(adapter)
          adapter.execute = async (operation, inputs, context) => {
            if (!execution?.agent || execution.agent.session?.id !== scope.id) fail('ACTIVE_AGENT_REQUIRED')
            if (!approved) fail('RUNNER_REVIEW_REQUIRED')
            active.set(context.runId, { host, principal: principalOf(scope), root: project.root })
            const cancel = () => { void host.cancel({ runId: context.runId, principal: principalOf(scope) }).catch(() => {}) }
            execution.signal?.addEventListener('abort', cancel, { once: true })
            if (execution.signal?.aborted) cancel()
            try { return await original(operation, inputs, context) }
            finally { execution.signal?.removeEventListener('abort', cancel) }
          }
          adapters[id] = adapter
        }
        const applyMetadata = info.operations['deploy-apply']
        const applyRow = visible.find(row => row.id === 'deploy-apply')
        if (applyMetadata?.supported && applyMetadata.configured && pwshPath) {
          try {
            const deployment = await core.inspectDeployBinding({ root: project.root, binding })
            if (deployment.projectId !== project.data.projectId) fail('DEPLOY_PROJECT_MISMATCH')
            const source = resolve(project.root, deployment.sourcePath)
            if (!(project.data.sourcePaths ?? []).some(path => resolve(project.root, path) === source)) fail('DEPLOY_SOURCE_SNAPSHOT_REQUIRED')
            if (!(project.data.configPaths ?? []).includes(binding.profilePath)) fail('DEPLOY_PROFILE_SNAPSHOT_REQUIRED')
            resources[id] = { id: deployment.target.id, environment: deployment.target.environment }
            deployTarget = resources[id]
            const deployOperations = Object.fromEntries(['deploy-apply', 'deploy-preview'].filter(name => info.operations[name]?.supported).map(name => [name, {
              command: pwshPath, inputSchema: emptySchema, effects: info.operations[name].effects,
              fingerprintPaths: info.fingerprintPaths.map(path => resolve(project.root, path)),
              args: (_inputs, context) => core.compileRunnerCommand({ runnerKind: binding.kind, operation: name,
                root: project.root, runnerPath: binding.runnerPath, profilePath: binding.profilePath, pwshPath,
                deployContext: context.deployContext }).args }]))
            const deploy = deploymentAdapter(id, deployOperations, deployment)
            const checks = adapters[id]
            adapters[id] = owned({ descriptor: core.validateDescriptor({ protocolVersion: 1, id, version: '2.0.0',
              operations: { ...(checks?.descriptor.operations ?? {}), ...deploy.descriptor.operations } }),
              fingerprint: async () => core.digest({ checks: checks ? await checks.fingerprint() : null, deploy: await deploy.fingerprint(),
                deployMode, runtime: core.runtimeDigest, service: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }),
              execute: (operation, inputs, context) => {
                if (!approved) fail('RUNNER_REVIEW_REQUIRED')
                if (['deploy-apply', 'deploy-preview'].includes(operation)) {
                  if (deployMode !== 'enabled') fail('ACTUAL_DEPLOY_DISABLED')
                  return deploy.execute(operation, inputs, context)
                }
                return checks.execute(operation, inputs, context)
              } })
            applyRow.enabled = approved && deployMode === 'enabled'
            applyRow.status = !approved ? 'needs-review' : deployMode !== 'enabled' ? 'disabled' : 'configured'
            applyRow.reason = !approved ? 'RUNNER_REVIEW_REQUIRED' : deployMode !== 'enabled' ? 'ACTUAL_DEPLOY_DISABLED' : null
            const previewRow = visible.find(row => row.id === 'deploy-preview')
            if (previewRow && deployOperations['deploy-preview']) Object.assign(previewRow, { enabled: applyRow.enabled, status: applyRow.status, reason: applyRow.reason })
          } catch (error) { applyRow.enabled = false; applyRow.status = 'not-configured'; applyRow.reason = safe(error) }
        }
        rows.push({ id, kind: binding.kind, status: !approved ? 'needs-review' : !pwshPath ? 'unavailable' : 'configured',
          ...(deployTarget ? { target: deployTarget } : {}),
          closureDigest: info.closureDigest, message: !approved ? 'Версия runner не входит в проверенный комплект. Нужен разбор изменений и регистрация проверенной версии.'
            : !pwshPath ? 'PowerShell не найден. Установите PowerShell или задайте путь к нему в настройках исполнителя DSH.'
              : 'Проверяется наличие и согласованность настроек; доступность базы не проверялась.',
          operations: visible, sourceFactsVerified: false, platformVerified: false })
      } catch (error) { rows.push({ id, kind: binding?.kind ?? 'unknown', status: 'unavailable', message: safe(error), operations: [] }) }
    }
    for (const [id, binding] of Object.entries(project.data.mcpProviders ?? {})) {
      if (!ID.test(id) || Object.hasOwn(project.runners, id)) fail('PROVIDER_ID_COLLISION')
      try {
        const adapter = createNativeMcpProvider({ ctx, execution, id, binding, core, allowedTools: config.readOnlyMcpTools ?? [],
          onRunStart: runId => {
            active.set(runId, { host, principal: principalOf(scope), root: project.root })
          } })
        const original = adapter.execute.bind(adapter)
        adapter.execute = async (operation, inputs, context) => {
          if (!execution?.agent || execution.agent.session?.id !== scope.id) fail('ACTIVE_AGENT_REQUIRED')
          const cancel = () => { void host.cancel({ runId: context.runId, principal: principalOf(scope) }).catch(() => {}) }
          execution.signal?.addEventListener('abort', cancel, { once: true })
          if (execution.signal?.aborted) cancel()
          try { return await original(operation, inputs, context) }
          finally { execution.signal?.removeEventListener('abort', cancel) }
        }
        adapters[id] = adapter
        rows.push({ id, kind: 'mcp', status: adapter.readOnlyApproved ? 'configured' : 'needs-review',
          operations: [{ id: 'check', label: 'check', enabled: adapter.readOnlyApproved, effects: ['readsSource'] }] })
      } catch (error) { rows.push({ id, kind: 'mcp', status: 'unavailable', message: safe(error), operations: [] }) }
    }
    const recovery = await recoveryRegistration(scope, execution, project.data.projectId, fixtureTargets, pwshPath)
    host = new core.WorkflowHost({ stateDir, projects: { [project.data.projectId]: { root: project.root, bindingPath: BINDING_PATH,
      sourcePaths: project.data.sourcePaths ?? [], configPaths: project.data.configPaths ?? [], resources } },
      workflows: project.workflows, adapters, allowTargetMutations: deployMode !== 'disabled',
      validators: { 'deployment-result': validateDeployEvidence },
      recoveryProviders: recovery.providers,
      authorize: async request => {
        if (request.principal !== principalOf(scope)) return false
        if (['plan', 'capabilities', 'result'].includes(request.action)) return true
        if (!execution?.agent || execution.agent.session?.id !== scope.id || !scope.writable) return false
        return true
      } })
    return { project, rows, host, recoveryRows: recovery.rows }
  }
  const scopeResult = async (scope, runId) => {
    const { host, recoveryRows } = await historicalHost(scope, runId)
    const result = await host.result({ runId, principal: principalOf(scope) })
    return { ...result, recoveryOptions: recoveryRows }
  }
  const service = {
    async status(scope) {
      const { project, rows, host, recoveryRows } = await prepare(scope)
      const workflows = []
      for (const [id] of Object.entries(project.workflows)) {
        const capabilities = await host.capabilities({ projectId: project.data.projectId, workflowId: id, principal: principalOf(scope) })
        const steps = capabilities.steps.map(step => {
          const definition = project.workflows[id].steps.find(row => row.id === step.id)
          const adapterId = project.data.providers[step.providerRef]?.adapterId
          const runner = rows.find(row => row.id === adapterId)
          const operation = runner?.operations.find(row => row.id === definition?.operation)
          const status = operation?.status ?? (operation ? operation.enabled ? 'configured' : runner.status : runner?.status === 'needs-review' ? 'needs-review' : step.status)
          return { ...step, operation: definition?.operation, adapterId, status,
            reason: operation?.reason ?? (runner?.status === 'unavailable' ? runner.message : null) }
        })
        workflows.push({ id, label: project.labels[id], steps })
      }
      return { project: { id: project.data?.projectId ?? null }, configured: project.configured,
        writable: scope.writable, workflows, runnerBindings: rows, runs: await this.runs(scope), recoveryProviders: recoveryRows ?? [],
        execution: { nativeSandbox: true, deployEnabled: deployMode === 'enabled', deployImplemented: true,
          deployMode, fixtureEnabled: deployMode !== 'disabled', modeConfigurationAvailable: typeof onModeChange === 'function', runViaAgentTool: true,
          reason: deployMode === 'enabled' ? null : deployMode === 'fixture-only' ? 'ACTUAL_DEPLOY_DISABLED' : 'DEPLOY_MODE_DISABLED' } }
    },
    async setup(scope) { return discoverSetup(scope, core) },
    async previewSetup(scope, setup) { return { ...await previewSetup(scope, core, setup), revision: await bindingRevision(scope, core) } },
    async saveSetup(scope, setup, revision) { return saveSetup({ scope, setup, revision, core, stateDir,
      authorizeWrite: async () => { const current = await workflowSession(ctx, scope.id, true); if (await realpath(current.root) !== await realpath(scope.root)) fail('WORKFLOW_SESSION_REQUIRED') } }) },
    async setMode(scope, mode) {
      if (!['disabled', 'fixture-only', 'enabled'].includes(mode)) fail('DEPLOY_MODE_INVALID')
      if (!scope.writable) fail('WORKSPACE_WRITE_REQUIRED')
      if (typeof onModeChange !== 'function') fail('MODE_CONFIGURATION_UNAVAILABLE')
      if (modeChangePending || activeRequests || active.size) fail('MODE_CHANGE_BUSY')
      let locks = []
      try { locks = await readdir(join(stateDir, 'recovery-locks'), { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const entry of locks.filter(row => row.isDirectory())) {
        try {
          const owner = JSON.parse((await core.safeRead(stateDir, join(stateDir, 'recovery-locks', entry.name, 'owner.json'), 4096)).toString('utf8'))
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('MODE_CHANGE_BUSY')
          try { process.kill(owner.pid, 0); fail('MODE_CHANGE_BUSY') } catch (error) { if (error.code !== 'ESRCH') throw error }
        } catch (error) { if (error.code === 'ENOENT') fail('MODE_CHANGE_BUSY'); throw error }
      }
      if (modeChangePending || activeRequests || active.size) fail('MODE_CHANGE_BUSY')
      if (mode === deployMode) return { mode, changed: false }
      modeChangePending = true
      try { await onModeChange(mode); deployMode = mode; return { mode, changed: true } }
      finally { modeChangePending = false }
    },
    async plan(scope, workflowId, execution) {
      if (!scope.writable) fail('WORKSPACE_WRITE_REQUIRED')
      const { project, host } = await prepare(scope, execution)
      if (!host || !Object.hasOwn(project.workflows, workflowId)) fail('WORKFLOW_NOT_CONFIGURED')
      for (const step of project.workflows[workflowId].steps.filter(row => ['deploy-apply', 'deploy-preview'].includes(row.operation))) {
        const id = project.data.providers[step.adapter]?.adapterId
        if (step.resources.length !== 1 || step.resources[0] !== id) fail('DEPLOY_RESOURCE_REQUIRED')
      }
      return host.plan({ projectId: project.data.projectId, workflowId, principal: principalOf(scope) })
    },
    async run(scope, args, execution) {
      if (!scope.writable || !execution?.agent || execution.agent.session?.id !== scope.id) fail('ACTIVE_AGENT_REQUIRED')
      if (execution.signal?.aborted) fail('WORKFLOW_CANCELLED')
      const { host, rows } = await prepare(scope, execution)
      if (!host) fail('WORKFLOW_NOT_CONFIGURED')
      const saved = await host.loadPlan(args.planId, principalOf(scope), args.planDigest)
      for (const step of saved.inputs.steps) {
        if (!step.configured) continue
        const provider = rows.find(row => row.id === step.adapterId)
        if (['deploy-apply', 'deploy-preview'].includes(step.operation)) {
          if (deployMode === 'disabled' || provider?.kind !== 'deploy-fixture' && deployMode !== 'enabled') fail('ACTUAL_DEPLOY_DISABLED')
          if (step.resources.length !== 1 || step.resources[0].ref !== step.adapterId
            || step.resources[0].id !== provider?.target?.id) fail('DEPLOY_RESOURCE_MISMATCH')
        } else if (provider?.kind !== 'mcp' && !CHECK_OPERATIONS.has(step.operation)) fail('REAL_DEPLOY_AND_DATABASE_TESTS_DISABLED')
        if (!provider || provider.status !== 'configured') fail('RUNNER_REVIEW_REQUIRED')
      }
      return host.run({ planId: args.planId, planDigest: args.planDigest, requestId: args.requestId, principal: principalOf(scope) })
        .finally(() => { for (const [id, row] of active) if (row.host === host) active.delete(id) })
    },
    result: scopeResult,
    async recover(scope, args, execution) {
      if (!scope.writable || execution?.agent?.session?.id !== scope.id || active.has(args.runId)) fail('RECOVERY_ACTIVE_AGENT_REQUIRED')
      const { host } = await historicalHost(scope, args.runId, execution)
      return host.recover({ runId: args.runId, targetId: args.targetId, providerId: args.providerId,
        requestId: args.requestId, principal: principalOf(scope) })
    },
    async runs(scope) {
      let directories
      try { directories = await readdir(join(stateDir, 'runs'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      if (directories.length > 10000) fail('RUN_HISTORY_LIMIT')
      const results = []
      for (const entry of directories.filter(row => row.isDirectory() && !row.isSymbolicLink() && ID.test(row.name))) {
        try {
          const path = join(stateDir, 'runs', entry.name, 'result.json'), stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue
          const result = JSON.parse(await readFile(path, 'utf8'))
          if (result.principal !== principalOf(scope)) continue
          await ownedJournal(scope, result.runId)
          results.push({ runId: result.runId, workflowId: result.workflowId, verdict: result.verdict, mutationState: result.mutationState, startedAt: result.startedAt })
        } catch {}
      }
      return Promise.all(results.sort((a, b) => b.startedAt - a.startedAt).slice(0, 100).map(async row => {
        const result = await scopeResult(scope, row.runId)
        return { ...row, recoveryState: result.recoveryState, retainedLocks: result.retainedLocks }
      }))
    },
    async cancel(scope, runId) {
      const target = active.get(runId)
      if (!target || target.principal !== principalOf(scope) || target.root !== await realpath(scope.root)) fail('RUN_NOT_OWNED_OR_NOT_ACTIVE')
      return target.host.cancel({ runId, principal: principalOf(scope) })
    },
    async dispose() {
      await Promise.allSettled([...active.entries()].map(([runId, target]) => target.host.cancel({ runId, principal: target.principal })))
    },
  }
  for (const name of ['run', 'recover']) {
    const execute = service[name]
    service[name] = async (...args) => {
      if (modeChangePending) fail('MODE_CHANGE_BUSY')
      activeRequests++
      try { return await execute.apply(service, args) } finally { activeRequests-- }
    }
  }
  return service
}
