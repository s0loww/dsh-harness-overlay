import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const SHARED_SKILLS = Object.freeze(['handoff', 'skill-maintainer', 'security-baseline', 'architecture-evolution', 'technical-debt'])
export const WORKBENCH_SHARED_SKILLS = Object.freeze(['caveman', 'api-conventions', 'craft-mermaid', 'creating-dsh-plugins', 'document-import', 'office', 'office-docx', 'office-xlsx', 'office-pptx', 'office-render', 'office-recalculate', 'office-export-pdf', 'telegram', 'memory-workspace'])
const hash = data => createHash('sha256').update(data).digest('hex')
const fail = () => { throw new Error('SHARED_SKILL_CLOSURE_INVALID') }

async function inventory(root, prefix = '', result = {}) {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || prefix.split('/').length > 12) fail()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) await inventory(join(root, entry.name), rel, result)
    else if (entry.isFile()) {
      const info = await lstat(join(root, entry.name))
      if (info.nlink !== 1 || info.size > 4 * 1024 * 1024 || Object.keys(result).length >= 256) fail()
      const data = await readFile(join(root, entry.name))
      result[rel] = { bytes: data.length, sha256: hash(data) }
    } else fail()
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en')))
}

/** Reuse only the named generic closures of the verified embedded package.
 * Domain presets never mount its entire mixed core/1C skill directory. */
export async function stageSharedSkills(rulepackRoot, packageTarget, names = SHARED_SKILLS) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length || names.some(name => !SHARED_SKILLS.includes(name) && !WORKBENCH_SHARED_SKILLS.includes(name))) fail()
  const manifest = JSON.parse(await readFile(join(rulepackRoot, 'manifest.json'), 'utf8'))
  if (manifest.package?.id !== 'airules-dsh-rulepack' || !Array.isArray(manifest.inventories?.skills)) fail()
  const target = join(packageTarget, 'skills', 'common')
  await mkdir(target, { recursive: true })
  for (const name of names) {
    const source = join(rulepackRoot, 'skills', name), records = await inventory(source)
    const row = manifest.inventories.skills.find(row => row.id === name)
    if (row?.path !== `skills/${name}/SKILL.md` || row.sha256 !== records['SKILL.md']?.sha256 || row.files !== Object.keys(records).length) fail()
    const declared = Object.keys(manifest.files ?? {}).filter(path => path.startsWith(`skills/${name}/`))
    if (declared.length !== Object.keys(records).length) fail()
    for (const [path, record] of Object.entries(records)) {
      const known = manifest.files[`skills/${name}/${path}`]
      if (known?.id !== name || known.bytes !== record.bytes || known.sha256 !== record.sha256) fail()
    }
    await cp(source, join(target, name), { recursive: true, force: false, errorOnExist: true })
    if (JSON.stringify(records) !== JSON.stringify(await inventory(source)) || JSON.stringify(records) !== JSON.stringify(await inventory(join(target, name)))) fail()
  }
  return [...names]
}
