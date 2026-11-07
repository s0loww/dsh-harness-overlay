const OWNED_IDS = Object.freeze([
  'ui-gui-customization',
  'tokenledger',
  'dock',
  'dock-files',
  'dsh-activity-pane',
  'dsh-always-status-bar',
  'dsh-auto-collapse',
  'composer-history',
  'ui-effort-slider',
  'notify',
  'dsh-sleep-send',
  'dsh-tool-autoexpand',
  'dsh-turn-navigator',
  'airules-provider-limits-hud',
  'airules-russian-localization',
])

const normalized = value => value.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
const OWNED_GENERATIONS = [OWNED_IDS, [...OWNED_IDS, 'airules-providers-settings']]
const validOwnedIds = values => OWNED_GENERATIONS.some(expected => sameSet(values, expected))
const blockText = value => normalized(value).trim()

function topLevelBlocks(text) {
  const source = normalized(text)
  const starts = []
  const pattern = /^-\s+\S/gmu
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) starts.push(match.index)
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length).trimEnd())
}

function ids(block) {
  return [...block.matchAll(/^\s+-\s+id:\s*([^\s#]+)\s*$/gmu)].map(match => match[1])
}

function sameSet(left, right) {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every(value => expected.has(value)) && new Set(left).size === left.length
}

function emptyDocument(text) {
  const body = normalized(text).split('\n').filter(line => !/^\s*(?:#.*)?$/u.test(line)).join('\n').trim()
  return body === '' || body === '[]'
}

function commentPrefix(text) {
  return normalized(text).split('\n').filter(line => /^\s*#/u.test(line)).join('\n')
}

export function validateUiCordisFragment(fragment) {
  const blocks = topLevelBlocks(fragment)
  if (blocks.length !== 1 || !/^-\s+insert:\s*$/mu.test(blocks[0]) || !validOwnedIds(ids(blocks[0]))) {
    throw Object.assign(new Error('UI_CORDIS_FRAGMENT_INVALID'), { code: 'UI_CORDIS_FRAGMENT_INVALID' })
  }
  const forbidden = /(?:\bmcp\b|https?:\/\/|\bheaders?\b|\btoken\b|\bcredentials?\b)/iu
  if (forbidden.test(blocks[0])) throw Object.assign(new Error('UI_CORDIS_FRAGMENT_FORBIDDEN_BINDING'), { code: 'UI_CORDIS_FRAGMENT_FORBIDDEN_BINDING' })
  return blocks[0]
}

export function analyzeUiCordis(current, fragment) {
  const desired = validateUiCordisFragment(fragment)
  if (emptyDocument(current)) return { action: 'merge', collision: false, reason: null }
  const owned = topLevelBlocks(current).filter(block => ids(block).some(id => OWNED_IDS.includes(id)))
  if (!owned.length) return { action: 'merge', collision: false, reason: null }
  if (owned.length !== 1) return { action: 'refuse', collision: true, reason: 'UI_CORDIS_MULTIPLE_OWNERS' }
  const actualIds = ids(owned[0])
  if (!validOwnedIds(actualIds)) return { action: 'refuse', collision: true, reason: 'UI_CORDIS_SHARED_BLOCK' }
  if (blockText(owned[0]) === blockText(desired)) return { action: 'noop', collision: false, reason: null }
  return { action: 'replace', collision: true, reason: 'UI_CORDIS_BLOCK_DIFFERS' }
}

export function mergeUiCordis(current, fragment, { replaceCollision = false } = {}) {
  const analysis = analyzeUiCordis(current, fragment)
  if (analysis.action === 'noop') return { ...analysis, text: current }
  if (analysis.action === 'refuse' || (analysis.action === 'replace' && !replaceCollision)) {
    throw Object.assign(new Error(analysis.reason), { code: analysis.reason })
  }
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const desired = `${validateUiCordisFragment(fragment).replace(/\n/gu, eol).trimEnd()}${eol}`
  if (emptyDocument(current)) {
    const comments = commentPrefix(current)
    return { ...analysis, text: comments ? `${comments.replace(/\n/gu, eol)}${eol}${desired}` : desired }
  }
  if (analysis.action === 'merge') {
    const separator = current.length && !/\r?\n$/u.test(current) ? eol : ''
    return { ...analysis, text: `${current}${separator}${desired}` }
  }
  const source = normalized(current)
  const old = topLevelBlocks(current).find(block => ids(block).some(id => OWNED_IDS.includes(id)))
  const index = source.indexOf(old)
  if (index < 0) throw Object.assign(new Error('UI_CORDIS_STRUCTURE_CHANGED'), { code: 'UI_CORDIS_STRUCTURE_CHANGED' })
  const result = source.slice(0, index) + desired.replace(/\r\n/gu, '\n') + source.slice(index + old.length)
  return { ...analysis, text: eol === '\r\n' ? result.replace(/\n/gu, '\r\n') : result }
}

export const UI_CORDIS_IDS = OWNED_IDS
