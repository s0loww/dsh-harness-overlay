import { readFile, writeFile, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'
import { companionsAcceptance } from './probe-companions-release.mjs'

const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

/** Actual SDK022 authenticated HTTP plus the installed trusted Python renderer.
 * Only synthetic candidate projects/shadows are mutated. No received code,
 * network Git, model, MCP, project runner, real 1C deployment or self-update. */
export async function gitMaintenanceAcceptance(input) {
  await companionsAcceptance(input)
  const { ctx, check, report, installed, agents, candidate, setSandboxMode } = input
  const mounted = [...ctx.loader.entries()].filter(row => row.options?.id === 'airules-git-maintenance' && row.options?.name === 'airules-dsh-git-maintenance')
  check('Git maintenance native host is mounted exactly once and active', mounted.length === 1 && mounted[0].fiber?.state === 2)
  check('Git maintenance service exposes the actual installed controller', typeof ctx.airulesGitMaintenance?.configuration === 'function')
  const primary = agents.find(row => row.preset === '1c-airules'), foreign = agents.find(row => row.preset === 'python-airules')
  const origin = ctx.webServer.getOrigin(), login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('maintenance probe obtains only the native loopback admission cookie', login.status === 303 && !!cookie)
  const endpoint = '/airules/git-maintenance'
  async function request(path = endpoint, { query = {}, body, token, authenticated = true, method } = {}) {
    const url = new URL(path, origin)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { origin: new URL(origin).origin, ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-airules-csrf': token ?? '' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    let value; try { value = await response.json() } catch { value = { ok: false } }
    return { status: response.status, ...value }
  }
  const rows = ctx.workspaceRegistry.list(), findProject = row => rows.find(project => key(project.path) === key(row.root))
  const projectId = String(findProject(primary)?.id), foreignId = String(findProject(foreign)?.id)
  check('maintenance fixture projects come from the native registered workspace roots', projectId !== 'undefined' && foreignId !== 'undefined' && projectId !== foreignId)
  async function pin(row = primary, id = projectId) {
    const selected = await request('/airules/projects', { query: { projectId: id, activeSessionId: row.id } })
    check('maintenance action pins the current native executor revision', selected.ok && selected.execution?.sessionId === row.id && typeof selected.execution.revision === 'string')
    return { projectId: id, sessionId: row.id, expectedProjectRoot: selected.projectRoot, expectedExecutorRevision: selected.execution.revision }
  }
  check('maintenance denies unadmitted configuration requests', (await request(endpoint, { authenticated: false })).status === 403)
  check('maintenance denies unsupported methods', (await request(endpoint, { method: 'DELETE' })).status === 405)
  const initial = await request(), token = initial.csrfToken
  check('configuration loads without a selected session or any Git subprocess', initial.ok && typeof token === 'string' && initial.defaults?.airules?.repository === 'https://github.com/s0loww/airules.git' && initial.defaults?.harness?.repository === 'https://github.com/s0loww/dsh-harness-overlay.git')
  check('embedded canonical source is versioned and does not expose its private inventory', /^[a-f0-9]{40}$/u.test(initial.embedded?.commit ?? '') && typeof initial.embedded.version === 'string' && initial.embedded.inventory === undefined)
  check('maintenance GET rejects unknown query fields before execution', (await request(endpoint, { query: { action: 'configuration', arbitraryPath: primary.root } })).error === 'MAINTENANCE_INPUT_INVALID')
  check('maintenance POST rejects arbitrary repository/path fields before execution', (await request(endpoint, { token, body: { action: 'rulesPlan', repository: 'https://evil.invalid/private', sourceMode: 'embedded' } })).error === 'MAINTENANCE_INPUT_INVALID')
  check('maintenance mutation retains native CSRF', (await request(endpoint, { body: { action: 'rulesPlan', sourceMode: 'embedded' } })).error === 'MAINTENANCE_CSRF_REQUIRED')

  // The generic probe blocks all subprocesses. Re-enable only the exact trusted
  // installed renderer, with all its path arguments confined to owned shadows.
  const previousSpawn = ctx.subprocess.spawn
  let prototype = Object.getPrototypeOf(ctx.subprocess), nativeSpawn
  while (prototype && !nativeSpawn) { if (Object.hasOwn(prototype, 'spawn') && typeof prototype.spawn === 'function') nativeSpawn = prototype.spawn.bind(ctx.subprocess); prototype = Object.getPrototypeOf(prototype) }
  if (!nativeSpawn) throw Error('MAINTENANCE_PROBE_NATIVE_PROCESS_REQUIRED')
  const packageRoot = join(installed, 'airules-dsh-git-maintenance'), engine = join(packageRoot, 'lib/rollout-engine/entry.py'), embedded = join(packageRoot, 'runtime/embedded-source'), privateRoot = resolve(ctx.dshHomePath('git-maintenance')), allowedCalls = []
  const inside = (root, path) => { if (typeof path !== 'string' || !isAbsolute(path)) return false; const rel = relative(resolve(root), resolve(path)); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) }
  ctx.subprocess.spawn = options => {
    const argv = options?.argv ?? [], command = argv[6]
    const prefix = argv.length >= 8 && /(?:^|[\\/])python(?:[0-9]+(?:\.[0-9]+)?)?(?:\.exe)?$/iu.test(argv[0] ?? '') && JSON.stringify(argv.slice(1, 5)) === JSON.stringify(['-I', '-B', '-X', 'utf8']) && key(argv[5]) === key(engine) && key(options.cwd) === key(dirname(engine))
    let valid = prefix && ['render', 'verify', 'apply', 'rollback'].includes(command) && argv.length <= 30
    const flags = new Set(['--source', '--project', '--profile', '--bindings', '--output', '--candidate', '--backup-root', '--backup', '--confirm']), switches = new Set(['--skip-mcp', '--skip-skills', '--adopt-existing-instructions'])
    for (let at = 7; valid && at < argv.length; at++) {
      const flag = argv[at]
      if (switches.has(flag)) continue
      if (!flags.has(flag) || typeof argv[at + 1] !== 'string') { valid = false; break }
      const value = argv[++at]
      if (flag === '--source') valid = command === 'render' && key(value) === key(embedded)
      else if (flag === '--profile') valid = value === 'public'
      else if (flag === '--confirm') valid = value === basename(primary.root)
      else valid = inside(join(privateRoot, 'rollout'), value)
    }
    if (!valid) return previousSpawn(options)
    allowedCalls.push({ command, argv: argv.slice(1), cwd: options.cwd })
    const handle = nativeSpawn(options); let stderr = ''
    handle.stderr?.on('data', chunk => { if (stderr.length < 2048) stderr += Buffer.from(chunk).toString('utf8') })
    void handle.done.then(done => { if (done.exitCode !== 0) (report.maintenanceRendererErrors ??= []).push({ command, exitCode: done.exitCode, diagnostic: stderr.slice(-2048) }) }).catch(() => {})
    return handle
  }
  report.maintenanceNativeProcessCalls = 0
  const userRules = Buffer.from('\uFEFFМои синтетические правила владельца\r\n', 'utf8'), mcp = Buffer.from('synthetic MCP sentinel, deliberately not imported\r\n')
  const protectedPaths = ['.dsh/response-style.json', '.dsh/skill-context.json'], protectedFiles = new Map()
  for (const path of protectedPaths) if (await exists(join(primary.root, path))) protectedFiles.set(path, await readFile(join(primary.root, path)))
  const originalMode = 'workspace-write'
  try {
    setSandboxMode(primary.agent.session, 'danger-full-access'); setSandboxMode(foreign.agent.session, 'danger-full-access')
    let pinned = await pin()
    const testSettings = structuredClone(initial.settings); testSettings.airules.ref = initial.settings.airules.ref === 'synthetic-maintenance-acceptance' ? 'synthetic-maintenance-next' : 'synthetic-maintenance-acceptance'
    const savedConfig = await request(endpoint, { token, body: { ...pinned, action: 'saveSettings', settings: testSettings, revision: initial.revision } })
    check('full-access GUI saves source preferences through actual native scope without creating a turn', savedConfig.ok && /^[a-f0-9]{64}$/u.test(savedConfig.revision ?? ''))
    const staleConfig = await request(endpoint, { token, body: { ...pinned, action: 'saveSettings', settings: initial.settings, revision: initial.revision } })
    check('source preferences reject stale settings revisions', staleConfig.status === 409 && staleConfig.error === 'MAINTENANCE_SETTINGS_STALE')
    const invalidSettings = structuredClone(initial.settings); invalidSettings.airules.repository = 'https://synthetic:never-publish@github.com/example/repo.git'
    const invalid = await request(endpoint, { token, body: { ...pinned, action: 'saveSettings', settings: invalidSettings, revision: savedConfig.revision } })
    check('source settings reject credential-bearing repository URLs without echoing credentials', invalid.status === 400 && !JSON.stringify(invalid).includes('never-publish'))

    await writeFile(join(primary.root, 'USER-RULES.md'), userRules); await writeFile(join(primary.root, '.mcp.json'), mcp)
    check('the synthetic target starts without a managed instruction file', !await exists(join(primary.root, 'AGENTS.md')))
    const planned = await request(endpoint, { token, body: { ...pinned, action: 'rulesPlan', sourceMode: 'embedded', includeSkills: false } })
    check('embedded source preview runs the actual trusted renderer for at least 55 canonical rules', planned.ok && planned.plan?.status === 'ready' && planned.plan.counts.rules >= 55 && planned.plan.mcp === 'unchanged' && planned.plan.profile === 'public')
    check('preview leaves project instructions absent and preserves BOM owner rules and MCP bytes', !await exists(join(primary.root, 'AGENTS.md')) && userRules.equals(await readFile(join(primary.root, 'USER-RULES.md'))) && mcp.equals(await readFile(join(primary.root, '.mcp.json'))))
    const detail = await request(endpoint, { token, body: { ...pinned, action: 'rulesDetail', planId: planned.plan.planId, path: 'AGENTS.md' } })
    check('review exposes the exact project instruction diff without applying it', detail.ok && detail.detail?.beforeText === '' && typeof detail.detail.afterText === 'string' && detail.detail.afterText.includes(basename(primary.root)))

    setSandboxMode(primary.agent.session, 'read-only'); pinned = await pin()
    const readonly = await request(endpoint, { token, body: { ...pinned, action: 'rulesApply', planId: planned.plan.planId } })
    check('a read-only executor cannot apply a reviewed rule candidate or borrow another chat authority', readonly.ok === false && /^(?:PROJECT_|MAINTENANCE_)/u.test(readonly.error ?? '') && !await exists(join(primary.root, 'AGENTS.md')))
    setSandboxMode(primary.agent.session, 'danger-full-access'); pinned = await pin()
    const foreignPin = await pin(foreign, foreignId)
    const crossed = await request(endpoint, { token, body: { ...foreignPin, action: 'rulesApply', planId: planned.plan.planId } })
    check('foreign project/preset cannot consume the 1C rollout plan', crossed.ok === false && /^(?:ROLLOUT_|PROJECT_)/u.test(crossed.error ?? '') && !await exists(join(primary.root, 'AGENTS.md')))
    await writeFile(join(primary.root, 'USER-RULES.md'), Buffer.concat([userRules, Buffer.from('concurrent owner edit\r\n')]))
    const changed = await request(endpoint, { token, body: { ...pinned, action: 'rulesApply', planId: planned.plan.planId } })
    check('changing owner instructions invalidates a reviewed candidate before project writes', changed.error === 'ROLLOUT_PROJECT_CHANGED' && !await exists(join(primary.root, 'AGENTS.md')))
    await writeFile(join(primary.root, 'USER-RULES.md'), userRules)

    const fresh = await request(endpoint, { token, body: { ...pinned, action: 'rulesPlan', sourceMode: 'embedded', includeSkills: false } })
    check('a fresh reviewed plan succeeds after the owner file is restored', fresh.ok && fresh.plan.status === 'ready')
    const applied = await request(endpoint, { token, body: { ...pinned, action: 'rulesApply', planId: fresh.plan.planId } })
    check('exact rule apply writes real canonical files and a project receipt', applied.ok && applied.result?.status === 'applied' && typeof applied.result.receiptId === 'string' && await exists(join(primary.root, 'AGENTS.md')))
    const status = await request(endpoint, { query: { ...pinned, action: 'projectStatus' } })
    check('installed rule status reports the embedded revision, public profile and zero drift', status.ok && status.project?.installed === true && status.project.sourceRevision === initial.embedded.commit && status.project.profile === 'public' && status.project.drift.length === 0)
    const update = await request(endpoint, { token, body: { ...pinned, action: 'rulesPlan', sourceMode: 'embedded', includeSkills: false } })
    check('updating unchanged managed rules produces no replacements or conflicts', update.ok && update.plan.status === 'ready' && update.plan.counts.replace === 0 && update.plan.conflicts.length === 0)
    const installedInstructions = await readFile(join(primary.root, 'AGENTS.md'))
    await writeFile(join(primary.root, 'AGENTS.md'), Buffer.concat([installedInstructions, Buffer.from('\nconcurrent managed edit\n')]))
    const deniedRollback = await request(endpoint, { token, body: { ...pinned, action: 'rulesRollback', receiptId: applied.result.receiptId } })
    check('rollback refuses a later user edit of a managed rule', deniedRollback.error === 'ROLLOUT_PROJECT_CHANGED' && (await readFile(join(primary.root, 'AGENTS.md'))).includes(Buffer.from('concurrent managed edit')))
    await writeFile(join(primary.root, 'AGENTS.md'), installedInstructions)
    const rolled = await request(endpoint, { token, body: { ...pinned, action: 'rulesRollback', receiptId: applied.result.receiptId } })
    check('native rollback restores the exact prior instruction state', rolled.ok && rolled.result?.status === 'rolled-back' && !await exists(join(primary.root, 'AGENTS.md')))
    const final = await request(endpoint, { query: { ...pinned, action: 'projectStatus' } })
    check('project status retains the rolled-back receipt and no installed rule manifest', final.ok && final.project.installed === false && final.project.receipts.some(row => row.receiptId === applied.result.receiptId && row.status === 'rolled-back'))
    check('owner rules, MCP and unrelated project preferences remain byte-for-byte intact', userRules.equals(await readFile(join(primary.root, 'USER-RULES.md'))) && mcp.equals(await readFile(join(primary.root, '.mcp.json'))) && (await Promise.all([...protectedFiles].map(async ([path, before]) => before.equals(await readFile(join(primary.root, path)))))).every(Boolean))
    check('only installed renderer commands were admitted to the native process seam', allowedCalls.length >= 7 && allowedCalls.some(row => row.command === 'render') && allowedCalls.some(row => row.command === 'verify') && allowedCalls.some(row => row.command === 'apply') && allowedCalls.some(row => row.command === 'rollback'))
    const latestSettings = await request(), restoredSettings = await request(endpoint, { token, body: { ...pinned, action: 'saveSettings', settings: initial.settings, revision: latestSettings.revision } })
    check('maintenance fixture restores the original source configuration values', restoredSettings.ok && JSON.stringify(restoredSettings.settings) === JSON.stringify(initial.settings))
    report.gitMaintenance = { source: 'embedded', revision: initial.embedded.commit, canonicalRules: fresh.plan.counts.rules, projectRuleApply: true, exactRollback: true, nativeProcessCalls: allowedCalls.length, gitNetworkRequests: 0, modelRequests: 0, mcpRequests: 0, selfUpdatesExecuted: 0, realDeployments: 0 }
  } finally {
    report.maintenanceNativeProcessCalls = allowedCalls.length
    ctx.subprocess.spawn = previousSpawn
    setSandboxMode(primary.agent.session, originalMode); setSandboxMode(foreign.agent.session, originalMode)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runReleaseProbe({ ...parseArguments(process.argv.slice(2)), extraAcceptance: gitMaintenanceAcceptance }))); process.exit(0) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', code: error.message, reportPath: error.reportPath ?? null })); process.exit(1) }
}
