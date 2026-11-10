import YAML from '../vendor/yaml/dist/index.js'

const normalize = value => value.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
export const NATIVE_FS_COMPAT_BLOCK = "- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n  disabled: true"
const exactNativeFs = block => normalize(block).trim() === NATIVE_FS_COMPAT_BLOCK
const yamlOptions = { strict: true, uniqueKeys: true,
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }

function mentionsId(block, id) {
  // Inspect configuration as data, including quoted keys and flow YAML. !!js
  // is an opaque scalar here; no loader or expression evaluator is involved.
  const doc = YAML.parseDocument(block, yamlOptions)
  if (doc.errors.length || doc.warnings.length) return block.includes(id)
  const visit = (node, depth = 0) => {
    if (depth > 100) return true
    if (YAML.isMap(node)) return node.items.some(pair =>
      (YAML.isScalar(pair.key) && pair.key.value === 'id' && YAML.isScalar(pair.value) && pair.value.value === id) || visit(pair.value, depth + 1))
    return YAML.isSeq(node) && node.items.some(item => visit(item, depth + 1))
  }
  return visit(doc.contents)
}

function exactCompatInsert(block) {
  const doc = YAML.parseDocument(block, yamlOptions)
  if (doc.errors.length || doc.warnings.length || !YAML.isSeq(doc.contents) || doc.contents.items.length !== 1) return false
  const host = doc.contents.items[0], inserted = YAML.isMap(host) ? host.get('insert', true) : undefined
  if (!YAML.isSeq(inserted)) return false
  const providers = inserted.items.filter(row => YAML.isMap(row) && row.get('id') === 'airules-native-fs')
  const count = (node, depth = 0) => {
    if (depth > 100) return Number.NaN
    if (YAML.isMap(node)) return Number(node.get('id') === 'airules-native-fs') + node.items.reduce((sum, pair) => sum + count(pair.value, depth + 1), 0)
    if (YAML.isSeq(node)) return node.items.reduce((sum, item) => sum + count(item, depth + 1), 0)
    return 0
  }
  return providers.length === 1 && count(doc.contents) === 1 && providers[0].items.length === 2 && providers[0].get('name') === 'airules-dsh-native-fs'
}

function blockSpans(text) {
  const source = text
  const starts = []
  const pattern = /^-\s+\S/gmu
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) starts.push(match.index)
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? source.length, text: source.slice(start, starts[index + 1] ?? source.length).trimEnd() }))
}

const blocks = text => blockSpans(text).map(row => row.text)

const empty = text => {
  const body = normalize(text).split('\n').filter(line => !/^\s*(?:#.*)?$/u.test(line)).join('\n').trim()
  return body === '' || body === '[]'
}

const prefix = text => normalize(text).split('\n').filter(line => /^\s*#/u.test(line)).join('\n')
const HOST_IDS = new Set(['airules-onec-bsl-editor', 'airules-openspec', 'airules-telegram',
  'airules-acp', 'airules-acp-adapter', 'airules-subscriptions', 'airules-mobile', 'airules-mcp-manager',
  'airules-additional-providers', 'airules-onec-panels', 'airules-project-settings', 'airules-model-orchestration', 'airules-domain-presets',
  'airules-workflows', 'airules-agent-import', 'airules-skills', 'airules-general-tools', 'airules-documents', 'airules-onec-capabilities', 'airules-native-fs',
  'airules-memory','airules-continuity','airules-provider-extensions','airules-cursor-provider','airules-onec-specialized'])
function ownership(block) {
  if (mentionsId(block, 'fs-sandbox')) return exactNativeFs(block) ? 'native-fs' : 'ambiguous'
  const hasCompatFs = mentionsId(block, 'airules-native-fs')
  const mentionsPreset = /(?:^|\n)\s*-\s+id:\s*['"]?preset-1c-airules['"]?\s*$/mu.test(block)
  const mentionsEditor = /(?:^|\n)\s*-\s+id:\s*['"]?airules-onec-bsl-editor['"]?\s*$/mu.test(block)
  const mentionsRegistry = /^-\s+id:\s*['"]?agent-preset-registry['"]?\s*$/mu.test(block)
  const preset = /^\s{4}-\s+id:\s*preset-1c-airules\s*$/mu.test(block)
  const editor = /^\s{4}-\s+id:\s*airules-onec-bsl-editor\s*$/mu.test(block)
  const registryId = /^-\s+id:\s*agent-preset-registry\s*$/mu.test(block)
  const registry = registryId && /^\s+default:\s*1c-airules\s*$/mu.test(block)
  if (!mentionsPreset && !mentionsEditor && !mentionsRegistry) return hasCompatFs ? 'ambiguous' : null
  if (hasCompatFs && (!mentionsEditor || !exactCompatInsert(block))) return 'ambiguous'
  if ((!preset && mentionsPreset) || (!editor && mentionsEditor) || (!registryId && mentionsRegistry)) return 'ambiguous'
  if (preset || editor) {
    const directIds = [...block.matchAll(/^\s{4}-\s+id:\s*([^\s#]+)\s*$/gmu)].map(match => match[1])
    const expected = preset ? 'preset-1c-airules' : 'airules-onec-bsl-editor'
    const dedicated = preset ? directIds.length === 1 && directIds[0] === expected
      : directIds.includes(expected) && new Set(directIds).size === directIds.length && directIds.every(id => HOST_IDS.has(id))
    if (!/^-\s+insert:\s*$/mu.test(block) || !dedicated || (preset && editor)) return 'ambiguous'
    return preset ? 'preset' : 'editor'
  }
  return registry ? 'registry' : 'ambiguous'
}

function ownedAnalysis(current) {
  const owned = [], ambiguous = []
  for (const span of blockSpans(current)) {
    const kind = ownership(span.text)
    if (kind === 'ambiguous') ambiguous.push(span)
    else if (kind) owned.push({ ...span, kind })
  }
  const duplicates = owned.filter((row, index) => owned.findIndex(item => item.kind === row.kind) !== index)
  return { owned, ambiguous: [...ambiguous, ...duplicates] }
}

export function validatePolicyFragment(fragment) {
  const rows = blocks(fragment)
  if (![3, 4].includes(rows.length) || (rows.length === 4 && (!exactNativeFs(rows[3]) || !exactCompatInsert(rows[1]) || rows.some((row, index) => index !== 1 && mentionsId(row, 'airules-native-fs')))) ||
      (rows.length === 3 && rows.some(row => mentionsId(row, 'airules-native-fs'))) || !/^-\s+insert:\s*$/mu.test(rows[0]) || !/^\s+-\s+id:\s*preset-1c-airules\s*$/mu.test(rows[0]) ||
      !/^-\s+insert:\s*$/mu.test(rows[1]) || !/^\s+-\s+id:\s*airules-onec-bsl-editor\s*$/mu.test(rows[1]) || !/^\s+name:\s*dsh-bsl-editor\s*$/mu.test(rows[1]) ||
      !/^-\s+id:\s*agent-preset-registry\s*$/mu.test(rows[2]) || !/^\s+default:\s*1c-airules\s*$/mu.test(rows[2])) {
    throw Object.assign(new Error('POLICY_CORDIS_FRAGMENT_INVALID'), { code: 'POLICY_CORDIS_FRAGMENT_INVALID' })
  }
  if (/https?:\/\/|\bheaders?\s*:|\btoken\s*:|\bcredentials?\s*:/iu.test(rows.join('\n'))) {
    throw Object.assign(new Error('POLICY_CORDIS_FORBIDDEN_BINDING'), { code: 'POLICY_CORDIS_FORBIDDEN_BINDING' })
  }
  return rows
}

export function analyzePolicyCordis(current, fragment) {
  const desired = validatePolicyFragment(fragment)
  if (empty(current)) return { action: 'merge', collision: false, reason: null }
  const { owned, ambiguous } = ownedAnalysis(current)
  if (ambiguous.length) return { action: 'refuse', collision: true, replaceable: false, reason: 'POLICY_CORDIS_AMBIGUOUS' }
  if (!owned.length) return { action: 'merge', collision: false, reason: null }
  if (owned.length === desired.length && owned.map(row => row.text.trim()).join('\n') === desired.map(row => row.trim()).join('\n')) {
    return { action: 'noop', collision: false, replaceable: true, reason: null }
  }
  const kinds = new Set(owned.map(row => row.kind))
  if (!kinds.has('preset') || !kinds.has('registry') || ![2, 3, 4].includes(owned.length) || (kinds.has('native-fs') && !kinds.has('editor'))) {
    return { action: 'refuse', collision: true, replaceable: false, reason: 'POLICY_CORDIS_AMBIGUOUS' }
  }
  return { action: 'replace', collision: true, replaceable: true, reason: 'POLICY_CORDIS_COLLISION' }
}

export function mergePolicyCordis(current, fragment, { replaceCollisions = false } = {}) {
  const analysis = analyzePolicyCordis(current, fragment)
  if (analysis.action === 'noop') return { ...analysis, text: current }
  if (analysis.collision && (!replaceCollisions || !analysis.replaceable)) throw Object.assign(new Error(analysis.reason), { code: analysis.reason })
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const desired = `${validatePolicyFragment(fragment).join('\n').replace(/\n/gu, eol)}${eol}`
  if (analysis.action === 'replace') {
    const owned = ownedAnalysis(current).owned.sort((a, b) => b.start - a.start)
    let retained = current
    for (const row of owned) retained = `${retained.slice(0, row.start)}${retained.slice(row.end)}`
    const separator = retained.length && !/\r?\n$/u.test(retained) ? eol : ''
    return { ...analysis, collision: false, text: `${retained}${separator}${desired}` }
  }
  if (empty(current)) {
    const comments = prefix(current)
    return { ...analysis, text: comments ? `${comments.replace(/\n/gu, eol)}${eol}${desired}` : desired }
  }
  const separator = current.length && !/\r?\n$/u.test(current) ? eol : ''
  return { ...analysis, text: `${current}${separator}${desired}` }
}
