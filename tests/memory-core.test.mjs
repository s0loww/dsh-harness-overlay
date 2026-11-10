import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMemoryService, datasetForRoot, validateEndpoint } from '../src/memory-workspace/lib/core.js'

const root = 'D:/projects/synthetic-memory', id = '11111111-1111-4111-8111-111111111111'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function schema(camel = true) {
  const alias = (snake, upper) => camel ? upper : snake
  const body = (media, properties) => ({ requestBody: { content: { [media]: { schema: { properties } } } } })
  return {
    openapi: '3.1.0', info: { version: 'fixture-only' },
    components: { schemas: { SearchKind: { enum: ['CHUNKS', 'GRAPH_COMPLETION'] } } },
    paths: {
      '/api/v1/permissions/principals/{principal_id}/datasets': { get: {} },
      '/api/v1/datasets': { get: {} },
      '/api/v1/datasets/{dataset_id}/data': { get: {} },
      '/api/v1/add': { post: body('multipart/form-data', { datasetName: {}, data: {}, run_in_background: {} }) },
      '/api/v1/cognify': { post: body('application/json', { [alias('dataset_ids', 'datasetIds')]: {}, [alias('run_in_background', 'runInBackground')]: {} }) },
      '/api/v1/search': { post: body('application/json', { [alias('search_type', 'searchType')]: { $ref: '#/components/schemas/SearchKind' }, [alias('dataset_ids', 'datasetIds')]: {}, query: {}, [alias('top_k', 'topK')]: {}, [alias('only_context', 'onlyContext')]: {} }) },
      '/api/v1/datasets/status/memory': { get: { parameters: [{ in: 'query', name: 'dataset' }] } },
      '/api/v1/activity/pipeline-runs': { get: { parameters: ['dataset_id', 'pipeline_name', 'limit'].map(name => ({ in: 'query', name })) } },
      '/api/v1/visualize/json': { get: { parameters: ['dataset_id', 'max_nodes', 'full', 'stream', 'include_session_events'].map(name => ({ in: 'query', name })) } },
    },
  }
}
function fixture({ camel = true, handler = () => json({}), documents = [{ id: 'doc1' }], datasets = [{ name: datasetForRoot(root), id }] } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname
    calls.push({ url, pathname, ...options })
    if (pathname === '/openapi.json') return json(schema(camel))
    if (pathname === '/api/v1/datasets') return json(datasets)
    if (pathname.endsWith('/data')) return json(documents)
    return handler({ url, pathname, ...options })
  }
  return { calls, service: createMemoryService({ fetchImpl, allowProcessing: true, apiKey: 'synthetic-key' }) }
}

test('Windows project identity is stable across case/separators and distinct by root', () => {
  assert.equal(datasetForRoot('D:\\Projects\\A\\'), datasetForRoot('d:/projects/a'))
  assert.notEqual(datasetForRoot('D:/projects/a'), datasetForRoot('D:/projects/b'))
  assert.throws(() => datasetForRoot('relative/path'), /PROJECT_ROOT_REQUIRED/)
})
test('endpoint only permits numeric HTTP loopback and no URL credentials, path or redirects', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:18080'), 'http://127.0.0.1:18080')
  for (const value of ['https://127.0.0.1:18080', 'http://localhost:18080', 'http://example.com', 'http://user:password@127.0.0.1', 'http://127.0.0.1/a', 'http://127.0.0.1/?token=x']) assert.throws(() => validateEndpoint(value), /COGNEE_LOOPBACK_REQUIRED/)
})
test('service has no constructor I/O; discovery ignores unrelated permission routes', async () => {
  const { service, calls } = fixture()
  assert.equal(calls.length, 0)
  const status = await service.status(root)
  assert.equal(status.capabilities.recall, true)
  assert.equal(status.datasetId, id)
  assert.equal(calls.filter(call => call.pathname === '/openapi.json').length, 1)
  await service.status(root)
  assert.equal(calls.filter(call => call.pathname === '/openapi.json').length, 1)
})
for (const camel of [false, true]) test(`retrieval obeys discovered ${camel ? 'camelCase' : 'snake_case'} schema and exact dataset`, async () => {
  let body
  const { service } = fixture({ camel, handler: request => { body = JSON.parse(request.body); return json([{ dataset_id: id, search_result: [{ text: 'Verified synthetic memory', source_id: 'source1', document_id: 'doc1' }] }]) } })
  const result = await service.recall(root, { query: 'synthetic', topK: 3 })
  assert.equal(body[camel ? 'searchType' : 'search_type'], 'CHUNKS')
  assert.deepEqual(body[camel ? 'datasetIds' : 'dataset_ids'], [id])
  assert.equal(body[camel ? 'onlyContext' : 'only_context'], false)
  assert.equal(result.results[0].source_id, 'source1')
  assert.equal(Object.keys(body).length, 5)
})
test('missing project has no global retrieval or graph fallback', async () => {
  const { service, calls } = fixture({ datasets: [] })
  assert.deepEqual((await service.recall(root, { query: 'x' })).results, [])
  assert.deepEqual((await service.graph(root)).nodes, [])
  assert.equal(calls.some(call => call.pathname === '/api/v1/search' || call.pathname === '/api/v1/visualize/json'), false)
})
test('foreign or unattributed search envelopes fail closed', async () => {
  for (const response of [[{ dataset_id: '22222222-2222-4222-8222-222222222222', search_result: [{ text: 'private foreign data' }] }], [{ text: 'unattributed result' }]]) {
    const { service } = fixture({ handler: () => json(response) })
    await assert.rejects(service.recall(root, { query: 'project query' }), { message: 'COGNEE_DATASET_ISOLATION_FAILED' })
  }
})
test('ambiguous dataset names fail before reading documents', async () => {
  const { service, calls } = fixture({ datasets: [{ name: datasetForRoot(root), id }, { name: datasetForRoot(root), id: '22222222-2222-4222-8222-222222222222' }] })
  await assert.rejects(service.listDocuments(root), /COGNEE_DATASET_AMBIGUOUS/)
  assert.equal(calls.some(call => call.pathname.endsWith('/data')), false)
})
test('note upload is literal file bytes even when note is URL; upload is not indexed', async () => {
  let form
  const { service, calls } = fixture({ handler: request => { form = request.body; return json({ pipeline_run_id: id, status: 'DATASET_PROCESSING_COMPLETED' }) } })
  const result = await service.remember(root, { text: 'http://127.0.0.1/private', title: 'URL is just data' })
  assert.equal(form.get('datasetName'), datasetForRoot(root))
  assert.equal(form.has('raw_data'), false)
  assert.match(await form.get('data').text(), /# URL is just data\n\nhttp:\/\/127.0.0.1\/private/)
  assert.equal(result.state, 'uploaded'); assert.equal(result.indexed, false)
  assert.equal(calls.some(call => call.pathname === '/api/v1/cognify'), false)
  assert.equal((await service.remember(root, { text: 'http://127.0.0.1/private', title: 'URL is just data' })).repeated, true)
  assert.equal(calls.filter(call => call.pathname === '/api/v1/add').length, 1)
})
test('unknown upload outcome is redacted and blocks repeated writes in this process', async () => {
  const { service, calls } = fixture({ handler: () => { throw new Error('upstream secret_token=NEVER_OUTPUT') } })
  await assert.rejects(service.remember(root, { text: 'synthetic note' }), { message: 'COGNEE_WRITE_OUTCOME_UNKNOWN' })
  const second = await service.remember(root, { text: 'synthetic note' })
  assert.equal(second.state, 'outcome-unknown'); assert.equal(second.retrySafe, false)
  assert.equal(calls.filter(call => call.pathname === '/api/v1/add').length, 1)
})
test('processing is explicit and scoped; accepted receipt stays pending', async () => {
  let body
  const { service, calls } = fixture({ handler: request => { body = JSON.parse(request.body); return json({ [id]: { pipeline_run_id: id, status: 'DATASET_PROCESSING_STARTED' } }) } })
  const receipt = await service.process(root)
  assert.deepEqual(body, { datasetIds: [id], runInBackground: true })
  assert.equal(receipt.state, 'processing-requested'); assert.equal(receipt.indexed, false)
  assert.equal(receipt.receipt.taskId, id)
  await service.process(root)
  assert.equal(calls.filter(call => call.pathname === '/api/v1/cognify').length, 1)
  const disabled = createMemoryService({ fetchImpl: () => { throw new Error('must not call') } })
  await assert.rejects(disabled.process(root), /COGNEE_PROCESSING_NOT_ENABLED/)
})
test('graph query is scoped/bounded JSON, strips properties/events and trims edges to returned nodes', async () => {
  let url
  const { service } = fixture({ handler: request => { url = new URL(request.url); return json({ nodes: [{ id: 'a', label: '<script>just text</script>', type: 'DocumentChunk', document_id: 'doc1', properties: { secret: 'not needed' } }, { id: 'entity1', type: 'Entity', label: 'owned entity' }], links: [{ source: 'a', target: 'entity1', relation: 'contains' }, { source: 'a', target: 'foreign', relation: 'hidden' }], search_events: ['private-other-dataset'] }) } })
  const result = await service.graph(root)
  assert.equal(url.searchParams.get('dataset_id'), id)
  assert.equal(url.searchParams.get('max_nodes'), '80')
  assert.equal(url.searchParams.get('include_session_events'), 'false')
  assert.equal(result.nodes[0].label, '<script>just text</script>')
  assert.equal('properties' in result.nodes[0], false)
  assert.equal(result.edges.length, 1)
  assert.equal('search_events' in result, false)
})
test('dataset pipeline tracking never claims exact completion of arbitrary task', async () => {
  let url
  const { service } = fixture({ handler: request => { if(request.pathname.endsWith('/pipeline-runs')) return json([]); url = new URL(request.url); return json({ [id]: { state: 'ready', search_level: 'graph' } }) } })
  const result = await service.task(root, { taskId: 'older-run' })
  assert.equal(url.searchParams.get('dataset'), id)
  assert.equal(result.exactTask, false)
  assert.equal(result.tracking, 'dataset-latest')
})
test('bounded response read fails without exposing upstream body', async () => {
  const service = createMemoryService({ maxResponseBytes: 128, fetchImpl: () => Promise.resolve(json({ value: 'x'.repeat(300) })) })
  await assert.rejects(service.status(), { message: 'COGNEE_RESPONSE_LIMIT' })
})
test('durable journal prevents uncertain upload retry across service restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-memory-journal-'))
  try {
    const journalPath = path.join(dir, 'receipts.json'); let adds = 0
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/openapi.json')) return json(schema())
      adds++; throw new Error('network result unknown')
    }
    const one = createMemoryService({ journalPath, fetchImpl, apiKey: 'synthetic-key' })
    await assert.rejects(one.remember(root, { text: 'synthetic restart receipt' }), /COGNEE_WRITE_OUTCOME_UNKNOWN/)
    const two = createMemoryService({ journalPath, fetchImpl, apiKey: 'synthetic-key' })
    const repeated = await two.remember(root, { text: 'synthetic restart receipt' })
    assert.equal(repeated.state, 'outcome-unknown'); assert.equal(adds, 1)
    assert.equal((await readFile(journalPath, 'utf8')).includes('synthetic restart receipt'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('completed dataset reconciles processing receipt and permits new-note processing after restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-memory-process-'))
  try {
    const journalPath = path.join(dir, 'receipts.json'); let starts = 0
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/openapi.json')) return json(schema())
      if (url.endsWith('/datasets')) return json([{ name: datasetForRoot(root), id }])
      if (url.includes('/status/memory')) return json({ [id]: { state: 'ready' } })
      if (url.includes('/activity/pipeline-runs')) return json([{ dataset_id: id, pipeline_run_id: id, kind: 'pipeline', status: 'DATASET_PROCESSING_COMPLETED' }])
      if (url.endsWith('/cognify')) { starts++; return json({ [id]: { pipeline_run_id: id, status: 'DATASET_PROCESSING_STARTED' } }) }
      if (url.endsWith('/add')) return json({ pipeline_run_id: id, status: 'DATASET_PROCESSING_COMPLETED' })
      throw new Error('unexpected request')
    }
    const one = createMemoryService({ journalPath, fetchImpl, allowProcessing: true, apiKey: 'synthetic-key' })
    await one.process(root)
    const two = createMemoryService({ journalPath, fetchImpl, allowProcessing: true, apiKey: 'synthetic-key' })
    assert.equal((await two.process(root)).repeated, true)
    await two.task(root)
    await two.remember(root, { text: 'new confirmed synthetic fact' })
    await two.process(root)
    assert.equal(starts, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('simultaneous identical uploads make only one HTTP mutation', async () => {
  const { service, calls } = fixture({ handler: () => json({ status: 'PipelineRunCompleted' }) })
  const results = await Promise.all([service.remember(root, { text: 'one identical fact' }), service.remember(root, { text: 'one identical fact' })])
  assert.equal(calls.filter(call => call.pathname === '/api/v1/add').length, 1)
  assert.equal(results.some(value => value.repeated), true)
})
test('old dataset-ready status cannot clear unknown processing outcome', async () => {
  let starts = 0
  const { service } = fixture({ handler: request => {
    if (request.pathname.endsWith('/cognify')) { starts++; throw new Error('unknown') }
    if (request.pathname.endsWith('/pipeline-runs')) return json([])
    return json({ [id]: { state: 'ready', error_message: 'never expose secret text' } })
  } })
  await assert.rejects(service.process(root), /COGNEE_WRITE_OUTCOME_UNKNOWN/)
  const state = await service.task(root)
  assert.equal(state.status.hasError, true)
  assert.equal(JSON.stringify(state).includes('never expose'), false)
  assert.equal((await service.process(root)).state, 'outcome-unknown')
  assert.equal(starts, 1)
})
test('explicit API key is sent only as header and never exposed by status', async () => {
  const calls = [], secret = 'synthetic-local-key'
  const service = createMemoryService({ apiKey: secret, fetchImpl: async (url, options) => { calls.push(options); return json(schema()) } })
  const result = await service.status()
  assert.equal(calls[0].headers['X-Api-Key'], secret)
  assert.equal(JSON.stringify(result).includes(secret), false)
})
test('missing auth fails before dataset access and a foreign document cannot enter retrieval', async () => {
  let requests = 0
  const unauth = createMemoryService({ fetchImpl: () => { requests++; throw new Error('not allowed') } })
  await assert.rejects(unauth.recall(root, { query: 'x' }), /COGNEE_AUTH_REQUIRED/)
  assert.equal(requests, 0)
  for (const hit of [{ text: 'unattributed' }, { text: 'foreign', document_id: 'foreign-doc' }]) {
    const { service } = fixture({ handler: () => json([{ dataset_id: id, search_result: [hit] }]) })
    await assert.rejects(service.recall(root, { query: 'x' }), /COGNEE_PROVENANCE_UNVERIFIED/)
  }
})
test('graph rejects foreign document/chunk provenance and excludes semantic/shared-type expansion', async () => {
  for (const node of [{ id: 'foreign-doc', type: 'TextDocument' }, { id: 'foreign-chunk', type: 'DocumentChunk', document_id: 'foreign-doc' }, { id: 'unattributed', type: 'DocumentChunk' }]) {
    const { service } = fixture({ handler: () => json({ nodes: [node], links: [] }) })
    await assert.rejects(service.graph(root), /COGNEE_(?:DATASET_ISOLATION_FAILED|PROVENANCE_UNVERIFIED)/)
  }
  const { service } = fixture({ handler: () => json({
    nodes: [{ id: 'c', type: 'DocumentChunk', properties: { document_id: 'doc1' } }, { id: 'e', type: 'Entity' }, { id: 't', type: 'EntityType' }, { id: 'foreign-entity', type: 'Entity', label: 'foreign marker must not escape' }],
    links: [{ source: 'c', target: 'e', relation: 'contains' }, { source: 'e', target: 't', relation: 'is_a' }, { source: 'foreign-entity', target: 't', relation: 'is_a' }, { source: 'e', target: 'foreign-entity', relation: 'knows' }],
    memory_map: { documents: [{ id: 'doc1', chunks: [{ id: 'c' }] }] },
  }) })
  const result = await service.graph(root)
  assert.deepEqual(result.nodes.map(node => node.id), ['c', 'e', 't'])
  assert.equal(result.edges.length, 2)
  assert.equal(JSON.stringify(result).includes('foreign marker'), false)
})
test('rotated service instances share write-before-effect receipt coordination', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-memory-rotate-'))
  try {
    const journalPath = path.join(dir, 'receipts.json'); let release, entered
    const started = new Promise(resolve => { entered = resolve }), delayed = new Promise(resolve => { release = resolve }); let adds = 0
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/openapi.json')) return json(schema())
      adds++
      if ((await options.body.get('data').text()).includes('first delayed fact')) { entered(); await delayed; throw new Error('result unknown') }
      return json({ status: 'PipelineRunCompleted' })
    }
    const first = createMemoryService({ journalPath, fetchImpl, apiKey: 'key1' })
    const pending = first.remember(root, { text: 'first delayed fact' })
    const asserted = assert.rejects(pending, /COGNEE_WRITE_OUTCOME_UNKNOWN/)
    await started
    const rotated = createMemoryService({ journalPath, fetchImpl, apiKey: 'key2' })
    await rotated.remember(root, { text: 'second fact' })
    assert.equal((await rotated.remember(root, { text: 'first delayed fact' })).state, 'outcome-unknown')
    release(); await asserted
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(journal.writes.length, 2); assert.equal(adds, 2)
    assert.equal(journal.writes.filter(row => row[1].state === 'outcome-unknown').length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('only exact terminal pipeline receipt releases processing, not previous dataset completion', async () => {
  const { service } = fixture({ handler: request => {
    if (request.pathname.endsWith('/cognify')) return json({ [id]: { pipeline_run_id: id, status: 'PipelineRunStarted' } })
    if (request.pathname.endsWith('/pipeline-runs')) return json([{ dataset_id: id, kind: 'pipeline', pipeline_run_id: 'older-run', status: 'DATASET_PROCESSING_COMPLETED' }])
    return json({ [id]: { state: 'ready' } })
  } })
  await service.process(root)
  const result = await service.task(root)
  assert.equal(result.exactTask, false)
  assert.equal((await service.process(root)).repeated, true)
})
test('HTTP-success pipeline failure preserves uncertain receipt against repeated partial ingestion', async () => {
  const { service, calls } = fixture({ handler: () => json({ status: 'PipelineRunErrored' }) })
  await assert.rejects(service.remember(root, { text: 'possibly partially ingested fact' }), /COGNEE_WRITE_OUTCOME_UNKNOWN/)
  assert.equal((await service.remember(root, { text: 'possibly partially ingested fact' })).state, 'outcome-unknown')
  assert.equal(calls.filter(call => call.pathname.endsWith('/add')).length, 1)
})
test('journal endpoint identity survives key rotation and refuses another server before network', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-memory-binding-'))
  try {
    const journalPath = path.join(dir, 'receipts.json'); let requests = 0
    const fetchImpl = async (url, options) => { requests++; return url.endsWith('/openapi.json') ? json(schema()) : json({ status: 'PipelineRunCompleted' }) }
    const first = createMemoryService({ journalPath, fetchImpl, apiKey: 'key1' })
    await first.remember(root, { text: 'server-bound fact' })
    const rotated = createMemoryService({ journalPath, fetchImpl, apiKey: 'key2' })
    assert.equal((await rotated.remember(root, { text: 'server-bound fact' })).repeated, true)
    const before = requests
    const otherServer = createMemoryService({ endpoint: 'http://127.0.0.1:18081', journalPath, fetchImpl, apiKey: 'key3', allowProcessing: true })
    await assert.rejects(otherServer.remember(root, { text: 'server-bound fact' }), /COGNEE_JOURNAL_ENDPOINT_MISMATCH/)
    await assert.rejects(otherServer.process(root), /COGNEE_JOURNAL_ENDPOINT_MISMATCH/)
    await assert.rejects(otherServer.graph(root), /COGNEE_JOURNAL_ENDPOINT_MISMATCH/)
    assert.equal(requests, before)
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(journal.endpoint, 'http://127.0.0.1:18080')
    assert.equal(JSON.stringify(journal).includes('key1'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
