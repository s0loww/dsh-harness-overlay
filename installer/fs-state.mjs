import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const canonical = value => `${JSON.stringify(value, null, 2)}\n`

export async function pathKind(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'special'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function directoryState(root) {
  const files = {}
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const rel = relative(root, path).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw Object.assign(new Error(`SYMLINK_FORBIDDEN: ${rel}`), { code: 'SYMLINK_FORBIDDEN' })
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        files[rel] = { sha256: sha256(bytes), bytes: bytes.byteLength }
      } else throw Object.assign(new Error(`SPECIAL_FILE_FORBIDDEN: ${rel}`), { code: 'SPECIAL_FILE_FORBIDDEN' })
    }
  }
  await walk(root)
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')))
  return { type: 'directory', digest: sha256(Buffer.from(canonical(sorted))), files: sorted }
}

export async function fileState(path) {
  const bytes = await readFile(path)
  return { type: 'file', sha256: sha256(bytes), bytes: bytes.byteLength }
}

export async function targetState(path) {
  const kind = await pathKind(path)
  if (kind === 'missing') return { type: 'missing' }
  if (kind === 'directory') return directoryState(path)
  if (kind === 'file') return fileState(path)
  throw Object.assign(new Error(`UNSAFE_TARGET_TYPE: ${kind}`), { code: 'UNSAFE_TARGET_TYPE' })
}

export function sameState(actual, expected) {
  if (!actual || !expected || actual.type !== expected.type) return false
  if (actual.type === 'missing') return true
  if (actual.type === 'file') return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
  return actual.digest === expected.digest && canonical(actual.files) === canonical(expected.files)
}

export async function atomicWrite(path, bytes, { expectedCurrentState } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(temporary, bytes)
  try {
    const current = await targetState(path)
    if (expectedCurrentState && !sameState(current, expectedCurrentState)) {
      throw Object.assign(new Error('EXPECTED_CURRENT_STATE_MISMATCH'), { code: 'EXPECTED_CURRENT_STATE_MISMATCH' })
    }
    const kind = current.type === 'missing' ? 'missing' : current.type
    if (kind === 'missing') {
      await rename(temporary, path)
      return { cleanupPending: null }
    }
    if (kind !== 'file') throw Object.assign(new Error('ATOMIC_FILE_TARGET_INVALID'), { code: 'ATOMIC_FILE_TARGET_INVALID' })
    const displaced = join(dirname(path), `.${randomUUID()}.old`)
    await rename(path, displaced)
    try {
      await rename(temporary, path)
      try {
        await rm(displaced, { force: true })
        return { cleanupPending: null }
      } catch {
        return { cleanupPending: displaced }
      }
    } catch (error) {
      if (await pathKind(path) === 'missing') await rename(displaced, path)
      throw error
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function atomicInstallDirectory(source, target, expectedState, { expectedCurrentState } = {}) {
  await mkdir(dirname(target), { recursive: true })
  const staged = join(dirname(target), `.${randomUUID()}.stage`)
  const displaced = join(dirname(target), `.${randomUUID()}.old`)
  await cp(source, staged, { recursive: true, force: false, errorOnExist: true })
  try {
    const stagedState = await directoryState(staged)
    if (!sameState(stagedState, expectedState)) throw Object.assign(new Error('STAGED_HASH_MISMATCH'), { code: 'STAGED_HASH_MISMATCH' })
    const current = await targetState(target)
    if (expectedCurrentState && !sameState(current, expectedCurrentState)) {
      throw Object.assign(new Error('EXPECTED_CURRENT_STATE_MISMATCH'), { code: 'EXPECTED_CURRENT_STATE_MISMATCH' })
    }
    const kind = current.type === 'missing' ? 'missing' : current.type
    if (!['missing', 'directory'].includes(kind)) throw Object.assign(new Error('TARGET_TYPE_COLLISION'), { code: 'TARGET_TYPE_COLLISION' })
    if (kind === 'directory') await rename(target, displaced)
    try {
      await rename(staged, target)
      if (kind === 'directory') {
        try {
          await rm(displaced, { recursive: true, force: true })
          return { cleanupPending: null }
        } catch {
          return { cleanupPending: displaced }
        }
      }
      return { cleanupPending: null }
    } catch (error) {
      if (kind === 'directory' && await pathKind(target) === 'missing') await rename(displaced, target)
      throw error
    }
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
}

export async function atomicRemoveDirectory(target, { expectedCurrentState } = {}) {
  if (expectedCurrentState && !sameState(await targetState(target), expectedCurrentState)) {
    throw Object.assign(new Error('EXPECTED_CURRENT_STATE_MISMATCH'), { code: 'EXPECTED_CURRENT_STATE_MISMATCH' })
  }
  const displaced = join(dirname(target), `.${randomUUID()}.remove`)
  await rename(target, displaced)
  await rm(displaced, { recursive: true, force: true })
}
