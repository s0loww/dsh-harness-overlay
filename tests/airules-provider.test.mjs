import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listRoles, listRules, loadRulepack, readRole, readRule, roleCapabilityStatus } from '../src/airules-provider/core.mjs'
import { registerAirulesRuntime } from '../src/airules-provider/runtime.mjs'
import { registerVerificationProvider, renderVerification, verificationCapabilityStatus } from '../src/airules-provider/verification.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'airules-provider-'))
  await mkdir(join(root, 'contract'), { recursive: true })
  await mkdir(join(root, 'rules'), { recursive: true })
  await mkdir(join(root, 'roles'), { recursive: true })
  await mkdir(join(root, 'testing'), { recursive: true })
  await mkdir(join(root, 'skills'), { recursive: true })
  const content = {
    'contract/AGENTS.bundle.md': '# Contract\nUse `airules_rule`.\n',
    'rules/alpha.md': '# Alpha\nAlpha body.\n',
    'rules/beta-rule.md': '# Beta\nBeta body.\n',
    'roles/developer.md': '# Developer\nImplement the approved plan.\n',
    'roles/tester.md': '# Tester\nVerify observable behavior.\n',
    'testing/default.json': JSON.stringify({
      checks: [
        { binding: 'project-defined', id: 'doctor', required: false },
        { binding: 'project-defined', id: 'analyze', required: true },
        { binding: 'project-defined', id: 'deploy', required: false },
        { binding: 'project-defined', id: 'test', required: true },
      ],
      id: 'default',
      mutations: { production_requires_explicit_approval: true, test_contour_required: true },
      policy: 'project-overridable',
      schema_version: 1,
    }, null, 2) + '\n',
  }
  for (const [relative, text] of Object.entries(content)) await writeFile(join(root, relative), text, 'utf8')
  const files = {}
  for (const [relative, text] of Object.entries(content)) {
    const bytes = Buffer.from(text)
    files[relative] = { sha256: hash(bytes), bytes: bytes.length, kind: relative.split('/')[0].replace(/s$/u, '') }
  }
  files['testing/default.json'].id = 'default'
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    package: { id: 'airules-dsh-rulepack', version: 'test.1' },
    mcp: { mode: 'logical-only', logical_roles: ['code-facade'] },
    files,
    inventories: {
      rules: [
        { id: 'beta-rule', path: 'rules/beta-rule.md', sha256: files['rules/beta-rule.md'].sha256, kind: 'recipe', description: 'Beta' },
        { id: 'alpha', path: 'rules/alpha.md', sha256: files['rules/alpha.md'].sha256, kind: 'invariant', description: 'Alpha' },
      ],
      roles: [
        { id: 'tester', path: 'roles/tester.md', sha256: files['roles/tester.md'].sha256, purpose: 'Tests', tier: 'high', effort: 'medium' },
        { id: 'developer', path: 'roles/developer.md', sha256: files['roles/developer.md'].sha256, purpose: 'Implementation', tier: 'high', effort: 'medium' },
      ],
    },
  }, null, 2), 'utf8')
  return root
}

test('loads verified contract/rules and exposes a stable sorted catalogue', async () => {
  const root = await fixture()
  try {
    const pack = loadRulepack(root)
    assert.equal(pack.version, 'test.1')
    assert.equal(pack.contract, '# Contract\nUse `airules_rule`.\n')
    assert.equal(listRules(pack), 'alpha: Alpha\nbeta-rule: Beta')
    assert.match(readRule(pack, 'beta-rule'), /embedded airules test\.1\/rules\/beta-rule\.md/u)
    assert.match(readRule(pack, 'beta-rule'), /Beta body/u)
    assert.deepEqual(roleCapabilityStatus(pack), {
      status: 'prompt-adapter',
      nativeRoleRegistry: false,
      nativeExtensionPoint: null,
      reason: 'DSH exposes subagent execution providers and complete agent presets, but no named-role registry.',
      roleCount: 2,
    })
    assert.match(listRoles(pack), /^capability: prompt-adapter; native-role-registry: unavailable; roles: 2\ndeveloper:/u)
    assert.match(readRole(pack, 'developer'), /roles\/developer\.md/u)
    assert.match(readRole(pack, 'developer'), /Implement the approved plan/u)
    assert.deepEqual(verificationCapabilityStatus(pack), {
      status: 'declarative-only', executesChecks: false, projectBindings: 'external',
      mcpBindings: false, defaultContour: 'default', schemaVersion: 1,
    })
    assert.match(renderVerification(pack), /1\. doctor[\s\S]*2\. analyze[\s\S]*3\. deploy[\s\S]*4\. test/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects traversal, unknown ids and tampered content', async () => {
  const root = await fixture()
  try {
    const pack = loadRulepack(root)
    assert.throws(() => readRule(pack, '../alpha'), /RULE_ID_INVALID/u)
    assert.throws(() => readRule(pack, 'missing'), /RULE_NOT_FOUND/u)
    assert.throws(() => readRole(pack, '../developer'), /ROLE_ID_INVALID/u)
    assert.throws(() => readRole(pack, 'missing'), /ROLE_NOT_FOUND/u)
    await writeFile(join(root, 'rules', 'alpha.md'), 'tampered\n', 'utf8')
    assert.throws(() => loadRulepack(root), /HASH_MISMATCH/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects tampered and duplicate role inventory', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'roles', 'developer.md'), 'tampered\n', 'utf8')
    assert.throws(() => loadRulepack(root), /HASH_MISMATCH: roles[\\/]developer\.md/u)
  } finally { await rm(root, { recursive: true, force: true }) }

  const duplicateRoot = await fixture()
  try {
    const path = join(duplicateRoot, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.inventories.roles.push({ ...manifest.inventories.roles[0] })
    await writeFile(path, JSON.stringify(manifest), 'utf8')
    assert.throws(() => loadRulepack(duplicateRoot), /ROLE_INVENTORY_INVALID/u)
  } finally { await rm(duplicateRoot, { recursive: true, force: true }) }
})

test('rejects tampered verification contour and invalid verification schema', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'testing', 'default.json'), '{"tampered":true}\n', 'utf8')
    assert.throws(() => loadRulepack(root), /HASH_MISMATCH: testing[\\/]default\.json/u)
  } finally { await rm(root, { recursive: true, force: true }) }

  const invalidRoot = await fixture()
  try {
    const contourPath = join(invalidRoot, 'testing', 'default.json')
    const manifestPath = join(invalidRoot, 'manifest.json')
    const contour = JSON.parse(await readFile(contourPath, 'utf8'))
    contour.checks[1].binding = 'mcp-injected'
    const bytes = Buffer.from(JSON.stringify(contour, null, 2) + '\n')
    await writeFile(contourPath, bytes)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.files['testing/default.json'].sha256 = hash(bytes)
    manifest.files['testing/default.json'].bytes = bytes.length
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    assert.throws(() => loadRulepack(invalidRoot), /VERIFICATION_SCHEMA_INVALID/u)
  } finally { await rm(invalidRoot, { recursive: true, force: true }) }
})

test('registers declarative verification provider without execution or MCP bindings', async () => {
  const root = await fixture()
  try {
    const sections = []
    const tools = []
    const ctx = {
      systemPrompt: { section(value) { sections.push(value) } },
      tools: { register(value) { tools.push(value) } },
    }
    const capability = registerVerificationProvider(ctx, loadRulepack(root), { defineTool: definition => definition })
    assert.equal(capability.status, 'declarative-only')
    assert.equal(capability.executesChecks, false)
    assert.equal(capability.mcpBindings, false)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'airules:verification')
    assert.match(sections[0].text, /doctor -> analyze -> deploy -> test/u)
    assert.match(sections[0].text, /production mutation or deployment requires explicit user approval/u)
    assert.deepEqual(tools.map(tool => tool.name), ['airules_verification'])
    assert.deepEqual(tools[0].parameters, {})
    assert.match(tools[0].execute({}).text, /executes-checks: no/u)
    assert.doesNotMatch(JSON.stringify(tools[0]), /endpoint|token|server|command/iu)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('registers rule and role adapters, prompt capability status, and filesystem skills', async () => {
  const root = await fixture()
  try {
    const sections = []
    const tools = []
    const providers = []
    const effects = []
    let disposed = false
    class FakeSkillProvider {
      constructor(ctx, control, options) { this.ctx = ctx; this.control = control; this.options = options }
      dispose() { disposed = true }
    }
    const ctx = {
      systemPrompt: { section(value) { sections.push(value) } },
      tools: { register(value) { tools.push(value) } },
      skills: { registerProvider(factory) { providers.push(factory) } },
      effect(factory) { effects.push(factory()) },
    }
    const capability = registerAirulesRuntime(ctx, loadRulepack(root), {
      defineTool: definition => definition,
      FileSystemSkillProvider: FakeSkillProvider,
    })

    assert.equal(capability.status, 'prompt-adapter')
    assert.equal(capability.nativeRoleRegistry, false)
    assert.deepEqual(sections.map(section => section.name), ['airules:contract', 'airules:roles'])
    assert.match(sections[1].text, /native named-role registry: unavailable/u)
    assert.deepEqual(tools.map(tool => tool.name), ['airules_rule', 'airules_role'])
    assert.match(tools[1].execute({}).text, /developer: Implementation/u)
    assert.match(tools[1].execute({ id: 'tester' }).text, /Verify observable behavior/u)
    assert.equal(providers.length, 1)
    const provider = providers[0]({ marker: true })
    assert.equal(provider.options.providerName, 'airules-rulepack')
    assert.equal(provider.options.bundledSkillDir, join(root, 'skills'))
    assert.equal(provider.options.customSkillDirs, undefined)
    effects[0]()
    assert.equal(disposed, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scopes airules prompt sections to the 1c-airules project preset', async () => {
  const root = await fixture()
  try {
    const sections = []
    class FakeSkillProvider { dispose() {} }
    const ctx = {
      systemPrompt: { section(value) { sections.push(value) } },
      tools: { register() {} },
      skills: { registerProvider() {} },
      effect() {},
    }
    const isEnabled = target => target?.preset === '1c-airules'
    registerAirulesRuntime(ctx, loadRulepack(root), {
      defineTool: definition => definition, FileSystemSkillProvider: FakeSkillProvider, isEnabled,
    })
    registerVerificationProvider(ctx, loadRulepack(root), { defineTool: definition => definition, isEnabled })
    assert.deepEqual(sections.map(section => section.text({ agent: { preset: 'general' } })), ['', '', ''])
    assert.ok(sections.every(section => section.text({ agent: { preset: '1c-airules' } }).length > 0))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('project-preset mode mounts packaged skills only in an enabled agent scope', async () => {
  const root = await fixture()
  try {
    let created
    const mounted = []
    class FakeSkillProvider {
      constructor(ctx) { this.ctx = ctx }
      dispose() {}
    }
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register() {} },
      skills: { registerProvider() { throw new Error('global skills must not be mounted') } },
      on(name, handler) { assert.equal(name, 'agent/created'); created = handler },
    }
    registerAirulesRuntime(ctx, loadRulepack(root), {
      defineTool: definition => definition,
      FileSystemSkillProvider: FakeSkillProvider,
      isEnabled: agent => agent?.preset === '1c-airules',
      activationMode: 'project-preset',
    })
    const general = { preset: 'general', ctx: { skills: { registerProvider() { throw new Error('disabled agent leak') } } } }
    created({ agent: general })
    const enabled = { preset: '1c-airules', ctx: { skills: { registerProvider(factory) { mounted.push(factory({ signal: new AbortController().signal })) } } } }
    created({ agent: enabled })
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0].ctx, enabled.ctx)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects connection-bearing MCP configuration', async () => {
  const root = await fixture()
  try {
    const path = join(root, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.mcp.endpoint = 'https://example.invalid'
    await writeFile(path, JSON.stringify(manifest), 'utf8')
    assert.throws(() => loadRulepack(root), /MCP_NOT_LOGICAL_ONLY/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

