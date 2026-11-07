import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = value => value.split(sep).join('/')
const validName = name => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)

async function checkedDirectory(root, path) {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('CLOSURE_PATH_ESCAPE')
  let current = root
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CLOSURE_DIRECTORY_LINK')
  }
  if (resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('CLOSURE_DIRECTORY_LINK')
}

async function packageFiles(root) {
  const files = {}
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name), rel = slash(relative(root, path))
      if (entry.isSymbolicLink()) throw new Error(`CLOSURE_FILE_LINK: ${rel}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files[rel] = hash(await readFile(path))
      else throw new Error(`CLOSURE_SPECIAL_FILE: ${rel}`)
    }
  }
  await visit(root)
  return files
}

export async function inspectPackageClosure({ modulesRoot, roots }) {
  const base = resolve(modulesRoot), packages = new Map()
  await checkedDirectory(base, base)
  async function locate(from, name) {
    if (!validName(name)) throw new Error('CLOSURE_PACKAGE_NAME_INVALID')
    let directory = from
    while (directory === base || relative(base, directory).startsWith('..') === false) {
      const candidate = directory === base ? join(base, name) : join(directory, 'node_modules', name)
      try { await lstat(join(candidate, 'package.json')); await checkedDirectory(base, candidate); return candidate }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (directory === base) break
      directory = dirname(directory)
    }
    throw new Error(`CLOSURE_DEPENDENCY_MISSING: ${name}`)
  }
  async function visit(path) {
    const rel = slash(relative(base, path))
    if (packages.has(rel)) return
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (!validName(manifest.name) || typeof manifest.version !== 'string') throw new Error('CLOSURE_PACKAGE_IDENTITY_INVALID')
    const files = await packageFiles(path)
    packages.set(rel, { path: rel, name: manifest.name, version: manifest.version, license: manifest.license ?? null, sha256: hash(JSON.stringify(files)) })
    // Only runtime dependencies. Peers are provided by the pinned host; missing
    // optional runtime packages fail closed instead of silently trimming features.
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      const dependency = await locate(path, name)
      const pkg = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'))
      if (pkg.name !== name) throw new Error(`CLOSURE_DEPENDENCY_IDENTITY_INVALID: ${name}`)
      await visit(dependency)
    }
  }
  for (const [name, version] of Object.entries(roots).sort()) {
    const path = await locate(base, name)
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (pkg.name !== name || pkg.version !== version) throw new Error(`CLOSURE_ROOT_VERSION_MISMATCH: ${name}`)
    await visit(path)
  }
  return { schemaVersion: 1, roots, packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) }
}

export async function stagePackageClosure({ modulesRoot, targetModulesRoot, lock }) {
  const actual = await inspectPackageClosure({ modulesRoot, roots: lock.roots })
  if (JSON.stringify(actual) !== JSON.stringify(lock)) throw new Error('CLOSURE_LOCK_MISMATCH')
  for (const row of actual.packages) {
    const source = join(modulesRoot, row.path), target = join(targetModulesRoot, row.path)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: true,
      filter: path => !relative(source, path).split(sep).some(part => part === 'node_modules' || part === '.git') })
  }
  // Post-copy validation catches drift between the inspected source and copy.
  const staged = await inspectPackageClosure({ modulesRoot: targetModulesRoot, roots: lock.roots })
  if (JSON.stringify(staged) !== JSON.stringify(lock)) throw new Error('CLOSURE_STAGED_HASH_MISMATCH')
  return actual
}
