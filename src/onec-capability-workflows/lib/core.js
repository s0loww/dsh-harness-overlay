import { createHash } from 'node:crypto'

export const CATEGORIES = Object.freeze({
  all: [], code: ['code', 'bsl', 'search', 'поиск', 'код'], metadata: ['metadata', 'метадан', 'form', 'форм'],
  impact: ['impact', 'usage', 'caller', 'callee', 'dependency', 'graph', 'влияни', 'использован', 'граф'],
  docs: ['help', 'docs', 'documentation', 'справ', 'бсп', 'ssl'], memory: ['memory', 'template', 'памят', 'шаблон'],
  qa: ['qa', 'testing', 'ui', 'test', 'тест'], capture: ['screenshot', 'capture', 'render', 'снимок', 'скрин'],
  journal: ['journal', 'eventlog', 'log', 'журнал', 'жр'], debug: ['debug', 'runtime', 'отлад', 'диагност'],
})
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)

/** Definition discovery only. Neither matching words nor a registered schema
 * proves transport health, semantic coverage or permission to execute it. */
export function discoverCapabilities(schemas, { category = 'all', query = '', limit = 8, offset = 0 } = {}) {
  if (!Object.hasOwn(CATEGORIES, category) || typeof query !== 'string' || query.length > 200
    || !Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0 || offset > 4096
    || !Array.isArray(schemas)) fail('CAPABILITY_QUERY_INVALID')
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean), terms = CATEGORIES[category]
  const matched = []
  for (const row of schemas.slice(0, 4096)) {
    if (!plain(row) || typeof row.name !== 'string' || row.name.length > 256 || row.name === 'airules_capabilities') continue
    const description = typeof row.description === 'string' ? row.description : ''
    const text = `${row.name} ${description}`.toLowerCase()
    const matches = term => term.length <= 3 ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${term}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text) : text.includes(term)
    const score = terms.reduce((n, term) => n + Number(matches(term)), 0)
      + words.reduce((n, term) => n + Number(text.includes(term)) * 4, 0)
    if ((terms.length && !terms.some(matches)) || (words.length && !words.some(term => text.includes(term)))) continue
    let parameters, schemaDigest = null, schemaOmitted = false
    try {
      const data = JSON.stringify(row.parameters ?? {})
      if (Buffer.byteLength(data) > 32768) schemaOmitted = true
      else { parameters = JSON.parse(data); schemaDigest = hash(data) }
    } catch { schemaOmitted = true }
    matched.push({ name: row.name, description: description.slice(0, 600), descriptionTruncated: description.length > 600, ...(parameters ? { parameters } : {}), schemaDigest, schemaOmitted, score })
  }
  matched.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  let bytes = 0
  const candidates = matched.slice(offset, offset + limit).map(({ score, ...row }) => {
    const size = Buffer.byteLength(JSON.stringify(row))
    bytes += size
    if (bytes <= 128 * 1024) return row
    const { parameters, ...small } = row
    return { ...small, schemaOmitted: true }
  })
  return { schemaVersion: 1, category, query, visibleCount: schemas.length, matchedCount: matched.length,
    complete: schemas.length <= 4096, offset, nextOffset: offset + limit < matched.length ? offset + limit : null,
    candidates,
    observation: 'definition-visible', health: 'not-probed', execution: 'not-performed',
    note: 'Candidates are actual visible schemas, not verified semantic bindings. Inspect the selected schema and project/target scope before calling. Nested facade operations require that facade\'s own discovery.' }
}
