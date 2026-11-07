import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'airules-openspec-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'plugin')
  cpSync(resolve('src/openspec-workflow'), pkg, { recursive: true })
  for (const [name, code] of Object.entries({
    '@fission-ai/openspec': 'export {}',
    '@j1nn0/agent-handoff': 'export const createHandoff = x => x',
    '@j1nn0/agent-progress': 'export const judgeProgress = x => ({recordedMilestones:x.current.milestones,newMilestones:x.current.milestones,withdrawnMilestones:[]})',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = x => x',
    '@deepseek-ai/dsh-skill': 'export const isUserInvocable = () => true; export const renderSkillContent = x => x.content',
  })) {
    const dir = join(pkg, 'node_modules', name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', version: '1.12.0', exports: './lib/index.js' }))
    writeFileSync(join(dir, 'lib/index.js'), code)
  }
  const project = join(root, 'project')
  mkdirSync(join(project, 'openspec/specs/demo'), { recursive: true })
  writeFileSync(join(project, 'openspec/specs/demo/spec.md'), '# Demo\n')
  const runtime = await import(pathToFileURL(join(pkg, 'lib/runtime.js')))
  const commands = await import(pathToFileURL(join(pkg, 'lib/openspec-commands.js')))
  const workspace = await import(pathToFileURL(join(pkg, 'lib/openspec-workspace.js')))
  const agent = { session: { id: 'session-1', header: { id: 'session-1', cwd: project, agentPreset: '1c-airules' } }, status: 'idle', followup() {} }
  return { root, pkg, project, runtime, commands, workspace, agent }
}

test('OpenSpec gates exact preset, explicit opt-out and malformed project bindings', async t => {
  const f = await fixture(t)
  assert.equal(f.runtime.openSpecEnabled({}, f.agent), true)
  assert.equal(f.runtime.openSpecEnabled({}, { session: { header: { cwd: f.project, agentPreset: 'standard' } } }), false)
  assert.equal(f.runtime.openSpecEnabled({}, { cwd: f.project }), false)
  const config = join(f.project, '.ai-rules.json')
  writeFileSync(config, JSON.stringify({ integrations: { openspec: { detected: true } } }))
  assert.equal(f.runtime.openSpecEnabled({}, f.agent), true)
  writeFileSync(config, JSON.stringify({ integrations: { openspec: false } }))
  assert.equal(f.runtime.openSpecEnabled({}, f.agent), false)
  writeFileSync(config, '{broken')
  assert.equal(f.runtime.openSpecEnabled({}, f.agent), false)
})

test('native pending plan selections and unknown mode fail closed for mutations', async t => {
  const f = await fixture(t)
  const ctx = state => ({ get: name => name === 'planMode' ? { get: () => state } : undefined })
  assert.equal(f.runtime.agentEffectiveMode(f.agent, ctx({ active: false, pending: true })), 'plan')
  assert.equal(f.runtime.agentEffectiveMode(f.agent, ctx({ active: true, pending: false })), 'build')
  assert.equal(f.runtime.agentEffectiveMode(f.agent, {}), 'ask')
  assert.throws(() => f.runtime.requireBuild({}, f.agent), /OPENSPEC_BUILD_REQUIRED/)
  assert.throws(() => f.runtime.requireBuild(ctx({ active: true }), f.agent), /OPENSPEC_BUILD_REQUIRED/)
  assert.throws(() => f.runtime.requireBuild(ctx({ active: false }), f.agent), /OPENSPEC_WRITE_ACCESS_REQUIRED/)
})

test('slash workflow dispatches canonical skills and the bundled CLI without supplier provider', async t => {
  const f = await fixture(t)
  const handlers = new Map(), loaded = [], messages = []
  f.agent.followup = value => messages.push(value)
  const ctx = { get: name => name === 'planMode' ? { get: () => ({ active: false }) } : undefined,
    commands: { register: command => handlers.set(command.name, command) },
    skills: { get: async name => { loaded.push(name); return { content: 'canonical instructions' } } } }
  f.commands.registerOpenSpecCommands(ctx)
  for (const name of ['propose', 'update', 'sync', 'archive', 'explore', 'apply']) {
    const result = await handlers.get('opsx-' + name).handler({ agent: f.agent, rawInput: 'demo' })
    assert.equal(result.kind, 'success')
    assert.equal(loaded.at(-1), f.commands.CANONICAL_SKILLS[name])
  }
  assert.match(messages[0].content[0].text, /openspec\.js/)
  assert.ok(messages[0].content[0].text.includes(join(f.pkg, 'node_modules')))
})

test('workspace rejects traversal and stale revisions while preserving external edits', async t => {
  const f = await fixture(t)
  const ws = new f.workspace.OpenSpecWorkspace(f.project)
  assert.throws(() => ws.read('../outside.md'), /OPENSPEC_PATH_REJECTED/)
  const page = ws.read('specs/demo/spec.md')
  writeFileSync(join(f.project, 'openspec/specs/demo/spec.md'), '# External\n')
  assert.throws(() => ws.write({ path: page.path, content: '# Mine\n', revision: page.revision }), /REVISION_CONFLICT/)
  assert.equal(readFileSync(join(f.project, 'openspec/specs/demo/spec.md'), 'utf8'), '# External\n')
  const current = ws.read(page.path)
  const saved = ws.write({ path: page.path, content: '# Accepted\n', revision: current.revision })
  assert.equal(saved.text, '# Accepted\n')
  const external = join(f.root, 'outside')
  mkdirSync(external)
  writeFileSync(join(external, 'spec.md'), '# Outside\n')
  symlinkSync(external, join(f.project, 'openspec/specs/escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => ws.read('specs/escape/spec.md'), /OPENSPEC_REPARSE_REJECTED|OPENSPEC_PATH_REJECTED/)
})

test('HTTP routes require selected session, CSRF and native build mode before workspace writes', async t => {
  const f = await fixture(t)
  const routes = new Map()
  let planning = true
  let fileMode = 'workspace-write'
  const ctx = {
    agents: { list: () => [], get: id => id === f.agent.session.id ? f.agent : undefined },
    sessions: { get: id => id === f.agent.session.id ? f.agent.session : undefined },
    systemPrompt: { context: () => () => {} }, on: () => () => {},
    get(name) {
      if (name === 'planMode') return { get: () => ({ active: planning }) }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: fileMode, workspaceRoot: f.project }) }
      return this[name]
    },
    inject(_names, callback) {
      return callback({ get: name => name === 'connection' ? { requestRejection: () => undefined } : undefined,
        effect: fn => fn(), webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } } })
    },
  }
  f.workspace.apply(ctx, { workspacePath: f.project })
  async function call(path, method, body, token) {
    const request = { method, url: path, headers: { 'x-dsh-csrf': token }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const response = { setHeader() {}, end(text) { this.payload = JSON.parse(text) } }
    await routes.get(path.split('?')[0])(request, response)
    return response
  }
  const noSession = await call('/onec/openspec', 'GET')
  assert.equal(noSession.payload.enabled, false)
  const opened = await call('/onec/openspec?sessionId=session-1', 'GET')
  assert.equal(opened.payload.enabled, true, JSON.stringify(opened.payload))
  const token = opened.payload.csrfToken
  const page = new f.workspace.OpenSpecWorkspace(f.project).read('specs/demo/spec.md')
  const input = { sessionId: 'session-1', action: 'write', path: page.path, revision: page.revision, content: '# Changed\n' }
  assert.equal((await call('/onec/openspec/action', 'POST', input)).statusCode, 403)
  const denied = await call('/onec/openspec/action', 'POST', input, token)
  assert.equal(denied.payload.error, 'OPENSPEC_BUILD_REQUIRED')
  assert.equal(readFileSync(join(f.project, 'openspec/specs/demo/spec.md'), 'utf8'), '# Demo\n')
  planning = false
  fileMode = 'read-only'
  assert.equal((await call('/onec/openspec/action', 'POST', input, token)).payload.error, 'OPENSPEC_WRITE_ACCESS_REQUIRED')
  fileMode = 'workspace-write'
  const changed = await call('/onec/openspec/action', 'POST', input, token)
  assert.equal(changed.payload.ok, true)
  const unknown = await call('/onec/openspec?sessionId=unknown', 'GET')
  assert.equal(unknown.statusCode, 400)
  ctx.sessionPersistence = { stat: async id => id === 'cold' ? { header: { id, cwd: f.project, agentPreset: '1c-airules' } } : undefined }
  const cold = await call('/onec/openspec?sessionId=cold', 'GET')
  assert.equal(cold.payload.enabled, true, JSON.stringify(cold.payload))
  assert.equal((await call('/onec/openspec/action', 'POST', { ...input, sessionId: 'cold' }, token)).payload.error, 'OPENSPEC_BUILD_REQUIRED')
})

test('cancelled tasks are excluded from milestones and handoff open items without counting as completed', async t => {
  const f = await fixture(t)
  const { HandoffProgressController } = await import(pathToFileURL(join(f.pkg, 'lib/handoff-progress.js')))
  const controller = new HandoffProgressController()
  const change = { id: 'demo', taskItems: [{ id: '1', status: 'done', evidence: 'junit' }, { id: '2', status: 'cancelled' }, { id: '3', status: 'pending' }] }
  const progress = controller.observeOpenSpec(change)
  assert.deepEqual(progress.recordedMilestones, ['demo:1'])
  const handoff = controller.createOpenSpecHandoff({ id: 'handoff', source: 'source', destination: 'next', goal: { objective: 'Goal', phase: 'active' }, change })
  assert.deepEqual(handoff.packet.openItems, ['demo:3'])
  assert.ok(handoff.packet.constraints.includes('cancelled-task:demo:2'))
  assert.equal(handoff.taskCompleted, false)
})
