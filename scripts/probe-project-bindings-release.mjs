import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'
import { memoryPolicyAcceptance } from './probe-memory-policy-release.mjs'

/** Native installed-byte project settings acceptance. All mutations are confined
 * to synthetic fixture projects; no Office process, model, runner or deploy. */
export async function projectBindingsAcceptance(input) {
  await memoryPolicyAcceptance(input)
  const { ctx, agents, check, report, setSandboxMode } = input
  const primary = agents.find(row => row.preset === '1c-airules'), foreign = agents.find(row => row.preset === 'python-airules')
  check('installed shared project context service is available', typeof ctx.airulesProjects?.selection === 'function' && typeof ctx.airulesProjects?.bindHandler === 'function')
  setSandboxMode(primary.agent.session, 'workspace-write'); setSandboxMode(foreign.agent.session, 'workspace-write')
  const secondId = `project-settings-peer-${randomUUID()}`
  await ctx.agents.create({ sessionId: secondId, meta: { cwd: primary.root, agentPreset: '1c-airules', title: 'Project settings peer · synthetic fixture' }, setup: async (_scope, agent) => { setSandboxMode(agent.session, 'workspace-write'); await ctx.agentPresets.select(agent, '1c-airules') } })
  const peer = { id: secondId, root: primary.root, preset: '1c-airules', agent: ctx.agents.get(secondId) }
  for (const row of [primary, peer, foreign]) await ctx.sessions.flush(row.agent.session)
  const nativeProject = await ctx.workspaceRegistry.create(primary.root, 'Project settings · isolated acceptance'), nativeForeign = await ctx.workspaceRegistry.create(foreign.root, 'Foreign project · isolated acceptance')
  await nativeProject.attachSession(primary.id); await nativeProject.attachSession(peer.id); await nativeForeign.attachSession(foreign.id)
  const projectId = String(nativeProject.id), foreignId = String(nativeForeign.id)
  const rootKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)

  // The generic older probe helper always adds sessionId. This route has an
  // explicitly session-free contract, so use a new native admitted cookie only.
  const origin = ctx.webServer.getOrigin(), login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('project acceptance exchanges native loopback admission', login.status === 303 && !!cookie)
  async function request(path, { query = {}, body, token, authenticated = true } = {}) {
    const url = new URL(path, origin)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { origin: new URL(origin).origin, ...(authenticated ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', 'x-airules-csrf': token ?? '', 'x-dsh-csrf': token ?? '' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    let value; try { value = await response.json() } catch { value = { ok: false } }
    return { status: response.status, ...value }
  }
  const baseQuery = { projectId, activeSessionId: primary.id, presets: '1c-airules' }
  check('projects endpoint denies unadmitted access', (await request('/airules/projects', { query: baseQuery, authenticated: false })).status === 403)
  let selection = await request('/airules/projects', { query: baseQuery })
  check('native workspace rows deduplicate multiple chats by project', selection.ok && selection.projects.filter(row => row.projectId === projectId).length === 1 && selection.projectId === projectId && rootKey(selection.projectRoot) === rootKey(primary.root))
  check('project selection reports the native automatic executor and revision', selection.execution?.sessionId === primary.id && typeof selection.execution.revision === 'string' && selection.execution.writable === true)
  const choose = { action: 'select', projectId, expectedRevision: selection.selectionRevision }
  check('project selection mutation retains native CSRF', (await request('/airules/projects', { body: choose })).error === 'PROJECT_CSRF_REQUIRED')
  check('explicit project selection persists via native admitted endpoint', (await request('/airules/projects', { body: choose, token: selection.csrfToken })).ok)
  const afterChatSwitch = await request('/airules/projects', { query: { activeSessionId: foreign.id } })
  check('switching the visible chat does not replace an explicit project preference', afterChatSwitch.projectId === projectId)

  const scoped = (sessionId = primary.id, id = projectId) => ({ projectId: id, sessionId })
  const firstDocs = await request('/airules/documents', { query: scoped() }), peerDocs = await request('/airules/documents', { query: scoped(peer.id) })
  check('documents and Office status resolve the same project across two chats', firstDocs.ok && peerDocs.ok && rootKey(firstDocs.projectRoot) === rootKey(primary.root) && rootKey(peerDocs.projectRoot) === rootKey(primary.root) && JSON.stringify(firstDocs.documents) === JSON.stringify(peerDocs.documents))
  const shown = await request('/airules/documents', { token: firstDocs.csrfToken, body: { ...scoped(peer.id), kind: 'document', action: 'show' } })
  check('document library show runs through project binding without Office or a model', shown.ok && Array.isArray(shown.documents))
  const onec = await request('/airules/project-settings', { query: { projectId } })
  check('1C settings load by native project without choosing a chat', onec.ok && rootKey(onec.projectRoot) === rootKey(primary.root))
  const workflows = await request('/airules/workflows', { query: { projectId, action: 'status' } })
  check('checks and deploy cold status resolves the project without executing a runner', workflows.ok && typeof workflows.configured === 'boolean')

  const style = await request('/airules/general-tools', { query: scoped() })
  check('Caveman settings identify project ownership', style.ok && style.ownership === 'project' && rootKey(style.projectRoot) === rootKey(primary.root))
  selection = await request('/airules/projects', { query: baseQuery })
  const saveStyle = { ...scoped(), expectedProjectRoot: selection.projectRoot, expectedExecutorRevision: selection.execution.revision, mode: 'lite', revision: style.revision }
  check('an unpinned project mutation is refused before writing', (await request('/airules/general-tools', { token: style.csrfToken, body: { projectId, mode: 'lite', revision: style.revision } })).error === 'PROJECT_EXECUTOR_PIN_REQUIRED')
  check('project binding does not replace the original style CSRF guard', (await request('/airules/general-tools', { body: saveStyle })).status === 403)
  check('native project style save succeeds with an exact executor lease', (await request('/airules/general-tools', { token: style.csrfToken, body: saveStyle })).ok)
  const peerStyle = await request('/airules/general-tools', { query: scoped(peer.id) }), foreignStyle = await request('/airules/general-tools', { query: scoped(foreign.id, foreignId) })
  check('Caveman preference is shared by project and isolated from another namespace', peerStyle.ok && peerStyle.mode === 'lite' && foreignStyle.ok && foreignStyle.mode === 'off')
  const styleFile = JSON.parse(await readFile(join(primary.root, '.dsh/response-style.json'), 'utf8'))
  check('project style file contains no session identity', styleFile.mode === 'lite' && !Object.hasOwn(styleFile, 'sessionId'))

  const skills = await request('/airules/skills', { query: scoped() })
  check('native skill inventory and assignment preferences resolve project scope', skills.ok && rootKey(skills.projectRoot) === rootKey(primary.root) && !!skills.assignments?.context)
  const task = { ...scoped(), expectedProjectRoot: selection.projectRoot, expectedExecutorRevision: selection.execution.revision, action: 'task-context', taskType: 'testing', revision: skills.assignments?.context?.revision }
  check('project task-type preference saves through real skills HTTP and CAS', (await request('/airules/skills', { body: task, token: skills.csrfToken })).ok)
  const peerSkills = await request('/airules/skills', { query: scoped(peer.id) }), foreignSkills = await request('/airules/skills', { query: scoped(foreign.id, foreignId) })
  check('two chats share project task preference while another project inherits auto', peerSkills.ok && peerSkills.assignments?.context?.selectedTaskType === 'testing' && foreignSkills.ok && foreignSkills.assignments?.context?.selectedTaskType === 'auto')
  const taskFile = JSON.parse(await readFile(join(primary.root, '.dsh/skill-context.json'), 'utf8'))
  check('project task-type file contains no session identity', taskFile.taskType === 'testing' && !Object.hasOwn(taskFile, 'sessionId'))

  const beforeStyle = await readFile(join(primary.root, '.dsh/response-style.json')), beforeTask = await readFile(join(primary.root, '.dsh/skill-context.json'))
  setSandboxMode(primary.agent.session, 'read-only'); setSandboxMode(peer.agent.session, 'danger-full-access')
  try {
    const readOnly = await request('/airules/projects', { query: baseQuery })
    check('the selected read-only executor is not replaced by a full-access peer', readOnly.execution?.sessionId === primary.id && readOnly.execution.writable === false)
    const protectedStyle = { ...saveStyle, revision: peerStyle.revision, expectedExecutorRevision: readOnly.execution.revision, mode: 'off' }
    const deniedStyle = await request('/airules/general-tools', { body: protectedStyle, token: style.csrfToken })
    check('read-only project style mutation cannot fall back to full-access peer', deniedStyle.ok === false && ['WORKSPACE_WRITE_REQUIRED', 'PROJECT_WRITE_REQUIRED'].includes(deniedStyle.error))
    const deniedTask = await request('/airules/skills', { token: skills.csrfToken, body: { ...task, taskType: 'auto', revision: peerSkills.assignments.context.revision, expectedExecutorRevision: readOnly.execution.revision } })
    check('read-only task-type mutation cannot fall back to full-access peer', deniedTask.ok === false && ['WRITE_REQUIRED', 'PROJECT_WRITE_REQUIRED'].includes(deniedTask.error))
    check('a foreign native workspace member cannot impersonate this project executor', (await request('/airules/general-tools', { query: scoped(foreign.id) })).error === 'PROJECT_EXECUTOR_MISMATCH')
    check('a stale executor lease refuses before mutation', (await request('/airules/general-tools', { token: style.csrfToken, body: { ...protectedStyle, expectedExecutorRevision: selection.execution.revision } })).error === 'PROJECT_EXECUTOR_STALE')
    check('a foreign expected project root refuses before mutation', (await request('/airules/general-tools', { token: style.csrfToken, body: { ...protectedStyle, expectedProjectRoot: foreign.root, expectedExecutorRevision: readOnly.execution.revision } })).error === 'PROJECT_SCOPE_CHANGED')
    check('denied writes preserve exact style and task preference bytes', beforeStyle.equals(await readFile(join(primary.root, '.dsh/response-style.json'))) && beforeTask.equals(await readFile(join(primary.root, '.dsh/skill-context.json'))))
  } finally { setSandboxMode(primary.agent.session, 'workspace-write'); setSandboxMode(peer.agent.session, 'workspace-write') }
  report.projectBindings = { nativeWorkspaces: 2, leadChatsInPrimaryProject: 2, projectPreferenceWrites: ['response-style', 'skill-context'], sharedProjectPreferences: true, nativeAdmissionAndLease: true, realBackendWrites: 0, modelRequests: 0, officeProcesses: 0, realDeployments: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runReleaseProbe({ ...parseArguments(process.argv.slice(2)), extraAcceptance: projectBindingsAcceptance }))); process.exit(0) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', code: error.message, reportPath: error.reportPath ?? null })); process.exit(1) }
}
