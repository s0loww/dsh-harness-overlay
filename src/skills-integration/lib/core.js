import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, mkdir, writeFile, rename, unlink, link } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const MAX_BODY = 512 * 1024
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const digest = text => createHash('sha256').update(text).digest('hex')
export const skillId = (root, file) => digest(`${resolve(root)}\0${relative(root, file)}`)
const absent = error => error.code === 'ENOENT'
export function inside(root, path) { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)) }
export async function safePath(root, path) {
  if (!inside(root, path)) throw new Error('PATH_REJECTED')
  const base = resolve(root), parts = relative(base, resolve(path)).split(sep).filter(Boolean)
  for (let index = 0; index <= parts.length; index++) {
    const target = join(base, ...parts.slice(0, index))
    let st; try { st = await lstat(target) } catch (error) { if (absent(error)) continue; throw error }
    if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) throw new Error('PATH_REJECTED')
  }
}
export function parseSkill(raw, parseYaml) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY || raw.includes('\0')) throw new Error('SKILL_INVALID')
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('SKILL_FRONTMATTER_REQUIRED')
  let data; try { data = parseYaml(match[1]) } catch { throw new Error('SKILL_INVALID') }
  if (!data || typeof data !== 'object' || !NAME.test(data.name ?? '') || typeof data.description !== 'string' || !data.description.trim()) throw new Error('SKILL_INVALID')
  if (['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(key => Object.hasOwn(data, key))) throw new Error('SKILL_INVALID')
  const modelInvocable = booleanField(data, 'disable-model-invocation') !== true, userInvocable = booleanField(data, 'user-invocable') !== false
  const managedDisabled = data['airules-disabled-shadow'] === 1
  return { name: data.name, description: data.description.slice(0, 4096), body: match[2], managedDisabled, originRevision: data['airules-disabled-origin-sha256'] ?? null, modelInvocable, userInvocable, nativePolicyDisabled: !managedDisabled && !modelInvocable && !userInvocable }
}
function booleanField(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  if (typeof data[key] === 'boolean') return data[key]
  if ([1, '1'].includes(data[key])) return true
  if ([0, '0'].includes(data[key])) return false
  if (typeof data[key] === 'string') {
    if (['true', 'yes', 'on'].includes(data[key].toLowerCase())) return true
    if (['false', 'no', 'off'].includes(data[key].toLowerCase())) return false
  }
  throw new Error('SKILL_INVALID')
}
export function skillRoots({ home, agentsHome, projectRoot }) {
  return [
    { root: join(home, 'skills'), scope: 'global', source: 'user-dsh' },
    { root: join(agentsHome, 'skills'), scope: 'global', source: 'user-agents' },
    ...(projectRoot ? [{ root: join(projectRoot, '.dsh', 'skills'), scope: 'project', source: 'project-dsh', anchor: projectRoot }, { root: join(projectRoot, '.agents', 'skills'), scope: 'project', source: 'project-agents', anchor: projectRoot }] : []),
  ]
}
export async function scanFiles(roots, parseYaml) {
  const rows = []; let truncated = false
  for (const root of roots) {
    await safePath(root.anchor ?? dirname(root.root), root.root)
    let entries; try { entries = await readdir(root.root, { withFileTypes: true }) } catch (error) { if (absent(error)) continue; throw error }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (rows.length >= 2000) { truncated = true; break }
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
      const path = join(root.root, entry.name)
      const files = entry.isDirectory() ? [join(path, 'SKILL.md'), join(path, 'SKILL.md.disabled')] : entry.isFile() && /\.md(?:\.disabled)?$/.test(entry.name) ? [path] : []
      for (const file of files) {
        try {
          await safePath(root.anchor ?? dirname(root.root), file)
          const st = await lstat(file); if (!st.isFile() || st.size > MAX_BODY) continue
          const raw = await readFile(file, 'utf8'), parsed = parseSkill(raw, parseYaml)
          rows.push({ ...parsed, id: skillId(root.root, file), revision: digest(raw), scope: root.scope, source: root.source, file, root: root.root, anchor: root.anchor ?? dirname(root.root), enabled: !file.endsWith('.disabled') && !parsed.managedDisabled && !parsed.nativePolicyDisabled, raw })
        } catch (error) { if (!absent(error) && !['SKILL_INVALID', 'SKILL_FRONTMATTER_REQUIRED', 'PATH_REJECTED'].includes(error.message)) throw error }
      }
    }
  }
  return { rows: rows.filter(row => !row.file.endsWith('.disabled') || !rows.some(shadow => shadow.managedDisabled && shadow.file === row.file.slice(0, -'.disabled'.length))), truncated }
}
async function backup(row, backupRoot) {
  const folder = join(backupRoot, randomUUID()); await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'SKILL.md'), row.raw, { flag: 'wx', mode: 0o600 })
  await writeFile(join(folder, 'receipt.json'), JSON.stringify({ schemaVersion: 1, file: row.file, revision: row.revision }), { flag: 'wx', mode: 0o600 })
}
export async function toggleFile(row, enabled, revision, backupRoot) {
  if (typeof enabled !== 'boolean' || revision !== row.revision) throw new Error('STALE_SKILL')
  await safePath(row.anchor, row.file)
  if (digest(await readFile(row.file)) !== revision) throw new Error('STALE_SKILL')
  if (row.managedDisabled) {
    if (!enabled) return false
    await backup(row, backupRoot)
    if (row.originRevision) {
      const original = `${row.file}.disabled`
      await safePath(row.anchor, original)
      if (digest(await readFile(original)) !== row.originRevision) throw new Error('STALE_SKILL')
      // Restore through an exclusive temp hard link, then atomic replacement.
      const temp = `${row.file}.${randomUUID()}.restore`
      await link(original, temp)
      try { await rename(temp, row.file); await unlink(original) } catch (error) { await unlink(temp).catch(() => {}); throw error }
    } else await unlink(row.file)
    return true
  }
  if (row.enabled === enabled) return false
  const target = enabled ? row.file.slice(0, -'.disabled'.length) : `${row.file}.disabled`
  await safePath(row.anchor, target)
  await backup(row, backupRoot)
  if (enabled) {
    await link(row.file, target)
    try { await unlink(row.file) } catch (error) { await unlink(target); throw error }
  } else {
    // Keep original bytes in .disabled and retain a native non-invocable winner.
    // Removing SKILL.md alone could reveal a same-name packaged fallback.
    const raw = disabledShadow(row.name, row.description, row.revision)
    const temp = `${row.file}.${randomUUID()}.tmp`
    await writeFile(temp, raw, { flag: 'wx', mode: 0o600 })
    try { await link(row.file, target); await rename(temp, row.file) } catch (error) { await unlink(temp).catch(() => {}); throw error }
  }
  return true
}
export function disabledShadow(name, description, originRevision = null) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ndisable-model-invocation: true\nuser-invocable: false\nairules-disabled-shadow: 1\n${originRevision ? `airules-disabled-origin-sha256: ${originRevision}\n` : ''}---\n\nНавык отключён пользователем в настройках DSH.\n`
}
export function draftSkill({ name, description, content }) {
  if (!NAME.test(name ?? '') || typeof description !== 'string' || !description.trim() || description.length > 4096 || typeof content !== 'string' || !content.trim()) throw new Error('SKILL_INVALID')
  const raw = `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${content.trim()}\n`
  if (Buffer.byteLength(raw) > MAX_BODY) throw new Error('SKILL_INVALID')
  return raw
}
export async function createSkill(root, fields, parseYaml, { shadow = false } = {}) {
  let raw = draftSkill(fields)
  if (shadow) raw = disabledShadow(fields.name, fields.description)
  parseSkill(raw, parseYaml)
  const folder = join(root.root, fields.name), file = join(folder, 'SKILL.md')
  await safePath(root.anchor ?? dirname(root.root), file)
  await mkdir(folder, { recursive: true })
  await safePath(root.anchor ?? dirname(root.root), file)
  await writeFile(file, raw, { flag: 'wx', mode: 0o600 })
  return { file, revision: digest(raw) }
}
export function publicRow(row, writable) {
  const { id, revision, name, description, scope, source, enabled, modelInvocable, userInvocable, managedDisabled, nativePolicyDisabled, file } = row
  return { id, revision, name, description, scope, source, enabled, modelInvocable, userInvocable, managedDisabled, nativePolicyDisabled, path: file, writable: writable && !nativePolicyDisabled }
}
