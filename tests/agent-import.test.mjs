import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewImport, applyImport } from '../src/agent-import/lib/core.js'
async function env(origin = 'cursor', scope = 'project') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-')), projectRoot = join(root, 'project'), userHome = join(root, 'user'), dshHome = join(root, 'dsh')
  for (const path of [projectRoot, userHome, dshHome]) await mkdir(path)
  return { root, projectRoot, userHome, dshHome, origin, scope }
}
async function put(root, path, value) { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value) }
const skill = '---\nname: sample\ndescription: Example skill\n---\nHello'
test('preview never writes; selected rule appends preserving existing orchestration and backs up', async () => {
  const e = await env(); await put(e.projectRoot, '.cursor/rules/example.mdc', 'Only run tests when needed.'); await put(e.projectRoot, 'AGENTS.md', 'Original orchestration')
  const p = await previewImport(e); assert.equal(p.entries.length, 1); assert.equal(await readFile(join(e.projectRoot, 'AGENTS.md'), 'utf8'), 'Original orchestration')
  const r = await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }); assert.equal(r.imported, 1)
  assert.match(await readFile(join(e.projectRoot, 'AGENTS.md'), 'utf8'), /^Original orchestration[\s\S]*Only run tests/u)
  assert.equal(await readFile(join(e.dshHome, 'agent-import/backups', r.backupId, 'AGENTS.md'), 'utf8'), 'Original orchestration')
  assert.equal((await previewImport(e)).entries[0].status, 'identical')
})
test('source changes invalidate preview before writing', async () => {
  const e = await env(); await put(e.projectRoot, '.cursorrules', 'one'); const p = await previewImport(e); await put(e.projectRoot, '.cursorrules', 'two')
  await assert.rejects(applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }), /STALE_PREVIEW/u)
  assert.ok(!(await readdir(e.projectRoot)).includes('AGENTS.md'))
})
test('destination changes invalidate preview', async () => {
  const e = await env(); await put(e.projectRoot, '.cursorrules', 'one'); const p = await previewImport(e); await put(e.projectRoot, 'AGENTS.md', 'new owner rules')
  await assert.rejects(applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }), /STALE_PREVIEW/u)
})
test('copy skill documentation/resources to native directory', async () => {
  const e = await env('claude'); await put(e.projectRoot, '.claude/skills/sample/SKILL.md', skill); await put(e.projectRoot, '.claude/skills/sample/docs/example.md', 'docs')
  const p = await previewImport(e); assert.equal(p.entries[0].fileCount, 2); await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] })
  assert.equal(await readFile(join(e.projectRoot, '.dsh/skills/sample/SKILL.md'), 'utf8'), skill)
  assert.equal((await previewImport(e)).entries[0].status, 'identical')
})

test('license resources survive an import without allowing arbitrary extensionless files', async () => {
  const e = await env('claude'); await put(e.projectRoot, '.claude/skills/sample/SKILL.md', skill)
  for (const name of ['NOTICE', 'LICENSE', 'COPYING']) await put(e.projectRoot, `.claude/skills/sample/${name}`, 'Copyright holder\nPermission notice\n')
  const p = await previewImport(e); assert.equal(p.entries[0].fileCount, 4)
  await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] })
  for (const name of ['NOTICE', 'LICENSE', 'COPYING']) assert.equal(await readFile(join(e.projectRoot, '.dsh/skills/sample', name), 'utf8'), 'Copyright holder\nPermission notice\n')
  const f = await env('claude'); await put(f.projectRoot, '.claude/skills/sample/SKILL.md', skill); await put(f.projectRoot, '.claude/skills/sample/execute', 'arbitrary executable')
  assert.equal((await previewImport(f)).entries.length, 0)
  const g = await env('claude'); await put(g.projectRoot, '.claude/skills/sample/SKILL.md', skill); await put(g.projectRoot, '.claude/skills/sample/NOTICE', Buffer.from([0, 255, 0]))
  assert.equal((await previewImport(g)).entries.length, 0)
})
test('existing skill conflicts are not overwritten', async () => {
  const e = await env('claude'); await put(e.projectRoot, '.claude/skills/sample/SKILL.md', skill); await put(e.projectRoot, '.dsh/skills/sample/SKILL.md', 'owner')
  const p = await previewImport(e); assert.equal(p.entries[0].status, 'conflict'); await assert.rejects(applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }), /CONFLICT_REJECTED/u)
  assert.equal(await readFile(join(e.projectRoot, '.dsh/skills/sample/SKILL.md'), 'utf8'), 'owner')
})
test('script-bearing skill is copied as data with preview inventory and never executed', async () => {
  const e = await env('claude'); await put(e.projectRoot, '.claude/skills/sample/SKILL.md', skill); await put(e.projectRoot, '.claude/skills/sample/run.ps1', 'Write-Output 1')
  const p = await previewImport(e); assert.equal(p.entries.length, 1); assert.equal(p.entries[0].hasScripts, true); assert.ok(p.entries[0].inventory.find(file => file.path === 'run.ps1' && file.script))
  await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }); assert.equal(await readFile(join(e.projectRoot, '.dsh/skills/sample/run.ps1'), 'utf8'), 'Write-Output 1')
  assert.match(await readFile(join(e.projectRoot, '.dsh/skills/sample/SKILL.md'), 'utf8'), /disable-model-invocation: true[\s\S]*user-invocable: false/u)
  assert.equal(await readFile(join(e.projectRoot, '.dsh/skills/sample/SKILL.md.disabled'), 'utf8'), skill)
  assert.equal((await previewImport(e)).entries[0].status, 'identical')
})
test('credentials-like content is not exposed in preview', async () => {
  const e = await env(); await put(e.projectRoot, '.cursorrules', 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456789')
  const p = await previewImport(e); assert.equal(p.entries.length, 0); assert.ok(!JSON.stringify(p).includes('sk-abc'))
})
test('global imports target DSH home, not project', async () => {
  const e = await env('codex', 'global'); await put(e.userHome, '.codex/AGENTS.md', 'Global rules'); const p = await previewImport(e)
  await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }); assert.match(await readFile(join(e.dshHome, 'AGENTS.md'), 'utf8'), /Global rules/u); assert.deepEqual(await readdir(e.projectRoot), [])
})
test('native project AGENTS and CLAUDE instructions are not duplicated', async () => {
  for (const origin of ['claude', 'codex', 'opencode']) { const e = await env(origin); await put(e.projectRoot, origin === 'claude' ? 'CLAUDE.md' : 'AGENTS.md', 'native'); const p = await previewImport(e); assert.equal(p.entries.length, 0); assert.equal(p.skipped.length, 1) }
})
test('unknown source and arbitrary selection rejected', async () => {
  const e = await env(); await assert.rejects(previewImport({ ...e, origin: '../escape' }), /OPTIONS_REJECTED/u)
  const p = await previewImport(e); await assert.rejects(applyImport(e, { revision: p.revision, selected: ['injected'] }), /CONFLICT_REJECTED/u)
})
test('changed managed blocks are a conflict', async () => {
  const e = await env(); await put(e.projectRoot, '.cursorrules', 'first'); let p = await previewImport(e); await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }); await put(e.projectRoot, '.cursorrules', 'second'); p = await previewImport(e); assert.equal(p.entries[0].status, 'conflict')
})
test('import busy does not overwrite lock', async () => {
  const e = await env(); await put(e.projectRoot, '.cursorrules', 'first'); const p = await previewImport(e); await put(e.projectRoot, '.airules-import.lock', 'busy')
  await assert.rejects(applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }), /IMPORT_BUSY/u); assert.equal(await readFile(join(e.projectRoot, '.airules-import.lock'), 'utf8'), 'busy')
})
test('linked source root rejected', async t => {
  const e = await env('claude'); await mkdir(join(e.root, 'external')); try { await symlink(join(e.root, 'external'), join(e.projectRoot, '.claude'), 'junction') } catch { t.skip('Host cannot create junction'); return }
  await assert.rejects(previewImport(e), /LINK_REJECTED/u)
})
test('Cursor applicability survives conversion and is visible before apply', async () => {
  const e = await env(); await put(e.projectRoot, '.cursor/rules/a.mdc', '---\nglobs: "**/*.bsl"\nalwaysApply: false\n---\nCheck BSL code.')
  const p = await previewImport(e); assert.match(p.entries[0].content, /only to matching files/u); assert.match(p.entries[0].content, /globs: "\*\*\/\*\.bsl"/u)
  await applyImport(e, { revision: p.revision, selected: [p.entries[0].id] }); assert.match(await readFile(join(e.projectRoot, 'AGENTS.md'), 'utf8'), /alwaysApply: false/u)
})
test('skill frontmatter name cannot shadow another skill name', async () => {
  const e = await env('claude'); await put(e.projectRoot, '.claude/skills/sample/SKILL.md', skill.replace('name: sample', 'name: protected-rules'))
  const p = await previewImport(e); assert.equal(p.entries.length, 0); assert.equal(p.skipped.length, 1)
})
