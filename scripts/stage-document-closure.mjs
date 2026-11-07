import { readFile, readdir, lstat, mkdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative, isAbsolute, parse, sep } from 'node:path'
const LOCK = new URL('../upstream/document-workbench-closure.lock.json', import.meta.url)
const NAMES = ['@jiaoqsh/dsh-document', '@firecrawl/anydoc', '@firecrawl/anydoc-win32-x64-msvc', '@firecrawl/pdf-inspector-wasm']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
async function safe(path, missing = false) {
 if (!isAbsolute(path)) fail('DOCUMENT_CLOSURE_ABSOLUTE_ROOT_REQUIRED')
 const absolute = resolve(path); let current = parse(absolute).root
 for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
  current = join(current, part)
  let stat; try { stat = await lstat(current) } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error }
  if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) fail('DOCUMENT_CLOSURE_REPARSE_REJECTED')
 }
 return absolute
}
async function verify(folder, spec) {
 await safe(folder)
 const seen = [], pending = [folder]
 while (pending.length) {
  const dir = pending.pop()
  for (const row of await readdir(dir, { withFileTypes: true })) {
   const file = join(dir, row.name), stat = await lstat(file)
   if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) fail('DOCUMENT_CLOSURE_REPARSE_REJECTED')
   if (stat.isDirectory()) pending.push(file)
   else if (stat.isFile()) {
    const key = relative(folder, file).split(sep).join('/'), record = spec.files[key]
    if (!record || stat.size !== record.bytes || sha(await readFile(file)) !== record.sha256) fail('DOCUMENT_CLOSURE_HASH_MISMATCH')
    seen.push(key)
   } else fail('DOCUMENT_CLOSURE_FILE_REJECTED')
  }
 }
 if (seen.length !== Object.keys(spec.files).length) fail('DOCUMENT_CLOSURE_INCOMPLETE')
 const meta = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
 if (meta.version !== spec.version || meta.license !== spec.license || meta.license !== 'MIT') fail('DOCUMENT_CLOSURE_METADATA_MISMATCH')
}
export async function stageDocumentClosure({ modulesRoot, targetModulesRoot }) {
 const lock = JSON.parse(await readFile(LOCK, 'utf8'))
 if (lock.schemaVersion !== 1 || lock.platform !== 'win32-x64' || Object.keys(lock.packages).sort().join('|') !== [...NAMES].sort().join('|')) fail('DOCUMENT_CLOSURE_LOCK_REJECTED')
 await safe(modulesRoot); await safe(targetModulesRoot, true)
 const overlaps = (a, b) => { const path = relative(resolve(a), resolve(b)); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) }
 if (overlaps(modulesRoot, targetModulesRoot) || overlaps(targetModulesRoot, modulesRoot)) fail('DOCUMENT_CLOSURE_SELF_COPY_REJECTED')
 for (const name of NAMES) {
  const spec = lock.packages[name]
  if (!Object.keys(spec.files).every(path => path && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.' || part === '') && !isAbsolute(path))) fail('DOCUMENT_CLOSURE_LOCK_PATH_REJECTED')
  await verify(join(modulesRoot, name), spec)
 }
 const packages = []
 for (const name of NAMES) {
  const source = join(modulesRoot, name), target = join(targetModulesRoot, name), spec = lock.packages[name]
  let exists = true; try { await lstat(target) } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error }
  if (!exists) {
   await safe(target, true); await mkdir(target, { recursive: true })
   for (const key of Object.keys(spec.files).sort()) {
    const destination = join(target, key); await safe(destination, true)
    await mkdir(resolve(destination, '..'), { recursive: true }); await copyFile(join(source, key), destination, 1)
   }
  }
  await verify(target, spec)
  packages.push({ name, version: spec.version, files: Object.keys(spec.files).length, license: spec.license })
 }
 return { schemaVersion: 1, platform: lock.platform, packages, externalPeers: lock.externalPeers, networkUsed: false, installScriptsExecuted: false }
}
