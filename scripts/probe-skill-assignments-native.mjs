import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

// Only a disposable profile and workspaces are used. No model turn, project
// runner, MCP call, database operation or deployment is started by this probe.
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
const patch = join(candidate, 'skill-assignments-probe.patch.yml')
await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n')
const report = { schemaVersion: 1, checks: [], modelTurns: 0, projectRunnersExecuted: 0, mcpCallsExecuted: 0, deploymentsExecuted: 0 }
let app
const timer = setTimeout(() => process.exit(2), 55000)
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ name, passed: true }) }
const skill = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nUse ${name} only as a disposable assignment probe.\n`
async function seed(root) {
  await mkdir(join(root, '.git'), { recursive: true })
  for (const [name, description, extra] of [
    ['probe-test', 'Fixture for testing work', ''],
    ['probe-doc', 'Fixture for documentation work', ''],
    ['probe-free', 'Fixture available for all tasks', ''],
    ['constructor', 'Fixture with a native-valid name matching an object prototype key', ''],
    ['probe-disabled', 'Fixture forbidden by native invocation policy', 'disable-model-invocation: true\nuser-invocable: false\n'],
  ]) {
    await mkdir(join(root, '.dsh/skills', name), { recursive: true })
    await writeFile(join(root, '.dsh/skills', name, 'SKILL.md'), skill(name, description, extra))
  }
}

try {
  const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
  const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
  app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
  const ctx = app.ctx
  ctx.on('agent/request', () => { report.modelTurns++; throw new Error('PROBE_MODEL_REQUEST_FORBIDDEN') })
  const entries = [...ctx.loader.entries()].filter(row => row.options?.name === 'airules-dsh-skills')
  check('native skills plugin started', entries.length === 1 && entries[0].fiber?.state === 2)
  const root = join(candidate, 'skill-assignments-fixtures', randomUUID())
  await seed(root)
  const sessionId = `skill-assignments-${randomUUID()}`
  async function createAgent(id, extraMeta = {}, options = {}) {
    const preset = extraMeta.agentPreset ?? '1c-airules'
    await ctx.agents.create({ ...options, sessionId: id, meta: { cwd: root, agentPreset: preset, ...extraMeta }, setup: async (_scope, agent) => {
      setSandboxMode(agent.session, 'workspace-write')
      await ctx.agentPresets.select(agent, preset)
    } })
    return ctx.agents.get(id)
  }
  const agent = await createAgent(sessionId), session = agent.session
  const registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.skills
  check('managed native preset composition available', ctx.agentPresets.composedPreset(agent.ctx) === '1c-airules')
  const origin = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookies = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('native browser authentication exchanged', login.status === 303 && cookies.length > 0)
  async function request(body, token, id = sessionId) {
    const url = new URL('/airules/skills', origin)
    if (!body) url.searchParams.set('sessionId', id)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { cookie: cookies, origin: new URL(origin).origin,
      ...(body ? { 'content-type': 'application/json', 'x-dsh-csrf': token ?? '' } : {}) },
      ...(body ? { body: JSON.stringify({ sessionId: id, ...body }) } : {}) })
    return { status: response.status, ...await response.json() }
  }

  let inventory = await request()
  check('native skill inventory includes isolated fixtures', inventory.ok && ['probe-test', 'probe-doc', 'probe-free', 'probe-disabled'].every(name => inventory.rows.some(row => row.name === name)))
  check('assignments expose project/common revisions and native definitions', !!inventory.assignments
    && inventory.assignments.definitions.roles.length === 13 && inventory.assignments.definitions.taskTypes.testing
    && Object.hasOwn(inventory.assignments.definitions.accessModes, 'read-only'))
  const post = body => request(body, inventory.csrfToken)
  async function refresh(id = sessionId) { const current = await request(undefined, undefined, id); check('assignment settings are readable', current.ok); return current }
  const noCsrf = await request({ action: 'task-context', taskType: 'testing', revision: null })
  check('assignment mutation rejects missing CSRF', noCsrf.status === 403 && noCsrf.error === 'CSRF_REQUIRED')
  const assignment = (taskTypes = [], roles = [], accessModes = []) => ({ taskTypes, roles, accessModes })
  async function save(skillName, value, scope = 'project', change = 'set') {
    inventory = await refresh()
    const result = await post({ action: 'assignment-save', scope, skill: skillName,
      revision: inventory.assignments[scope === 'global' ? 'common' : 'project'].revision, change,
      ...(change === 'set' ? { assignment: value } : {}) })
    check(`${scope} assignment ${change} ${skillName}`, result.ok)
    return result
  }
  async function context(taskType, id = sessionId) {
    const current = await refresh(id)
    const result = await request({ action: 'task-context', taskType, revision: current.assignments.context.revision }, current.csrfToken, id)
    check(`session task selection ${taskType}`, result.ok)
    return result
  }
  const nativeSkill = name => registry.get(name, { cwd: root, scope: agent })
  check('native disabled policy survives settings inventory', (await nativeSkill('probe-disabled'))?.invocation.modelInvocable === false)
  await save('probe-test', assignment(['testing']))
  await save('probe-doc', assignment(['documentation']))
  await save('probe-disabled', assignment(['testing']))
  check('project assignment is a portable project file', (await readFile(join(root, '.dsh/skill-assignments.json'), 'utf8')).includes('probe-test'))
  const oldRevision = (await refresh()).assignments.project.revision
  await save('probe-free', assignment([]))
  const stale = await post({ action: 'assignment-save', scope: 'project', skill: 'probe-test', revision: oldRevision, change: 'set', assignment: assignment(['analysis']) })
  check('stale assignment revision is rejected', stale.status === 409 && stale.error === 'STALE_ASSIGNMENTS')

  let position = 0
  const catalogs = decision => decision.messages.filter(message => message.source?.kind === 'skill-catalog')
  const names = message => message?.source?.entries?.map(row => row.name) ?? []
  async function preStep(target = agent, publish = true) {
    position++
    const decision = await target.dispatch.waterfall('agent/pre-step', { messages: [], turn: 1, step: position, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }))
    check('real native pre-step enters without inference', decision.kind === 'enter')
    if (publish) {
      for (const message of catalogs(decision)) target.session.append('user/message', message, { surfaceOp: 'append' })
      target.session.append('step/start', { turn: 1, step: position })
    }
    return decision
  }
  await context('testing')
  let decision = await preStep()
  let catalog = catalogs(decision).at(-1)
  check('testing catalog contains matching and unrestricted skills', catalog?.source.owner === 'airules-skill-assignments'
    && names(catalog).includes('probe-test') && names(catalog).includes('probe-free') && !names(catalog).includes('probe-doc'))
  check('native-valid prototype-like skill names remain unrestricted and usable', names(catalog).includes('constructor'))
  check('catalog never advertises a native disabled skill', !names(catalog).includes('probe-disabled'))
  decision = await preStep()
  check('unchanged task does not append a duplicate catalog', catalogs(decision).length === 0)
  await context('documentation')
  decision = await preStep()
  catalog = catalogs(decision).at(-1)
  check('task change rebuilds from full registry instead of previous narrowed list', names(catalog).includes('probe-doc') && !names(catalog).includes('probe-test'))
  const skillTool = agent.ctx.tools.get('skill', agent)
  check('explicit native skill call remains available outside suggested catalog', (await skillTool.execute({ name: 'probe-test' }, { agent, signal: new AbortController().signal })).content.includes('probe-test'))
  await assert.rejects(skillTool.execute({ name: 'probe-disabled' }, { agent, signal: new AbortController().signal }), /not available for model invocation/)
  check('assignment never bypasses disabled native skill invocation policy', true)
  await context('all')
  decision = await preStep()
  check('all task selection expands catalog again', names(catalogs(decision).at(-1)).includes('probe-test') && names(catalogs(decision).at(-1)).includes('probe-doc'))

  const incomplete = registry.registerProvider(() => ({ name: `probe-incomplete-${randomUUID()}`, list: async () => ({ candidates: [], complete: false }), load: async () => undefined }))
  await context('testing')
  decision = await preStep()
  check('incomplete provider scan preserves earlier catalog without a partial replacement', catalogs(decision).length === 0)
  incomplete()
  decision = await preStep()
  check('complete provider scan resumes task filtering', names(catalogs(decision).at(-1)).includes('probe-test') && !names(catalogs(decision).at(-1)).includes('probe-doc'))

  await save('probe-test', assignment(['testing'], ['tester']))
  async function roleAgent(role, label = `airules-role:${role}`) {
    const id = `skill-role-${role}-${randomUUID()}`, child = await createAgent(id, { parentSession: sessionId })
    child.session.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label })
    return child
  }
  const tester = await roleAgent('tester')
  decision = await preStep(tester)
  check('managed tester role resolves testing task from durable own descriptor', names(catalogs(decision).at(-1)).includes('probe-test')
    && ctx.airulesSkillCatalog.status(tester.session.id)?.taskType === 'testing' && ctx.airulesSkillCatalog.status(tester.session.id)?.role === 'tester')
  tester.session.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label: 'airules-role:developer' })
  await preStep(tester)
  check('later descriptor cannot rewrite establishing managed role', ctx.airulesSkillCatalog.status(tester.session.id)?.role === 'tester')
  const developer = await roleAgent('developer')
  decision = await preStep(developer)
  check('developer role receives implementation catalog instead of testing skills', !names(catalogs(decision).at(-1)).includes('probe-test')
    && ctx.airulesSkillCatalog.status(developer.session.id)?.taskType === 'implementation')
  const generic = await roleAgent('tester', 'tester')
  await preStep(generic)
  check('generic labels do not masquerade as managed role selection', ctx.airulesSkillCatalog.status(generic.session.id)?.role === null
    && ctx.airulesSkillCatalog.status(generic.session.id)?.taskType === 'all')
  const inheritedEvents = tester.session.snapshotEvents()
  const fork = await createAgent(`skill-fork-${randomUUID()}`, { parentSession: tester.session.id, isSeeded: true }, { seed: inheritedEvents, inheritedEventCount: inheritedEvents.length })
  decision = await preStep(fork)
  check('fork ignores inherited parent descriptor and task context', ctx.airulesSkillCatalog.status(fork.session.id)?.role === null
    && ctx.airulesSkillCatalog.status(fork.session.id)?.taskType === 'all')
  check('fork republishes its own scoped catalog rather than trusting parent ownership', catalogs(decision).at(-1)?.source.catalogSessionId === fork.session.id)

  await context('documentation')
  session.append('plan/mode', { active: true })
  decision = await preStep()
  check('explicit task selection remains metadata while native plan is reported', ctx.airulesSkillCatalog.status(sessionId)?.taskType === 'documentation'
    && ctx.airulesSkillCatalog.status(sessionId)?.nativePlan === true)
  await context('auto')
  await preStep()
  check('auto task selection follows native plan mode', ctx.airulesSkillCatalog.status(sessionId)?.taskType === 'planning'
    && ctx.airulesSkillCatalog.status(sessionId)?.source === 'native-plan')
  session.append('plan/mode', { active: false })
  await preStep()
  check('leaving native plan restores automatic full catalog', ctx.airulesSkillCatalog.status(sessionId)?.taskType === 'all')
  await context('documentation')

  await save('probe-doc', assignment(['documentation'], [], ['read-only']))
  setSandboxMode(session, 'workspace-write')
  decision = await preStep()
  check('native access axis filters task catalog in workspace mode', !names(catalogs(decision).at(-1)).includes('probe-doc'))
  setSandboxMode(session, 'read-only')
  decision = await preStep()
  check('native readonly access axis exposes matching task skill', names(catalogs(decision).at(-1)).includes('probe-doc'))
  inventory = await refresh()
  const deniedProject = await post({ action: 'assignment-save', scope: 'project', skill: 'probe-doc', revision: inventory.assignments.project.revision, change: 'reset' })
  check('native readonly rights reject project assignment writes', !deniedProject.ok && deniedProject.error === 'WRITE_REQUIRED')
  await context('all')
  check('readonly session can select a task without granting workspace write rights', ctx.sandboxPolicy.resolve({ session }).mode === 'read-only')
  setSandboxMode(session, 'workspace-write')
  inventory = await refresh()
  const deniedGlobal = await post({ action: 'assignment-save', scope: 'global', skill: 'probe-free', revision: inventory.assignments.common.revision, change: 'set', assignment: assignment(['operations']) })
  check('workspace rights reject global assignment writes', !deniedGlobal.ok && deniedGlobal.error === 'WRITE_REQUIRED')
  setSandboxMode(session, 'danger-full-access')
  await save('probe-free', assignment(['operations']), 'global')
  await save('probe-free', assignment(['testing']))
  inventory = await refresh()
  check('project assignment overrides a shared rule', inventory.assignments.effective['probe-free'].taskTypes.join() === 'testing')
  await save('probe-free', undefined, 'project', 'reset')
  inventory = await refresh()
  check('reset project assignment restores shared inheritance', inventory.assignments.effective['probe-free'].taskTypes.join() === 'operations')
  await save('probe-free', undefined, 'global', 'reset')
  inventory = await refresh()
  check('reset shared assignment restores unrestricted unknown skill', !inventory.assignments.effective['probe-free'])
  const previousContext = inventory.assignments.context.revision
  await context('testing')
  const staleContext = await post({ action: 'task-context', taskType: 'documentation', revision: previousContext })
  check('stale task context cannot overwrite a newer selection', staleContext.status === 409 && staleContext.error === 'STALE_ASSIGNMENTS')
  await preStep()
  const projectAssignments = join(root, '.dsh/skill-assignments.json'), validAssignments = await readFile(projectAssignments, 'utf8')
  try {
    await writeFile(projectAssignments, '{corrupt-fixture')
    decision = await preStep()
    check('invalid assignment file fails softly without blocking native pre-step', ctx.airulesSkillCatalog.status(sessionId)?.settingsError === true)
    check('invalid assignment file falls back to complete native skill catalog', names(catalogs(decision).at(-1)).includes('probe-doc')
      && names(catalogs(decision).at(-1)).includes('probe-test') && catalogs(decision).at(-1).source.owner !== 'airules-skill-assignments')
    const invalidSettings = await request()
    check('settings page reports invalid assignment state explicitly', invalidSettings.ok && invalidSettings.assignments.settingsError === true)
  } finally { await writeFile(projectAssignments, validAssignments) }
  await context('auto')
  setSandboxMode(session, 'workspace-write')

  const standard = await createAgent(`skill-standard-${randomUUID()}`, { agentPreset: 'standard' })
  decision = await preStep(standard)
  check('standard preset retains native unfiltered catalog', catalogs(decision).length > 0
    && catalogs(decision).every(row => row.source.owner !== 'airules-skill-assignments')
    && names(catalogs(decision).at(-1)).includes('probe-test') && names(catalogs(decision).at(-1)).includes('probe-doc'))
  check('no model request was attempted', report.modelTurns === 0)

  report.passed = true
  await writeFile(join(smoke, 'skill-assignments-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--serve-preview')) {
    clearTimeout(timer)
    const connectionPath = join(smoke, 'skill-assignments-preview.private.json'), stop = join(smoke, 'skill-assignments-preview.stop')
    await rm(stop, { force: true })
    await writeFile(connectionPath, JSON.stringify({ url: ctx.connection.authenticatedUrl(origin), sessionId, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 720000
    while (Date.now() < deadline) {
      if (await access(stop).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    await rm(connectionPath, { force: true }); await rm(stop, { force: true })
  }
  await app.ctx.fiber.dispose()
  clearTimeout(timer)
  process.stdout.write(`Native skill assignments: PASS (${report.checks.length} checks); no model, MCP or deployment calls\n`)
  process.exit(0)
} catch (error) {
  report.passed = false
  await writeFile(join(smoke, 'skill-assignments-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
  await writeFile(join(smoke, 'skill-assignments-probe-error.log'), String(error?.stack ?? 'PROBE_ERROR')).catch(() => {})
  try { await app?.ctx?.fiber.dispose() } catch {}
  clearTimeout(timer)
  process.stderr.write('NATIVE_SKILL_ASSIGNMENTS_PROBE_FAILED; inspect isolated probe error log\n')
  process.exit(1)
}
