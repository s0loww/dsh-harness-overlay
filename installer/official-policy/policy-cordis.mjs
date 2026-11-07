const normalize = value => value.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')

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
  'airules-additional-providers', 'airules-onec-panels', 'airules-project-settings', 'airules-model-orchestration', 'airules-domain-presets'])
function ownership(block) {
  const mentionsPreset = /(?:^|\n)\s*-\s+id:\s*['"]?preset-1c-airules['"]?\s*$/mu.test(block)
  const mentionsEditor = /(?:^|\n)\s*-\s+id:\s*['"]?airules-onec-bsl-editor['"]?\s*$/mu.test(block)
  const mentionsRegistry = /^-\s+id:\s*['"]?agent-preset-registry['"]?\s*$/mu.test(block)
  const preset = /^\s{4}-\s+id:\s*preset-1c-airules\s*$/mu.test(block)
  const editor = /^\s{4}-\s+id:\s*airules-onec-bsl-editor\s*$/mu.test(block)
  const registryId = /^-\s+id:\s*agent-preset-registry\s*$/mu.test(block)
  const registry = registryId && /^\s+default:\s*1c-airules\s*$/mu.test(block)
  if (!mentionsPreset && !mentionsEditor && !mentionsRegistry) return null
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
  if (rows.length !== 3 || !/^-\s+insert:\s*$/mu.test(rows[0]) || !/^\s+-\s+id:\s*preset-1c-airules\s*$/mu.test(rows[0]) ||
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
  if (owned.length === 3 && owned.map(row => row.text.trim()).join('\n') === desired.map(row => row.trim()).join('\n')) {
    return { action: 'noop', collision: false, replaceable: true, reason: null }
  }
  const kinds = new Set(owned.map(row => row.kind))
  if (!kinds.has('preset') || !kinds.has('registry') || ![2, 3].includes(owned.length)) {
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
