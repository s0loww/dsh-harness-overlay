import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FIELDS, validateUpdates } from './schema.js'
const MAX_BYTES = 1024 * 1024, revisionKey = randomBytes(32)
const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export function assertRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || lstatSync(root).isSymbolicLink() || normalized(realpathSync(root)) !== normalized(root) || !lstatSync(root).isDirectory()) throw new Error('WORKSPACE_REJECTED')
  return resolve(root)
}
function snapshot(root) {
  assertRoot(root)
  const path = join(root, '.dev.env')
  if (!existsSync(path)) {
    // existsSync follows symlinks; reject a dangling symlink as well.
    try { lstatSync(path); throw new Error('FILE_REJECTED') } catch (error) { if (error.code !== 'ENOENT') throw error }
    return null
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES || stat.nlink > 1) throw new Error('FILE_REJECTED')
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.size > MAX_BYTES || current.nlink > 1) throw new Error('FILE_REJECTED')
    const buffer = Buffer.alloc(MAX_BYTES + 1), bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
    if (bytes > MAX_BYTES || lstatSync(path).isSymbolicLink() || normalized(realpathSync(path)) !== normalized(path)) throw new Error('FILE_REJECTED')
    const result = buffer.subarray(0, bytes)
    new TextDecoder('utf-8', { fatal: true }).decode(result)
    if (result.includes(0)) throw new Error('FILE_ENCODING_REJECTED')
    return result
  } finally { closeSync(descriptor) }
}
function revision(root, source) { return createHmac('sha256', revisionKey).update(normalized(root)).update('\0').update(source === null ? 'missing' : 'present').update(source ?? '').digest('base64url') }
function parse(source) {
  const values = Object.create(null)
  for (const line of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}
export function readSettings(root) {
  const source = snapshot(root), all = parse(source?.toString('utf8') ?? ''), values = {}, secrets = {}, redactedKeys = []
  for (const field of FIELDS) {
    if (field.secret) { secrets[field.key] = Boolean(all[field.key]); continue }
    let value = all[field.key] ?? ''
    if (field.key === 'INFOBASE_PATH' && /\b(?:pwd|password)\s*=/iu.test(value)) { value = ''; redactedKeys.push(field.key) }
    if (field.key === 'INFOBASE_PUBLISH_URL' && value) {
      try { const url = new URL(value); if (url.password || url.username) { value = ''; redactedKeys.push(field.key) } } catch {}
    }
    values[field.key] = value
  }
  return { file: '.dev.env', exists: source !== null, revision: revision(root, source), values, secrets, redactedKeys, fields: FIELDS }
}
export function renderUpdates(source, updates) {
  validateUpdates(updates)
  const eol = source.includes('\r\n') ? '\r\n' : '\n', seen = new Set()
  const output = source.replace(/(^|\n)(\uFEFF?\s*)([A-Z][A-Z0-9_]*)(\s*=\s*)([^\r\n]*)/gu, (row, newline, prefix, key, separator) => {
    if (!Object.hasOwn(updates, key)) return row
    seen.add(key)
    return `${newline}${prefix}${key}${separator}${updates[key]}`
  })
  const added = Object.entries(updates).filter(([key]) => !seen.has(key)).map(([key, value]) => `${key}=${value}`)
  return added.length ? `${output}${output && !output.endsWith('\n') ? eol : ''}${added.join(eol)}${eol}` : output
}
function protect(path, directory = false) {
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); return }
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!user) throw new Error('PROTECTION_UNAVAILABLE')
  const result = spawnSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${user}:${directory ? '(OI)(CI)(F)' : '(F)'}`], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  if (result.error || result.status !== 0) throw new Error('PROTECTION_FAILED')
}
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || normalized(realpathSync(path)) !== normalized(path)) throw new Error('BACKUP_DIRECTORY_REJECTED')
  protect(path, true)
}
function writePrivate(path, content) {
  const descriptor = openSync(path, 'wx', 0o600)
  try { protect(path); writeFileSync(descriptor, content); fsyncSync(descriptor) } catch (error) { try { unlinkSync(path) } catch {} throw error } finally { closeSync(descriptor) }
}
/** Caller supplies only trusted, host-owned backupHome (never browser input). */
export function saveSettings(root, { revision: wanted, updates }, backupHome) {
  validateUpdates(updates)
  assertRoot(root)
  if (typeof wanted !== 'string' || wanted.length > 256) throw new Error('REVISION_REQUIRED')
  if (!Object.keys(updates).length) { const data = readSettings(root); if (data.revision !== wanted) throw new Error('STALE_SETTINGS'); return { ...data, changed: false } }
  const lockPath = join(root, '.dev.env.airules-lock'), tempPath = join(root, `.dev.env.airules-${randomUUID()}.tmp`)
  let lock
  try {
    lock = openSync(lockPath, 'wx', 0o600)
    protect(lockPath)
    const current = snapshot(root)
    if (revision(root, current) !== wanted) throw new Error('STALE_SETTINGS')
    const next = Buffer.from(renderUpdates(current?.toString('utf8') ?? '', updates))
    if (next.length > MAX_BYTES) throw new Error('FILE_LIMIT')
    if (current?.equals(next)) return { ...readSettings(root), changed: false }
    if (current !== null) {
      assertRoot(backupHome)
      const directory = join(backupHome, 'project-settings-backups')
      privateDirectory(directory)
      const projectDirectory = join(directory, createHash('sha256').update(normalized(root)).digest('hex'))
      privateDirectory(projectDirectory)
      writePrivate(join(projectDirectory, `${Date.now()}-${randomUUID()}.env`), current)
    }
    writePrivate(tempPath, next)
    // Reject known concurrent external edits immediately before commit. The
    // lock serializes this writer; unrelated editors do not share its lease.
    if (revision(root, snapshot(root)) !== wanted) throw new Error('STALE_SETTINGS')
    assertRoot(root)
    renameSync(tempPath, join(root, '.dev.env'))
    return { ...readSettings(root), changed: true }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath) }
  }
}
