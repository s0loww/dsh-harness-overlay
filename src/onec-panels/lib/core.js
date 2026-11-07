import { open, opendir, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export const LIMITS = Object.freeze({ entries: 4000, files: 200, depth: 8, bytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, milliseconds: 2500, summaryItems: 500 })
const TYPES = new Set(['Catalog', 'Document', 'Enum', 'CommonModule', 'CommonForm', 'InformationRegister', 'AccumulationRegister', 'AccountingRegister', 'CalculationRegister', 'Report', 'DataProcessor', 'ChartOfAccounts', 'ChartOfCalculationTypes', 'ChartOfCharacteristicTypes', 'BusinessProcess', 'Task', 'Subsystem', 'Configuration', 'ConfigurationExtension', 'Form'])
const SKIP = new Set(['node_modules', '.git', '.dsh', '.claude', '.agents', '.codex', 'vendor', 'data', 'databases', 'backups'])
const local = key => key.split(':').at(-1)
const child = (obj, name) => Object.entries(obj ?? {}).find(([key]) => local(key).toLowerCase() === name.toLowerCase())?.[1]
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) : value && typeof value === 'object' ? text(value['#text']) : ''
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, parseTagValue: false, trimValues: true })
export function parseXml(buffer) {
  let source
  if (buffer[0] === 0xff && buffer[1] === 0xfe) source = buffer.subarray(2).toString('utf16le')
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) { const copy = Buffer.from(buffer.subarray(2)); if (copy.length % 2) throw new Error('XML_ENCODING'); copy.swap16(); source = copy.toString('utf16le') }
  else source = buffer.toString('utf8').replace(/^\uFEFF/u, '')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) throw new Error('XML_DECLARATION_REJECTED')
  if (XMLValidator.validate(source) !== true) throw new Error('XML_INVALID')
  return parser.parse(source)
}
function contains(root, path) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
export async function safeFile(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('PATH_REJECTED')
  if (!/\.(xml|mdo|form)$/iu.test(file)) throw new Error('FILE_TYPE_REJECTED')
  const canonical = await realpath(root)
  let current = resolve(root)
  // Reject symlinked workspace and every descendant, including junctions.
  if (await realpath(current) !== current || (await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_REJECTED')
  for (const part of file.split('/')) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_REJECTED') }
  if (!contains(canonical, await realpath(current))) throw new Error('PATH_REJECTED')
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > LIMITS.bytes) throw new Error('FILE_LIMIT')
    // A capped read also bounds files which grow after stat.
    const buffer = Buffer.alloc(LIMITS.bytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > LIMITS.bytes) throw new Error('FILE_LIMIT')
    let checked = resolve(root)
    for (const part of file.split('/')) { checked = join(checked, part); if ((await lstat(checked)).isSymbolicLink()) throw new Error('SYMLINK_REJECTED') }
    if (!contains(canonical, await realpath(current))) throw new Error('PATH_REJECTED')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}
export function summarizeXml(tree) {
  const result = { objects: [], elements: [], events: [], modules: [] }
  let count = 0
  function walk(value, inItems = false, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 80 || count > 10000) return
    for (const [key, node] of Object.entries(value)) {
      if (++count > 10000) return
      if (key.startsWith('@_')) continue
      const tag = local(key)
      for (const item of Array.isArray(node) ? node : [node]) {
        if (TYPES.has(tag) && result.objects.length < LIMITS.summaryItems) {
          const properties = child(item, 'Properties') ?? item
          const name = text(child(properties, 'Name') ?? properties?.['@_name'])
          if (name) result.objects.push({ type: tag, name })
        }
        if (inItems && item && typeof item === 'object' && item['@_name'] && result.elements.length < LIMITS.summaryItems) result.elements.push({ type: tag, name: text(item['@_name']), id: text(item['@_id']) })
        if (tag === 'Event' && result.events.length < LIMITS.summaryItems) result.events.push({ name: text(item?.['@_name']), handler: text(item) })
        if (/Module$/u.test(tag) && typeof item === 'string' && result.modules.length < LIMITS.summaryItems) result.modules.push({ kind: tag, reference: text(item) })
        walk(item, tag === 'ChildItems', depth + 1)
      }
    }
  }
  walk(tree)
  return { ...result, truncated: count > 10000 }
}
export async function inspectFile(root, file) {
  const buffer = await safeFile(root, file)
  return { path: file, bytes: buffer.length, ...summarizeXml(parseXml(buffer)) }
}
export async function inventory(root) {
  const start = Date.now(), output = [], modules = [], warnings = []
  let entries = 0, bytes = 0, candidates = 0, truncated = false
  async function visit(dir, depth) {
    if (depth > LIMITS.depth) { truncated = true; return }
    const listing = await opendir(dir)
    for await (const entry of listing) {
      if (++entries > LIMITS.entries || Date.now() - start > LIMITS.milliseconds || candidates >= LIMITS.files || bytes >= LIMITS.totalBytes) { truncated = true; break }
      if (entry.isSymbolicLink() || SKIP.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name), rel = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile() && /\.bsl$/iu.test(entry.name)) { if (modules.length < LIMITS.files) modules.push(rel); else truncated = true }
      else if (entry.isFile() && /\.(xml|mdo|form)$/iu.test(entry.name)) {
        candidates += 1
        try {
          const data = await inspectFile(root, rel)
          if (bytes + data.bytes > LIMITS.totalBytes) { truncated = true; break }
          bytes += data.bytes
          if (data.objects.length || data.elements.length || /(?:^|\/)Form\.(?:xml|mdo|form)$/iu.test(rel)) output.push({ path: rel, objects: data.objects, elements: data.elements.length, events: data.events.length })
        } catch { warnings.push({ path: rel, reason: 'Файл пропущен: XML, ограничение размера или безопасного пути.' }) }
      }
    }
  }
  if (!isAbsolute(root) || await realpath(root) !== resolve(root) || (await lstat(root)).isSymbolicLink()) throw new Error('WORKSPACE_REJECTED')
  await visit(root, 0)
  return { files: output, modules, warnings, truncated, scannedEntries: entries, scannedXml: candidates, readBytes: bytes, limits: LIMITS }
}
