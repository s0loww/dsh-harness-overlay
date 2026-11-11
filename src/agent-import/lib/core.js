import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, mkdir, writeFile, rename, unlink, open } from 'node:fs/promises'
import { resolve, join, relative, dirname, extname, sep, isAbsolute } from 'node:path'
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(code) }
const missing = error => error.code === 'ENOENT'
const secret = text => /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})|(?:api[_-]?key|password|passwd|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"'<${][^\s"']{7,})/iu.test(text)
const SCRIPTS = new Set(['.py', '.ps1', '.psm1', '.js', '.mjs', '.cjs', '.ts', '.sh', '.cmd', '.bat'])
const ALLOWED = new Set(['.md', '.mdc', '.txt', '.json', '.yaml', '.yml', '.svg', '.png', '.jpg', '.jpeg', '.webp', ...SCRIPTS])
const TEXT = new Set(['.md', '.mdc', '.txt', '.json', '.yaml', '.yml', '.svg', ...SCRIPTS])
const LIMIT = 1024 * 1024, TOTAL = 8 * LIMIT
// Shared wire format with skills-integration; native discovery sees a disabled
// shadow while the manager retains and can restore the original exact bytes.
function disabledImportedSkill(entry, original) {
  return `---\nname: ${entry.title}\ndescription: ${JSON.stringify(`Импортированный навык ${entry.title}; включите после проверки исходников.`)}\ndisable-model-invocation: true\nuser-invocable: false\nairules-disabled-shadow: 1\nairules-disabled-origin-sha256: ${hash(original)}\n---\n\nНавык отключён после импорта. Проверьте исходники и включите в настройках DSH.\n`
}
export const ORIGINS = ['claude', 'codex', 'cursor', 'opencode']
export async function safePath(root, path, create = false) {
  root = resolve(root); path = resolve(path)
  const rel = relative(root, path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) fail('PATH_REJECTED')
  let at = root
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    at = part ? join(at, part) : at
    try { const st = await lstat(at); if (st.isSymbolicLink()) fail('LINK_REJECTED'); if (at !== path && !st.isDirectory()) fail('PATH_REJECTED') }
    catch (e) { if (!missing(e)) throw e; if (!create) return path }
  }
  return path
}
async function bytes(root, path) {
  await safePath(root, path)
  try { const st = await lstat(path); if (!st.isFile() || st.nlink !== 1 || st.size > LIMIT) fail('FILE_REJECTED'); return await readFile(path) }
  catch (e) { if (missing(e)) return null; throw e }
}
async function names(root, path) {
  await safePath(root, path)
  try { const rows = await readdir(path, { withFileTypes: true }); if (rows.length > 512) fail('ENTRY_LIMIT'); return rows.sort((a, b) => a.name.localeCompare(b.name)) }
  catch (e) { if (missing(e)) return []; throw e }
}
function cleanRule(text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)
  if (!frontmatter) return text.trim()
  return `Applicability: preserve the original rule restrictions below. Apply this rule only to matching files/tasks; if applicability is uncertain, do not apply it automatically.\n\nOriginal rule metadata:\n\`\`\`yaml\n${frontmatter[1]}\n\`\`\`\n\n${text.slice(frontmatter[0].length).trim()}`
}
function roots(options) {
  const { origin, scope, projectRoot, userHome, dshHome } = options
  if (!ORIGINS.includes(origin) || !['project', 'global'].includes(scope)) fail('OPTIONS_REJECTED')
  const base = resolve(scope === 'project' ? projectRoot : userHome), target = resolve(scope === 'project' ? projectRoot : dshHome)
  const paths = origin === 'claude' ? { rule: scope === 'project' ? 'CLAUDE.md' : '.claude/CLAUDE.md', rules: '.claude/rules', skills: '.claude/skills' }
    : origin === 'codex' ? { rule: scope === 'project' ? 'AGENTS.md' : '.codex/AGENTS.md', rules: '.codex/rules', skills: '.codex/skills', extraSkills: '.agents/skills' }
    : origin === 'cursor' ? { rule: '.cursorrules', rules: '.cursor/rules', skills: '.cursor/skills' }
    : { rule: scope === 'project' ? 'AGENTS.md' : '.config/opencode/AGENTS.md', skills: scope === 'project' ? '.opencode/skills' : '.config/opencode/skills' }
  return { base, target, paths, skillsTarget: join(target, scope === 'project' ? '.dsh/skills' : 'skills') }
}
async function scan(options) {
  const { base, target, paths, skillsTarget } = roots(options), entries = [], skipped = []; let total = 0
  async function rule(path) {
    const data = await bytes(base, path); if (!data) return
    const source = relative(base, path).replaceAll('\\', '/'), id = hash(`rule:${source}`).slice(0, 20)
    if (secret(data.toString())) { skipped.push({ source, reason: 'Содержимое похоже на реквизиты доступа; импорт запрещён.' }); return }
    if (resolve(path) === join(target, 'AGENTS.md') || (options.scope === 'project' && resolve(path) === join(base, 'CLAUDE.md'))) { skipped.push({ source, reason: 'DSH уже читает этот файл штатно; копирование не требуется.' }); return }
    total += data.length
    entries.push({ id, kind: 'rule', source, title: source, files: [{ path: source, data }], content: cleanRule(data.toString()), destination: 'AGENTS.md' })
  }
  await rule(join(base, paths.rule))
  if (paths.rules) for (const row of await names(base, join(base, paths.rules))) {
    if (row.isFile() && ['.md', '.mdc'].includes(extname(row.name).toLowerCase())) await rule(join(base, paths.rules, row.name))
  }
  for (const root of [paths.skills, paths.extraSkills].filter(Boolean)) for (const row of await names(base, join(base, root))) {
    if (!row.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(row.name)) continue
    const skillRoot = join(base, root, row.name), files = [], source = relative(base, skillRoot).replaceAll('\\', '/'); let blocked = false
    async function walk(dir, depth = 0) {
      if (depth > 5 || files.length > 128) fail('ENTRY_LIMIT')
      for (const child of await names(base, dir)) {
        const path = join(dir, child.name)
        if (child.isSymbolicLink()) { blocked = true; continue }
        if (child.isDirectory()) { if (!['.git', 'node_modules', '__pycache__'].includes(child.name)) await walk(path, depth + 1); continue }
        const ext = extname(child.name).toLowerCase(), licenseText = /^(?:NOTICE|LICENSE|COPYING)$/iu.test(child.name)
        if ((!ALLOWED.has(ext) && !licenseText) || /^\./u.test(child.name)) { blocked = true; continue }
        const data = await bytes(base, path); if (!data) continue
        if (licenseText && (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data))) { blocked = true; continue }
        if ((TEXT.has(ext) || licenseText) && secret(data.toString())) { blocked = true; continue }
        files.push({ path: relative(skillRoot, path), data }); total += data.length
      }
    }
    await walk(skillRoot)
    const main = files.find(file => file.path === 'SKILL.md')
    const skillName = main?.data.toString().match(/^name:\s*["']?([a-z0-9][a-z0-9-]{0,63})["']?\s*$/mu)?.[1]
    if (blocked || !main || !/^---\r?\n/u.test(main.data.toString()) || skillName !== row.name || !/^description:\s*\S+/mu.test(main.data.toString())) {
      skipped.push({ source, reason: 'Нужен полный безопасный SKILL.md; пакет со ссылками, двоичными программами, неподдерживаемыми файлами или реквизитами не импортируется.' }); continue
    }
    entries.push({ id: hash(`skill:${source}`).slice(0, 20), kind: 'skill', title: row.name, source, files, content: main.data.toString(), hasScripts: files.some(file => SCRIPTS.has(extname(file.path).toLowerCase())), inventory: files.map(file => ({ path: file.path.replaceAll('\\', '/'), bytes: file.data.length, script: SCRIPTS.has(extname(file.path).toLowerCase()) })), destination: relative(target, join(skillsTarget, row.name)).replaceAll('\\', '/') })
  }
  if (total > TOTAL || entries.length > 128) fail('IMPORT_LIMIT')
  const agents = await bytes(target, join(target, 'AGENTS.md'))
  for (const entry of entries) {
    entry.sourceDigest = hash(Buffer.concat(entry.files.flatMap(file => [Buffer.from(file.path), file.data])))
    if (entry.kind === 'rule') { const start = `<!-- airules-import:${entry.id} -->`, end = `<!-- /airules-import:${entry.id} -->`; entry.block = `${start}\n### Imported ${options.origin}: ${entry.source}\n\n${entry.content}\n${end}`; entry.status = agents?.toString().includes(entry.block) ? 'identical' : agents?.toString().includes(start) ? 'conflict' : 'new' }
    else {
      const dest = join(target, entry.destination), existing = await names(target, dest)
      if (!existing.length) { try { await lstat(dest); entry.status = 'conflict' } catch(e) { if (!missing(e)) throw e; entry.status = 'new' } }
      else {
        let same = true
        // Existing bundles are never overwritten, even when source names match.
        for (const file of entry.files) {
          const current = await bytes(target, join(dest, file.path))
          if (current?.equals(file.data)) continue
          if (file.path === 'SKILL.md' && entry.hasScripts && current?.toString().includes(`airules-disabled-origin-sha256: ${hash(file.data)}`)) {
            const original = await bytes(target, join(dest, 'SKILL.md.disabled'))
            if (original?.equals(file.data)) continue
          }
          same = false
        }
        entry.status = same ? 'identical' : 'conflict'
      }
    }
  }
  return { entries, skipped, agents, target, revision: hash(JSON.stringify({ origin: options.origin, scope: options.scope, target, agents: agents ? hash(agents) : null, entries: entries.map(e => [e.id, e.sourceDigest, e.status]) })) }
}
export async function previewImport(options) {
  const result = await scan(options)
  return { revision: result.revision, target: result.target, skipped: result.skipped, entries: result.entries.map(({ files, block, ...entry }) => ({ ...entry, fileCount: files.length, bytes: files.reduce((n, f) => n + f.data.length, 0) })) }
}
export async function applyImport(options, request) {
  if (!Array.isArray(request.selected) || !request.selected.length || request.selected.length > 128 || new Set(request.selected).size !== request.selected.length) fail('SELECTION_REQUIRED')
  const result = await scan(options)
  await options.verifyProject?.()
  if (request.revision !== result.revision) fail('STALE_PREVIEW')
  const selected = request.selected.map(id => result.entries.find(entry => entry.id === id))
  if (selected.some(entry => !entry || entry.status !== 'new')) fail('CONFLICT_REJECTED')
  const run = randomUUID(), backupRoot = join(options.dshHome, 'agent-import', 'backups', run), lock = join(result.target, '.airules-import.lock')
  await options.verifyProject?.()
  await safePath(result.target, lock, true); const handle = await open(lock, 'wx').catch(() => fail('IMPORT_BUSY'))
  const created = []; let agentsChanged = false, temp
  try {
    if ((await scan(options)).revision !== request.revision) fail('STALE_PREVIEW')
    await safePath(options.dshHome, backupRoot, true); await mkdir(backupRoot, { recursive: true })
    const rules = selected.filter(e => e.kind === 'rule')
    if (rules.length) {
      if (result.agents) await writeFile(join(backupRoot, 'AGENTS.md'), result.agents, { flag: 'wx', mode: 0o600 })
      const merged = `${result.agents?.toString() ?? ''}\n\n${rules.map(e => e.block).join('\n\n')}\n`
      if (Buffer.byteLength(merged) > LIMIT) fail('IMPORT_LIMIT')
      temp = join(result.target, `.airules-import-${run}.tmp`)
      await writeFile(temp, merged, { flag: 'wx', mode: 0o600 })
    }
    for (const entry of selected.filter(e => e.kind === 'skill')) {
      await options.verifyProject?.()
      const dest = join(result.target, entry.destination)
      await safePath(result.target, dest, true); await mkdir(dirname(dest), { recursive: true }); await mkdir(dest); created.push(dest)
      for (const file of entry.files) {
        await options.verifyProject?.()
        const path = join(dest, file.path); await safePath(result.target, path, true); await mkdir(dirname(path), { recursive: true })
        if (file.path === 'SKILL.md' && entry.hasScripts) {
          // Write the original under a non-discovered name first, then the
          // disabled shadow. Script-bearing imports never become invocable.
          await writeFile(join(dest, 'SKILL.md.disabled'), file.data, { flag: 'wx', mode: 0o600 })
          await writeFile(path, disabledImportedSkill(entry, file.data), { flag: 'wx', mode: 0o600 })
        } else await writeFile(path, file.data, { flag: 'wx', mode: 0o600 })
      }
    }
    await options.verifyProject?.()
    if (temp) { const current = await bytes(result.target, join(result.target, 'AGENTS.md')); if (hash(current ?? '') !== hash(result.agents ?? '')) fail('STALE_PREVIEW'); await rename(temp, join(result.target, 'AGENTS.md')); temp = undefined; agentsChanged = true }
    await writeFile(join(backupRoot, 'receipt.json'), JSON.stringify({ schemaVersion: 1, id: run, target: result.target, agentsChanged, selected: selected.map(e => ({ id: e.id, source: e.source, destination: e.destination, digest: e.sourceDigest })) }, null, 2), { flag: 'wx', mode: 0o600 })
    return { imported: selected.length, backupId: run, target: result.target }
  } catch (error) {
    // Avoid deleting a bundle that another process may already have modified.
    // A failed partial copy remains visible as a conflict and can be reviewed.
    if (created.length || agentsChanged) error.partial = true
    throw error
  } finally { if (temp) await unlink(temp).catch(() => {}); await handle.close(); await unlink(lock).catch(() => {}) }
}
