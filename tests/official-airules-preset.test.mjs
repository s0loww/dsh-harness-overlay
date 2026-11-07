import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AIRULES_TOOL_NAMES, registerProjectToolIsolation, resolveAirulesActivation } from '../src/airules-provider/activation.mjs'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRESET = join(ROOT, 'src', 'official-preset', 'cordis.patch.yml')
const STANDARD_PLUGIN_IDS = [
  'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
  'tool-jobs', 'tool-schedule', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'planning',
  'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'tool-plugin-manager', 'tool-plugin-market',
]

test('official preset is a complete Standard-derived 1c-airules composition with scoped policy', async () => {
  const source = await readFile(PRESET, 'utf8')
  assert.match(source, /name: '@deepseek-ai\/dsh-agent-preset'/u)
  assert.match(source, /\n        id: 1c-airules\n/u)
  assert.match(source, /\n        name: 1С\n/u)
  assert.match(source, /\n    default: 1c-airules\n/u)
  const ids = [...source.matchAll(/^          - id: ([^\r\n]+)/gmu)].map(match => match[1])
  assert.deepEqual(ids.filter(id => !['airules-policy', 'onec-lsp-actions'].includes(id)), STANDARD_PLUGIN_IDS)
  assert.equal(ids.filter(id => id === 'airules-policy').length, 1)
  assert.equal(ids.filter(id => id === 'onec-lsp-actions').length, 1)
  assert.match(source, /id: airules-policy\n            name: airules-dsh-provider\n            config:\n              compositionScoped: true/u)
  assert.match(source, /id: onec-lsp-actions\n            name: dsh-lsp-actions/u)
  assert.match(source, /id: airules-onec-bsl-editor\n      name: dsh-bsl-editor/u)
  assert.doesNotMatch(source, /1c-full|onec:contract|mcp-servers|https?:\/\//iu)
})

test('activation is composition-local or fails closed on an unavailable project preset API', () => {
  const composition = resolveAirulesActivation({}, { compositionScoped: true })
  assert.equal(composition.mode, 'composition')
  assert.equal(composition.isEnabled({}), true)
  assert.throws(() => resolveAirulesActivation({}, {}), /PROJECT_PRESETS_REQUIRED/u)
  const project = resolveAirulesActivation({ get: () => ({ featuresFor: target => ({ preset: target?.preset }) }) }, {})
  assert.equal(project.mode, 'project-preset')
  assert.equal(project.isEnabled({ preset: 'general' }), false)
  assert.equal(project.isEnabled({ preset: '1c-airules' }), true)
  assert.equal(project.isEnabled(null), false)
})

test('project-preset mode guards and hides every airules tool outside 1c-airules', () => {
  let guard
  let created
  let denied
  const ctx = {
    tools: { guard(value) { guard = value; return () => {} } },
    on(name, value) { assert.equal(name, 'agent/created'); created = value; return () => {} },
    effect(factory) { assert.equal(typeof factory(), 'function') },
  }
  const isEnabled = agent => agent?.preset === '1c-airules'
  registerProjectToolIsolation(ctx, isEnabled)
  assert.equal(guard({ name: 'airules_rule', agent: { preset: 'general' } }), 'Инструмент доступен только в пресете 1c-airules.')
  assert.equal(guard({ name: 'airules_rule', agent: { preset: '1c-airules' } }), undefined)
  assert.equal(guard({ name: 'unrelated', agent: { preset: 'general' } }), undefined)
  created({ agent: { preset: 'general', ctx: { tools: { restrict(value) { denied = value; return () => {} } } } } })
  assert.deepEqual(denied, { deny: [...AIRULES_TOOL_NAMES] })
  denied = undefined
  created({ agent: { preset: '1c-airules', ctx: { tools: { restrict() { throw new Error('must not restrict') } } } } })
  assert.equal(denied, undefined)
  assert.throws(() => registerProjectToolIsolation({}, isEnabled), /ISOLATION_API_REQUIRED/u)
})

async function rulepackFixture(root, mcp = { mode: 'logical-only', logical_roles: ['code-facade'] }) {
  const path = join(root, 'rulepack')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'manifest.json'), JSON.stringify({
    package: { id: 'airules-dsh-rulepack', version: 'test.dev' },
    source: { dirty: true }, counts: { files: 0, rules: 0, roles: 0, skills: 0 }, mcp,
  }), 'utf8')
  return path
}

test('stages an official policy artifact without MCP bindings or Full canon', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'airules-official-policy-'))
  try {
    const rulepack = await rulepackFixture(temp)
    const output = join(temp, 'airules-official-policy-test.dev')
    const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.dev' })
    assert.equal(manifest.artifact.version, 'test.dev')
    assert.equal(manifest.target.kind, 'official-desktop')
    assert.equal(manifest.preset.id, '1c-airules')
    assert.equal(manifest.preset.label, '1С')
    assert.equal(manifest.preset.extensionPoint, '@deepseek-ai/dsh-agent-preset')
    assert.equal(manifest.preset.scope, 'composition')
    assert.deepEqual(manifest.preset.base, {
      id: 'standard', hostVersion: '0.2.1-rc.5',
      sourceSha256: '0d398d2a6872a73a106cb3bd19303ecccf1637e1fcad4d0bf9d8a72d2c2c68f5',
    })
    assert.deepEqual(manifest.separation, { mcpBindings: 'excluded', credentials: 'excluded', runtimeState: 'excluded', olegFullCanon: 'excluded' })
    assert.equal(manifest.operations.filter(row => row.kind === 'package-copy').length, 8)
    assert.equal(manifest.integrations.openspec.package, 'dsh-openspec-workflow')
    assert.equal(manifest.integrations.openspec.cliVersion, '1.12.0')
    assert.equal(manifest.integrations.openspec.atlassian, false)
    assert.equal(manifest.operations.at(-1).kind, 'cordis-merge')
    assert.equal(manifest.onecMechanics.scope, '1c-airules-only')
    assert.equal(manifest.onecMechanics.lspServer.bundled, false)
    assert.equal(manifest.onecMechanics.projectWizard.included, false)
    assert.ok(manifest.operations.some(row => row.target === 'node_modules/dsh-bsl-editor'))
    assert.ok(manifest.operations.some(row => row.target === 'node_modules/dsh-lsp-actions'))
    const fragment = await readFile(join(output, 'cordis.policy.fragment.yml'), 'utf8')
    assert.match(fragment, /compositionScoped: true/u)
    assert.doesNotMatch(fragment, /https?:\/\/|\b(?:endpoint|headers|api[_-]?key|token|secret)\s*:/iu)
    const editor = await readFile(join(output, 'payload', 'packages', 'dsh-bsl-editor', 'lib', 'index.js'), 'utf8')
    assert.doesNotMatch(editor, /dsh-1c-bundle\/project-root/u)
    assert.match(editor, /header\.agentPreset !== "1c-airules"/u)
    assert.match(editor, /BSL_PRESET_REQUIRED/u)
    assert.match(await readFile(join(output, 'payload', 'packages', 'dsh-bsl-editor', 'lib', 'airules-project-root.js'), 'utf8'), /findSessionProjectRoot/u)
    const editorClient = await readFile(join(output, 'payload', 'packages', 'dsh-bsl-editor', 'lib', 'client.js'), 'utf8')
    assert.doesNotMatch(editorClient, /\/onec\/bsl-intelligence/u)
    assert.match(editorClient, /diagnostics\/hover are provided by composition-scoped dsh-lsp-actions/u)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('official policy staging rejects connection-bearing rulepack metadata', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'airules-official-policy-bad-'))
  try {
    const rulepack = await rulepackFixture(temp, { mode: 'logical-only', logical_roles: [], endpoint: 'https://invalid.example' })
    await assert.rejects(stageOfficialPolicy({ rulepack, output: join(temp, 'airules-official-policy-test.bad'), artifactVersion: 'test.bad' }), /MCP_NOT_LOGICAL_ONLY/u)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('policy staging without OpenSpec omits its package, integration declaration and Cordis mount', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'airules-policy-no-openspec-'))
  try {
    const rulepack = await rulepackFixture(temp)
    const output = join(temp, 'airules-official-policy-test.no-openspec')
    const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.no-openspec', includeOpenSpec: false })
    assert.equal(manifest.operations.filter(row => row.kind === 'package-copy').length, 7)
    assert.equal(manifest.integrations, undefined)
    assert.doesNotMatch(await readFile(join(output, 'cordis.policy.fragment.yml'), 'utf8'), /airules-openspec|dsh-openspec-workflow/u)
    await assert.rejects(readFile(join(output, 'payload/packages/dsh-openspec-workflow/package.json')), /ENOENT/u)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('policy artifact version is required, path-bound and immutable across different inputs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'airules-official-policy-version-'))
  try {
    const rulepack = await rulepackFixture(temp)
    const output = join(temp, 'airules-official-policy-test.immutable')
    await assert.rejects(stageOfficialPolicy({ rulepack, output }), /ARTIFACT_VERSION_REQUIRED/u)
    await assert.rejects(stageOfficialPolicy({ rulepack, output: join(temp, 'different-name'), artifactVersion: 'test.immutable' }), /OUTPUT_VERSION_MISMATCH/u)
    await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.immutable' })
    const manifestPath = join(rulepack, 'manifest.json')
    const changed = JSON.parse(await readFile(manifestPath, 'utf8'))
    changed.counts.files = 99
    await writeFile(manifestPath, JSON.stringify(changed), 'utf8')
    await assert.rejects(stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.immutable' }), /OUTPUT_EXISTS/u)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
