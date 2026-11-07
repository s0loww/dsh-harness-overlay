import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { discoverCapabilities } from '../src/onec-capability-workflows/lib/core.js'
import { createInvestigationStore } from '../src/onec-capability-workflows/lib/store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'onec-capabilities-')), home = join(root, 'home'), project = join(root, 'project'), other = join(root, 'other')
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of [home, project, other]) await mkdir(path)
  await writeFile(join(project, 'module.bsl'), 'Процедура Тест()\nКонецПроцедуры\n')
  return { root, home, project, other, store: createInvestigationStore(home) }
}

test('discovery returns actual scoped schemas without assuming a facade, method arguments or health', () => {
  const source = [{ name: 'mcp__project__find_code', description: 'BSL code search for a selected project', parameters: { project: { type: 'string' }, q: { type: 'string' } } },
    { name: 'direct_metadata', description: 'Metadata dossier', parameters: { object: { type: 'string' } } }, { name: 'build_artifact', description: 'Build output', parameters: {} }]
  const result = discoverCapabilities(source, { category: 'code', query: 'BSL' })
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].name, source[0].name)
  assert.deepEqual(result.candidates[0].parameters, source[0].parameters)
  result.candidates[0].parameters.q.type = 'number'; assert.equal(source[0].parameters.q.type, 'string')
  assert.equal(result.health, 'not-probed'); assert.equal(result.execution, 'not-performed')
  assert.equal(discoverCapabilities(source, { category: 'qa' }).candidates.length, 0)
  assert.throws(() => discoverCapabilities(source, { category: 'constructor' }), /CAPABILITY_QUERY_INVALID/)
  assert.throws(() => discoverCapabilities(source, { limit: 26 }), /CAPABILITY_QUERY_INVALID/)
})

test('catalogue pagination and oversized schemas are explicit instead of guessed or silently partial', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${index}`, description: 'metadata', parameters: { value: 'x'.repeat(40000) } }))
  const result = discoverCapabilities(rows, { category: 'metadata', limit: 2 })
  assert.equal(result.matchedCount, 30); assert.equal(result.nextOffset, 2)
  assert.ok(result.candidates.every(row => row.schemaOmitted && !Object.hasOwn(row, 'parameters')))
  assert.deepEqual(discoverCapabilities([], {}).candidates, [])
})

test('investigation records selected artifact hashes and stale evidence without changing project source', async t => {
  const f = await fixture(t), source = await readFile(join(f.project, 'module.bsl'))
  const opened = await f.store.open(f.project, { title: 'Investigate a branch', hypotheses: ['Condition differs in runtime'], paths: ['module.bsl'] })
  assert.equal(opened.sourceFresh, true); assert.equal(opened.certified, false); assert.equal(opened.execution, 'not-performed')
  assert.deepEqual(await readFile(join(f.project, 'module.bsl')), source)
  await writeFile(join(f.project, 'report.json'), '{"observed":true}')
  const evidence = await f.store.evidence(f.project, { caseId: opened.id, expectedRevision: opened.revision, kind: 'report', text: 'Observation from the isolated fixture', paths: ['report.json'] })
  await assert.rejects(f.store.close(f.project, { caseId: opened.id, expectedRevision: opened.revision, outcome: 'unresolved' }), /INVESTIGATION_STALE/)
  await writeFile(join(f.project, 'module.bsl'), 'Changed source')
  await writeFile(join(f.project, 'report.json'), '{"observed":false}')
  const stale = await f.store.status(f.project, opened.id)
  assert.equal(stale.sourceFresh, false); assert.equal(stale.artifactsFresh, false)
  assert.ok(stale.freshness.some(row => row.origin !== 'source' && row.state === 'changed'))
  const closed = await f.store.close(f.project, { caseId: opened.id, expectedRevision: evidence.revision, outcome: 'reported-resolved' })
  assert.equal(closed.outcome, 'reported-resolved'); assert.equal(closed.certified, false); assert.equal(closed.sourceFresh, false)
  assert.equal((await f.store.list(f.project)).cases.length, 1)
  await assert.rejects(f.store.evidence(f.project, { caseId: opened.id, expectedRevision: closed.revision, kind: 'cleanup', text: 'Late note', paths: [] }), /INVESTIGATION_CLOSED/)
})

test('project identity, unsupported paths and no-observation resolution are enforced', async t => {
  const f = await fixture(t), opened = await f.store.open(f.project, { title: 'Case', paths: [] })
  await assert.rejects(f.store.status(f.other, opened.id), { code: 'ENOENT' })
  await assert.rejects(f.store.close(f.project, { caseId: opened.id, expectedRevision: opened.revision, outcome: 'reported-resolved' }), /INVESTIGATION_EVIDENCE_REQUIRED/)
  for (const path of ['../outside.txt', '.env', '.env.local', 'src/../module.bsl', 'module.bsl/child', 'C:/Windows/file']) {
    await assert.rejects(f.store.open(f.project, { title: 'Denied', paths: [path] }))
  }
  await assert.rejects(f.store.open(f.project, { title: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456789', paths: [] }), /INVESTIGATION_TEXT_INVALID/)
  assert.deepEqual(await readdir(f.other), [])
})

test('links and hard-linked artifacts are rejected; files named as scripts are only hashed', async t => {
  const f = await fixture(t)
  await writeFile(join(f.project, 'do-not-run.ps1'), 'throw "This script must never execute"')
  const result = await f.store.open(f.project, { title: 'Hash script', paths: ['do-not-run.ps1'] })
  assert.equal(result.sourceArtifacts[0].bytes, Buffer.byteLength('throw "This script must never execute"'))
  await link(join(f.project, 'module.bsl'), join(f.project, 'linked.bsl'))
  await assert.rejects(f.store.open(f.project, { title: 'Linked', paths: ['linked.bsl'] }), /INVESTIGATION_PATH_REJECTED|INVESTIGATION_ARTIFACT_INVALID/)
  try { await symlink(f.other, join(f.project, 'junction'), 'junction') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
  await writeFile(join(f.other, 'outside.bsl'), 'outside')
  await assert.rejects(f.store.open(f.project, { title: 'Outside', paths: ['junction/outside.bsl'] }), /INVESTIGATION_PATH_REJECTED/)
})

test('native composition plugin registers only discovery/notebook tools and retains session/permission scope', async t => {
  const f = await fixture(t), packageRoot = join(f.root, 'package')
  await cp(fileURLToPath(new URL('../src/onec-capability-workflows/', import.meta.url)), packageRoot, { recursive: true })
  const file = join(packageRoot, 'lib/tools.js'), nativeTools = new URL('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js', import.meta.url).href
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll("'@deepseek-ai/dsh-tools'", JSON.stringify(nativeTools)))
  const module = await import(pathToFileURL(file)), root = new Context(), definitions = [], sections = []
  class Tools extends Service { constructor(ctx) { super(ctx, 'tools') } register(tool) { definitions.push(tool) } schemas() { return [{ name: 'actual_bsl', description: 'BSL code search', parameters: {} }] } }
  class Prompt extends Service { constructor(ctx) { super(ctx, 'systemPrompt') } section(value) { sections.push(value) } }
  class Policy extends Service { constructor(ctx) { super(ctx, 'sandboxPolicy') } resolve({ session }) { return { mode: 'read-only', workspaceRoot: session.header.cwd } } }
  class Presets extends Service { constructor(ctx) { super(ctx, 'agentPresets') } composedPreset(agent) { return agent.preset } }
  class Capabilities extends Service { constructor(ctx) { super(ctx, 'airulesOnecCapabilities'); this.investigations = f.store } }
  new Tools(root); new Prompt(root); new Policy(root); new Presets(root); new Capabilities(root)
  const fiber = root.plugin(module); await fiber.await(); t.after(() => fiber.dispose())
  assert.deepEqual(definitions.map(row => row.name).sort(), ['airules_capabilities', 'airules_debug_case'])
  assert.equal(sections.length, 1)
  const agent = { ctx: { preset: '1c-airules' }, session: { id: 'fixture', header: { cwd: f.project } } }, exec = { agent, signal: new AbortController().signal }
  const found = await definitions.find(row => row.name === 'airules_capabilities').execute({ category: 'code' }, exec)
  assert.equal(found.candidates[0].name, 'actual_bsl')
  const opened = await definitions.find(row => row.name === 'airules_debug_case').execute({ action: 'open', title: 'Read-only metadata note', paths: ['module.bsl'] }, exec)
  assert.equal(opened.execution, 'not-performed'); assert.deepEqual(await readdir(f.project), ['module.bsl'])
  await assert.rejects(definitions.find(row => row.name === 'airules_debug_case').execute({ action: 'list' }, { ...exec, agent: { ...agent, ctx: { preset: 'python-airules' } } }), /ONEC_ACTIVE_SESSION_REQUIRED/)
})
