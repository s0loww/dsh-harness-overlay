import { openSync, closeSync, constants, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { readSettings, assertRoot } from './core.js'
const canonical = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const LIMITS = Object.freeze({ catalogBytes: 2 * 1024 * 1024, catalogs: 4, bases: 500, platformEntries: 300, sourceEntries: 1200, sourceDepth: 4, sources: 30, sourceBytes: 512 * 1024, milliseconds: 2500, pathEntries: 80 })
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
function regular(path) {
  try { const stat = lstatSync(path); return !stat.isSymbolicLink() && stat.isFile() && canonical(realpathSync(path)) === canonical(path) } catch { return false }
}
function folder(path) {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() && canonical(realpathSync(path)) === canonical(path) } catch { return false }
}
function readBounded(path, max) {
  if (!regular(path)) throw new Error('FILE_REJECTED')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (fstatSync(fd).size > max) throw new Error('FILE_LIMIT')
    const buffer = Buffer.alloc(max + 1), count = readSync(fd, buffer, 0, buffer.length, 0)
    if (count > max || !regular(path)) throw new Error('FILE_LIMIT')
    const bytes = buffer.subarray(0, count)
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
    if (bytes[0] === 0xfe && bytes[1] === 0xff) { const copy = Buffer.from(bytes.subarray(2)); if (copy.length % 2) throw new Error('ENCODING'); copy.swap16(); return copy.toString('utf16le') }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')
  } finally { closeSync(fd) }
}
/** Browser input never participates in construction of machine discovery paths. */
export function machinePaths(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { programRoots: [], catalogs: [], toolDirectories: [], localTools: [], edtRoots: [] }
  const unique = items => [...new Set(items.filter(path => typeof path === 'string' && isAbsolute(path)).map(path => resolve(path)))]
  return {
    programRoots: unique([env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]),
    catalogs: [env.APPDATA && { path: join(env.APPDATA, '1C', '1CEStart', 'ibases.v8i'), label: 'Список пользователя' }, env.PROGRAMDATA && { path: join(env.PROGRAMDATA, '1C', '1CEStart', 'ibases.v8i'), label: 'Общий список' }].filter(Boolean),
    toolDirectories: unique(String(env.PATH ?? '').split(';').map(value => value.replace(/^"|"$/gu, ''))).slice(0, LIMITS.pathEntries),
    localTools: env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'bsl-language-server'), join(env.LOCALAPPDATA, 'Programs', 'bsl-language-server', 'bin')] : [],
    edtRoots: unique([env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', '1C', '1CE'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, '1C', '1CE'), env.ProgramFiles && join(env.ProgramFiles, '1C', '1CE'), env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], '1C', '1CE')]),
  }
}
const versionOrder = (a, b) => {
  const x = a.version.split('.').map(Number), y = b.version.split('.').map(Number)
  for (let index = 0; index < Math.max(x.length, y.length); index++) { const difference = (y[index] ?? 0) - (x[index] ?? 0); if (difference) return difference }
  return a.path.localeCompare(b.path)
}
export async function installedPlatforms(paths = machinePaths()) {
  const platforms = [], seen = new Set(); let count = 0, truncated = false
  for (const root of paths.programRoots.slice(0, 6)) for (const product of ['1cv8', '1cv8_x86']) {
    const base = join(root, product)
    if (!folder(base)) continue
    const entries = await opendir(base)
    for await (const entry of entries) {
      if (++count > LIMITS.platformEntries) { truncated = true; break }
      if (!entry.isDirectory() || !/^8\.\d+\.\d+(?:\.\d+)?$/u.test(entry.name)) continue
      const path = join(base, entry.name), executable = join(path, 'bin', '1cv8.exe'), key = canonical(path)
      if (!seen.has(key) && regular(executable)) { seen.add(key); platforms.push({ path, executable, version: entry.name, architecture: /\(x86\)|_x86/iu.test(root + product) ? 'x86' : 'не определена' }) }
    }
  }
  return { platforms: platforms.sort(versionOrder), truncated }
}
function connectionParts(source) {
  const result = Object.create(null)
  const matcher = /(?:^|;)\s*([A-Za-z]+)\s*=\s*(?:"((?:[^"]|"")*)"|'([^']*)'|([^;]*))\s*(?=;|$)/gu
  let match
  while ((match = matcher.exec(source))) result[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4]).replace(/""/gu, '"').trim()
  return result
}
export function parseInfobases(source, label = 'Локальный список') {
  const sections = []; let current
  for (const row of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const section = /^\[([^\]\r\n]{1,500})\]\s*$/u.exec(row)
    if (section) { current = { name: section[1] }; if (sections.length >= LIMITS.bases) break; sections.push(current); continue }
    if (current && /^Connect\s*=/iu.test(row)) current.connect = row.slice(row.indexOf('=') + 1).trim()
  }
  return sections.flatMap((section, index) => {
    if (!section.connect || section.connect.length > 8192) return []
    const parts = connectionParts(section.connect)
    let kind, path
    // Allowlist only the minimum location fields. Login, password, tokens,
    // launch arguments and all unknown connection fields never leave the host.
    if (parts.file && !/[\r\n\0]/u.test(parts.file)) { kind = 'file'; path = parts.file }
    else if (parts.srvr && parts.ref && !/["\r\n\0]/u.test(parts.srvr + parts.ref)) { kind = 'server'; path = `Srvr="${parts.srvr}";Ref="${parts.ref}";` }
    else return []
    return [{ id: createHash('sha256').update(`${label}\0${index}\0${section.name}\0${path}`).digest('hex').slice(0, 24), name: section.name, kind, path, source: label }]
  })
}
export function registeredInfobases(paths = machinePaths()) {
  const bases = [], catalogs = []; let truncated = false
  for (const catalog of paths.catalogs.slice(0, LIMITS.catalogs)) {
    if (!isAbsolute(catalog.path)) continue
    try {
      const found = parseInfobases(readBounded(catalog.path, LIMITS.catalogBytes), catalog.label)
      bases.push(...found.slice(0, Math.max(0, LIMITS.bases - bases.length)))
      if (found.length >= LIMITS.bases || bases.length >= LIMITS.bases) truncated = true
      catalogs.push({ label: catalog.label, status: 'прочитан' })
    } catch { catalogs.push({ label: catalog.label, status: 'нет доступного списка в стандартном пути' }) }
  }
  return { bases, catalogs, truncated }
}
function xmlValue(text, tag) {
  const clean = text.replace(/<!--[\s\S]*?-->/gu, '')
  const found = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${tag}\\b[^>]*>([^<]{0,500})<\\/`, 'iu').exec(clean)?.[1]
  return found?.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>') ?? ''
}
export async function projectSources(root, configured = '') {
  assertRoot(root)
  const sources = [], seen = new Set(), started = Date.now(); let count = 0, truncated = false
  const skip = new Set(['.git', '.dsh', '.claude', '.codex', '.agents', 'node_modules', 'vendor', 'backups', 'data'])
  async function visit(directory, depth) {
    if (!folder(directory) || !inside(root, directory)) return
    const entries = await opendir(directory)
    for await (const entry of entries) {
      if (++count > LIMITS.sourceEntries || sources.length >= LIMITS.sources || Date.now() - started > LIMITS.milliseconds) { truncated = true; break }
      if (entry.isSymbolicLink() || skip.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (depth < LIMITS.sourceDepth) await visit(path, depth + 1); else truncated = true }
      else if (entry.isFile() && /^Configuration(?:Extension)?\.(?:xml|mdo)$/iu.test(entry.name) && !seen.has(path)) {
        seen.add(path)
        try {
          const text = readBounded(path, LIMITS.sourceBytes)
          if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) continue
          sources.push({ path: relative(root, path).split(sep).join('/'), directory: relative(root, dirname(path)).split(sep).join('/') || '.', format: /\.mdo$/iu.test(path) ? 'EDT' : 'XML', kind: /ConfigurationExtension/iu.test(entry.name) || /<(?:(?:\w+):)?ConfigurationExtension\b/u.test(text) ? 'extension' : 'configuration', name: xmlValue(text, 'Name') || xmlValue(text, 'name'), compatibility: xmlValue(text, 'CompatibilityMode') || xmlValue(text, 'compatibilityMode') })
        } catch {}
      }
    }
  }
  if (configured) {
    const path = isAbsolute(configured) ? resolve(configured) : resolve(root, configured)
    if (inside(root, path)) await visit(path, 0)
  }
  await visit(root, 0)
  return { sources, truncated, scannedEntries: count }
}
export async function localTools(paths = machinePaths()) {
  const names = { git: ['git.exe', 'git.cmd'], java: ['java.exe'], bsl: ['bsl-language-server.exe', 'bsl-language-server.cmd', 'bsl-language-server.bat'], edt: ['1cedt.exe', 'edt.exe'] }
  const tools = Object.entries(names).map(([id, names]) => {
    for (const directory of [...paths.toolDirectories, ...paths.localTools].slice(0, LIMITS.pathEntries + 4)) {
      if (!isAbsolute(directory)) continue
      for (const name of names) { const path = join(directory, name); if (regular(path)) return { id, installed: true, path } }
    }
    return { id, installed: false }
  })
  // 1C:EDT is commonly managed by 1C:Enterprise Development Tools' component
  // manager rather than PATH. Inspect only known local component roots.
  let edtEntries = 0
  async function findEdt(directory, depth = 0) {
    if (!folder(directory) || edtEntries >= 400) return null
    const listing = await opendir(directory)
    for await (const entry of listing) {
      if (++edtEntries > 400) break
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isFile() && /^(?:1cedt|edt)\.exe$/iu.test(entry.name) && regular(path)) return path
      if (entry.isDirectory() && depth < 4) { const found = await findEdt(path, depth + 1); if (found) return found }
    }
    return null
  }
  const edt = tools.find(tool => tool.id === 'edt')
  if (!edt.installed) for (const root of (paths.edtRoots ?? []).slice(0, 4)) { const path = await findEdt(root); if (path) { Object.assign(edt, { installed: true, path }); break } }
  tools.push({ id: 'node-runtime', installed: regular(process.execPath), path: process.execPath })
  return tools
}
export function proposedSettings(environment, existing = {}) {
  const values = {}, reasons = []
  const main = environment.sources.sources.filter(source => source.kind === 'configuration')
  const chosen = main.length === 1 ? main[0] : environment.sources.sources.length === 1 ? environment.sources.sources[0] : null
  if (chosen) {
    if (!existing.EXPORT_PATH) values.EXPORT_PATH = chosen.directory
    if (!existing.USE_EDT) values.USE_EDT = chosen.format === 'EDT' ? 'true' : 'false'
    reasons.push('Однозначно обнаруженный каталог исходников; формат определяется по XML/MDO.')
  }
  if (environment.platforms.platforms.length === 1) {
    const platform = environment.platforms.platforms[0]
    if (!existing.PLATFORM_PATH) values.PLATFORM_PATH = platform.path
    if (!existing.PLATFORM_VERSION) values.PLATFORM_VERSION = platform.version
    reasons.push('Обнаружена одна установленная платформа. Совместимость с базой этим не проверена.')
  }
  return { values, reasons, ambiguousSources: main.length > 1, ambiguousPlatforms: environment.platforms.platforms.length > 1 }
}
export async function environmentStatus(root, paths = machinePaths()) {
  const settings = readSettings(root), platforms = await installedPlatforms(paths), catalogs = registeredInfobases(paths), sources = await projectSources(root, settings.values.EXPORT_PATH)
  const configuredPlatform = settings.values.PLATFORM_PATH ? resolve(root, settings.values.PLATFORM_PATH) : null
  const environment = { platforms, catalogs, sources, tools: await localTools(paths), configuredPlatform: configuredPlatform ? { path: settings.values.PLATFORM_PATH, executableFound: regular(join(configuredPlatform, 'bin', '1cv8.exe')) } : null, limits: LIMITS }
  return { ...environment, proposal: proposedSettings(environment, settings.values), projectRoot: root, writable: false, catalogScope: 'Стандартные локальные списки ibases.v8i. CommonInfoBases, сетевые списки, реестр и запущенные базы не опрашиваются.' }
}
