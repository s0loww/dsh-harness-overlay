import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export const SDK_VERSION = '1.0.38'
const loadedPins = new Map()
export const fail = code => { throw Object.assign(new Error(code), { code }) }
export async function inspectRuntime(packageRoot) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 13) fail('CURSOR_NODE_VERSION')
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot)) fail('CURSOR_PACKAGE_PATH_REQUIRED')
  const root = await realpath(packageRoot)
  if ((await lstat(packageRoot)).isSymbolicLink()) fail('CURSOR_SYMLINK_REJECTED')
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (meta.name !== '@cursor/sdk' || meta.version !== SDK_VERSION || meta.main !== './dist/cjs/index.js') fail('CURSOR_SDK_VERSION')
  const hash = createHash('sha256'); let bytes = 0, count = 0
  async function walk(directory) {
    for (const item of (await readdir(directory, { withFileTypes:true })).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if (item.name === 'node_modules') continue
      const path = join(directory,item.name), stat = await lstat(path)
      if (stat.isSymbolicLink()) fail('CURSOR_SYMLINK_REJECTED')
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) {
        bytes += stat.size; count++
        if (bytes > 128*1024*1024 || count > 4000) fail('CURSOR_RUNTIME_TOO_LARGE')
        hash.update(relative(root,path).split(sep).join('/')).update('\0').update(await readFile(path)).update('\0')
      } else fail('CURSOR_RUNTIME_FILE_TYPE')
    }
  }
  await walk(root)
  return { packageRoot:root, version:SDK_VERSION, sha256:hash.digest('hex'), files:count }
}
export async function loadRuntime(pin) {
  const actual = await inspectRuntime(pin?.packageRoot)
  if (!/^[a-f0-9]{64}$/.test(pin?.sha256??'') || actual.sha256 !== pin.sha256 || pin.version !== SDK_VERSION) fail('CURSOR_RUNTIME_CHANGED')
  // CJS also caches dependency chunks. A changed tree requires process restart,
  // rather than pretending a fresh pin reloaded its transitive module graph.
  if (loadedPins.has(actual.packageRoot) && loadedPins.get(actual.packageRoot) !== actual.sha256) fail('CURSOR_RUNTIME_RESTART_REQUIRED')
  loadedPins.set(actual.packageRoot,actual.sha256)
  const sdk = createRequire(import.meta.url)(join(actual.packageRoot,'dist/cjs/index.js'))
  if (typeof sdk.Cursor?.auth?.login !== 'function' || typeof sdk.Cursor?.models?.list !== 'function' || typeof sdk.Cursor?.me !== 'function' || typeof sdk.Agent?.create !== 'function' || typeof sdk.JsonlLocalAgentStore !== 'function') fail('CURSOR_SDK_API')
  return sdk
}
