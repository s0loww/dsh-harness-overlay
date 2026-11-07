import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
export const sha = value => createHash('sha256').update(value).digest('hex')
export const FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx'])
export const fail = code => { throw new Error(code) }
export const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
export async function safePath(root, value, { directory = false, missing = false, absolute = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0') || (!absolute && isAbsolute(value))) fail('DOCUMENT_PATH_REJECTED')
  root = resolve(root); const path = resolve(root, value)
  if (!inside(root, path)) fail('DOCUMENT_PATH_REJECTED')
  let at = root
  const parts = relative(root, path).split(sep).filter(Boolean)
  for (const part of ['', ...parts]) {
    at = part ? resolve(at, part) : at
    let stat
    try { stat = await lstat(at) } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) fail('DOCUMENT_PATH_REJECTED')
    if (at !== path && !stat.isDirectory()) fail('DOCUMENT_PATH_REJECTED')
    if (at === path && !missing && (directory ? !stat.isDirectory() : !stat.isFile())) fail('DOCUMENT_PATH_REJECTED')
  }
  if (!missing && (process.platform === 'win32' ? resolve(await realpath(path)).toLowerCase() !== path.toLowerCase() : resolve(await realpath(path)) !== path)) fail('DOCUMENT_PATH_REJECTED')
  return path
}
export async function boundedRead(path, limit) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) fail('DOCUMENT_FILE_LIMIT')
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.ino !== info.ino || before.dev !== info.dev || before.size > limit) fail('DOCUMENT_FILE_LIMIT')
    let size = 0; const chunks = []
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      size += chunk.length; if (size > limit) fail('DOCUMENT_FILE_LIMIT'); chunks.push(chunk)
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) fail('DOCUMENT_SOURCE_CHANGED')
    return Buffer.concat(chunks, size)
  } finally { await handle.close() }
}
