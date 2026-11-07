import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCandidatePath } from './smoke-official-candidate.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SDK = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
const sha = data => createHash('sha256').update(data).digest('hex')
const native = name => import(pathToFileURL(join(SDK, name, 'lib/index.js')))
const RUNNER = `import{readFile,writeFile}from'node:fs/promises';
const a=process.argv.slice(2);if(a.length!==4||a[0]!=='--request'||a[2]!=='--result')process.exit(9);
const r=JSON.parse(await readFile(a[1],'utf8'));if(!r.fixture||r.operation!=='status')process.exit(8);
await writeFile(a[3],JSON.stringify({schemaVersion:1,runId:r.runId,planDigest:r.planDigest,requestDigest:r.requestDigest,domain:r.domain,operation:r.operation,fixture:true,complete:true,assertions:[{id:'native.fixture.argv-json-report',passed:true}]}));
`
const REPO_STUB = `param([string]$Operation,[string]$ReportFile,[int]$TimeoutSeconds,[int]$MaxReportChars)
if($Operation -ne 'status'){exit 7}
[System.IO.File]::WriteAllText($ReportFile,"Версия fixture 1",[System.Text.Encoding]::Unicode)
Write-Host 'password=PRIVATE_NATIVE_FIXTURE_SENTINEL'
Write-Host "Repository operation 'status' completed successfully"
exit 0
`
export async function runNativeProbe({ candidateRoot }) {
  const candidate = assertCandidatePath(candidateRoot)
  const runRoot = join(REPO, 'var/onec-specialized-native', `run-${randomUUID()}`)
  const home = join(runRoot, 'home'), profile = join(home, 'profiles/desktop'), workspace = join(runRoot, 'project')
  const candidateProfile = join(candidate, 'home/profiles/desktop')
  await mkdir(profile, { recursive: true }); await mkdir(join(workspace, '.git'), { recursive: true })
  for (const name of ['package.json', 'cordis.yml']) await cp(join(candidateProfile, name), join(profile, name))
  let configuration = await readFile(join(candidateProfile, 'cordis.patch.yml'), 'utf8')
  configuration = configuration.replace(/^([ \t]*)name: ['"]?@deepseek-ai\/dsh-tool-jobs['"]?[ \t]*\r?$/gmu,
    (_line, indent) => `${indent}name: '@deepseek-ai/dsh-tool-jobs'\n${indent}config:\n${indent}  completionDelivery: quiet`)
  await writeFile(join(profile, 'cordis.patch.yml'), configuration)
  // Individual package links let native linkedProfileRoots associate each
  // foreign package with this fresh profile's runtime peer-resolution layer.
  await mkdir(join(profile, 'node_modules'))
  for (const entry of await readdir(join(candidateProfile, 'node_modules'), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      await mkdir(join(profile, 'node_modules', entry.name))
      for (const child of await readdir(join(candidateProfile, 'node_modules', entry.name))) await symlink(join(candidateProfile, 'node_modules', entry.name, child), join(profile, 'node_modules', entry.name, child), 'junction')
    } else await symlink(join(candidateProfile, 'node_modules', entry.name), join(profile, 'node_modules', entry.name), 'junction')
  }
  const packageRoot = join(runRoot, 'specialized-package')
  await cp(join(REPO, 'src/onec-specialized'), packageRoot, { recursive: true })
  await mkdir(join(packageRoot, 'node_modules'), { recursive: true })
  await symlink(SDK, join(packageRoot, 'node_modules/@deepseek-ai'), 'junction')
  const workflowCopy = join(runRoot, 'workflow-package')
  await cp(join(candidateProfile, 'node_modules/airules-dsh-workflows'), workflowCopy, { recursive: true })
  // The maintained adapter's new contained-child-cwd option is under test;
  // immutable candidate bytes remain untouched.
  await cp(join(REPO, 'src/workflow-integration/lib/native-process.js'), join(workflowCopy, 'lib/native-process.js'))
  await symlink(workflowCopy, join(packageRoot, 'node_modules/airules-dsh-workflows'), 'junction')
  const { bundledRunnerTemplate } = await import(pathToFileURL(join(packageRoot, 'lib/bridge.mjs')))
  const bridge = await bundledRunnerTemplate()
  const powerShellPath = process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : '/usr/bin/pwsh'
  const powerShellSha = sha(await readFile(powerShellPath))
  await mkdir(join(workspace, 'tools/onec-specialized'), { recursive: true })
  await mkdir(join(workspace, '.dsh'))
  await writeFile(join(workspace, 'tools/onec-specialized/runner.mjs'), RUNNER)
  await writeFile(join(workspace, '.dsh/onec-specialized.json'), JSON.stringify({ schemaVersion: 1, repository: { allowForce: false, runner: {
    protocolVersion: 1, kind: 'node', path: 'tools/onec-specialized/runner.mjs', sha256: sha(RUNNER), fixture: true,
    operations: ['status', 'lock'], writeOperations: ['lock'], timeoutMs: 30000,
  } } }))
  const disabled = ['airules-subscriptions', 'airules-telegram', 'airules-mobile', 'airules-mcp-manager', 'airules-acp', 'airules-acp-adapter',
    'airules-additional-providers', 'airules-onec-panels', 'session-title-llm', 'session-telemetry-otel', 'desktop-product-telemetry',
    'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'llm-retry', 'hmr', 'plugin-manager']
  const patch = join(runRoot, 'probe.patch.yml')
  await writeFile(patch, disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    '- id: tool-jobs\n  config:\n    completionDelivery: quiet\n- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n' +
    `- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: ${JSON.stringify(workspace)}\n`)
  process.env.DSH_HOME = home; process.env.DSH_AGENTS_HOME = join(runRoot, 'agents')
  process.env.DSH_TELEMETRY_DISABLED = '1'; process.env.DSH_TELEMETRY = 'off'
  const report = { schemaVersion: 1, modelRequestAttempts: 0, externalMcpCalls: 0, realOnecCalls: 0, deployments: 0,
    checks: [], nativeSpawnCalls: 0, nativeConfineCalls: 0, nativeApprovalCalls: 0, localFixtureToolCalls: 0, unexpectedTools: [] }
  report.sourceDigests = Object.fromEntries(await Promise.all(['core.mjs', 'index.js', 'tools.js'].map(async name => [name, sha(await readFile(join(packageRoot, 'lib', name)))])))
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); assert.ok(passed, name) }
  let app
  const timer = setTimeout(() => process.exit(2), 180000)
  try {
    const { runProfile } = await import(pathToFileURL(join(SDK, 'dsh/lib/profile-boot.js')))
    const { loadLayeredEnv } = await native('dsh-app-boot')
    const { setSandboxMode } = await native('dsh-sandbox-policy')
    const { defineTool } = await native('dsh-tools')
    app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
    const ctx = app.ctx
    ctx.on('agent/request', () => { report.modelRequestAttempts++; throw new Error('NATIVE_PROBE_MODEL_FORBIDDEN') }, { prepend: true })
    const allowed = new Set(['airules_onec_specialized', 'airules_background_call', 'job_output', 'job_list', 'run_code', 'mcp__readonly_fixture__graph'])
    ctx.tools.guard(exec => { if (!allowed.has(exec.name)) { report.unexpectedTools.push(exec.name); return 'NATIVE_PROBE_TOOL_REFUSED' } })
    const confine = ctx.sandbox.confine
    ctx.sandbox.confine = function(argv, policy, signal) {
      report.nativeConfineCalls++
      check('native confinement uses exact fixture workspace', policy.mode === 'workspace-write' && resolve(policy.workspaceRoot) === resolve(workspace))
      if (argv.includes(join(workspace, 'tools/onec-specialized/runner.mjs'))) check('fixed runner argv enters real native sandbox', argv.length === 6 && argv[0] === process.execPath && argv[1] === join(workspace, 'tools/onec-specialized/runner.mjs') && argv[2] === '--request' && argv[4] === '--result')
      return confine.call(this, argv, policy, signal)
    }
    const spawn = ctx.subprocess.spawn
    ctx.subprocess.spawn = function(spec) {
      report.nativeSpawnCalls++
      const handle = spawn.call(this, spec)
      handle.stderr?.on('data', bytes => { const code = String(bytes).trim(); if (/^BRIDGE_[A-Z0-9_]+$/u.test(code)) report.bridgeFailureCode = code })
      return handle
    }
    const approval = ctx.approval.request
    ctx.approval.request = function(req) { report.nativeApprovalCalls++; return approval.call(this, req) }
    const serviceModule = await import(pathToFileURL(join(packageRoot, 'lib/index.js')))
    const serviceHandle = ctx.plugin(serviceModule, { trustedRunnerDigests: [sha(RUNNER), bridge.sha256, sha(REPO_STUB), powerShellSha], nodePath: process.execPath, powerShellPath })
    await serviceHandle.await()
    const id = `specialized-native-${randomUUID()}`
    await ctx.agents.create({ sessionId: id, meta: { cwd: workspace, agentPreset: '1c-airules' }, setup: async (_scope, agent) => {
      setSandboxMode(agent.session, 'workspace-write'); await ctx.agentPresets.select(agent, '1c-airules')
    } })
    const agent = ctx.agents.get(id), toolModule = await import(pathToFileURL(join(packageRoot, 'lib/tools.js')))
    await agent.ctx.plugin(toolModule).await()
    const execute = (name, args, extra = {}) => agent.ctx.tools.execute({ name, arguments: args, agent, callId: `native-${randomUUID()}`, signal: new AbortController().signal, ...extra })
    const call = async args => { const value = await execute('airules_onec_specialized', args); check(`native specialized ${args.action} succeeds`, value.isError === false); return value.value }
    check('actual specialized tool registered in 1C composition', !!agent.ctx.tools.get('airules_onec_specialized', agent))
    const status = await call({ action: 'status' }); check('actual native service sees trusted fixture', status.domains.find(row => row.domain === 'repository')?.execution === 'configured')
    const plan = await call({ action: 'plan', domain: 'repository', operation: 'status' })
    const result = await call({ action: 'run', planDigest: plan.planDigest, requestId: 'native-fixture-status' })
    report.result = result
    check('actual native subprocess fixture succeeds with report binding', result.status === 'passed' && result.fixture === true && result.projectCertified === false && result.terminationConfirmed === true && !result.lockRetained)
    check('exactly one real native sandboxed process', report.nativeSpawnCalls === 1 && report.nativeConfineCalls === 1)
    report.specializedRunnerNativeProof = { spawnCalls: report.nativeSpawnCalls, confineCalls: report.nativeConfineCalls }
    const readResult = await call({ action: 'result', runId: result.runId }); check('native result returns owning invocation', readResult.runId === result.runId)
    setSandboxMode(agent.session, 'read-only')
    check('native read-only denies specialized run before process', (await execute('airules_onec_specialized', { action: 'run', planDigest: plan.planDigest, requestId: 'denied-read-only' })).isError === true && report.nativeSpawnCalls === 1)
    setSandboxMode(agent.session, 'workspace-write')
    const lockPlan = await call({ action: 'plan', domain: 'repository', operation: 'lock', objects: ['Документ.Заказ'] })
    const blockedWrite = await execute('airules_onec_specialized', { action: 'run', planDigest: lockPlan.planDigest, requestId: 'requires-native-open-turn' })
    check('write operation reaches actual native approval and fails closed without open turn', blockedWrite.isError === true && report.nativeApprovalCalls === 1 && report.nativeSpawnCalls === 1)
    await writeFile(join(workspace, bridge.path), bridge.source)
    await writeFile(join(workspace, 'tools/repo-ops.ps1'), REPO_STUB)
    await writeFile(join(workspace, bridge.driverConfigPath), JSON.stringify({ schemaVersion: 1, repository: { format: 'repo-ops-v1.1-text', scriptPath: 'tools/repo-ops.ps1', scriptSha256: sha(REPO_STUB), powerShellPath, powerShellSha256: powerShellSha } }))
    await writeFile(join(workspace, '.dsh/onec-specialized.json'), JSON.stringify({ schemaVersion: 1, repository: { runner: {
      protocolVersion: 1, kind: 'node', path: bridge.path, sha256: bridge.sha256, driverConfigPath: bridge.driverConfigPath,
      operations: ['status'], writeOperations: [], fixture: true, timeoutMs: 30000,
    } } }))
    const bridgePlan = await call({ action: 'plan', domain: 'repository', operation: 'status' })
    const bridgeResult = await call({ action: 'run', planDigest: bridgePlan.planDigest, requestId: 'native-packaged-bridge' })
    report.bridgeResult = bridgeResult
    check('packaged bridge actually invokes isolated PowerShell fixture via native parent process', bridgeResult.status === 'passed' && bridgeResult.fixture === true && bridgeResult.assertions.some(row => row.id === 'repo-ops.known-text-verdict') && report.nativeSpawnCalls === 2 && report.nativeConfineCalls === 2)
    check('raw child stdout is not exposed in the native result', !JSON.stringify(bridgeResult).includes('PRIVATE_NATIVE_FIXTURE_SENTINEL'))
    report.bundledBridgeNativeProof = { status: bridgeResult.status, bridgeSha256: bridge.sha256, nativeSpawnDelta: 1, nativeConfineDelta: 1, rawOutputExposed: false }
    const { createWorkbench } = await import(pathToFileURL(join(REPO, 'src/onec-panels/lib/workbench.js')))
    const workbench = createWorkbench(ctx, { configPath: join(home, 'workbench-fixture.json') })
    ctx.provide('airulesOnecWorkbench', workbench)
    const config = await workbench.configuration()
    await workbench.save({ readOnlyTools: ['mcp__readonly_fixture__graph'], timeoutMs: 1000 }, config.revision)
    ctx.on('tools/result', (exec, value) => workbench.graphs.capture(exec, value), { global: true })
    agent.ctx.tools.register(defineTool({ name: 'mcp__readonly_fixture__graph', description: 'Local read-only graph fixture, no MCP connection.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() { report.localFixtureToolCalls++; return { nodes: [{ id: 'a', name: 'Local fixture' }], edges: [] } },
    }))
    // Load source tools with SDK peers; no source/package mutations.
    const toolsCopy = join(packageRoot, 'lib/workbench-tools.js')
    await cp(join(REPO, 'src/onec-panels/lib/tools.js'), toolsCopy)
    await agent.ctx.plugin(await import(pathToFileURL(toolsCopy))).await()
    const presentation = agent.ctx.tools.presentAs('ptc'); await presentation
    check('native PTC rejects direct MCP fixture call', (await execute('mcp__readonly_fixture__graph', {})).isError === true && report.localFixtureToolCalls === 0)
    const ptc = await execute('run_code', { code: 'const r = await tools.airules_background_call({tool:"mcp__readonly_fixture__graph",arguments:{}}); console.log(r);', description: 'Run local native background fixture' })
    check('native PTC invokes real background wrapper', ptc.isError === false)
    const jobs = ctx.jobs.list(agent.id).filter(row => row.kind === 'airules-mcp')
    check('native job is actually owned by requesting session', jobs.length === 1 && jobs[0].owner === agent.id)
    await ctx.jobs.wait(jobs[0].id, 10000, agent.id)
    check('parent token permits actual nested fixture in PTC', report.localFixtureToolCalls === 1 && ctx.jobs.get(jobs[0].id, agent.id).status === 'completed')
    const output = await execute('run_code', { code: `console.log(await tools.job_output({job_id:${JSON.stringify(jobs[0].id)},wait:false}));`, description: 'Collect native background fixture' })
    check('native job_output actually collects bounded result under PTC', output.isError === false && JSON.stringify(output.value ?? output.content).includes('Local fixture'))
    check('actual tools/result graph capture keeps same session provenance', workbench.graphs.get(agent.id, workspace)?.tool === 'mcp__readonly_fixture__graph')
    check('no model request attempted or unexpected tool', report.modelRequestAttempts === 0 && report.unexpectedTools.length === 0)
    report.status = 'PASS'
    await writeFile(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    return { report, reportPath: join(runRoot, 'summary.json') }
  } catch (error) {
    report.status = 'FAIL'; report.error = /^[A-Z0-9_ :.-]+$/u.test(error.message ?? '') ? error.message : 'NATIVE_SPECIALIZED_ASSERTION_FAILED'
    await writeFile(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    error.reportPath = join(runRoot, 'summary.json'); throw error
  } finally { clearTimeout(timer); await app?.ctx?.fiber.dispose() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--candidate-root') throw new Error('EXPLICIT_CANDIDATE_REQUIRED')
  runNativeProbe({ candidateRoot: resolve(args[1]) }).then(({ report, reportPath }) => process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath }) + '\n'), error => { process.stderr.write(`Native specialized probe failed; report ${error.reportPath ?? 'unavailable'}\n`); process.exitCode = 1 })
}
