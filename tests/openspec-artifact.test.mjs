import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectPackageClosure, stagePackageClosure } from '../scripts/stage-package-closure.mjs'
import { policyPackageNames, verifyPolicyArtifact, DEFAULT_ARTIFACT } from '../installer/official-policy/common.mjs'
import { validatePrivateClosure } from '../scripts/smoke-official-candidate.mjs'

async function fixture(root, rel, name, version, dependencies = {}, peerDependencies = {}) {
  const path = join(root, rel)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, license: 'MIT', dependencies, peerDependencies }))
  await writeFile(join(path, 'index.js'), 'module.exports = 1\n')
  return path
}

test('private closure preserves nested versions, excludes host peers and rejects source drift', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'openspec-closure-'))
  try {
    const source = join(temp, 'source'), target = join(temp, 'plugin', 'node_modules')
    await fixture(source, 'cli', 'cli', '1.0.0', { leaf: '^1.0.0', helper: '1.0.0' }, { 'host-only': '1.0.0' })
    const leaf = await fixture(source, 'leaf', 'leaf', '1.0.0')
    await fixture(source, 'helper', 'helper', '1.0.0', { leaf: '^2.0.0' })
    await fixture(source, 'helper/node_modules/leaf', 'leaf', '2.0.0')
    const roots = { cli: '1.0.0' }, lock = await inspectPackageClosure({ modulesRoot: source, roots })
    assert.equal(lock.packages.length, 4)
    assert.deepEqual(lock.packages.filter(row => row.name === 'leaf').map(row => row.version).sort(), ['1.0.0', '2.0.0'])
    await stagePackageClosure({ modulesRoot: source, targetModulesRoot: target, lock })
    assert.equal(await validatePrivateClosure(join(temp, 'plugin'), roots), 4)
    await writeFile(join(leaf, 'index.js'), 'tampered\n')
    await assert.rejects(stagePackageClosure({ modulesRoot: source, targetModulesRoot: join(temp, 'different'), lock }), /CLOSURE_LOCK_MISMATCH/u)
    await rm(join(target, 'helper', 'node_modules', 'leaf'), { recursive: true })
    await rm(join(target, 'leaf'), { recursive: true })
    await assert.rejects(validatePrivateClosure(join(temp, 'plugin'), roots), /PRIVATE_DEPENDENCY_MISSING/u)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('policy package allowlist supports legacy artifacts and exact OpenSpec integration only', async () => {
  const legacy = await verifyPolicyArtifact(DEFAULT_ARTIFACT)
  assert.equal(legacy.packageNames.length, 7)
  const openspec = { package: 'dsh-openspec-workflow', cliVersion: '1.12.0', dependencyLockSha256: 'a'.repeat(64), privateRuntimePackages: 73, policyOwner: 'project_rules', atlassian: false }
  assert.equal(policyPackageNames({ integrations: { openspec } }).length, 8)
  assert.throws(() => policyPackageNames({ integrations: { openspec: { ...openspec, atlassian: true } } }), /POLICY_INTEGRATION_INVALID/u)
  assert.throws(() => policyPackageNames({ integrations: { openspec, other: {} } }), /POLICY_INTEGRATION_INVALID/u)
})

test('pinned private OpenSpec CLI runs without globally installed openspec or host packages', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'openspec-cli-'))
  try {
    const lock = JSON.parse(await readFile(new URL('../upstream/openspec-closure.lock.json', import.meta.url), 'utf8'))
    const targetModulesRoot = join(temp, 'plugin', 'node_modules')
    await stagePackageClosure({
      modulesRoot: 'E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules',
      targetModulesRoot, lock,
    })
    assert.equal(await validatePrivateClosure(join(temp, 'plugin'), lock.roots), lock.packages.length)
    const cli = spawnSync(process.execPath, [join(targetModulesRoot, '@fission-ai', 'openspec', 'bin', 'openspec.js'), '--version'], {
      cwd: temp, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', NODE_PATH: '' },
    })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(cli.stdout.trim(), '1.12.0')
  } finally { await rm(temp, { recursive: true, force: true }) }
})
