import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

// Exercise actual native registry, skill tool and settings routes in a disposable
// profile. There are no model turns, project runners, MCP calls or deployments.
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const candidate = assertCandidatePath(process.argv[2])
const ui = resolve(process.argv[3]), policy = resolve(process.argv[4])
await preflightCandidate({ candidateRoot: candidate, uiArtifactRoot: ui, policyArtifactRoot: policy })
process.env.DSH_HOME = join(candidate, 'home')
process.env.DSH_AGENTS_HOME = join(candidate, 'home-agents')
process.env.DSH_TELEMETRY = 'off'
process.env.DSH_TELEMETRY_DISABLED = '1'
process.chdir(candidate)
const modules = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
const smoke = join(candidate, 'smoke')
await mkdir(smoke, { recursive: true })
const patch = join(candidate, 'canonical-skills-probe.patch.yml')
await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n')
const GENERAL = ['handoff', 'skill-maintainer', 'security-baseline', 'architecture-evolution', 'technical-debt']
const ONEC = ['1c-business-tests', '1c-ui-regression', '1c-verify-project']
const NEW_SKILLS = [...GENERAL, ...ONEC]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, checks: [], modelTurns: 0, projectRunnersExecuted: 0, mcpCallsExecuted: 0, deploymentsExecuted: 0 }
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ name, passed: true }) }
let app
const timer = setTimeout(() => process.exit(2), 55000)
try {
  const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
  const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
  app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
  const ctx = app.ctx
  ctx.on('agent/request', () => { report.modelTurns++; throw new Error('PROBE_MODEL_REQUEST_FORBIDDEN') }, { prepend: true })
  report.presets = (await ctx.agentPresets.list()).map(row => ({ id: row.id, broken: !!row.broken }))
  check('all selected native presets are healthy', ['1c-airules', 'python-airules', 'sysadmin-airules', 'standard'].every(id => report.presets.some(row => row.id === id && !row.broken)))
  const installedModules = join(candidate, 'home/profiles/desktop/node_modules')
  const rulepack = join(installedModules, 'airules-dsh-rulepack')
  const artifactRulepack = join(policy, 'payload/packages/airules-dsh-rulepack')
  const manifest = JSON.parse(await readFile(join(rulepack, 'manifest.json'), 'utf8'))
  const artifactManifest = JSON.parse(await readFile(join(artifactRulepack, 'manifest.json'), 'utf8'))
  check('fresh canonical manifest declares 22 embedded skills', manifest.counts.skills === 22)
  check('installed canonical manifest equals reviewed artifact', sha(JSON.stringify(manifest)) === sha(JSON.stringify(artifactManifest)))
  const sources = new Map()
  for (const name of NEW_SKILLS) {
    const prefix = `skills/${name}/`, records = Object.entries(manifest.files).filter(([path]) => path.startsWith(prefix))
    check(`canonical manifest contains ${name} entrypoint`, records.some(([path]) => path === `${prefix}SKILL.md`))
    for (const [path, record] of records) {
      const current = await readFile(join(rulepack, path)), reviewed = await readFile(join(artifactRulepack, path))
      check(`verified canonical resource ${path}`, sha(current) === record.sha256 && current.length === record.bytes && current.equals(reviewed))
      if (GENERAL.includes(name)) {
        const shared = await readFile(join(installedModules, 'airules-dsh-domain-presets/skills/common', name, path.slice(prefix.length)))
        check(`shared domain resource matches canonical manifest ${path}`, shared.equals(current))
      }
    }
    sources.set(name, await readFile(join(rulepack, prefix, 'SKILL.md'), 'utf8'))
  }
  check('review adaptations retain their upstream NOTICE resources', ['security-baseline', 'architecture-evolution', 'technical-debt'].every(name => Object.hasOwn(manifest.files, `skills/${name}/NOTICE`)))

  const origin = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookies = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('native browser admission authenticated', login.status === 303 && cookies.length > 0)
  async function request(id, body, token, path = '/airules/skills') {
    const url = new URL(path, origin)
    if (!body) url.searchParams.set('sessionId', id)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { cookie: cookies, origin: new URL(origin).origin,
      ...(body ? { 'content-type': 'application/json', 'x-dsh-csrf': token ?? '' } : {}) },
      ...(body ? { body: JSON.stringify({ sessionId: id, ...body }) } : {}) })
    return { status: response.status, ...await response.json() }
  }
  const agents = []
  for (const preset of ['1c-airules', 'python-airules', 'sysadmin-airules', 'standard']) {
    const root = join(candidate, 'canonical-skills-fixtures', `${preset}-${randomUUID()}`), id = `canonical-skills-${randomUUID()}`
    await mkdir(join(root, '.git'), { recursive: true })
    await ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: preset }, setup: async (_scope, agent) => {
      setSandboxMode(agent.session, 'workspace-write'); await ctx.agentPresets.select(agent, preset)
    } })
    const agent = ctx.agents.get(id), registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.skills
    const tool = agent.ctx.tools.get('skill', agent)
    check(`${preset} is actually composed`, ctx.agentPresets.composedPreset(agent.ctx) === preset && !!tool)
    const snapshot = await registry.snapshot({ cwd: root, scope: agent })
    check(`${preset} has a complete native snapshot`, snapshot.complete)
    const names = snapshot.skills.map(row => row.name)
    const expected = preset === '1c-airules' ? NEW_SKILLS : preset === 'standard' ? [] : GENERAL
    for (const name of NEW_SKILLS) {
      check(`${preset} ${expected.includes(name) ? 'exposes' : 'isolates'} ${name}`, names.includes(name) === expected.includes(name))
      if (expected.includes(name)) {
        const loaded = await tool.execute({ name }, { agent, signal: new AbortController().signal })
        const heading = sources.get(name).split(/\r?\n/).find(line => line.startsWith('# '))
        check(`${preset} native skill tool loads canonical ${name}`, typeof loaded.content === 'string' && heading && loaded.content.includes(heading))
      }
    }
    if (['python-airules', 'sysadmin-airules', 'standard'].includes(preset)) check(`${preset} never receives 1C-only skills`, !names.some(name => name.startsWith('1c-') || name === 'ibcmd-ibsrv'))
    const item = { preset, root, id, agent, registry, tool }; agents.push(item)
    if (preset === 'standard') continue
    let inventory = await request(id)
    check(`${preset} settings expose canonical assignment defaults`, inventory.ok && NEW_SKILLS.every(name => Object.hasOwn(inventory.assignments.defaults, name)))
    check(`${preset} handoff is always suggested by its built-in default`, inventory.assignments.defaults.handoff.taskTypes.length === 0)
    setSandboxMode(agent.session, 'danger-full-access')
    inventory = await request(id)
    const originalHandoff = await tool.execute({ name: 'handoff' }, { agent, signal: new AbortController().signal })
    let row = inventory.rows.find(row => row.name === 'handoff')
    check(`${preset} packaged handoff has a native managed toggle`, row?.bundled && row.writable && row.enabled)
    const disabled = await request(id, { action: 'toggle', items: [{ id: row.id, revision: row.revision }], enabled: false }, inventory.csrfToken)
    check(`${preset} native manager saves disabling handoff`, disabled.ok && disabled.changed === 1)
    const hidden = await registry.get('handoff', { cwd: root, scope: agent })
    check(`${preset} disabled handoff invocation is natively forbidden`, hidden?.invocation.modelInvocable === false && hidden?.invocation.userInvocable === false)
    await assert.rejects(tool.execute({ name: 'handoff' }, { agent, signal: new AbortController().signal }), /not available for model invocation/)
    check(`${preset} native skill tool rejects disabled handoff`, true)
    inventory = await request(id); row = inventory.rows.find(row => row.name === 'handoff' && !row.enabled)
    check(`${preset} disabled handoff remains visible in manager`, !!row)
    const enabled = await request(id, { action: 'toggle', items: [{ id: row.id, revision: row.revision }], enabled: true }, inventory.csrfToken)
    check(`${preset} native manager restores handoff`, enabled.ok && enabled.changed === 1)
    check(`${preset} restored native handoff matches original content`, (await tool.execute({ name: 'handoff' }, { agent, signal: new AbortController().signal })).content === originalHandoff.content)
    setSandboxMode(agent.session, 'workspace-write')
  }
  const onec = agents.find(row => row.preset === '1c-airules')
  const beforeOverride = await onec.tool.execute({ name: 'handoff' }, { agent: onec.agent, signal: new AbortController().signal })
  const overrideFolder = join(onec.root, '.dsh/skills/handoff'), override = join(overrideFolder, 'SKILL.md')
  const local = '---\nname: handoff\ndescription: Isolated project override\n---\nProject-owned handoff marker.\n'
  await mkdir(overrideFolder, { recursive: true }); await writeFile(override, local)
  onec.registry.invalidateCache()
  check('project skill overrides canonical packaged handoff', (await onec.tool.execute({ name: 'handoff' }, { agent: onec.agent, signal: new AbortController().signal })).content.includes('Project-owned handoff marker.'))
  await unlink(override); await rmdir(overrideFolder); onec.registry.invalidateCache()
  check('removing isolated project override restores bundled handoff', (await onec.tool.execute({ name: 'handoff' }, { agent: onec.agent, signal: new AbortController().signal })).content === beforeOverride.content)

  // License resources are portable payload, not executables. Exercise the real
  // import route so generated native skill bundles remain transferable.
  const licensedSource = join(onec.root, '.claude/skills/security-baseline')
  await mkdir(licensedSource, { recursive: true })
  const licenseBytes = await readFile(join(rulepack, 'skills/security-baseline/NOTICE'))
  const skillBytes = await readFile(join(rulepack, 'skills/security-baseline/SKILL.md'))
  await writeFile(join(licensedSource, 'SKILL.md'), skillBytes)
  await writeFile(join(licensedSource, 'NOTICE'), licenseBytes)
  const importState = await request(onec.id, undefined, undefined, '/airules/agent-import')
  check('native import route is admitted for licensed skill roundtrip', importState.ok && importState.writable)
  const importer = body => request(onec.id, body, importState.csrfToken, '/airules/agent-import')
  const preview = await importer({ action: 'preview', origin: 'claude', scope: 'project' })
  const licensed = preview.entries?.find(row => row.title === 'security-baseline')
  check('licensed canonical skill preview retains NOTICE in complete inventory', preview.ok && licensed?.status === 'new'
    && licensed.inventory?.some(file => file.path === 'NOTICE' && file.bytes === licenseBytes.length))
  const imported = await importer({ action: 'apply', origin: 'claude', scope: 'project', revision: preview.revision, selected: [licensed.id] })
  check('native import accepts canonical SKILL plus text NOTICE', imported.ok && imported.imported === 1)
  const licensedTarget = join(onec.root, '.dsh/skills/security-baseline')
  check('licensed roundtrip preserves NOTICE and entrypoint exact bytes', (await readFile(join(licensedTarget, 'NOTICE'))).equals(licenseBytes)
    && (await readFile(join(licensedTarget, 'SKILL.md'))).equals(skillBytes))
  check('licensed roundtrip leaves source and original package unchanged', (await readFile(join(licensedSource, 'NOTICE'))).equals(licenseBytes)
    && (await readFile(join(rulepack, 'skills/security-baseline/NOTICE'))).equals(licenseBytes))
  const repeated = await importer({ action: 'preview', origin: 'claude', scope: 'project' })
  const duplicate = repeated.entries?.find(row => row.title === 'security-baseline')
  check('repeated licensed preview detects an identical bundle', repeated.ok && duplicate?.status === 'identical')
  const rejected = await importer({ action: 'apply', origin: 'claude', scope: 'project', revision: repeated.revision, selected: [duplicate.id] })
  check('duplicate licensed import cannot overwrite existing files', !rejected.ok && rejected.error === 'CONFLICT_REJECTED'
    && (await readFile(join(licensedTarget, 'NOTICE'))).equals(licenseBytes)
    && (await readFile(join(licensedTarget, 'SKILL.md'))).equals(skillBytes))
  for (const name of NEW_SKILLS) check(`native tests preserve original package bytes ${name}`, sha(await readFile(join(rulepack, `skills/${name}/SKILL.md`))) === manifest.files[`skills/${name}/SKILL.md`].sha256)

  let inventory = await request(onec.id)
  for (const taskType of ['testing', 'code-review']) {
    const context = await request(onec.id, { action: 'task-context', taskType, revision: inventory.assignments.context.revision }, inventory.csrfToken)
    check(`native task selection accepts ${taskType}`, context.ok)
    const decision = await onec.agent.dispatch.waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const catalog = decision.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1)
    const names = catalog?.source.entries.map(row => row.name) ?? []
    check(`${taskType} catalog keeps handoff`, catalog?.source.owner === 'airules-skill-assignments' && names.includes('handoff'))
    check(`${taskType} catalog applies 1C testing defaults`, ONEC.every(name => names.includes(name) === (taskType === 'testing')))
    check(`${taskType} catalog applies security review default`, names.includes('security-baseline') === (taskType === 'code-review'))
    for (const message of decision.messages.filter(message => message.source?.kind === 'skill-catalog')) onec.agent.session.append('user/message', message, { surfaceOp: 'append' })
    onec.agent.session.append('step/start', { turn: 1, step: taskType === 'testing' ? 1 : 2 })
    inventory = await request(onec.id)
  }
  check('preview restores automatic task selection', (await request(onec.id, { action: 'task-context', taskType: 'auto', revision: inventory.assignments.context.revision }, inventory.csrfToken)).ok)
  check('no model turn was requested by this native probe', report.modelTurns === 0)
  report.passed = true
  await writeFile(join(smoke, 'canonical-skills-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--serve-preview')) {
    clearTimeout(timer)
    const path = join(smoke, 'canonical-skills-preview.private.json'), stop = join(smoke, 'canonical-skills-preview.stop')
    await rm(stop, { force: true })
    await writeFile(path, JSON.stringify({ url: ctx.connection.authenticatedUrl(origin), sessionId: onec.id, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 720000
    while (Date.now() < deadline) { if (await access(stop).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 500)) }
    await rm(path, { force: true }); await rm(stop, { force: true })
  }
  await app.ctx.fiber.dispose(); clearTimeout(timer)
  process.stdout.write(`Native canonical skills: PASS (${report.checks.length} checks); no model, MCP, runner or deployment calls\n`)
  process.exit(0)
} catch (error) {
  report.passed = false
  await writeFile(join(smoke, 'canonical-skills-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
  await writeFile(join(smoke, 'canonical-skills-probe-error.log'), String(error?.stack ?? 'PROBE_ERROR')).catch(() => {})
  try { await app?.ctx?.fiber.dispose() } catch {}
  clearTimeout(timer)
  process.stderr.write('NATIVE_CANONICAL_SKILLS_PROBE_FAILED; inspect isolated probe error log\n'); process.exit(1)
}
