import YAML from '../vendor/yaml/dist/index.js'
import { validatePolicyFragment } from '../official-policy/policy-cordis.mjs'

const fail = detail => { throw Object.assign(new Error(`LIVE_CORDIS_MIGRATION_CONFLICT: ${detail}`), { code: 'LIVE_CORDIS_MIGRATION_CONFLICT' }) }
const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }], strict: true, uniqueKeys: true }
function parse(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 2 * 1024 * 1024) fail('document size')
  const doc = YAML.parseDocument(source, options)
  if (doc.errors.length || doc.warnings.length || !YAML.isSeq(doc.contents)) fail('invalid YAML sequence')
  normalize(doc.contents)
  if (!doc.contents.items.every(YAML.isMap)) fail('invalid root row')
  return doc
}
function normalize(node, depth = 0) {
  if (depth > 100 || YAML.isAlias(node)) fail('alias or depth')
  if (node == null) return null
  if (YAML.isScalar(node)) {
    if (typeof node.value === 'number' && !Number.isFinite(node.value)) fail('nonfinite value')
    return ['scalar', node.tag ?? '', typeof node.value, node.value]
  }
  if (YAML.isSeq(node)) return ['sequence', node.items.map(value => normalize(value, depth + 1))]
  if (YAML.isMap(node)) return ['map', node.items.map(pair => {
    if (!YAML.isScalar(pair.key) || typeof pair.key.value !== 'string') fail('non-string map key')
    return [pair.key.value, normalize(pair.value, depth + 1)]
  }).sort(([a], [b]) => a.localeCompare(b, 'en'))]
  fail('unsupported YAML node')
}
const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
const keyOf = pair => pair.key.value
const get = (map, key) => map?.items.find(pair => keyOf(pair) === key)?.value
const value = node => YAML.isScalar(node) ? node.value : undefined
const idOf = node => YAML.isMap(node) ? value(get(node, 'id')) : undefined
function cloneWithComments(next, current) {
  if (next == null) return next
  const result = next.clone()
  for (const key of ['comment', 'commentBefore', 'spaceBefore']) if (current?.[key] !== undefined) result[key] = current[key]
  if (YAML.isMap(result) && YAML.isMap(current)) {
    for (const pair of result.items) pair.value = cloneWithComments(pair.value, get(current, keyOf(pair)))
  } else if (YAML.isSeq(result) && YAML.isSeq(current)) {
    const nextIds = ids(result), currentIds = ids(current)
    if (nextIds && currentIds) result.items = result.items.map(row => cloneWithComments(row, current.items.find(item => idOf(item) === idOf(row))))
    else if (result.items.length === current.items.length) result.items = result.items.map((row, index) => cloneWithComments(row, current.items[index]))
  }
  return result
}
function ids(sequence) {
  if (!YAML.isSeq(sequence)) return null
  const result = sequence.items.map(idOf)
  return result.every(id => typeof id === 'string' && id.length) && new Set(result).size === result.length ? result : null
}
// Three-way merge: preserve user changes wherever this release has no delta.
// A simultaneous change to the same value is a conflict, never an overwrite.
function merge(old, next, current, path) {
  if (same(old, next)) return current?.clone()
  if (same(old, current) || same(next, current)) return cloneWithComments(next, current)
  if (YAML.isMap(old) && YAML.isMap(next) && YAML.isMap(current)) {
    const result = current.clone()
    const keys = new Set([...old.items, ...next.items].map(keyOf))
    for (const key of keys) {
      const merged = merge(get(old, key), get(next, key), get(current, key), `${path}.${key}`)
      const pair = result.items.find(pair => keyOf(pair) === key)
      if (merged == null) result.items = result.items.filter(item => item !== pair)
      else if (pair) pair.value = merged
      else result.items.push(new YAML.Pair(new YAML.Scalar(key), merged))
    }
    return result
  }
  const oldIds = ids(old), nextIds = ids(next), currentIds = ids(current)
  if (oldIds && nextIds && currentIds) {
    const result = current.clone()
    for (const id of new Set([...oldIds, ...nextIds])) {
      const merged = merge(old.items.find(row => idOf(row) === id), next.items.find(row => idOf(row) === id), current.items.find(row => idOf(row) === id), `${path}[${id}]`)
      const index = result.items.findIndex(row => idOf(row) === id)
      if (merged == null) { if (index >= 0) result.items.splice(index, 1) }
      else if (index >= 0) result.items[index] = merged
      else result.items.push(merged)
    }
    if (JSON.stringify(oldIds) !== JSON.stringify(nextIds)) {
      const common = id => oldIds.includes(id) && nextIds.includes(id) && currentIds.includes(id)
      const oldOrder = oldIds.filter(common), nextOrder = nextIds.filter(common), currentOrder = currentIds.filter(common)
      if (JSON.stringify(currentOrder) !== JSON.stringify(oldOrder) && JSON.stringify(currentOrder) !== JSON.stringify(nextOrder)) fail(`${path} order`)
      const ordered = nextIds.map(id => result.items.find(row => idOf(row) === id)).filter(Boolean)
      let index = 0
      result.items = result.items.map(row => nextIds.includes(idOf(row)) ? ordered[index++] : row)
    }
    return result
  }
  fail(path)
}
function identity(row) {
  const id = idOf(row)
  if (id) return { type: 'id', id }
  const list = ids(get(row, 'insert'))
  if (!list?.length) fail('unidentified managed block')
  return { type: 'insert', ids: list }
}
function matches(row, identity) {
  if (identity.type === 'id') return idOf(row) === identity.id
  const list = ids(get(row, 'insert'))
  return list?.some(id => identity.ids.includes(id)) ?? false
}
function serialize(row, eol) {
  const doc = new YAML.Document(undefined, options)
  doc.contents = new YAML.YAMLSeq()
  doc.contents.items = [row]
  return doc.toString({ lineWidth: 0 }).replace(/\n/g, eol)
}

function mentionsId(node, id) {
  if (YAML.isMap(node)) return idOf(node) === id || node.items.some(pair => mentionsId(pair.value, id))
  return YAML.isSeq(node) && node.items.some(item => mentionsId(item, id))
}
const mentionsNativeFs = node => mentionsId(node, 'fs-sandbox')

// Cardinality changes are reserved for this exact, reviewed global provider
// alias. No other new root row or unrelated fragment gets this exception.
// Provider extensions, Cursor and specialized 1C hosts belong to the existing
// host insert row; their tools belong to the existing preset plugin sequence.
// The ordinary id-aware three-way merge handles those additions without a new
// root cardinality exception or replacing the user's existing runtime config.
function nativeFsCardinality(oldFragment, newFragment, old, next) {
  if (old.length === next.length) return null
  if (!((old.length === 3 && next.length === 4) || (old.length === 4 && next.length === 3))) fail('managed block cardinality')
  try { validatePolicyFragment(oldFragment); validatePolicyFragment(newFragment) }
  catch { fail('managed block cardinality') }
  return old.length === 3 ? 'add' : 'remove'
}

/** Data-only migration. !!js remains an opaque tagged scalar and is never run. */
export function migrateCordisFragments(current, pairs) {
  let source = current
  for (const { oldFragment, newFragment } of pairs) {
    if (oldFragment === newFragment) continue
    const old = parse(oldFragment).contents.items, next = parse(newFragment).contents.items
    const nativeFsChange = nativeFsCardinality(oldFragment, newFragment, old, next)
    const doc = parse(source), rows = doc.contents.items, replacements = [], claimed = new Set()
    if (nativeFsChange === 'add' && rows.some(row => mentionsNativeFs(row) || mentionsId(row, 'airules-native-fs'))) fail('native filesystem provider collision')
    if (nativeFsChange === 'remove') {
      const found = rows.map((row, index) => mentionsNativeFs(row) ? index : -1).filter(index => index >= 0)
      if (found.length !== 1 || !same(rows[found[0]], old[3])) fail('native filesystem provider ownership')
      const row = rows[found[0]]
      claimed.add(found[0])
      replacements.push({ start: source.lastIndexOf('\n', row.range[0] - 1) + 1, end: row.range[2], text: '' })
    }
    for (let index = 0; index < Math.min(old.length, next.length); index++) {
      if (same(old[index], next[index])) continue
      const signature = identity(old[index])
      if (!matches(next[index], signature)) fail('managed identity changed')
      const found = rows.map((row, index) => matches(row, signature) ? index : -1).filter(index => index >= 0)
      if (found.length !== 1 || claimed.has(found[0])) fail('missing or ambiguous managed block')
      const position = found[0], row = rows[position]
      claimed.add(position)
      const merged = merge(old[index], next[index], row, signature.id ?? signature.ids.join(','))
      // This prefix lies before the replaced range and stays in source bytes.
      // Serializing commentBefore again would duplicate the user's comment.
      merged.commentBefore = undefined
      merged.spaceBefore = false
      // A newly managed id must not already belong to another current block.
      const beforeIds = ids(get(old[index], 'insert')) ?? [], afterIds = ids(get(next[index], 'insert')) ?? []
      for (const id of afterIds.filter(id => !beforeIds.includes(id))) {
        if (rows.some((other, i) => i !== position && ((ids(get(other, 'insert')) ?? []).includes(id) || idOf(other) === id))) fail('new managed id collision')
      }
      const start = source.lastIndexOf('\n', row.range[0] - 1) + 1
      const end = row.range[2]
      replacements.push({ start, end, text: serialize(merged, source.includes('\r\n') ? '\r\n' : '\n') })
    }
    for (const row of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, row.start) + row.text + source.slice(row.end)
    if (nativeFsChange === 'add') {
      const eol = source.includes('\r\n') ? '\r\n' : '\n'
      source += (source.length && !/\r?\n$/u.test(source) ? eol : '') + serialize(next[3], eol)
    }
    parse(source)
  }
  return source
}
