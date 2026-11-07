import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const candidate = assertCandidatePath(process.argv[2])
const ui = resolve(process.argv[3]), policy = resolve(process.argv[4])
await preflightCandidate({ candidateRoot: candidate, uiArtifactRoot: ui, policyArtifactRoot: policy })
process.env.DSH_HOME = join(candidate, 'home')
process.env.DSH_TELEMETRY = 'off'
process.env.DSH_TELEMETRY_DISABLED = '1'
process.chdir(candidate)
const modules = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
const patch = join(candidate, 'workflow-probe.patch.yml')
await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n')
const timer = setTimeout(() => process.exit(2), 55000)
let app
try {
  const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
  app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
  const ctx = app.ctx
  const presets = await ctx.agentPresets.list()
  const compositions = ctx.agentPresets.inspectCompositions()
  const feature = ctx.get('airulesWorkflows')
  const entries = [...ctx.loader.entries()].filter(row => row.options?.name === 'airules-dsh-workflows')
  const report = {
    schemaVersion: 1, nativeWorkflowService: !!feature,
    nativeServices: Object.fromEntries(['sandbox', 'sandboxPolicy', 'subprocess', 'tools', 'connection', 'webServer'].map(name => [name, !!ctx.get(name)])),
    hostEntries: entries.map(row => ({ id: row.options.id, state: row.fiber?.state ?? null })),
    presets: presets.map(row => ({ id: row.id, broken: !!row.broken })),
    compositions: compositions.map(row => ({ id: row.id, modules: row.modules, leakedServices: row.leakedServices })),
    deploymentsExecuted: 0, projectRunnersExecuted: 0, mcpCallsExecuted: 0,
  }
  if (process.argv.includes('--fixture-exec')) {
    const workspace = join(candidate, 'workflow-fixture-workspace')
    await mkdir(workspace, { recursive: true })
    const packageRoot = join(candidate, 'home/profiles/desktop/node_modules/airules-dsh-workflows')
    const { loadRuntime } = await import(pathToFileURL(join(packageRoot, 'lib/runtime.js')))
    const { createNativeProcessAdapter } = await import(pathToFileURL(join(packageRoot, 'lib/native-process.js')))
    const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
    const { scrubbedParentEnv } = await import(pathToFileURL(join(modules, 'dsh-subprocess/lib/index.js')))
    const { classifyRunnerFailure, matchesSignature } = await import(pathToFileURL(join(modules, 'dsh-sandbox/lib/index.js')))
    const runtime = await loadRuntime()
    report.fixtureExecutions = []
    for (const mode of ['danger-full-access', 'workspace-write', 'read-only']) {
      const session = ctx.sessions.prepare(`workflow-fixture-${mode}`, { meta: { cwd: workspace, agentPreset: '1c-airules' } })
      setSandboxMode(session, mode)
      const adapter = createNativeProcessAdapter({ ctx, agent: { session }, callId: `fixture-${mode}`, id: 'fixture.node', core: runtime,
        nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature }, operations: { inspect: {
          command: process.execPath, args: () => ['-e', 'process.stdout.write("fixture-only")'],
          inputSchema: { type: 'object', additionalProperties: false }, effects: ['startsProcess'], validator: 'process-exit',
        } } })
      const result = await adapter.execute('inspect', {}, { cwd: workspace, timeoutMs: 10000,
        runId: `fixture-${mode}`, stepId: 'inspect', artifactDir: workspace, signal: new AbortController().signal })
      report.fixtureExecutions.push({ mode, ...result.data })
    }
    if (report.fixtureExecutions[0].exitCode !== 0 || report.fixtureExecutions[0].terminationConfirmed !== true) throw new Error('NATIVE_FIXTURE_EXECUTION_FAILED')
    report.fixtureWriteGuards = []
    for (const mode of ['workspace-write', 'read-only']) {
      const session = ctx.sessions.prepare(`workflow-write-fixture-${mode}`, { meta: { cwd: workspace, agentPreset: '1c-airules' } })
      setSandboxMode(session, mode)
      const marker = join(workspace, `write-${randomUUID()}.txt`)
      const adapter = createNativeProcessAdapter({ ctx, agent: { session }, callId: `write-fixture-${mode}`, id: 'fixture.write', core: runtime,
        nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature }, operations: { inspect: {
          command: process.execPath, args: () => ['-e', 'require("node:fs").writeFileSync(process.argv[1],"fixture-only")', marker],
          inputSchema: { type: 'object', additionalProperties: false }, effects: ['startsProcess', 'writesFilesystem'], validator: 'process-exit',
        } } })
      const result = await adapter.execute('inspect', {}, { cwd: workspace, timeoutMs: 10000,
        runId: `write-fixture-${mode}`, stepId: 'inspect', artifactDir: workspace, signal: new AbortController().signal })
      const exists = await lstat(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      const expected = mode === 'workspace-write'
      const passed = result.data.terminationConfirmed && exists === expected && (expected ? result.data.exitCode === 0 : result.data.exitCode !== 0)
      report.fixtureWriteGuards.push({ mode, writeObserved: exists, passed, ...result.data })
      if (!passed) throw new Error('NATIVE_WORKFLOW_WRITE_GUARD_FAILED')
    }
  }
  if (process.argv.includes('--deploy-fixtures') || process.argv.includes('--complete-workflows')) {
    await mkdir(join(candidate, 'smoke'), { recursive: true })
    const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
    report.deployFixtures = []
    report.recoveryFixtures = []
    for (const outcome of ['pass', 'fail-before', 'partial', 'no-report', 'stale', 'timeout', 'cancel']) {
      const root = join(candidate, 'deploy-fixtures', `${outcome}-${randomUUID()}`), id = `deploy-fixture-${randomUUID()}`
      await mkdir(join(root, '.airules'), { recursive: true }); await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/fixture.txt'), 'Isolated deploy executor fixture; no 1C or database.\n')
      await writeFile(join(root, '.airules/workflows.json'), JSON.stringify({ schemaVersion: 1, projectId: 'deploy-fixture',
        sourcePaths: ['src'], configPaths: [], providers: { deploy: { adapterId: 'stub' } },
        runners: { stub: { schemaVersion: 1, kind: 'deploy-fixture', outcome: outcome === 'cancel' ? 'timeout' : outcome } },
        workflows: { deploy: { schemaVersion: 1, id: 'deploy', version: '0.1.0', steps: [
          { id: 'apply', adapter: 'deploy', operation: 'deploy-apply', resources: ['stub'], timeoutMs: outcome === 'timeout' ? 1500 : 15000 },
        ] } } }))
      const session = ctx.sessions.prepare(id, { meta: { cwd: root, agentPreset: '1c-airules' } })
      setSandboxMode(session, 'workspace-write')
      const scope = { id, root, writable: true, mode: 'workspace-write', preset: '1c-airules' }
      const status = await feature.status(scope)
      if (status.execution.deployMode !== 'fixture-only' || status.execution.deployEnabled || !status.execution.fixtureEnabled) throw new Error('DEPLOY_FIXTURE_MODE_INVALID')
      const plan = await feature.plan(scope, 'deploy')
      const running = feature.run(scope, { planId: plan.id, planDigest: plan.planDigest, requestId: randomUUID() },
        { agent: { session }, callId: `fixture-${outcome}`, signal: new AbortController().signal })
      if (outcome === 'cancel') {
        const marker = join(root, '.airules/workflow-fixture-reports/simulated-target.json')
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await access(marker).then(() => true, () => false)) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        const [run] = await feature.runs(scope)
        await feature.cancel(scope, run.runId)
      }
      const result = await running
      const expected = outcome === 'pass' ? 'PASS' : outcome === 'fail-before' ? 'FAIL' : outcome === 'cancel' ? 'INTERRUPTED' : 'INDETERMINATE'
      const markerObserved = await access(join(root, '.airules/workflow-fixture-reports/simulated-target.json')).then(() => true, () => false)
      report.deployFixtures.push({ outcome, verdict: result.verdict, mutationState: result.mutationState,
        recoveryState: result.recoveryState, retainedLocks: result.retainedLocks, markerObserved,
        passed: result.verdict === expected && (outcome === 'fail-before' || markerObserved) })
      await writeFile(join(candidate, 'smoke/workflow-deploy-fixtures.json'), JSON.stringify(report.deployFixtures, null, 2))
      if (!report.deployFixtures.at(-1).passed) throw new Error('NATIVE_DEPLOY_FIXTURE_FAILED')
      if (process.argv.includes('--complete-workflows') && result.retainedLocks) {
        const recovery = await feature.recover(scope, { runId: result.runId, targetId: result.targets[0].id,
          providerId: 'fixture-stub', requestId: randomUUID() }, { agent: { session }, callId: `recover-${outcome}` })
        const restored = await feature.result(scope, result.runId)
        const afterMarker = await access(join(root, '.airules/workflow-fixture-reports/simulated-target.json')).then(() => true, () => false)
        const configuration = JSON.parse(await readFile(join(root, '.airules/workflows.json'), 'utf8'))
        configuration.runners.stub.outcome = 'pass'
        await writeFile(join(root, '.airules/workflows.json'), JSON.stringify(configuration))
        const retryPlan = await feature.plan(scope, 'deploy')
        const retry = await feature.run(scope, { planId: retryPlan.id, planDigest: retryPlan.planDigest, requestId: randomUUID() },
          { agent: { session }, callId: `retry-${outcome}` })
        report.recoveryFixtures.push({ outcome, receipt: recovery.phase, recoveryState: restored.recoveryState,
          retainedLocks: restored.retainedLocks, markerRestored: !afterMarker, retryVerdict: retry.verdict,
          originalVerdict: restored.verdict, originalMutation: restored.mutationState,
          passed: recovery.phase === 'completed' && restored.recoveryState === 'completed' && !restored.retainedLocks && !afterMarker && retry.verdict === 'PASS' })
        await writeFile(join(candidate, 'smoke/workflow-recovery-fixtures.json'), JSON.stringify(report.recoveryFixtures, null, 2))
        if (!report.recoveryFixtures.at(-1).passed) throw new Error('NATIVE_RECOVERY_FIXTURE_FAILED')
      }
    }
  }
  if (process.argv.includes('--mode-cycle')) {
    const configurationPath = join(candidate, 'home/profiles/desktop/cordis.patch.yml')
    await mkdir(join(candidate, 'smoke'), { recursive: true })
    await writeFile(join(candidate, 'smoke/mode-cordis.before.yml'), await readFile(configurationPath))
    const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
    const root = join(candidate, 'mode-cycle-workspace'), id = `mode-${randomUUID()}`
    await mkdir(root, { recursive: true })
    const session = ctx.sessions.prepare(id, { meta: { cwd: root, agentPreset: '1c-airules' } })
    setSandboxMode(session, 'workspace-write')
    const scope = { id, root, writable: true, mode: 'workspace-write', preset: '1c-airules' }
    report.modeCycle = []
    for (const mode of process.argv.includes('--mode-persist-enabled') ? ['disabled', 'enabled'] : ['disabled', 'enabled', 'fixture-only']) {
      await ctx.get('airulesWorkflows').setMode(scope, mode)
      let status
      for (let attempt = 0; attempt < 60; attempt++) {
        try { status = await ctx.get('airulesWorkflows')?.status(scope) } catch {}
        if (status?.execution?.deployMode === mode) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      report.modeCycle.push({ requested: mode, observed: status?.execution?.deployMode,
        available: status?.execution?.modeConfigurationAvailable === true, passed: status?.execution?.deployMode === mode })
      await writeFile(join(candidate, 'smoke/workflow-mode-cycle.json'), JSON.stringify(report.modeCycle, null, 2))
      if (!report.modeCycle.at(-1).passed) throw new Error('NATIVE_MODE_CYCLE_FAILED')
    }
  }
  if (process.argv.includes('--expect-mode')) {
    const expected = process.argv[process.argv.indexOf('--expect-mode') + 1]
    const root = join(candidate, 'mode-restart-workspace')
    await mkdir(root, { recursive: true })
    const observed = await ctx.get('airulesWorkflows').status({ id: 'mode-restart', root, writable: true, mode: 'workspace-write', preset: '1c-airules' })
    report.modeAfterRestart = { expected, observed: observed.execution.deployMode, passed: observed.execution.deployMode === expected }
    await writeFile(join(candidate, 'smoke/workflow-mode-restart.json'), JSON.stringify(report.modeAfterRestart, null, 2))
    if (!report.modeAfterRestart.passed) throw new Error('NATIVE_MODE_PERSISTENCE_FAILED')
  }
  if (!feature || entries.length !== 1 || entries.some(row => row.fiber?.state !== 2)
    || Object.values(report.nativeServices).some(value => !value)
    || report.presets.some(row => ['1c-airules', 'python-airules', 'sysadmin-airules'].includes(row.id) && row.broken)) throw new Error('NATIVE_WORKFLOW_PROBE_FAILED')
  await mkdir(join(candidate, 'smoke'), { recursive: true })
  await writeFile(join(candidate, 'smoke/workflow-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--serve-preview')) {
    clearTimeout(timer)
    const root = join(candidate, 'workflow-ui-fixture'), sessionId = `workflow-ui-${randomUUID()}`
    const packageRoot = join(candidate, 'home/profiles/desktop/node_modules/airules-dsh-workflows')
    const lock = JSON.parse(await readFile(join(packageRoot, 'runtime/reviewed-runners.json'), 'utf8'))
    await mkdir(join(root, '.airules'), { recursive: true }); await mkdir(join(root, 'src'), { recursive: true })
    const canonicalRunner = join(REPO, '../project_rules/overlays/1c/tools/agent-1c')
    for (const file of lock.codeClosure.files) {
      const destination = join(root, file.path)
      await mkdir(resolve(destination, '..'), { recursive: true })
      await writeFile(destination, await readFile(join(canonicalRunner, file.path.replace(/^tools\/agent-1c\//u, ''))))
    }
    await writeFile(join(root, 'src/fixture.bsl'), '// UI fixture only; no configuration or database\n')
    await writeFile(join(root, 'agent-1c.json'), JSON.stringify({ schemaVersion: 1, projectId: 'workflow-ui-fixture',
      sourceDir: 'src', resultDir: 'reports', platform: { engine: 'auto', versionPrefix: '8.3.27' },
      extension: { name: 'WorkflowFixture' }, testTarget: { kind: 'file', environment: 'test' } }))
    if (!process.argv.includes('--blank-workflow')) await writeFile(join(root, '.airules/workflows.json'), JSON.stringify({ schemaVersion: 1, projectId: 'workflow-ui-fixture',
      sourcePaths: ['src'], configPaths: ['agent-1c.json'], providers: { checks: { adapterId: 'fixture-runner' } },
      runners: { 'fixture-runner': { schemaVersion: 1, kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1',
        profilePath: 'agent-1c.json', sourceKind: 'extension', extensionName: 'WorkflowFixture', exactBuild: '8.3.27.1989' } },
      workflows: { static: { schemaVersion: 1, id: 'static', label: 'Проверка интерфейса — без запуска', version: '0.1.0',
        steps: [{ id: 'doctor', adapter: 'checks', operation: 'doctor' }, { id: 'analyze', adapter: 'checks', operation: 'analyze', dependsOn: ['doctor'] }] } } }))
    const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
    const session = ctx.sessions.create(sessionId, { meta: { cwd: root, agentPreset: '1c-airules' } })
    setSandboxMode(session, 'workspace-write')
    const status = await feature.status({ id: sessionId, root, writable: true, mode: 'workspace-write', preset: '1c-airules' })
    const connectionPath = join(candidate, 'smoke/workflow-preview.private.json'), stop = join(candidate, 'smoke/workflow-preview.stop')
    await rm(stop, { force: true })
    await writeFile(connectionPath, JSON.stringify({ url: ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()), sessionId,
      configured: status.configured, operations: status.runnerBindings[0]?.operations, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 720000
    while (Date.now() < deadline) {
      if (await access(stop).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    await rm(connectionPath, { force: true }); await rm(stop, { force: true })
  }
  await app.ctx.fiber.dispose()
  clearTimeout(timer)
  process.stdout.write('Native workflow service/presets: PASS; no project runner, MCP or real deployment executed\n')
  process.exit(0)
} catch (error) {
  await writeFile(join(candidate, 'smoke/workflow-probe-error.log'), String(error?.stack ?? 'PROBE_ERROR')).catch(() => {})
  try { await app?.ctx?.fiber.dispose() } catch {}
  clearTimeout(timer)
  const code = error?.code ?? error?.message ?? ''
  process.stderr.write(`NATIVE_WORKFLOW_PROBE_FAILED: ${/^[A-Z][A-Z0-9_:-]{0,95}$/u.test(code) ? code : 'ISOLATED_PROBE_ERROR'}; inspect isolated probe logs\n`)
  process.exit(1)
}
