import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policyPackageNames, verifyPolicyArtifact } from '../installer/official-policy/common.mjs'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { validatePrivateClosure } from '../scripts/smoke-official-candidate.mjs'

const telegram = Object.freeze({ package: 'airules-dsh-telegram', defaultEnabled: false, autostart: false, secretStorage: 'windows-dpapi-current-user', transport: 'single-owner-long-polling' })
const acp = Object.freeze({ package: 'airules-dsh-acp', defaultEnabled: false, inbound: 'local-named-pipe', outbound: 'native-external-agent',
  adapterVersion: '0.2.1-rc.3.1', sdkVersion: '1.5.1', dependencyLockSha256: 'b'.repeat(64), privateRuntimePackages: 22,
  adaptation: { sourceSha256: 'c'.repeat(64), stagedSha256: 'd'.repeat(64) } })
const openspec = Object.freeze({ package: 'dsh-openspec-workflow', cliVersion: '1.12.0', dependencyLockSha256: 'a'.repeat(64), privateRuntimePackages: 82, policyOwner: 'project_rules', atlassian: false })
const subscriptions = Object.freeze({ package: 'airules-dsh-subscriptions', defaultEnabled: false, state: 'isolated', credentials: 'excluded', dependencyLockSha256: 'e'.repeat(64), privateRuntimePackages: 1 })
const mobile = Object.freeze({ package: 'airules-dsh-mobile-access', defaultEnabled: false, autostart: false, listener: 'explicit-start-https', firewallChanges: false, dependencyLockSha256: 'f'.repeat(64), privateRuntimePackages: 68 })
const mcpManager = Object.freeze({ package: 'airules-dsh-mcp-manager', bindings: 'machine-or-project-external', defaultServers: 0, authority: 'native-loopback-csrf' })

test('optional transports extend the exact allowlist while immutable dev7/dev8/dev10 still verify', async () => {
  const old = await verifyPolicyArtifact(fileURLToPath(new URL('../dist/airules-official-policy-0.12.0-dev7', import.meta.url)))
  const current = await verifyPolicyArtifact(fileURLToPath(new URL('../dist/airules-official-policy-0.12.0-dev8', import.meta.url)))
  assert.equal(old.packageNames.length, 7)
  assert.equal(current.packageNames.length, 8)
  const dev10 = await verifyPolicyArtifact(fileURLToPath(new URL('../dist/airules-official-policy-0.12.0-dev10', import.meta.url)))
  assert.equal(dev10.packageNames.length, 13)
  assert.deepEqual(policyPackageNames({ integrations: { telegram } }).slice(-1), ['airules-dsh-telegram'])
  assert.deepEqual(policyPackageNames({ integrations: { openspec, telegram, acp } }).slice(-4), ['dsh-openspec-workflow', 'airules-dsh-telegram', 'airules-dsh-acp', '@zaimokuza/dsh-acp-adapter'])
  assert.equal(policyPackageNames({ integrations: { openspec, telegram, acp, subscriptions, mobile } }).length, 13)
  assert.equal(policyPackageNames({ integrations: { openspec, telegram, acp, subscriptions, mobile, mcpManager } }).length, 14)
})

test('transport declarations refuse unknown packages, eager activation and credential-bearing metadata', () => {
  for (const integrations of [
    { telegram: { ...telegram, package: 'unknown-package' } },
    { telegram: { ...telegram, defaultEnabled: true } },
    { telegram: { ...telegram, autostart: true } },
    { telegram: { ...telegram, token: 'synthetic' } },
    { acp: { ...acp, inbound: 'public-tcp' } },
    { acp: { ...acp, command: 'synthetic' } },
    { subscriptions: { ...subscriptions, state: 'shared-live-profile' } },
    { subscriptions: { ...subscriptions, credentials: 'imported' } },
    { mobile: { ...mobile, autostart: true } },
    { mobile: { ...mobile, firewallChanges: true } },
    { mobile: { ...mobile, listener: 'public-http' } },
    { mcpManager: { ...mcpManager, defaultServers: 1 } },
    { mcpManager: { ...mcpManager, authority: 'unrestricted' } },
    { mcpManager: { ...mcpManager, bindings: 'embedded' } },
    { mcpManager: { ...mcpManager, endpoint: 'synthetic' } },
    { openspec, unknown: {} },
    null,
    [],
    {},
  ]) assert.throws(() => policyPackageNames({ integrations }), /POLICY_INTEGRATION_INVALID/u)
})

test('Telegram-only staging includes its self-contained runtime and removes disabled feature mounts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-telegram-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rulepack = join(root, 'rulepack')
  await mkdir(rulepack)
  await writeFile(join(rulepack, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'test' },
    mcp: { mode: 'logical-only', logical_roles: [] }, counts: { files: 0, rules: 0, skills: 0, roles: 0 } }))
  const output = join(root, 'airules-official-policy-test.telegram')
  const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.telegram', includeOpenSpec: false, includeTelegram: true, includeAcp: false })
  const verified = await verifyPolicyArtifact(output)
  assert.equal(verified.packageNames.length, 8)
  assert.deepEqual(manifest.integrations, { telegram })
  const cordis = await readFile(join(output, 'cordis.policy.fragment.yml'), 'utf8')
  assert.match(cordis, /name: airules-dsh-telegram/u)
  assert.doesNotMatch(cordis, /airules-acp|name: dsh-openspec-workflow/u)
  assert.ok(manifest.files['payload/packages/airules-dsh-telegram/scripts/telegram-secret.ps1'])
  assert.ok(manifest.files['payload/packages/airules-dsh-telegram/vendor/dsh-telegram/lib/bridge.js'])
  assert.equal(Object.keys(manifest.files).some(path => /config\.local|credentials|\.env$/u.test(path)), false)
})

test('full feature staging keeps private closures and the native ACP adapter independent of live state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-acp-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rulepack = join(root, 'rulepack')
  await mkdir(rulepack)
  await writeFile(join(rulepack, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'test' },
    mcp: { mode: 'logical-only', logical_roles: [] }, counts: { files: 0, rules: 0, skills: 0, roles: 0 } }))
  const output = join(root, 'airules-official-policy-test.acp')
  const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.acp', includeAcp: true, includeTelegram: true, includeSubscriptions: true, includeMobile: true, includeMcpManager: true })
  const verified = await verifyPolicyArtifact(output)
  assert.equal(verified.packageNames.length, 14)
  const adapter = join(output, 'payload/packages/@zaimokuza/dsh-acp-adapter')
  const wrapper = join(output, 'payload/packages/airules-dsh-acp')
  const dependency = path => readFile(path, 'utf8').then(JSON.parse)
  assert.equal((await dependency(join(adapter, 'node_modules/@agentclientprotocol/sdk/package.json'))).version, '1.5.1')
  assert.equal((await dependency(join(wrapper, 'node_modules/@agentclientprotocol/sdk/package.json'))).version, '1.5.1')
  assert.equal((await dependency(join(wrapper, 'node_modules/@agentclientprotocol/sdk/node_modules/zod/package.json'))).version, '4.4.3')
  const sdk = await import(pathToFileURL(join(wrapper, 'node_modules/@agentclientprotocol/sdk/dist/acp.js')))
  assert.equal(typeof sdk.AgentSideConnection, 'function')
  assert.equal(typeof sdk.ndJsonStream, 'function')
  assert.ok(await validatePrivateClosure(adapter, (await dependency(join(adapter, 'package.json'))).dependencies) > 1)
  const registry = await readFile(join(adapter, 'lib/host/composition/installed-profile-registry.js'), 'utf8')
  assert.match(registry, /from 'airules-dsh-acp\/outbound'/u)
  assert.doesNotMatch(registry, /\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/acp-outbound/u)
  assert.equal(manifest.integrations.acp.sdkVersion, '1.5.1')
  assert.equal(await validatePrivateClosure(join(output, 'payload/packages/airules-dsh-subscriptions'), { undici: '7.29.1' }), 1)
  assert.equal(await validatePrivateClosure(join(output, 'payload/packages/airules-dsh-mobile-access'), { 'dsh-relay': '0.2.1' }), 68)
  assert.equal(manifest.integrations.subscriptions.state, 'isolated')
  assert.equal(manifest.integrations.mobile.firewallChanges, false)
  const cordis = await readFile(join(output, 'cordis.policy.fragment.yml'), 'utf8')
  assert.match(cordis, /name: airules-dsh-subscriptions/u)
  assert.match(cordis, /name: airules-dsh-mobile-access/u)
  assert.match(cordis, /name: airules-dsh-mcp-manager/u)
  assert.deepEqual(manifest.integrations.mcpManager, mcpManager)
})

test('MCP manager-only staging installs its UI/runtime without server definitions or bindings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-mcp-manager-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rulepack = join(root, 'rulepack')
  await mkdir(rulepack)
  await writeFile(join(rulepack, 'manifest.json'), JSON.stringify({ package: { id: 'airules-dsh-rulepack', version: 'test' },
    mcp: { mode: 'logical-only', logical_roles: [] }, counts: { files: 0, rules: 0, skills: 0, roles: 0 } }))
  const output = join(root, 'airules-official-policy-test.mcp')
  const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion: 'test.mcp', includeOpenSpec: false, includeMcpManager: true })
  const verified = await verifyPolicyArtifact(output)
  assert.equal(verified.packageNames.length, 8)
  assert.deepEqual(manifest.integrations, { mcpManager })
  const fragment = await readFile(join(output, 'cordis.policy.fragment.yml'), 'utf8')
  assert.match(fragment, /name: airules-dsh-mcp-manager/u)
  assert.doesNotMatch(fragment, /airules-telegram|airules-mobile|airules-subscriptions|airules-acp|dsh-openspec-workflow/u)
  const packageRoot = join(output, 'payload/packages/airules-dsh-mcp-manager')
  assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).dependencies, undefined)
  assert.equal(Object.keys(manifest.files).some(path => /mcp-servers\.json|\.mcp\.json|credentials\.json|config\.local|\.env$/u.test(path)), false)
})
