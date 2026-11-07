const AIRULES_ID = 'airules-policy'

function normalizeBlock(value) {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').trim()
}

function topLevelBlocks(text) {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  const starts = []
  const pattern = /^-\s+\S/gmu
  for (let match = pattern.exec(normalized); match; match = pattern.exec(normalized)) starts.push(match.index)
  return starts.map((start, index) => {
    const segment = normalized.slice(start, starts[index + 1] ?? normalized.length)
    const lines = segment.split('\n')
    while (lines.length && (/^\s*$/u.test(lines.at(-1)) || /^#/u.test(lines.at(-1)))) lines.pop()
    return lines.join('\n')
  })
}

function idCount(block, id = AIRULES_ID) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return [...block.matchAll(new RegExp(`^\\s*-?\\s*id:\\s*${escaped}\\s*$`, 'gmu'))].length
}

function nestedProviderCount(block) {
  return [...block.matchAll(/^\s+-\s+id:\s*\S+\s*$/gmu)].length
}

export function validateCordisFragment(fragment) {
  const blocks = topLevelBlocks(fragment)
  if (blocks.length !== 1 || idCount(blocks[0]) !== 1 || nestedProviderCount(blocks[0]) !== 1) {
    const error = new Error('CORDIS_FRAGMENT_INVALID')
    error.code = 'CORDIS_FRAGMENT_INVALID'
    throw error
  }
  if (!/^\s*name:\s*airules-dsh-provider\s*$/gmu.test(blocks[0])) {
    const error = new Error('CORDIS_FRAGMENT_INVALID')
    error.code = 'CORDIS_FRAGMENT_INVALID'
    throw error
  }
  return blocks[0]
}

export function analyzeCordis(current, fragment) {
  const desired = validateCordisFragment(fragment)
  const matches = topLevelBlocks(current).filter(block => idCount(block) > 0)
  if (!matches.length) return { action: 'merge', collision: false, reason: null }
  if (matches.length > 1 || matches.some(block => idCount(block) !== 1)) {
    return { action: 'refuse', collision: true, reason: 'CORDIS_MULTIPLE_AIRULES_ENTRIES' }
  }
  if (normalizeBlock(matches[0]) === normalizeBlock(desired)) {
    return { action: 'noop', collision: false, reason: null }
  }
  if (nestedProviderCount(matches[0]) !== 1) {
    return { action: 'refuse', collision: true, reason: 'CORDIS_SHARED_BLOCK_COLLISION' }
  }
  return { action: 'replace', collision: true, reason: 'CORDIS_ENTRY_DIFFERS' }
}

export function mergeCordis(current, fragment, { replaceCollision = false } = {}) {
  const analysis = analyzeCordis(current, fragment)
  if (analysis.action === 'noop') return { ...analysis, text: current }
  if (analysis.action === 'refuse' || (analysis.action === 'replace' && !replaceCollision)) {
    const error = new Error(analysis.reason)
    error.code = analysis.reason
    throw error
  }

  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const desired = validateCordisFragment(fragment).replace(/\r\n|\n/gu, eol).trimEnd() + eol
  if (analysis.action === 'merge') {
    const separator = current.length && !current.endsWith('\n') ? eol : ''
    return { ...analysis, text: current + separator + desired }
  }

  const normalized = current.replace(/\r\n/gu, '\n')
  const blocks = topLevelBlocks(current)
  const old = blocks.find(block => idCount(block) > 0)
  const oldNormalized = old.replace(/\r\n/gu, '\n')
  const index = normalized.indexOf(oldNormalized)
  if (index < 0) {
    const error = new Error('CORDIS_STRUCTURE_CHANGED')
    error.code = 'CORDIS_STRUCTURE_CHANGED'
    throw error
  }
  const merged = normalized.slice(0, index) + desired.replace(/\r\n/gu, '\n') + normalized.slice(index + oldNormalized.length)
  return { ...analysis, text: eol === '\r\n' ? merged.replace(/\n/gu, '\r\n') : merged }
}
