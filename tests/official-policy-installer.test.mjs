import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { applyOfficialPolicy } from '../installer/official-policy/apply.mjs'
import { buildOfficialPolicyPlan, policyPackageNames } from '../installer/official-policy/common.mjs'
import { rollbackOfficialPolicy } from '../installer/official-policy/rollback.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const names = [
  'airules-dsh-provider', 'airules-dsh-rulepack', 'airules-official-preset',
  'airules-official-onec-mechanics', 'dsh-bsl-editor', 'dsh-lsp-actions', 'schemastery',
]

test('workbench integrations pin scope and cannot turn on remote conversion or implicit style', () => {
  const integrations = {
    generalTools: { package: 'airules-dsh-general-tools', defaultStyle: 'off', style: 'opt-in-lite', renderer: 'native-sandbox' },
    documentWorkbench: { package: 'airules-dsh-document-workbench', cache: 'project-scoped', conversion: 'local', cloud: false },
    onecCapabilities: { package: 'airules-dsh-onec-capability-workflows', scope: '1c-airules', discovery: 'native-schemas', liveCalls: false },
  }
  assert.deepEqual(policyPackageNames({ integrations }), [...names, 'airules-dsh-general-tools', 'airules-dsh-document-workbench', 'airules-dsh-onec-capability-workflows'])
  for (const [key, field, value] of [['generalTools', 'defaultStyle', 'lite'], ['documentWorkbench', 'cloud', true], ['onecCapabilities', 'liveCalls', true]]) {
    assert.throws(() => policyPackageNames({ integrations: { ...integrations, [key]: { ...integrations[key], [field]: value } } }), /POLICY_INTEGRATION_INVALID/)
  }
})

test('import and skills manifest capabilities are explicit and immutable', () => {
  const integrations = {
    agentImport: { package: 'airules-dsh-agent-import', scopes: ['project', 'global'], chats: false, mcp: false, credentials: false },
    skillsManager: { package: 'airules-dsh-skills', storage: 'native', scopes: ['project', 'global'], bundledAssets: false },
  }
  assert.deepEqual(policyPackageNames({ integrations }), [...names, 'airules-dsh-agent-import', 'airules-dsh-skills'])
  assert.throws(() => policyPackageNames({ integrations: { ...integrations, agentImport: { ...integrations.agentImport, credentials: true } } }), /POLICY_INTEGRATION_INVALID/u)
  assert.throws(() => policyPackageNames({ integrations: { ...integrations, skillsManager: { ...integrations.skillsManager, storage: 'parallel' } } }), /POLICY_INTEGRATION_INVALID/u)
})
async function put(path, body) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body) }
async function files(root, excluded = '') { const out = {}; async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name), rel = relative(root, p).replaceAll('\\', '/'); if (e.isDirectory()) await walk(p); else if (rel !== excluded) { const b = await readFile(p); out[rel] = { sha256: sha(b), bytes: b.length } } } } await walk(root); return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en'))) }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'official-policy-')), candidate = join(root, 'candidate'), install = join(candidate, 'install'), profile = join(candidate, 'home/profiles/desktop'), artifact = join(root, 'artifact'), lockPath = join(root, 'lock.json')
  await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(artifact, { recursive: true })
  const app = Buffer.from('app'); await put(join(install, 'resources/app.asar'), app)
  const lock = { schemaVersion: 1, target: 'official-desktop', product: 'DeepSeek Harness', hostVersion: '0.2.1-rc.5', buildCommit: 'x', platform: 'win32-x64', profileLayout: '.dsh/profiles/desktop', files: { 'resources/app.asar': { bytes: app.length, sha256: sha(app) } } }
  await put(lockPath, JSON.stringify(lock)); await put(join(candidate, 'candidate-manifest.json'), JSON.stringify({ schemaVersion: 1, status: 'created-not-launched', candidate: { install: 'install', dshHome: 'home', profile: 'home/profiles/desktop', electronUserData: 'electron-user-data', uiReadyMarker: 'ui-ready.json', launchAllowed: false }, isolation: { copiesLiveProfile: false } }))
  const ui = '# profile\n- insert:\n    - id: ui-existing\n      name: ui-existing\n'; await put(join(profile, 'cordis.patch.yml'), ui)
  for (const name of names) await put(join(artifact, `payload/packages/${name}/package.json`), JSON.stringify({ name, version: '1.0.0' }))
  const fragment = "- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n- insert:\n    - id: airules-onec-bsl-editor\n      name: dsh-bsl-editor\n- id: agent-preset-registry\n  config:\n    default: 1c-airules\n"
  await put(join(artifact, 'cordis.policy.fragment.yml'), fragment)
  const manifest = { schemaVersion: 1, artifact: { id: 'airules-official-policy-overlay', version: 'test.1' }, target: { kind: 'official-desktop', hostVersion: lock.hostVersion, buildCommit: 'x', appAsarSha256: sha(app), releaseLockSha256: sha(await readFile(lockPath)), unknownTargetPolicy: 'block' }, separation: { mcpBindings: 'excluded', credentials: 'excluded', runtimeState: 'excluded', olegFullCanon: 'excluded' }, preset: { id: '1c-airules', label: '1С', extensionPoint: '@deepseek-ai/dsh-agent-preset', scope: 'composition' }, rulepack: { version: 'test', sourceDirty: true, counts: { files: 1, roles: 1, rules: 1, skills: 1 } }, operations: [...names.map(name => ({ kind: 'package-copy', source: `payload/packages/${name}`, target: `node_modules/${name}` })), { kind: 'cordis-merge', source: 'cordis.policy.fragment.yml', target: 'cordis.patch.yml' }], files: await files(artifact) }
  await put(join(artifact, 'official-policy-manifest.json'), JSON.stringify(manifest))
  return { root, candidate, profile, artifact, lockPath, ui }
}

async function installOldPolicyFixture(f, { ambiguousCordis = false } = {}) {
  for (const name of names.slice(0, 3)) await put(join(f.profile, `node_modules/${name}/package.json`), JSON.stringify({ name, version: '0.12.0-dev-old' }))
  await put(join(f.profile, 'node_modules/ui-package/package.json'), '{"name":"ui-package","version":"keep"}')
  const preset = ambiguousCordis
    ? "- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n    - id: shared-neighbour\n      name: shared-package\n"
    : "- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n"
  await put(join(f.profile, 'cordis.patch.yml'), `${f.ui}${preset}- id: agent-preset-registry\n  config:\n    default: 1c-airules\n`)
  await put(join(f.candidate, 'policy-ready.json'), `${JSON.stringify({ schemaVersion: 1, status: 'policy-ready', artifact: { id: 'airules-official-policy-overlay', version: '0.12.0-dev' }, receipt: '.airules-policy-backups/airules-official-policy-overlay-0.12.0-dev/receipt.json' }, null, 2)}\n`)
}

test('policy plan is read-only and preserves an existing UI block', async t => { const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const before = await files(f.candidate); const plan = await buildOfficialPolicyPlan({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath }); assert.equal(plan.status, 'ready'); assert.equal(plan.operations.length, 9); assert.deepEqual(await files(f.candidate), before) })

test('policy apply and rollback leave UI bytes and packages intact', async t => { const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await put(join(f.profile, 'node_modules/ui-package/package.json'), '{"name":"ui-package"}'); const applied = await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath }); assert.match(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), /preset-1c-airules/u); assert.equal(await readFile(join(f.profile, 'node_modules/ui-package/package.json'), 'utf8'), '{"name":"ui-package"}'); const rolled = await rollbackOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, receiptPath: applied.receiptPath }); assert.equal(rolled.status, 'rolled-back'); assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), f.ui); assert.equal(await readFile(join(f.profile, 'node_modules/ui-package/package.json'), 'utf8'), '{"name":"ui-package"}'); await assert.rejects(readFile(join(f.candidate, 'policy-ready.json')), /ENOENT/u) })

test('partial policy failure restores existing UI profile', async t => { const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await assert.rejects(applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, failAfterOperation: 4 }), /INJECTED_POLICY_APPLY_FAILURE/u); assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), f.ui); assert.deepEqual(await readdir(join(f.profile, 'node_modules')), []) })

test('same policy version with different artifact bytes is refused without candidate writes', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath })
  const before = await files(f.candidate)
  await put(join(f.artifact, 'payload/packages/airules-official-onec-mechanics/changed.txt'), 'different bytes')
  const manifestPath = join(f.artifact, 'official-policy-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files = await files(f.artifact, 'official-policy-manifest.json')
  await put(manifestPath, JSON.stringify(manifest))
  await assert.rejects(
    applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath }),
    /PLAN_BLOCKED/u,
  )
  assert.deepEqual(await files(f.candidate), before)
})

test('explicit migration replaces owned dev4 policy and dev7 rollback restores it byte-for-byte', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f)
  const oldProfile = await files(f.profile)
  const oldMarker = await readFile(join(f.candidate, 'policy-ready.json'))
  const blocked = await buildOfficialPolicyPlan({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.collisions.every(row => row.authorized === false), true)
  const migration = await buildOfficialPolicyPlan({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal(migration.status, 'ready')
  assert.equal(migration.collisions.every(row => row.authorized === true), true)
  const applied = await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal(applied.receipt.operations.filter(row => row.backup).length, 5)
  assert.equal(await readFile(join(f.profile, 'node_modules/ui-package/package.json'), 'utf8'), '{"name":"ui-package","version":"keep"}')
  assert.equal((await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).startsWith(f.ui), true)
  const rolled = await rollbackOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, receiptPath: applied.receiptPath })
  assert.equal(rolled.status, 'rolled-back')
  assert.deepEqual(await files(f.profile), oldProfile)
  assert.deepEqual(await readFile(join(f.candidate, 'policy-ready.json')), oldMarker)
})

test('replace flag refuses a shared Cordis block containing a policy id', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f, { ambiguousCordis: true })
  const before = await files(f.candidate)
  const plan = await buildOfficialPolicyPlan({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal(plan.status, 'blocked')
  assert.equal(plan.blockers.some(row => row.type === 'cordis' && row.reason === 'POLICY_CORDIS_AMBIGUOUS'), true)
  await assert.rejects(applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true }), /PLAN_BLOCKED/u)
  assert.deepEqual(await files(f.candidate), before)
})

test('failed dev7 migration recovers the complete dev4 state', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f)
  const before = await files(f.candidate)
  await assert.rejects(
    applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true, failAfterOperation: 6 }),
    /INJECTED_POLICY_APPLY_FAILURE/u,
  )
  assert.deepEqual(await files(f.candidate), before)
})

test('migration preserves a BOM and CRLF UI prefix byte-for-byte', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f)
  const cordisPath = join(f.profile, 'cordis.patch.yml')
  const oldCordis = `\uFEFF${(await readFile(cordisPath, 'utf8')).replace(/\n/gu, '\r\n')}`
  const uiPrefix = `\uFEFF${f.ui.replace(/\n/gu, '\r\n')}`
  await put(cordisPath, oldCordis)
  const applied = await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal((await readFile(cordisPath, 'utf8')).startsWith(uiPrefix), true)
  await rollbackOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, receiptPath: applied.receiptPath })
  assert.equal(await readFile(cordisPath, 'utf8'), oldCordis)
})

test('OpenSpec policy extension applies the eighth owned package and rollback restores legacy profile', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f)
  const before = await files(f.profile)
  const manifestPath = join(f.artifact, 'official-policy-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await put(join(f.artifact, 'payload/packages/dsh-openspec-workflow/package.json'), JSON.stringify({ name: 'dsh-openspec-workflow', version: 'test.1' }))
  manifest.integrations = { openspec: { package: 'dsh-openspec-workflow', cliVersion: '1.12.0', dependencyLockSha256: 'a'.repeat(64), privateRuntimePackages: 82, policyOwner: 'project_rules', atlassian: false } }
  manifest.operations.splice(-1, 0, { kind: 'package-copy', source: 'payload/packages/dsh-openspec-workflow', target: 'node_modules/dsh-openspec-workflow' })
  manifest.files = await files(f.artifact, 'official-policy-manifest.json')
  await put(manifestPath, JSON.stringify(manifest))
  const applied = await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal(applied.receipt.packageNames.length, 8)
  assert.equal(JSON.parse(await readFile(join(f.profile, 'node_modules/dsh-openspec-workflow/package.json'), 'utf8')).name, 'dsh-openspec-workflow')
  await rollbackOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, receiptPath: applied.receiptPath })
  assert.deepEqual(await files(f.profile), before)
})

test('transport policy extension restores every legacy profile byte after apply and rollback', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await installOldPolicyFixture(f)
  const before = await files(f.profile)
  const markerBefore = await readFile(join(f.candidate, 'policy-ready.json'))
  const manifestPath = join(f.artifact, 'official-policy-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.integrations = {
    telegram: { package: 'airules-dsh-telegram', defaultEnabled: false, autostart: false, secretStorage: 'windows-dpapi-current-user', transport: 'single-owner-long-polling' },
    acp: { package: 'airules-dsh-acp', defaultEnabled: false, inbound: 'local-named-pipe', outbound: 'native-external-agent',
      adapterVersion: '0.2.1-rc.3.1', sdkVersion: '1.5.1', dependencyLockSha256: 'b'.repeat(64), privateRuntimePackages: 22,
      adaptation: { sourceSha256: 'c'.repeat(64), stagedSha256: 'd'.repeat(64) } },
  }
  for (const name of ['airules-dsh-telegram', 'airules-dsh-acp', '@zaimokuza/dsh-acp-adapter']) {
    await put(join(f.artifact, `payload/packages/${name}/package.json`), JSON.stringify({ name, version: 'test.1' }))
    manifest.operations.splice(-1, 0, { kind: 'package-copy', source: `payload/packages/${name}`, target: `node_modules/${name}` })
  }
  manifest.files = await files(f.artifact, 'official-policy-manifest.json')
  await put(manifestPath, JSON.stringify(manifest))
  const applied = await applyOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, replaceCollisions: true })
  assert.equal(applied.receipt.packageNames.length, 10)
  await rollbackOfficialPolicy({ candidateRoot: f.candidate, artifactRoot: f.artifact, releaseLockPath: f.lockPath, receiptPath: applied.receiptPath })
  assert.deepEqual(await files(f.profile), before)
  assert.deepEqual(await readFile(join(f.candidate, 'policy-ready.json')), markerBefore)
})
