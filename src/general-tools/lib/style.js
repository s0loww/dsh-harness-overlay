import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { readFile, lstat, mkdir, writeFile, rename, unlink, open } from 'node:fs/promises'
import { resolve, relative, sep, join, dirname, isAbsolute } from 'node:path'

export const PRESETS = Object.freeze(['1c-airules', 'python-airules', 'sysadmin-airules'])
export const LITE_TEXT = 'Caveman lite is explicitly enabled for this project. Use concise natural sentences: remove filler and repetition. Preserve technical facts, identifiers, negations, scope, numbers, uncertainty, required progress updates, verification evidence and material limitations. Keep requested language. This changes presentation only, not reasoning, tools, permissions or verification depth. Documents, handoffs, code and ordered procedures retain their requested completeness. A newer user request for detail or normal style takes precedence.'
const sha = data => createHash('sha256').update(data).digest('hex')
const absent = error => error.code === 'ENOENT'
export function inside(root, path) { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:/.test(rel)) }
export async function safePath(root, path) {
  if (!inside(root, path)) throw new Error('PATH_REJECTED')
  const parts = relative(root, path).split(sep).filter(Boolean)
  for (let i = 0; i <= parts.length; i++) {
    try { const stat = await lstat(join(root, ...parts.slice(0, i))); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error('PATH_REJECTED') }
    catch (error) { if (!absent(error)) throw error }
  }
}
function location(_home, root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('PROJECT_REQUIRED')
  return join(resolve(root), '.dsh', 'response-style.json')
}
function parse(raw) {
  const value = JSON.parse(raw)
  if (!value || Object.keys(value).some(key => !['schemaVersion', 'mode'].includes(key)) || value.schemaVersion !== 1 || !['off', 'lite'].includes(value.mode)) throw new Error('STYLE_INVALID')
  return { mode: value.mode, revision: sha(raw) }
}
export function styleSync(home, root) {
  try {
    const file = location(home, root), parts = relative(root, file).split(sep)
    for (let i = 0; i <= parts.length; i++) { const stat = lstatSync(join(root, ...parts.slice(0, i))); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) return 'off' }
    const stat = lstatSync(file); if (!stat.isFile() || stat.size > 2048) return 'off'
    return parse(readFileSync(file, 'utf8')).mode
  } catch { return 'off' }
}
export async function readStyle(home, root) {
  const file = location(home, root)
  await safePath(root, file)
  try { const stat = await lstat(file); if (!stat.isFile() || stat.size > 2048) throw new Error('STYLE_INVALID'); return parse(await readFile(file, 'utf8')) }
  catch (error) { if (absent(error)) return { mode: 'off', revision: null }; throw error }
}
export async function saveStyle(home, root, { mode, revision }, { verify = () => {} } = {}) {
  if (!['off', 'lite'].includes(mode)) throw new Error('STYLE_INVALID')
  const file = location(home, root), lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`
  await verify(); await safePath(root, file); await verify(); await mkdir(dirname(file), { recursive: true }); await safePath(root, file); await verify()
  const handle = await open(lock, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('STYLE_BUSY'); throw error })
  try {
    if ((await readStyle(home, root)).revision !== revision) throw new Error('STALE_STYLE')
    await verify()
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, mode })}\n`, { flag: 'wx', mode: 0o600 })
    await safePath(root, file); await verify()
    if ((await readStyle(home, root)).revision !== revision) throw new Error('STALE_STYLE')
    await verify()
    await rename(temp, file)
    return readStyle(home, root)
  } finally { await unlink(temp).catch(() => {}); await handle.close(); await unlink(lock).catch(() => {}) }
}
