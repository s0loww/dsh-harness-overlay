import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import yaml from '../var/asar-extract-rc5/dsh/node_modules/js-yaml/dist/js-yaml.mjs'
import { Context, Service } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { AgentPresetRegistry, entryListProblem } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js'
import { applyEntryPatches } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js'
import { FileSystemSkillProvider } from '../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js'
import { createPresets } from '../src/domain-presets/composition.mjs'
import { contract, listRules, readRule, skillsRoot } from '../src/domain-presets/core.mjs'
import { stageSharedSkills, SHARED_SKILLS } from '../scripts/stage-shared-skills.mjs'

const ROOT = new URL('../src/domain-presets/', import.meta.url)
const NATIVE = new URL('../var/asar-extract-rc5/dsh/node_modules/', import.meta.url)

test('workbench tools are optional, independently selected and scoped to custom compositions', () => {
  for (const preset of createPresets({ generalTools: true, documents: true })) {
    assert.equal(preset.plugins.filter(p => p.name === 'airules-dsh-general-tools/tools').length, 1)
    assert.equal(preset.plugins.filter(p => p.name === 'airules-dsh-document-workbench/tools').length, 1)
    assert.ok(!preset.plugins.some(p => p.name === 'airules-dsh-onec-capability-workflows/tools'))
    assert.equal(entryListProblem(preset.plugins), undefined)
  }
  assert.throws(() => createPresets({ documents: 'true' }), /WORKBENCH_BOOLEAN_REQUIRED/)
  assert.throws(() => createPresets({ generalTools: 1 }), /WORKBENCH_BOOLEAN_REQUIRED/)
  assert.ok(createPresets({ documents: true }).every(p => !p.plugins.some(v => v.name === 'airules-dsh-general-tools/tools')))
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airules-domains-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(fileURLToPath(ROOT), root, { recursive: true })
  const modules = { '@deepseek-ai/dsh-agent-preset': '@deepseek-ai/dsh-agent-preset/lib/index.js', '@deepseek-ai/schemastery': '@deepseek-ai/schemastery/lib/index.mjs', '@deepseek-ai/dsh-tools': '@deepseek-ai/dsh-tools/lib/index.js', '@deepseek-ai/dsh-skill-filesystem': '@deepseek-ai/dsh-skill-filesystem/lib/index.js' }
  // Adapt only import locations in the isolated fixture; implementations are
  // the actual pinned host modules, not stand-ins for their public contracts.
  for (const file of ['index.js', 'policy.js']) {
    let source = await readFile(join(root, file), 'utf8')
    for (const [name, target] of Object.entries(modules)) source = source.replaceAll(`'${name}'`, JSON.stringify(new URL(target, NATIVE).href))
    await writeFile(join(root, file), source)
  }
  return { root, host: await import(pathToFileURL(join(root, 'index.js'))), policy: await import(pathToFileURL(join(root, 'policy.js'))) }
}

test('both complete compositions match actual pinned Standard and retain native model/permission boundaries', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', ROOT), 'utf8'))
  const standardText = await readFile(new URL('@deepseek-ai/dsh-web-app/presets/standard.patch.yml', NATIVE), 'utf8')
  assert.equal(createHash('sha256').update(standardText).digest('hex'), manifest.nativeBase.sourceSha256)
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ platformExpression: value }) })
  const standard = yaml.load(standardText, { schema: yaml.DEFAULT_SCHEMA.extend([js]) })[0].insert[0].config.plugins
  for (const platform of ['win32', 'linux']) for (const preset of createPresets({ platform })) {
    assert.equal(entryListProblem(preset.plugins), undefined)
    const base = structuredClone(standard)
    for (const row of base) { if (row.id === 'tool-bash') row.disabled = platform === 'win32'; if (row.id === 'tool-pwsh') row.disabled = platform !== 'win32' }
    const actual = structuredClone(preset.plugins.filter(row => row.id !== 'domain-policy'))
    actual[0].config = base[0].config
    actual[1].config = base[1].config
    assert.deepEqual(actual, base)
    assert.equal(new Set(preset.plugins.map(row => row.id)).size, preset.plugins.length)
    assert.match(preset.plugins[1].config.instructionFileCandidates.join(','), /AGENTS.md/)
    assert.equal(preset.plugins.find(row => row.id === 'domain-policy').name, 'airules-dsh-domain-presets/policy')
    assert.doesNotMatch(JSON.stringify(preset), /rulepackRoot|onec-lsp|bsl|apiKey|credential|sandboxPolicy|permissionPreset|modelSelectionSettings":false/)
    assert.equal(preset.plugins.find(row => row.id === 'delegation').config[2].config.modelSelectionSettings, true)
  }
  assert.deepEqual(createPresets({ sysadmin: false }).map(row => row.id), ['python-airules'])
})

test('actual profile patch inserts one host mount and leaves native preset default alone', async () => {
  const fragment = yaml.load(await readFile(new URL('cordis.fragment.yml', ROOT), 'utf8'))
  const initial = [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }]
  const patched = applyEntryPatches(initial, fragment, message => { throw new Error(message) })
  assert.equal(patched.filter(row => row.id === 'airules-domain-presets').length, 1)
  assert.equal(patched.find(row => row.id === 'agent-preset-registry').config.default, 'standard')
  assert.doesNotMatch(JSON.stringify(fragment), /https?:|headers|credential|apiKey|endpoint/)
})

test('host mounts actual native AgentPreset children and native registry rejects duplicate preset IDs', async t => {
  const { host } = await fixture(t)
  const ctx = new Context(), configs = []
  class Registry extends Service {
    definitions = new Map()
    constructor(scope) { super(scope, 'agentPresets') }
    async activate(record) { assert.equal(entryListProblem(record.config.plugins), undefined); configs.push(record.config) }
    register(definition) { return AgentPresetRegistry.prototype.register.call(this, definition) }
  }
  const registry = new Registry(ctx)
  const fiber = ctx.plugin(host)
  await fiber.await()
  t.after(() => fiber.dispose())
  assert.deepEqual(configs.map(row => row.id).sort(), ['python-airules', 'sysadmin-airules'])
  await assert.rejects(registry.register(configs[0]), /Duplicate agent preset/)
  assert.equal(registry.definitions.size, 2)
})

test('native tool registration is scoped per domain and rule loading rejects unknown or cross-domain paths', async t => {
  const { policy } = await fixture(t)
  for (const domain of ['python', 'sysadmin']) {
    const sections = [], tools = [], providers = []
    policy.apply({ systemPrompt: { section(value) { sections.push(value) } }, tools: { register(tool) { tools.push(tool) } }, skills: { registerProvider(factory) { providers.push(factory) } }, effect() {} }, { domain })
    assert.equal(sections.length, 1)
    assert.equal(tools[0].name, 'domain_rule')
    assert.equal(providers.length, 1)
    assert.ok(sections[0].text.length < 1600)
    assert.equal((await tools[0].execute({})).text, listRules(domain))
    assert.equal((await tools[0].execute({ id: 'orchestration' })).text, readRule(domain, 'orchestration'))
    await assert.rejects(tools[0].execute({ id: '../python/environment' }), /DOMAIN_RULE_UNKNOWN/)
    await assert.rejects(tools[0].execute({ id: domain === 'python' ? 'diagnosis' : 'environment' }), /DOMAIN_RULE_UNKNOWN/)
    assert.doesNotMatch(sections[0].text, /# Изменение, проверка|# Реализация и проверка/)
  }
})

test('actual native skill provider discovers only the two selected-domain skills and lazily loads their bodies', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'domain-skill-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  for (const domain of ['python', 'sysadmin']) {
    const control = new AbortController()
    const provider = new FileSystemSkillProvider({ get() { return undefined }, logger: { warn(message) { throw new Error(message) } } }, { invalidate() {}, signal: control.signal }, { includeDefaultRoots: false, bundledSkillDir: skillsRoot(domain), watch: false, dshHome: temp, agentsHome: temp })
    try {
      const result = await provider.list({ cwd: temp, signal: control.signal })
      const candidates = Array.isArray(result) ? result : result.candidates
      assert.equal(candidates.length, 2)
      for (const candidate of candidates) {
        assert.ok(candidate.name.startsWith(domain + '-airules-'))
        assert.equal(candidate.source, 'bundled')
        const skill = await provider.get(candidate, { signal: control.signal })
        assert.match(skill.content ?? skill.body ?? JSON.stringify(skill), /domain_rule/)
      }
    } finally { control.abort(); await provider.dispose() }
  }
  assert.match(readRule('sysadmin', 'diagnosis'), /\/etc\/init.d\/xray-tproxy stop/)
  assert.match(readRule('sysadmin', 'diagnosis'), /Browbox\/sing-tun/)
  assert.match(readRule('python', 'environment'), /Не считай uv/)
  assert.throws(() => contract('1c-airules'), /DOMAIN_UNSUPPORTED/)
})

test('policy activates under real Cordis dependency enforcement and native bundled skill reads', async t => {
  const { policy, root: fixtureRoot } = await fixture(t)
  const root = new Context(), abort = new AbortController(), tools = []
  let provider
  class Prompt extends Service { constructor(ctx) { super(ctx, 'systemPrompt') } section() {} }
  class Tools extends Service { constructor(ctx) { super(ctx, 'tools') } register(tool) { tools.push(tool) } }
  class Skills extends Service { constructor(ctx) { super(ctx, 'skills') } registerProvider(factory) { provider = factory({ signal: abort.signal, invalidate() {} }) } }
  class Fs extends Service { constructor(ctx) { super(ctx, 'fs') } }
  new Prompt(root); new Tools(root); new Skills(root); new Fs(root)
  const fiber = root.plugin(policy, { domain: 'python' })
  await fiber.await()
  t.after(async () => { abort.abort(); await fiber.dispose() })
  assert.equal(tools[0].name, 'domain_rule')
  const result = await provider.list({ cwd: fixtureRoot, signal: abort.signal })
  const candidates = Array.isArray(result) ? result : result.candidates
  assert.equal(candidates.length, 2)
  assert.ok(candidates.every(candidate => candidate.source === 'bundled'))
})

test('shared generic skills load in both domain compositions without the 1C skill catalogue', async t => {
  const { policy, root } = await fixture(t)
  await stageSharedSkills('D:/AI_Projects/project_rules/var/rulepack/airules-0.12.0-skills2', root)
  for (const domain of ['python', 'sysadmin']) {
    const abort = new AbortController(), providers = []
    const ctx = { get() { return undefined }, logger: { warn(message) { throw new Error(message) } }, systemPrompt: { section() {} }, tools: { register() {} },
      skills: { registerProvider(factory) { providers.push(factory({ signal: abort.signal, invalidate() {} })) } }, effect() {} }
    policy.apply(ctx, { domain, sharedSkills: true })
    try {
      assert.equal(providers.length, 2)
      const candidates = []
      for (const provider of providers) {
        const result = await provider.list({ cwd: root, signal: abort.signal })
        const rows = Array.isArray(result) ? result : result.candidates
        candidates.push(...rows)
        for (const row of rows) assert.ok((await provider.get(row, { signal: abort.signal })).content.length > 0)
      }
      const names = candidates.map(row => row.name)
      assert.equal(names.length, 7)
      for (const name of SHARED_SKILLS) assert.ok(names.includes(name))
      assert.ok(names.every(name => SHARED_SKILLS.includes(name) || name.startsWith(`${domain}-airules-`)))
      assert.ok(candidates.every(row => row.source === 'bundled'))
    } finally { abort.abort(); await Promise.all(providers.map(provider => provider.dispose())) }
  }
})
