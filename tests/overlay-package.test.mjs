import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stageOverlay } from '../scripts/stage-overlay.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const RELEASE = '20261103-134539'

async function rulepack() {
  const root = await mkdtemp(join(tmpdir(), 'airules-overlay-pack-'))
  for (const dir of ['contract', 'rules', 'roles', 'testing', 'skills/demo']) await mkdir(join(root, dir), { recursive: true })
  const content = {
    'contract/AGENTS.bundle.md': '# Contract\nCall airules_rule.\n',
    'rules/alpha.md': '# Alpha\n',
    'roles/developer.md': '# Developer\nImplement.\n',
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
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n',
  }
  const files = {}
  for (const [relative, text] of Object.entries(content)) {
    const bytes = Buffer.from(text)
    await writeFile(join(root, relative), bytes)
    files[relative] = { sha256: hash(bytes), bytes: bytes.length, kind: relative.startsWith('rules/') ? 'rule' : relative.startsWith('skills/') ? 'skill' : 'contract' }
  }
  files['testing/default.json'].id = 'default'
  files['testing/default.json'].kind = 'testing'
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    package: { id: 'airules-dsh-rulepack', version: 'test.1' },
    source: { dirty: false, revision: 'test' },
    counts: { files: 5, rules: 1, roles: 1, skills: 1, testing: 1 },
    mcp: { mode: 'logical-only', logical_roles: ['code-facade'] },
    files,
    inventories: {
      rules: [{ id: 'alpha', path: 'rules/alpha.md', sha256: files['rules/alpha.md'].sha256, kind: 'invariant', description: 'Alpha' }],
      roles: [{ id: 'developer', path: 'roles/developer.md', sha256: files['roles/developer.md'].sha256, purpose: 'Implementation', tier: 'high', effort: 'medium' }],
    },
  }, null, 2), 'utf8')
  return root
}

async function tree(root) {
  const { readdir } = await import('node:fs/promises')
  const result = {}
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else result[path.slice(root.length + 1).replaceAll('\\', '/')] = await readFile(path)
    }
  }
  await walk(root)
  return result
}

test('stages a deterministic, release-guarded provider and rulepack payload', async () => {
  const pack = await rulepack(), temp = await mkdtemp(join(tmpdir(), 'airules-overlay-out-'))
  try {
    const first = join(temp, 'first'), second = join(temp, 'second')
    const one = await stageOverlay({ rulepackRoot: pack, output: first, targetRelease: RELEASE })
    const two = await stageOverlay({ rulepackRoot: pack, output: second, targetRelease: RELEASE })
    assert.deepEqual(await tree(first), await tree(second))
    assert.deepEqual(one, two)
    assert.equal(one.schemaVersion, 2)
    assert.equal(one.target.releaseId, RELEASE)
    assert.equal(one.rulepack.mcpMode, 'logical-only')
    assert.equal(one.install.rulepackTarget, 'profiles/node_modules/airules-dsh-rulepack')
    assert.equal(one.releasePatch.required, true)
    assert.equal(one.releasePatch.engine, 'exact-text-replacements/v1')
    assert.deepEqual(one.releasePatch.preset, { id: '1c-airules', label: '1С' })
    assert.equal(one.releasePatch.files.length, 7)
    assert.ok(one.releasePatch.files.every(file => /^[a-f0-9]{64}$/u.test(file.sourceSha256) && /^[a-f0-9]{64}$/u.test(file.resultSha256)))
    assert.ok(one.files[one.releasePatch.source])
    assert.match(await readFile(join(first, 'cordis.patch.fragment.yml'), 'utf8'), /airules-dsh-provider/u)
    assert.match(await readFile(join(first, 'cordis.patch.fragment.yml'), 'utf8'), /projectPresets/u)
    const patch = JSON.parse(await readFile(join(first, one.releasePatch.source), 'utf8'))
    assert.equal(patch.id, 'project-preset-1c-airules')
    assert.equal(JSON.stringify(patch).includes('mcp__'), false)
    assert.equal(JSON.stringify(one).includes(pack), false)
    const staged = await tree(first)
    delete staged['overlay-manifest.json']
    assert.equal(Object.keys(one.files).length, Object.keys(staged).length)
    for (const [relative, record] of Object.entries(one.files)) {
      assert.ok(staged[relative], relative)
      assert.equal(record.sha256, hash(staged[relative]), relative)
      assert.equal(record.bytes, staged[relative].byteLength, relative)
    }
  } finally { await rm(pack, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }) }
})

test('refuses an unknown target release and an existing output', async () => {
  const pack = await rulepack(), temp = await mkdtemp(join(tmpdir(), 'airules-overlay-refuse-'))
  try {
    await assert.rejects(() => stageOverlay({ rulepackRoot: pack, output: join(temp, 'bad-release'), targetRelease: 'other' }), /TARGET_RELEASE_MISMATCH/u)
    const output = join(temp, 'existing'); await mkdir(output)
    await writeFile(join(output, 'keep.txt'), 'keep\n', 'utf8')
    await assert.rejects(() => stageOverlay({ rulepackRoot: pack, output, targetRelease: RELEASE }), /OUTPUT_EXISTS/u)
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'keep\n')
  } finally { await rm(pack, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }) }
})

test('refuses a rulepack whose declared non-rule payload was tampered', async () => {
  const pack = await rulepack(), temp = await mkdtemp(join(tmpdir(), 'airules-overlay-tamper-'))
  try {
    await writeFile(join(pack, 'skills', 'demo', 'SKILL.md'), 'tampered\n', 'utf8')
    await assert.rejects(() => stageOverlay({ rulepackRoot: pack, output: join(temp, 'output'), targetRelease: RELEASE }), /RULEPACK_FILE_MISMATCH/u)
  } finally { await rm(pack, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }) }
})

