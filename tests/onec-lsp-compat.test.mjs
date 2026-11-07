import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchOnecLspManifest, adaptOnecLspPackage, verifyOnecLspCompatibility, ONEC_LSP_TOOL_NAMES, ONEC_LSP_STAGED_MANIFEST_SHA256 } from '../src/onec-lsp-compat/patch.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const baseline = join(REPO, 'var/candidate/official-desktop-rc5-26/home/profiles/desktop/node_modules/dsh-lsp-actions')
const sourceAvailable = await access(join(baseline, 'package.json')).then(() => true, () => false)
test('exact compatibility adapts only pinned LSP manifest/code and preserves peer contracts', { skip: !sourceAvailable }, async () => {
  const [manifest, entry] = await Promise.all([readFile(join(baseline, 'package.json')), readFile(join(baseline, 'lib/index.js'))])
  const result = patchOnecLspManifest(manifest, entry), original = JSON.parse(manifest), pkg = JSON.parse(result.manifestBytes)
  assert.equal(pkg.engines.dsh, '0.2.1-rc.5'); assert.equal(pkg.engines.node, original.engines.node)
  assert.deepEqual(pkg.peerDependencies, original.peerDependencies)
  assert.equal(createHash('sha256').update(result.manifestBytes).digest('hex'), ONEC_LSP_STAGED_MANIFEST_SHA256)
  assert.deepEqual(verifyOnecLspCompatibility(result.manifestBytes, entry), result.adaptation)
  assert.throws(() => patchOnecLspManifest(Buffer.concat([manifest, Buffer.from('\n')]), entry), /MANIFEST_DRIFT/)
  assert.throws(() => patchOnecLspManifest(manifest, Buffer.concat([entry, Buffer.from('\n')])), /ENTRY_DRIFT/)
  assert.throws(() => patchOnecLspManifest(manifest, entry, { hostVersion: '0.2.1-rc.6' }), /HOST_MISMATCH/)
  assert.throws(() => patchOnecLspManifest(result.manifestBytes, entry), /MANIFEST_DRIFT/)
})
test('owned-stage helper changes only its copied manifest, leaving entry and original untouched', { skip: !sourceAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onec-lsp-compat-'))
  const [manifest, entry] = await Promise.all([readFile(join(baseline, 'package.json')), readFile(join(baseline, 'lib/index.js'))])
  try {
    await mkdir(join(directory, 'lib')); await writeFile(join(directory, 'package.json'), manifest); await writeFile(join(directory, 'lib/index.js'), entry)
    const adaptation = await adaptOnecLspPackage(directory)
    assert.equal(adaptation.stagedManifestSha256, ONEC_LSP_STAGED_MANIFEST_SHA256)
    assert.deepEqual(await readFile(join(directory, 'lib/index.js')), entry)
    assert.deepEqual(await readFile(join(baseline, 'package.json')), manifest)
    await assert.rejects(adaptOnecLspPackage(directory), /MANIFEST_DRIFT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('actual pinned native profile admits scoped eight LSP tools without a server or model', { skip: !sourceAvailable, timeout: 120000 }, async () => {
  const candidate = resolve(process.env.AIRULES_LSP_CANDIDATE ?? join(REPO, 'var/candidate/official-desktop-rc5-26'))
  const { stdout } = await promisify(execFile)(process.execPath, [join(REPO, 'scripts/probe-onec-lsp-compat.mjs'), candidate], { cwd: REPO, timeout: 115000, maxBuffer: 1024 * 1024 })
  const outcome = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)), report = JSON.parse(await readFile(outcome.reportPath, 'utf8'))
  assert.equal(outcome.status, 'PASS'); assert.equal(report.status, 'PASS')
  assert.deepEqual(report.tools, [...ONEC_LSP_TOOL_NAMES])
  assert.equal(report.activation.enabled, true); assert.equal(report.activation.fiberState, 2)
  assert.equal(report.emptyServerResult.code, 'LSP_ACTION_UNAVAILABLE')
  assert.equal(report.modelAttempts, 0); assert.equal(report.subprocessAttempts, 0); assert.equal(report.mcpCalls, 0)
  assert.equal(report.serverValidation, 'NOT_RUN')
})
