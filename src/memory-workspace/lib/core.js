import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const fail = code => { throw new Error(code) }
const clean = (value, max = 300) => String(value ?? '').slice(0, max)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)
// A controller can rotate service instances while an older request is in flight.
// Keep receipt maps/loading/serialization shared for the lifetime of this module.
const journals = new Map()
function journalCoordinator(journalPath) {
  if (!journalPath) return { writes: new Map(), processing: new Map(), ready: null, queue: Promise.resolve(), endpoint: null }
  const resolved = path.resolve(journalPath), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (!journals.has(key)) journals.set(key, { writes: new Map(), processing: new Map(), ready: null, queue: Promise.resolve(), endpoint: null })
  return journals.get(key)
}
function bounded(value, depth = 0) {
  if (typeof value === 'string') return clean(value, 24_000)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 6) return '[limited]'
  if (Array.isArray(value)) return value.slice(0, 30).map(item => bounded(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [clean(key, 128), bounded(item, depth + 1)]))
  return null
}

export function datasetForRoot(root) {
  if (typeof root !== 'string' || root.includes('\0') || (!path.win32.isAbsolute(root) && !path.posix.isAbsolute(root))) fail('PROJECT_ROOT_REQUIRED')
  const windows = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\')
  const normalized = windows ? path.win32.normalize(root).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : path.posix.normalize(root).replace(/\/+$/, '') || '/'
  return `airules-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`
}

export function validateEndpoint(value) {
  let url
  try { url = new URL(value) } catch { fail('COGNEE_ENDPOINT_INVALID') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('COGNEE_LOOPBACK_REQUIRED')
  return url.origin
}

function resolveSchema(spec, value, seen = new Set()) {
  if (!value || typeof value !== 'object') return {}
  if (value.$ref) {
    if (!value.$ref.startsWith('#/') || seen.has(value.$ref)) fail('COGNEE_SCHEMA_UNSUPPORTED')
    const next = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec)
    return resolveSchema(spec, next, new Set([...seen, value.$ref]))
  }
  if (value.allOf) return value.allOf.reduce((acc, item) => { const part = resolveSchema(spec, item, seen); return { ...acc, ...part, properties: { ...acc.properties, ...part.properties } } }, {})
  return value
}
function pick(properties, candidates, required = true) {
  const key = candidates.find(candidate => own(properties, candidate))
  if (!key && required) fail('COGNEE_SCHEMA_UNSUPPORTED')
  return key
}
function enumValues(spec, schema) {
  const resolved = resolveSchema(spec, schema)
  return resolved.enum ?? resolved.anyOf?.flatMap(value => enumValues(spec, value)) ?? []
}
function operation(spec, suffix, method) {
  const matches = Object.entries(spec.paths ?? {}).filter(([route, value]) => route.replace(/\/$/, '') === `/api/v1${suffix}` && value[method])
  if (matches.length !== 1) return null
  const [route, descriptor] = matches[0]
  // Discovered routes must stay API-local, with no queries, traversal or encoded redirects.
  if (!/^\/api\/v1\/[a-zA-Z0-9_{}\-/]+$/.test(route) || route.includes('..')) fail('COGNEE_SCHEMA_UNSUPPORTED')
  return { route, ...descriptor[method], pathParameters: descriptor.parameters ?? [] }
}
function bodySchema(spec, op, media) {
  return resolveSchema(spec, resolveSchema(spec, op?.requestBody).content?.[media]?.schema)
}
function parameter(op, candidates, place = 'query') {
  return [...op?.pathParameters ?? [], ...op?.parameters ?? []].find(value => value.in === place && candidates.includes(value.name))?.name
}

/** No import-time I/O, no ambient credentials, no writes unless remember/process are called. */
export function createMemoryService({ endpoint = 'http://127.0.0.1:18080', apiKey, journalPath, fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxResponseBytes = 4 * 1024 * 1024, allowProcessing = false, capabilityTtlMs = 60_000 } = {}) {
  endpoint = validateEndpoint(endpoint)
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 16 * 1024 * 1024) fail('COGNEE_OPTIONS_INVALID')
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey))) fail('COGNEE_AUTH_INVALID')
  if (journalPath !== undefined && (typeof journalPath !== 'string' || !path.isAbsolute(journalPath))) fail('COGNEE_JOURNAL_INVALID')
  let cached, cacheTime = 0, inflight
  const journal = journalCoordinator(journalPath), { writes, processing } = journal
  async function loadJournal() {
    if (!journalPath) return
    journal.ready ??= (async () => {
      let bytes
      try { bytes = await readFile(journalPath) } catch (error) { if (error.code === 'ENOENT') { journal.endpoint = endpoint; return } fail('COGNEE_JOURNAL_UNAVAILABLE') }
      if (bytes.length > 1024 * 1024) fail('COGNEE_JOURNAL_INVALID')
      let value
      try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('COGNEE_JOURNAL_INVALID') }
      if (value.version !== 2 || typeof value.endpoint !== 'string' || !Array.isArray(value.writes) || !Array.isArray(value.processing) || value.writes.length + value.processing.length > 1000) fail('COGNEE_JOURNAL_INVALID')
      journal.endpoint = validateEndpoint(value.endpoint)
      for (const [rows, target, keyPattern] of [[value.writes, writes, /^airules-[0-9a-f]{32}:[0-9a-f]{64}$/], [value.processing, processing, /^airules-[0-9a-f]{32}$/]]) {
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !keyPattern.test(row[0]) || !row[1] || !/^airules-[0-9a-f]{32}$/.test(row[1].dataset) || row[0].split(':')[0] !== row[1].dataset || !['uploaded', 'processing-requested', 'outcome-unknown'].includes(row[1].state)) fail('COGNEE_JOURNAL_INVALID')
          target.set(row[0], bounded(row[1]))
        }
      }
    })()
    await journal.ready
    if (journal.endpoint !== endpoint) fail('COGNEE_JOURNAL_ENDPOINT_MISMATCH')
  }
  async function saveJournal() {
    if (!journalPath) return
    const action = journal.queue.catch(() => {}).then(async () => {
      if (writes.size + processing.size > 1000) fail('COGNEE_JOURNAL_FULL')
      if (journal.endpoint !== endpoint) fail('COGNEE_JOURNAL_ENDPOINT_MISMATCH')
      const value = JSON.stringify({ version: 2, endpoint, writes: [...writes], processing: [...processing] })
      const tmp = `${journalPath}.${randomUUID()}.tmp`
      try { await mkdir(path.dirname(journalPath), { recursive: true }); await writeFile(tmp, value, { mode: 0o600, flag: 'wx' }); await rename(tmp, journalPath) }
      catch { fail('COGNEE_JOURNAL_UNAVAILABLE') }
    })
    journal.queue = action
    return action
  }
  async function request(route, { method = 'GET', body, headers = {}, mutation = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${endpoint}${route}`, { method, body, headers: { accept: 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}), ...headers }, signal: controller.signal, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        fail(mutation && response.status >= 500 ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : `COGNEE_HTTP_${response.status}`)
      }
      if (!String(response.headers?.get('content-type') ?? '').includes('application/json')) fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_JSON_REQUIRED')
      if (Number(response.headers?.get('content-length') ?? 0) > maxResponseBytes) fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_RESPONSE_LIMIT')
      const chunks = []; let bytes = 0
      if (response.body?.getReader) {
        const reader = response.body.getReader()
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxResponseBytes) { await reader.cancel(); fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_RESPONSE_LIMIT') } chunks.push(Buffer.from(value)) } }
        finally { reader.releaseLock() }
      } else {
        const value = await response.text(); bytes = Buffer.byteLength(value); if (bytes > maxResponseBytes) fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_RESPONSE_LIMIT'); chunks.push(Buffer.from(value))
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_JSON_INVALID') }
    } catch (error) {
      if (/^COGNEE_[A-Z0-9_]+$/.test(error.message)) throw error
      // Do not expose upstream response bodies, request data, arbitrary exception messages or keys.
      fail(mutation ? 'COGNEE_WRITE_OUTCOME_UNKNOWN' : 'COGNEE_UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }
  async function capabilities() {
    if (cached && Date.now() - cacheTime < capabilityTtlMs) return cached
    if (inflight) return inflight
    inflight = (async () => {
      const spec = await request('/openapi.json')
      if (!spec.openapi || !spec.paths) fail('COGNEE_SCHEMA_UNSUPPORTED')
      const ops = {
        datasets: operation(spec, '/datasets', 'get'), add: operation(spec, '/add', 'post'),
        cognify: operation(spec, '/cognify', 'post'), search: operation(spec, '/search', 'post'),
        documents: operation(spec, '/datasets/{dataset_id}/data', 'get'),
        graph: operation(spec, '/visualize/json', 'get'), legacyGraph: operation(spec, '/datasets/{dataset_id}/graph', 'get'),
        status: operation(spec, '/datasets/status/memory', 'get') ?? operation(spec, '/datasets/status', 'get'),
        runs: operation(spec, '/activity/pipeline-runs', 'get'),
      }
      if (!ops.datasets) fail('COGNEE_SCHEMA_UNSUPPORTED')
      cached = { spec, ops }; cacheTime = Date.now(); return cached
    })()
    try { return await inflight } finally { inflight = null }
  }
  async function dataset(root) {
    if (!apiKey) fail('COGNEE_AUTH_REQUIRED')
    await loadJournal()
    const name = datasetForRoot(root), { ops } = await capabilities(), response = await request(ops.datasets.route)
    if (!Array.isArray(response)) fail('COGNEE_SCHEMA_UNSUPPORTED')
    const matches = response.filter(value => value.name === name)
    if (matches.length > 1 || (matches[0] && !uuid(matches[0].id))) fail('COGNEE_DATASET_AMBIGUOUS')
    return { name, id: matches[0]?.id ?? null }
  }
  async function scoped(root) { const selected = await dataset(root); if (!selected.id) fail('COGNEE_DATASET_NOT_FOUND'); return selected }
  const routeFor = (op, selected) => { if (!op) fail('COGNEE_CAPABILITY_UNAVAILABLE'); return op.route.replace('{dataset_id}', encodeURIComponent(selected.id)) }
  function publicReceipt(value) {
    if (!value || typeof value !== 'object') return null
    const id = value.pipeline_run_id ?? value.pipelineRunId ?? value.task_id ?? value.taskId
    return { ...(typeof id === 'string' ? { taskId: clean(id, 128) } : {}), status: clean(value.status ?? 'accepted', 80) }
  }
  return {
    async status(root) {
      const { spec, ops } = await capabilities()
      const selected = root ? await dataset(root) : null
      let canSearch = false
      if (ops.search) { const p = bodySchema(spec, ops.search, 'application/json').properties ?? {}; const key = pick(p, ['searchType', 'search_type'], false); canSearch = !!key && enumValues(spec, p[key]).includes('CHUNKS') && !!pick(p, ['datasetIds', 'dataset_ids', 'datasets'], false) }
      return { endpoint, version: clean(spec.info?.version, 80), dataset: selected?.name ?? null, datasetId: selected?.id ?? null, capabilities: { documents: !!ops.documents, upload: !!ops.add, process: !!ops.cognify && allowProcessing, recall: canSearch, graph: !!(ops.graph || ops.legacyGraph), status: !!ops.status }, processingEnabled: allowProcessing }
    },
    async listDocuments(root) {
      const selected = await dataset(root)
      if (!selected.id) return { dataset: selected.name, datasetId: null, documents: [], truncated: false }
      const { ops } = await capabilities(), result = await request(routeFor(ops.documents, selected))
      if (!Array.isArray(result)) fail('COGNEE_SCHEMA_UNSUPPORTED')
      return { dataset: selected.name, datasetId: selected.id, documents: result.slice(0, 200).map(item => ({ id: clean(item.id, 128), name: clean(item.name ?? item.label ?? item.filename ?? item.file_name, 300), type: clean(item.mime_type ?? item.mimeType ?? item.type, 100), size: typeof item.size === 'number' ? item.size : null })), truncated: result.length > 200 }
    },
    async recall(root, { query, topK = 8 } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 8000 || !Number.isInteger(topK) || topK < 1 || topK > 20) fail('MEMORY_QUERY_INVALID')
      const selected = await dataset(root)
      if (!selected.id) return { dataset: selected.name, results: [], missingDataset: true }
      const { spec, ops } = await capabilities()
      if (!ops.search) fail('COGNEE_CAPABILITY_UNAVAILABLE')
      const p = bodySchema(spec, ops.search, 'application/json').properties ?? {}, type = pick(p, ['searchType', 'search_type'])
      if (!enumValues(spec, p[type]).includes('CHUNKS')) fail('COGNEE_CHUNKS_UNAVAILABLE')
      const ds = pick(p, ['datasetIds', 'dataset_ids', 'datasets']), q = pick(p, ['query']), k = pick(p, ['topK', 'top_k']), context = pick(p, ['onlyContext', 'only_context'], false)
      const body = { [type]: 'CHUNKS', [ds]: [ds === 'datasets' ? selected.name : selected.id], [q]: query, [k]: topK, ...(context ? { [context]: false } : {}) }
      const result = await request(ops.search.route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!Array.isArray(result)) fail('COGNEE_SCHEMA_UNSUPPORTED')
      // Refuse unscoped or foreign envelopes rather than silently hiding evidence of a
      // server isolation failure. Only CHUNKS structured results are supported here.
      if (result.some(item => !item || (item.dataset_id ?? item.datasetId) !== selected.id || !Array.isArray(item.search_result ?? item.searchResult))) fail('COGNEE_DATASET_ISOLATION_FAILED')
      const hits = result.flatMap(item => item.search_result ?? item.searchResult)
      if (hits.length) {
        const documents = await request(routeFor(ops.documents, selected))
        if (!Array.isArray(documents)) fail('COGNEE_SCHEMA_UNSUPPORTED')
        const allowed = new Set(documents.map(item => item.id))
        if (hits.some(item => !item || typeof item !== 'object' || !allowed.has(item.document_id ?? item.documentId))) fail('COGNEE_PROVENANCE_UNVERIFIED')
      }
      // Preserve source IDs/metadata; retrieved text is evidence, never instructions.
      const results = hits.slice(0, topK).map(item => ({ datasetId: selected.id, ...bounded(item) }))
      return { dataset: selected.name, datasetId: selected.id, searchType: 'CHUNKS', results, truncated: hits.length > topK }
    },
    async remember(root, { text, title = 'Заметка DSH' } = {}) {
      if (!apiKey) fail('COGNEE_AUTH_REQUIRED')
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 256 * 1024 || typeof title !== 'string' || title.length > 200) fail('MEMORY_NOTE_INVALID')
      const content = `# ${title}\n\n${text}`
      const name = datasetForRoot(root), digest = createHash('sha256').update(content).digest('hex'), key = `${name}:${digest}`
      await loadJournal()
      if (writes.has(key)) return { ...writes.get(key), repeated: true }
      const { spec, ops } = await capabilities()
      if (!ops.add) fail('COGNEE_CAPABILITY_UNAVAILABLE')
      const p = bodySchema(spec, ops.add, 'multipart/form-data').properties ?? {}, ds = pick(p, ['datasetName', 'dataset_name']), upload = pick(p, ['data'])
      const form = new FormData(); form.set(ds, name)
      // A file upload always treats the supplied note as bytes, never a URL or a server path.
      form.append(upload, new Blob([content], { type: 'text/plain;charset=utf-8' }), `dsh-${digest}.txt`)
      const background = pick(p, ['runInBackground', 'run_in_background'], false)
      if (background) form.set(background, 'false')
      const unknown = { dataset: name, contentHash: digest, state: 'outcome-unknown', indexed: false, retrySafe: false }
      if (writes.has(key)) return { ...writes.get(key), repeated: true }
      writes.set(key, unknown)
      await saveJournal()
      try {
        const result = await request(ops.add.route, { method: 'POST', body: form, mutation: true })
        if (/errored|failed/i.test(String(result.status ?? ''))) fail('COGNEE_WRITE_OUTCOME_UNKNOWN')
        const receipt = { dataset: name, contentHash: digest, state: 'uploaded', indexed: false, needsProcessing: true, receipt: publicReceipt(result), retrySafe: false }
        writes.set(key, receipt); await saveJournal(); return receipt
      } catch (error) { if (!['COGNEE_WRITE_OUTCOME_UNKNOWN', 'COGNEE_JOURNAL_UNAVAILABLE'].includes(error.message)) { writes.delete(key); await saveJournal() } throw error }
    },
    async process(root) {
      if (!allowProcessing) fail('COGNEE_PROCESSING_NOT_ENABLED')
      await loadJournal()
      const selected = await scoped(root), { spec, ops } = await capabilities()
      if (!ops.cognify) fail('COGNEE_CAPABILITY_UNAVAILABLE')
      const p = bodySchema(spec, ops.cognify, 'application/json').properties ?? {}, ds = pick(p, ['datasetIds', 'dataset_ids', 'datasets']), bg = pick(p, ['runInBackground', 'run_in_background'])
      if (processing.has(selected.name)) return { ...processing.get(selected.name), repeated: true }
      processing.set(selected.name, { dataset: selected.name, datasetId: selected.id, state: 'outcome-unknown', indexed: false, retrySafe: false })
      await saveJournal()
      try {
        const result = await request(ops.cognify.route, { method: 'POST', body: JSON.stringify({ [ds]: [ds === 'datasets' ? selected.name : selected.id], [bg]: true }), headers: { 'content-type': 'application/json' }, mutation: true })
        const value = result[selected.id] ?? result
        if (/errored|failed/i.test(String(value.status ?? ''))) fail('COGNEE_WRITE_OUTCOME_UNKNOWN')
        const receipt = { dataset: selected.name, datasetId: selected.id, state: 'processing-requested', indexed: false, receipt: publicReceipt(value), retrySafe: false }
        processing.set(selected.name, receipt); await saveJournal(); return receipt
      } catch (error) { if (!['COGNEE_WRITE_OUTCOME_UNKNOWN', 'COGNEE_JOURNAL_UNAVAILABLE'].includes(error.message)) { processing.delete(selected.name); await saveJournal() } throw error }
    },
    async task(root, { taskId } = {}) {
      await loadJournal()
      const selected = await scoped(root), { ops } = await capabilities()
      if (!ops.status) fail('COGNEE_CAPABILITY_UNAVAILABLE')
      const param = parameter(ops.status, ['dataset', 'dataset_ids', 'datasetIds'])
      if (!param) fail('COGNEE_SCHEMA_UNSUPPORTED')
      const result = await request(`${ops.status.route}?${new URLSearchParams({ [param]: selected.id })}`)
      if (!result || typeof result !== 'object' || !own(result, selected.id)) fail('COGNEE_SCHEMA_UNSUPPORTED')
      const latest = result[selected.id]
      // Dataset-ready alone can describe a previous run. Resolve the exact receipt
      // against the scoped pipeline activity feed before releasing a pending write.
      const pending = processing.get(selected.name), wantedTask = taskId || pending?.receipt?.taskId
      let exactTask = false, runStatus = null
      if (wantedTask && ops.runs) {
        const ds = parameter(ops.runs, ['dataset_id', 'datasetId']), pipeline = parameter(ops.runs, ['pipeline_name', 'pipelineName']), limit = parameter(ops.runs, ['limit'])
        if (ds && pipeline && limit) {
          const runs = await request(`${ops.runs.route}?${new URLSearchParams({ [ds]: selected.id, [pipeline]: 'cognify_pipeline', [limit]: '100' })}`)
          if (!Array.isArray(runs) || runs.some(run => (run.dataset_id ?? run.datasetId) !== selected.id)) fail('COGNEE_DATASET_ISOLATION_FAILED')
          const matching = runs.filter(run => run.kind === 'pipeline' && (run.pipeline_run_id ?? run.pipelineRunId) === wantedTask)
          const terminal = matching.find(run => /(?:COMPLETED|ERRORED|FAILED)$/.test(String(run.status)))
          const match = terminal ?? matching[0]
          exactTask = !!match; runStatus = match ? clean(match.status, 100) : null
          if (terminal && pending?.state === 'processing-requested' && pending.receipt?.taskId === wantedTask) { processing.delete(selected.name); await saveJournal() }
        }
      }
      const safeStatus = typeof latest === 'string' ? clean(latest, 100) : { ...Object.fromEntries(['state', 'search_level', 'searchable', 'graph_ready', 'indexing_status', 'cognify_status'].filter(key => own(latest, key)).map(key => [key, bounded(latest[key])])), hasError: !!(latest.error_class || latest.error_message) }
      return { dataset: selected.name, datasetId: selected.id, taskId: clean(wantedTask, 128) || null, exactTask, tracking: exactTask ? 'pipeline-run' : 'dataset-latest', runStatus, status: safeStatus }
    },
    async graph(root) {
      const selected = await dataset(root)
      if (!selected.id) return { dataset: selected.name, nodes: [], edges: [], truncated: false }
      const { ops } = await capabilities(); let route
      if (ops.graph) {
        const ds = parameter(ops.graph, ['dataset_id', 'datasetId']); if (!ds) fail('COGNEE_SCHEMA_UNSUPPORTED')
        const query = new URLSearchParams({ [ds]: selected.id })
        for (const [names, value] of [[['max_nodes', 'maxNodes'], '80'], [['full'], 'false'], [['stream'], 'false'], [['include_session_events', 'includeSessionEvents'], 'false']]) { const p = parameter(ops.graph, names); if (p) query.set(p, value) }
        route = `${ops.graph.route}?${query}`
      } else route = routeFor(ops.legacyGraph, selected)
      const result = await request(route)
      const sourceEdges = result.edges ?? result.links
      if (!Array.isArray(result.nodes) || !Array.isArray(sourceEdges)) fail('COGNEE_SCHEMA_UNSUPPORTED')
      const documents = await request(routeFor(ops.documents, selected))
      if (!Array.isArray(documents)) fail('COGNEE_SCHEMA_UNSUPPORTED')
      const documentIds = new Set(documents.map(item => item.id))
      const sourceNodes = new Map(result.nodes.map(node => [String(node.id), node]))
      if (sourceNodes.size !== result.nodes.length) fail('COGNEE_PROVENANCE_UNVERIFIED')
      const chunks = new Set(), anchored = new Set(), structural = new Set(['is_part_of', 'contains', 'is_a', 'made_from', 'summarized_in'])
      for (const doc of result.memory_map?.documents ?? []) {
        if (!documentIds.has(doc.id)) fail('COGNEE_DATASET_ISOLATION_FAILED')
        for (const chunk of doc.chunks ?? []) {
          const node = sourceNodes.get(String(chunk.id)), owner = node?.document_id ?? node?.properties?.document_id
          if (node && owner && owner !== doc.id) fail('COGNEE_DATASET_ISOLATION_FAILED')
          if (node?.type === 'DocumentChunk') chunks.add(String(chunk.id))
        }
      }
      for (const node of result.nodes) {
        const id = String(node.id), owner = node.document_id ?? node.properties?.document_id
        if (node.type === 'TextDocument') { if (!documentIds.has(id)) fail('COGNEE_DATASET_ISOLATION_FAILED'); anchored.add(id) }
        if (node.type === 'DocumentChunk') {
          if (owner && !documentIds.has(owner)) fail('COGNEE_DATASET_ISOLATION_FAILED')
          if (!owner && !chunks.has(id)) fail('COGNEE_PROVENANCE_UNVERIFIED')
          chunks.add(id); anchored.add(id)
        }
      }
      // Grow only in the document -> chunk -> entity -> type direction.
      // Do not follow a shared entity type back into unrelated entities or
      // traverse arbitrary semantic links from another document's component.
      for (const edge of sourceEdges) {
        const from = String(edge.source ?? edge.from), to = String(edge.target ?? edge.to), relation = edge.label ?? edge.relation ?? edge.type
        if (chunks.has(from) && relation === 'contains' && sourceNodes.get(to)?.type === 'Entity') anchored.add(to)
        if (chunks.has(to) && relation === 'made_from' && ['TextSummary', 'Summary'].includes(sourceNodes.get(from)?.type)) anchored.add(from)
      }
      for (const edge of sourceEdges) {
        const from = String(edge.source ?? edge.from), to = String(edge.target ?? edge.to), relation = edge.label ?? edge.relation ?? edge.type
        if (anchored.has(from) && sourceNodes.get(from)?.type === 'Entity' && relation === 'is_a' && sourceNodes.get(to)?.type === 'EntityType') anchored.add(to)
      }
      if (result.nodes.length && !chunks.size) fail('COGNEE_PROVENANCE_UNVERIFIED')
      const eligible = result.nodes.filter(node => anchored.has(String(node.id)))
      const nodes = eligible.slice(0, 80).map(node => ({ id: clean(node.id, 128), label: clean(node.label ?? node.name ?? node.id, 300), type: clean(node.type, 100) }))
      const ids = new Set(nodes.map(node => node.id)), relevant = sourceEdges.filter(edge => ids.has(String(edge.source ?? edge.from)) && ids.has(String(edge.target ?? edge.to)))
      const edges = relevant.filter(edge => structural.has(edge.label ?? edge.relation ?? edge.type)).slice(0, 600).map(edge => ({ from: clean(edge.source ?? edge.from, 128), to: clean(edge.target ?? edge.to, 128), label: clean(edge.label ?? edge.relation ?? edge.type, 200) }))
      return { dataset: selected.name, datasetId: selected.id, nodes, edges, provenance: 'document-structural', truncated: !!result.truncated || result.nodes.length >= 80 || relevant.length > 600 || eligible.length !== result.nodes.length || edges.length !== sourceEdges.length, partial: true }
    },
  }
}
