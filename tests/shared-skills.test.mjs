import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stageSharedSkills, SHARED_SKILLS } from '../scripts/stage-shared-skills.mjs'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { createPresets } from '../src/domain-presets/composition.mjs'
import { DEFAULTS, selectCatalog } from '../src/skills-integration/lib/assignments.js'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shared-skills-')), rulepack = join(root, 'rulepack'), target = join(root, 'domain')
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = { package: { id: 'airules-dsh-rulepack' }, files: {}, inventories: { skills: [] } }
  for (const name of SHARED_SKILLS) {
    const text = `---\nname: ${name}\ndescription: Shared fixture\n---\n\nUse this fixture.\n`
    await mkdir(join(rulepack, 'skills', name), { recursive: true })
    await writeFile(join(rulepack, 'skills', name, 'SKILL.md'), text)
    manifest.files[`skills/${name}/SKILL.md`] = { id: name, kind: 'skill', bytes: Buffer.byteLength(text), sha256: sha(text) }
    manifest.inventories.skills.push({ id: name, path: `skills/${name}/SKILL.md`, sha256: sha(text), files: 1 })
  }
  await writeFile(join(rulepack, 'manifest.json'), JSON.stringify(manifest))
  return { root, rulepack, target, manifest, save: () => writeFile(join(rulepack, 'manifest.json'), JSON.stringify(manifest)) }
}

test('domain shared closures preserve bytes and notices and never copy adjacent domain skills', async t => {
  const f = await fixture(t), name = SHARED_SKILLS[0], notice = 'Copyright and license notice\n'
  await writeFile(join(f.rulepack, 'skills', name, 'NOTICE'), notice)
  f.manifest.files[`skills/${name}/NOTICE`] = { id: name, kind: 'skill', bytes: Buffer.byteLength(notice), sha256: sha(notice) }
  f.manifest.inventories.skills[0].files++
  await mkdir(join(f.rulepack, 'skills/1c-never-share'))
  await writeFile(join(f.rulepack, 'skills/1c-never-share/SKILL.md'), 'not shared')
  await f.save()
  assert.deepEqual(await stageSharedSkills(f.rulepack, f.target), [...SHARED_SKILLS])
  assert.equal(await readFile(join(f.target, 'skills/common', name, 'NOTICE'), 'utf8'), notice)
  await assert.rejects(readFile(join(f.target, 'skills/common/1c-never-share/SKILL.md')), { code: 'ENOENT' })
})

test('source drift or undeclared resources cannot enter a shared closure', async t => {
  const f = await fixture(t)
  await writeFile(join(f.rulepack, 'skills', SHARED_SKILLS[0], 'SKILL.md'), 'changed')
  await assert.rejects(stageSharedSkills(f.rulepack, f.target), /SHARED_SKILL_CLOSURE_INVALID/)
  const g = await fixture(t)
  await writeFile(join(g.rulepack, 'skills', SHARED_SKILLS[0], 'extra.txt'), 'undeclared')
  await assert.rejects(stageSharedSkills(g.rulepack, g.target), /SHARED_SKILL_CLOSURE_INVALID/)
})

test('shared policy is opt-in at composition and requires the domain integration at staging', async () => {
  assert.ok(createPresets().every(row => !row.plugins.find(plugin => plugin.id === 'domain-policy').config.sharedSkills))
  assert.ok(createPresets({ sharedSkills: true }).every(row => row.plugins.find(plugin => plugin.id === 'domain-policy').config.sharedSkills === true))
  assert.throws(() => createPresets({ sharedSkills: 'true' }), /SHARED_SKILLS_BOOLEAN_REQUIRED/)
  await assert.rejects(stageOfficialPolicy({ includeSharedSkills: true }), /SHARED_SKILLS_REQUIRE_DOMAIN_PRESETS/)
})

test('new built-in assignments select useful catalogue entries without restricting unknown skills', () => {
  const rows = [...SHARED_SKILLS, '1c-business-tests', '1c-ui-regression', '1c-verify-project', 'external-plugin'].map(name => ({ name }))
  const context = { taskType: 'testing', role: 'tester', accessMode: 'read-only' }
  const names = selectCatalog(rows, context, DEFAULTS).map(row => row.name)
  for (const name of ['handoff', '1c-business-tests', '1c-ui-regression', '1c-verify-project', 'external-plugin']) assert.ok(names.includes(name))
  assert.ok(!names.includes('skill-maintainer'))
  assert.ok(selectCatalog(rows, { ...context, taskType: 'code-review' }, DEFAULTS).some(row => row.name === 'security-baseline'))
})
