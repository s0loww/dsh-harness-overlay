import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
const MODES = ['disabled', 'fixture-only', 'enabled']
const hash = value => createHash('sha256').update(value).digest('hex')

/** Feature preference in native dshHomePath storage; never changes sandbox or tool permissions. */
export async function readMode(path, fallback = 'fixture-only') {
  if (!MODES.includes(fallback)) throw new Error('DEPLOY_MODE_INVALID')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error('MODE_SETTINGS_INVALID')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.schemaVersion !== 1 || !MODES.includes(value.mode) || !Number.isSafeInteger(value.updatedAt)
      || value.digest !== hash(JSON.stringify({ schemaVersion: 1, mode: value.mode, updatedAt: value.updatedAt }))) throw new Error('MODE_SETTINGS_INVALID')
    return { mode: value.mode, issue: null }
  } catch (error) {
    if (error.code === 'ENOENT') return { mode: fallback, issue: null }
    return { mode: 'disabled', issue: 'MODE_SETTINGS_INVALID' }
  }
}
export async function writeMode(path, mode) {
  if (!MODES.includes(mode)) throw new Error('DEPLOY_MODE_INVALID')
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('MODE_SETTINGS_INVALID')
  try { const old = await lstat(path); if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) throw new Error('MODE_SETTINGS_INVALID') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const value = { schemaVersion: 1, mode, updatedAt: Date.now() }
  const bytes = JSON.stringify({ ...value, digest: hash(JSON.stringify(value)) })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
