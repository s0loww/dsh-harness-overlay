import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const candidate = resolve(process.env.AIRULES_NATIVE_CANDIDATE ?? join(REPO, 'var/candidate/official-desktop-rc5-25'))
test('pinned native DSH executes specialized fixture and PTC-owned background job without models', { timeout: 180000 }, async t => {
  if (!await access(join(candidate, 'home/profiles/desktop/cordis.patch.yml')).then(() => true, () => false)) return t.skip('Explicit local native candidate is unavailable; this is not a runtime PASS')
  const { stdout } = await promisify(execFile)(process.execPath, [join(REPO, 'scripts/probe-onec-specialized-native.mjs'), '--candidate-root', candidate], { cwd: REPO, timeout: 175000, maxBuffer: 1024 * 1024 })
  const summary = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
  assert.equal(summary.status, 'PASS'); assert.ok(summary.checks >= 20)
  const report = JSON.parse(await readFile(summary.reportPath, 'utf8'))
  assert.equal(report.modelRequestAttempts, 0); assert.equal(report.externalMcpCalls, 0); assert.equal(report.realOnecCalls, 0); assert.equal(report.deployments, 0)
  assert.deepEqual(report.specializedRunnerNativeProof, { spawnCalls: 1, confineCalls: 1 })
  assert.equal(report.nativeApprovalCalls, 1); assert.equal(report.localFixtureToolCalls, 1)
  assert.equal(report.bundledBridgeNativeProof.status, 'passed'); assert.equal(report.bundledBridgeNativeProof.rawOutputExposed, false)
  assert.equal(report.result.status, 'passed'); assert.equal(report.result.fixture, true); assert.equal(report.result.projectCertified, false)
  assert.ok(report.checks.every(row => row.passed))
})
