import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { createPresets } from '../src/domain-presets/composition.mjs'
import { groupSections } from '../src/settings-shell/navigation.mjs'

const CANONICAL = 'D:/AI_Projects/project_rules'
const RUNTIME_ROOTS = ['core/tools/workflow', 'overlays/1c/tools/workflow-onec', 'overlays/1c/tools/workflow-runners']
const hash = data => createHash('sha256').update(data).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))

async function fixture(t, withCanonical = false) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-staging-')), rulepack = join(root, 'rulepack')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(rulepack)
  await writeFile(join(rulepack, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'fixture' }, source: { dirty: true }, counts: {}, mcp: { mode: 'logical-only', logical_roles: [] } }))
  const canonical = join(root, 'canonical')
  if (withCanonical) for (const rel of [...RUNTIME_ROOTS, 'overlays/1c/tools/agent-1c']) {
    await mkdir(join(canonical, rel, '..'), { recursive: true })
    await cp(join(CANONICAL, rel), join(canonical, rel), { recursive: true })
  }
  return { root, rulepack, canonical, output: join(root, 'airules-official-policy-workflows.test'),
    stage(extra = {}) { return stageOfficialPolicy({ rulepack, output: this.output, artifactVersion: 'workflows.test', includeOpenSpec: false, ...extra }) } }
}

test('workflows are absent by default, preserving complete default domain compositions', async t => {
  const f = await fixture(t)
  const manifest = await f.stage()
  assert.equal(manifest.integrations?.workflows, undefined)
  assert.equal(manifest.operations.some(row => row.target === 'node_modules/airules-dsh-workflows'), false)
  const fragment = await readFile(join(f.output, 'cordis.policy.fragment.yml'), 'utf8')
  assert.doesNotMatch(fragment, /airules-workflows|airules-workflow-tools|airules-dsh-workflows/u)
  assert.equal(createPresets().every(preset => !preset.plugins.some(row => row.id === 'airules-workflow-tools')), true)
})

test('workflows require an explicit canonical root and strict boolean option', async t => {
  const f = await fixture(t)
  await assert.rejects(f.stage({ includeWorkflows: true }), /CANONICAL_WORKFLOW_RULES_REQUIRED/u)
  await assert.rejects(f.stage({ includeWorkflows: true, workflowRulesRoot: 'relative' }), /CANONICAL_WORKFLOW_RULES_REQUIRED/u)
  await assert.rejects(f.stage({ includeWorkflows: 'false' }), /BOOLEAN_OPTION_REQUIRED/u)
  await assert.rejects(f.stage({ includeWorkflows: true, workflowRulesRoot: f.canonical }), /CANONICAL_WORKFLOW_RULES_REQUIRED/u)
  assert.throws(() => createPresets({ workflows: 'false' }), /WORKFLOWS_BOOLEAN_REQUIRED/u)
})

test('staged runtime preserves canonical imports, pins reviewed runner closure and mounts all three scoped presets', async t => {
  const f = await fixture(t, true)
  const core = join(f.canonical, 'core/tools/workflow')
  for (const rel of ['.env.local', 'unsafe.env', 'node_modules/private.json', 'tests/should-not-ship.json']) {
    await mkdir(join(core, rel, '..'), { recursive: true }); await writeFile(join(core, rel), 'not-in-artifact')
  }
  const manifest = await f.stage({ includeWorkflows: true, workflowRulesRoot: f.canonical, includeDomainPresets: true, domainRulesRoot: join(CANONICAL, 'overlays') })
  const integration = manifest.integrations.workflows
  assert.equal(integration.package, 'airules-dsh-workflows'); assert.equal(integration.nativeSandbox, true)
  assert.equal(integration.deployEnabled, false); assert.equal(integration.policyOwner, 'project_rules')
  assert.equal(integration.provenance.source, 'project_rules'); assert.equal(integration.provenance.roots.length, 3)
  assert.doesNotMatch(JSON.stringify(integration), /[A-Za-z]:[\\/]|not-in-artifact/u)
  const pkg = join(f.output, 'payload/packages/airules-dsh-workflows')
  for (const root of integration.provenance.roots) {
    assert.equal(root.target, `runtime/${root.source}`)
    for (const [rel, metadata] of Object.entries(root.inventory)) {
      const bytes = await readFile(join(pkg, root.target, rel))
      assert.equal(hash(bytes), metadata.sha256)
      assert.equal(bytes.length, metadata.bytes)
      assert.doesNotMatch(rel, /(?:^|\/)(?:tests?|node_modules)(?:\/|$)|\.env/u)
    }
  }
  const modules = await import(pathToFileURL(join(pkg, 'lib/runtime.js')))
  const runtime = await modules.loadRuntime()
  assert.equal(typeof runtime.WorkflowHost, 'function'); assert.equal(typeof runtime.inspectRunnerBinding, 'function')
  const lock = await json(join(pkg, 'runtime/reviewed-runners.json'))
  assert.equal(lock.policyOwner, 'project_rules')
  assert.deepEqual(lock.operations, ['doctor', 'analyze']); assert.equal(lock.deployEnabled, false)
  assert.equal(lock.codeClosure.kind, 'agent-1c')
  assert.deepEqual(lock.reviewedDigests, [runtime.digest(lock.codeClosure)])
  assert.equal(lock.reviewedDigests[0], integration.reviewedRunners.digest)
  assert.ok(lock.codeClosure.files.some(file => file.path === 'tools/agent-1c/lib/1c-guard.ps1'))
  assert.ok(lock.codeClosure.files.some(file => file.path === 'tools/agent-1c/toolchain.lock.json'))
  for (const file of lock.codeClosure.files) {
    assert.match(file.path, /^tools\/agent-1c\/(?:.*\.(?:ps1|psm1)|toolchain\.lock\.json)$/u)
    const bundledPath = `bundled/agent-1c/${file.path.slice('tools/agent-1c/'.length)}`
    const bytes = await readFile(join(pkg, bundledPath))
    assert.equal(bytes.length, file.bytes)
    assert.equal(hash(bytes), file.digest)
    assert.deepEqual(manifest.files[`payload/packages/airules-dsh-workflows/${bundledPath}`], { bytes: file.bytes, sha256: file.digest })
  }
  const fragment = await readFile(join(f.output, 'cordis.policy.fragment.yml'), 'utf8')
  assert.match(fragment, /id: airules-workflows\n      name: airules-dsh-workflows/u)
  assert.match(fragment, /id: airules-workflow-tools\n            name: airules-dsh-workflows\/tools/u)
  assert.match(fragment, /id: airules-domain-presets\n      name: airules-dsh-domain-presets\n      config:\n        workflows: true/u)
  for (const preset of createPresets({ workflows: true })) assert.equal(preset.plugins.filter(row => row.id === 'airules-workflow-tools').length, 1)
  const entries = await readdir(join(pkg, 'runtime/core/tools/workflow'))
  assert.equal(entries.includes('test'), false); assert.equal(entries.includes('tests'), false); assert.equal(entries.includes('.env.local'), false)
  assert.equal(groupSections([{ id: 'airules-workflows', label: 'unknown' }])[0].label, 'Инструменты и MCP')
})

test('bundled runner contains exactly reviewed code and lock, excluding private, test and report artifacts', async t => {
  const f = await fixture(t, true)
  const runner = join(f.canonical, 'overlays/1c/tools/agent-1c')
  for (const path of ['.env.local', 'unsafe.env', 'tests/private-test.ps1', 'test/fixture.psm1',
    'node_modules/private.ps1', 'reports/result.json', 'agent-1c.private.json']) {
    await mkdir(join(runner, path, '..'), { recursive: true })
    await writeFile(join(runner, path), 'PRIVATE_RUNNER_ARTIFACT_MUST_NOT_SHIP')
  }
  const manifest = await f.stage({ includeWorkflows: true, workflowRulesRoot: f.canonical })
  const packageRoot = join(f.output, 'payload/packages/airules-dsh-workflows')
  const lock = await json(join(packageRoot, 'runtime/reviewed-runners.json'))
  const expected = lock.codeClosure.files.map(row => row.path.slice('tools/agent-1c/'.length)).sort()
  async function inventory(root, prefix = '') {
    const paths = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(...await inventory(join(root, entry.name), `${prefix}${entry.name}/`))
      else paths.push(`${prefix}${entry.name}`)
    }
    return paths.sort()
  }
  const bundled = join(packageRoot, 'bundled/agent-1c')
  assert.deepEqual(await inventory(bundled), expected)
  assert.ok(expected.includes('agent-1c.ps1'))
  assert.ok(expected.includes('lib/1c-guard.ps1'))
  assert.ok(expected.includes('toolchain.lock.json'))
  assert.doesNotMatch(JSON.stringify(expected), /(?:tests?|node_modules|reports|private|\.env)/u)
  for (const row of lock.codeClosure.files) {
    const bytes = await readFile(join(bundled, row.path.slice('tools/agent-1c/'.length)))
    assert.equal(hash(bytes), row.digest)
    assert.equal(bytes.length, row.bytes)
  }
  assert.equal(manifest.integrations.workflows.deployEnabled, false)
  assert.deepEqual(lock.operations, ['doctor', 'analyze'])
})

test('reparse entries in canonical runtime are rejected instead of copied', async t => {
  const f = await fixture(t, true)
  const outside = join(f.root, 'external.mjs'); await writeFile(outside, 'export default 1')
  await symlink(outside, join(f.canonical, 'core/tools/workflow/lib/linked.mjs'))
  await assert.rejects(f.stage({ includeWorkflows: true, workflowRulesRoot: f.canonical }), /WORKFLOW_REPARSE_FORBIDDEN/u)
})
