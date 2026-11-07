import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

// This probe boots a disposable candidate profile. It never starts a model turn,
// project runner, MCP request, database operation, or deployment.
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
const patch = join(candidate, 'import-skills-probe.patch.yml')
await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n')
const report = { schemaVersion: 1, checks: [], modelTurns: 0, projectRunnersExecuted: 0, mcpCallsExecuted: 0, deploymentsExecuted: 0 }
let app
const timer = setTimeout(() => process.exit(2), 55000)
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ name, passed: true }) }
const skill = (name, description = 'Disposable native probe skill') => `---\nname: ${name}\ndescription: ${description}\n---\n\nUse this fixture only for isolated import and skill-management checks.\n`
const scriptResource = '# Harmless fixture resource; copied as data and never executed by this probe.\nprint("probe-script-resource")\n'
const scriptInstructions = `${skill('probe-script', 'Skill with an explicitly reviewed Python resource')}\nReference: tools/check.py. Inspect this resource before enabling the skill.\n`
async function seed(root) {
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, '.cursor/rules'), { recursive: true })
  await mkdir(join(root, '.cursor/skills/probe-imported/docs'), { recursive: true })
  await mkdir(join(root, '.claude/skills/probe-claude'), { recursive: true })
  await mkdir(join(root, '.codex/skills/probe-codex'), { recursive: true })
  await mkdir(join(root, '.codex/skills/probe-script/tools'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# Existing project instructions\n\nKeep this project-owned sentinel.\n')
  await writeFile(join(root, 'CLAUDE.md'), '# Native Claude instructions\nAlready readable by DSH.\n')
  await writeFile(join(root, '.cursor/rules/checks.mdc'), '---\ndescription: Isolated checks\nglobs: "**/*.bsl"\nalwaysApply: false\n---\n\nCheck changed BSL modules before completing work.\n')
  await writeFile(join(root, '.cursor/skills/probe-imported/SKILL.md'), skill('probe-imported'))
  await writeFile(join(root, '.cursor/skills/probe-imported/docs/guide.md'), '# Fixture guide\nPreserve this referenced document.\n')
  await writeFile(join(root, '.claude/skills/probe-claude/SKILL.md'), skill('probe-claude'))
  await writeFile(join(root, '.codex/skills/probe-codex/SKILL.md'), skill('probe-codex'))
  await writeFile(join(root, '.codex/skills/probe-script/SKILL.md'), scriptInstructions)
  await writeFile(join(root, '.codex/skills/probe-script/tools/check.py'), scriptResource)
}
try {
  const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
  const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
  app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
  const ctx = app.ctx
  report.plugins = [...ctx.loader.entries()].filter(row => ['airules-dsh-agent-import', 'airules-dsh-skills'].includes(row.options?.name))
    .map(row => ({ id: row.options.id, name: row.options.name, state: row.fiber?.state ?? null }))
  check('both native plugins started', report.plugins.length === 2 && report.plugins.every(row => row.state === 2))
  report.presets = (await ctx.agentPresets.list()).map(row => ({ id: row.id, broken: !!row.broken }))
  check('managed presets remain healthy', report.presets.filter(row => ['1c-airules', 'python-airules', 'sysadmin-airules'].includes(row.id)).every(row => !row.broken))

  const root = join(candidate, 'import-skills-fixtures', randomUUID())
  await seed(root)
  const sessionId = `import-skills-${randomUUID()}`
  await ctx.agents.create({ sessionId, meta: { cwd: root, agentPreset: '1c-airules' }, setup: async (_scope, agent) => {
    setSandboxMode(agent.session, 'workspace-write')
    await ctx.agentPresets.select(agent, '1c-airules')
  } })
  const session = ctx.sessions.get(sessionId), agent = ctx.agents.get(sessionId)
  check('native agent composition available', !!session && !!agent)
  const registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.skills
  check('native agent is bound to managed preset scope', ctx.agentPresets.composedPreset(agent.ctx) === '1c-airules')
  const nativeSkill = name => registry.get(name, { cwd: root, scope: agent })
  const origin = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookies = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('native browser authentication exchanged', login.status === 303 && cookies.length > 0)
  async function request(path, body, token, id = sessionId) {
    const url = new URL(path, origin)
    if (!body) url.searchParams.set('sessionId', id)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { cookie: cookies, origin: new URL(origin).origin,
      ...(body ? { 'content-type': 'application/json', 'x-dsh-csrf': token ?? '' } : {}) },
      ...(body ? { body: JSON.stringify({ sessionId: id, ...body }) } : {}) })
    return { status: response.status, ...await response.json() }
  }
  const importPath = '/airules/agent-import', skillsPath = '/airules/skills'
  const importState = await request(importPath)
  check('import route is writable in native workspace mode', importState.ok && importState.writable && !importState.globalWritable)
  const noCsrf = await request(importPath, { action: 'preview', origin: 'cursor', scope: 'project' })
  check('import refuses missing CSRF token', noCsrf.status === 403 && noCsrf.error === 'CSRF_REQUIRED')
  const importer = body => request(importPath, body, importState.csrfToken)
  const oldPreview = await importer({ action: 'preview', origin: 'cursor', scope: 'project' })
  check('preview discovers rule and complete skill bundle', oldPreview.ok && oldPreview.entries.filter(row => row.status === 'new').length === 2)
  await writeFile(join(root, '.cursor/rules/checks.mdc'), `${await readFile(join(root, '.cursor/rules/checks.mdc'), 'utf8')}\nAdditional fixture revision.\n`)
  const stale = await importer({ action: 'apply', origin: 'cursor', scope: 'project', revision: oldPreview.revision, selected: oldPreview.entries.map(row => row.id) })
  check('source changes invalidate old import preview', stale.status === 409 && stale.error === 'STALE_PREVIEW')
  const preview = await importer({ action: 'preview', origin: 'cursor', scope: 'project' })
  const imported = await importer({ action: 'apply', origin: 'cursor', scope: 'project', revision: preview.revision, selected: preview.entries.map(row => row.id) })
  check('selected project instructions and skill are imported', imported.ok && imported.imported === 2)
  const merged = await readFile(join(root, 'AGENTS.md'), 'utf8')
  check('import preserves project rules and original applicability', merged.includes('project-owned sentinel') && merged.includes('globs:') && merged.includes('Additional fixture revision'))
  check('import preserves referenced skill resources', (await readFile(join(root, '.dsh/skills/probe-imported/docs/guide.md'), 'utf8')).includes('Preserve this referenced document'))
  const repeated = await importer({ action: 'preview', origin: 'cursor', scope: 'project' })
  check('repeated preview identifies already imported entries', repeated.ok && repeated.entries.every(row => row.status === 'identical'))
  const duplicate = await importer({ action: 'apply', origin: 'cursor', scope: 'project', revision: repeated.revision, selected: repeated.entries.map(row => row.id) })
  check('duplicate import never appends instructions twice', !duplicate.ok && duplicate.error === 'CONFLICT_REJECTED' && await readFile(join(root, 'AGENTS.md'), 'utf8') === merged)
  const claude = await importer({ action: 'preview', origin: 'claude', scope: 'project' })
  check('native CLAUDE instructions are not duplicated', claude.ok && claude.entries.length === 1 && claude.entries[0].kind === 'skill' && claude.skipped.some(row => row.source === 'CLAUDE.md'))
  check('Claude skill import succeeds', (await importer({ action: 'apply', origin: 'claude', scope: 'project', revision: claude.revision, selected: claude.entries.map(row => row.id) })).ok)

  const codePreview = await importer({ action: 'preview', origin: 'codex', scope: 'project' })
  const codeEntry = codePreview.entries?.find(row => row.title === 'probe-script')
  check('script-bearing skill preview exposes code inventory before import', codePreview.ok && codeEntry?.hasScripts === true
    && codeEntry.inventory?.some(file => file.path === 'tools/check.py' && file.script === true && file.bytes === Buffer.byteLength(scriptResource)))
  check('script-bearing skill is imported only by explicit selection', (await importer({ action: 'apply', origin: 'codex', scope: 'project', revision: codePreview.revision, selected: [codeEntry.id] })).imported === 1)
  const codeDisabled = await nativeSkill('probe-script')
  check('imported script-bearing skill starts disabled in native registry', codeDisabled?.invocation.modelInvocable === false && codeDisabled?.invocation.userInvocable === false)

  let inventory = await request(skillsPath)
  check('skills page sees imported native filesystem skills', inventory.ok && ['probe-imported', 'probe-claude'].every(name => inventory.rows.some(row => row.name === name && row.scope === 'project' && row.enabled)))
  const mutate = body => request(skillsPath, body, inventory.csrfToken)
  const codeRow = inventory.rows.find(row => row.name === 'probe-script' && row.scope === 'project' && !row.enabled)
  const codeContent = codeRow ? await mutate({ action: 'content', id: codeRow.id }) : null
  check('disabled imported skill viewer exposes original instructions', codeContent?.ok && codeContent.content === scriptInstructions)
  check('reviewed script-bearing skill can be enabled in native manager', !!codeRow
    && (await mutate({ action: 'toggle', items: [{ id: codeRow.id, revision: codeRow.revision }], enabled: true })).ok
    && (await nativeSkill('probe-script'))?.invocation.modelInvocable === true)
  check('script resource and instructions retain exact imported bytes without execution',
    await readFile(join(root, '.dsh/skills/probe-script/tools/check.py'), 'utf8') === scriptResource
    && await readFile(join(root, '.dsh/skills/probe-script/SKILL.md'), 'utf8') === scriptInstructions)
  let importedSkill = await nativeSkill('probe-imported')
  if (!importedSkill) {
    registry.invalidateCache()
    const retried = await nativeSkill('probe-imported')
    report.importCacheDiagnostic = { before: false, afterExplicitInvalidation: !!retried }
    if (process.argv.includes('--refresh-import-cache')) importedSkill = retried
  }
  check('native registry can load imported skill', importedSkill?.content.includes('isolated import'))
  check('skills add creates project skill', (await mutate({ action: 'add', scope: 'project', name: 'probe-created', description: 'Created through native settings route', content: 'Use this disposable project skill.' })).ok)
  inventory = await request(skillsPath)
  let row = inventory.rows.find(row => row.name === 'probe-created' && row.scope === 'project')
  check('created skill is registered for the native agent', row?.enabled && (await nativeSkill('probe-created'))?.invocation.modelInvocable)
  const content = await mutate({ action: 'content', id: row.id })
  check('skills instructions are readable from settings', content.ok && content.content.includes('disposable project skill'))
  check('individual disable is saved', (await mutate({ action: 'toggle', items: [{ id: row.id, revision: row.revision }], enabled: false })).ok)
  let disabled = await nativeSkill('probe-created')
  check('disabled skill cannot be invoked by model or user', !disabled || (disabled.invocation.modelInvocable === false && disabled.invocation.userInvocable === false))
  inventory = await request(skillsPath)
  row = inventory.rows.find(row => row.name === 'probe-created' && row.scope === 'project' && !row.enabled)
  check('disabled skill remains visible in manager', !!row)
  check('individual enable is saved', (await mutate({ action: 'toggle', items: [{ id: row.id, revision: row.revision }], enabled: true })).ok)
  check('enabled skill is available again to native agent', (await nativeSkill('probe-created'))?.invocation.modelInvocable === true)
  inventory = await request(skillsPath)
  row = inventory.rows.find(row => row.name === 'probe-created' && row.scope === 'project')
  await writeFile(join(root, '.dsh/skills/probe-created/SKILL.md'), `${await readFile(join(root, '.dsh/skills/probe-created/SKILL.md'), 'utf8')}\nExternal edit.\n`)
  const staleSkill = await mutate({ action: 'toggle', items: [{ id: row.id, revision: row.revision }], enabled: false })
  check('stale skill toggle is rejected', staleSkill.status === 409 && staleSkill.error === 'STALE_SKILL')
  inventory = await request(skillsPath)
  let bulk = inventory.rows.filter(row => ['probe-created', 'probe-imported'].includes(row.name) && row.scope === 'project')
  check('bulk disable is saved', (await mutate({ action: 'toggle', items: bulk.map(({ id, revision }) => ({ id, revision })), enabled: false })).ok)
  check('bulk disable affects real native invocation', (await Promise.all(bulk.map(row => nativeSkill(row.name)))).every(value => !value || (!value.invocation.modelInvocable && !value.invocation.userInvocable)))
  inventory = await request(skillsPath)
  bulk = inventory.rows.filter(row => ['probe-created', 'probe-imported'].includes(row.name) && row.scope === 'project' && !row.enabled)
  check('bulk enable restores selected skills', (await mutate({ action: 'toggle', items: bulk.map(({ id, revision }) => ({ id, revision })), enabled: true })).ok && (await nativeSkill('probe-created'))?.invocation.modelInvocable)

  setSandboxMode(session, 'read-only')
  const readOnlySkill = await mutate({ action: 'add', scope: 'project', name: 'probe-denied', description: 'Denied', content: 'Never written.' })
  check('read-only native policy blocks project skill writes', !readOnlySkill.ok && readOnlySkill.error === 'WRITE_REQUIRED')
  const readOnlyImport = await importer({ action: 'apply', origin: 'claude', scope: 'project', revision: claude.revision, selected: claude.entries.map(row => row.id) })
  check('read-only native policy blocks imports', !readOnlyImport.ok && readOnlyImport.error === 'WORKSPACE_WRITE_REQUIRED')
  setSandboxMode(session, 'workspace-write')
  const globalDenied = await mutate({ action: 'add', scope: 'global', name: 'probe-global-denied', description: 'Denied', content: 'Never written.' })
  check('workspace policy blocks shared skill writes', !globalDenied.ok && globalDenied.error === 'WRITE_REQUIRED')
  setSandboxMode(session, 'danger-full-access')
  const globalName = `probe-global-${randomUUID().slice(0, 8)}`
  check('explicit native full access permits isolated global skill creation', (await mutate({ action: 'add', scope: 'global', name: globalName, description: 'Isolated shared skill', content: 'Only candidate home is changed.' })).ok)
  check('shared skill is stored under isolated DSH home', (await readFile(join(candidate, 'home/skills', globalName, 'SKILL.md'), 'utf8')).includes('Only candidate home'))
  inventory = await request(skillsPath)
  const bundled = inventory.rows.find(row => row.bundled && row.writable && row.enabled)
  if (bundled) {
    check('bundled skill disable is saved without install writes', (await mutate({ action: 'toggle', items: [{ id: bundled.id, revision: bundled.revision }], enabled: false })).ok)
    const native = await nativeSkill(bundled.name)
    check('bundled override blocks native invocation in preset scope', !native || (!native.invocation.modelInvocable && !native.invocation.userInvocable))
    inventory = await request(skillsPath)
    const override = inventory.rows.find(row => row.name === bundled.name && !row.enabled && row.writable)
    check('bundled override can be restored', !!override && (await mutate({ action: 'toggle', items: [{ id: override.id, revision: override.revision }], enabled: true })).ok)
    check('restored bundled skill is invocable again', (await nativeSkill(bundled.name))?.invocation.modelInvocable === true)
  } else report.bundledToggle = 'no writable bundled skills in this composition'
  setSandboxMode(session, 'workspace-write')
  report.passed = true
  await writeFile(join(smoke, 'import-skills-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`)

  if (process.argv.includes('--serve-preview')) {
    clearTimeout(timer)
    const previewRoot = join(candidate, 'import-skills-ui-fixtures', randomUUID()), previewId = `import-skills-ui-${randomUUID()}`
    await seed(previewRoot)
    await mkdir(join(previewRoot, '.dsh/skills/project-review'), { recursive: true })
    await writeFile(join(previewRoot, '.dsh/skills/project-review/SKILL.md'), skill('project-review', 'Проверка изменений проекта перед завершением задачи'))
    await ctx.agents.create({ sessionId: previewId, meta: { cwd: previewRoot, agentPreset: '1c-airules', title: 'Импорт и навыки — стенд' }, setup: async (_scope, previewAgent) => {
      setSandboxMode(previewAgent.session, 'workspace-write')
      await ctx.agentPresets.select(previewAgent, '1c-airules')
    } })
    const connectionPath = join(smoke, 'import-skills-preview.private.json'), stop = join(smoke, 'import-skills-preview.stop')
    await rm(stop, { force: true })
    await writeFile(connectionPath, JSON.stringify({ url: ctx.connection.authenticatedUrl(origin), sessionId: previewId, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 720000
    while (Date.now() < deadline) {
      if (await access(stop).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    await rm(connectionPath, { force: true }); await rm(stop, { force: true })
  }
  await app.ctx.fiber.dispose()
  clearTimeout(timer)
  process.stdout.write(`Native import/skills: PASS (${report.checks.length} checks); no model, MCP or deployment calls\n`)
  process.exit(0)
} catch (error) {
  report.passed = false
  await writeFile(join(smoke, 'import-skills-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
  await writeFile(join(smoke, 'import-skills-probe-error.log'), String(error?.stack ?? 'PROBE_ERROR')).catch(() => {})
  try { await app?.ctx?.fiber.dispose() } catch {}
  clearTimeout(timer)
  process.stderr.write('NATIVE_IMPORT_SKILLS_PROBE_FAILED; inspect isolated probe error log\n')
  process.exit(1)
}
