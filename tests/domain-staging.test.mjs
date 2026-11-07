import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'

const rulepack = 'D:/AI_Projects/project_rules/var/rulepack/airules-0.12.0-dev8'
test('domain staging copies canonical policy instead of seed contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'domain-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const layers = join(root, 'layers')
  for (const domain of ['python', 'sysadmin']) for (const kind of ['rules', 'skills']) {
    await mkdir(join(layers, domain), { recursive: true })
    await cp(resolve('src/domain-presets', kind, domain), join(layers, domain, kind), { recursive: true })
  }
  await writeFile(join(layers, 'python/rules/environment.md'), '# Canonical policy test\n')
  const artifactVersion = 'domain-test.1', output = join(root, `airules-official-policy-${artifactVersion}`)
  const manifest = await stageOfficialPolicy({ rulepack, output, artifactVersion, includeOpenSpec: false, includeDomainPresets: true, domainRulesRoot: layers })
  assert.equal(manifest.integrations.domainPresets.policyOwner, 'project_rules')
  assert.equal(await readFile(join(output, 'payload/packages/airules-dsh-domain-presets/rules/python/environment.md'), 'utf8'), '# Canonical policy test\n')
  await rm(join(layers, 'sysadmin/rules/change.md'))
  await assert.rejects(stageOfficialPolicy({ rulepack, output: join(root, 'airules-official-policy-domain-test.2'), artifactVersion: 'domain-test.2', includeOpenSpec: false, includeDomainPresets: true, domainRulesRoot: layers }), /CANONICAL_DOMAIN_INVENTORY_MISMATCH/)
})
test('domain policy requires an explicit canonical source', async () => {
  await assert.rejects(stageOfficialPolicy({ rulepack, output: 'unused', artifactVersion: 'test', includeDomainPresets: true }), /CANONICAL_DOMAIN_RULES_REQUIRED/)
})
