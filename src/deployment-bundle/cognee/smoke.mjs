/** Explicit isolated synthetic acceptance only. Never discovers existing project data. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCogneeAdapter, dockerRunner } from './adapter.mjs'

export async function smokeInstalledCognee({ stateRoot, reportPath }) {
  const adapter = createCogneeAdapter(), receipt = JSON.parse(await readFile(join(stateRoot, 'receipt.json'), 'utf8'))
  const auth = JSON.parse(await readFile(join(stateRoot, 'memory-workspace/auth.json'), 'utf8'))
  if (!receipt.offline || !receipt.container.startsWith('airules-cognee-') || receipt.port === 18080) throw new Error('COGNEE_SMOKE_ISOLATED_INSTANCE_REQUIRED')
  const checks = [], check = (name, passed) => { checks.push({ name, passed: !!passed }); if (!passed) throw new Error('COGNEE_SMOKE_CHECK_FAILED') }
  const endpoint = receipt.endpoint, headers = { 'X-Api-Key': auth.apiKey }, marker = `OFFLINE-${randomUUID()}`, dataset = `portable-${randomUUID()}`
  let success = false
  async function call(path, value) {
    const form = value instanceof FormData
    const response = await fetch(endpoint + path, { method: value ? 'POST' : 'GET', headers: { ...headers, ...(value && !form ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: form ? value : JSON.stringify(value) } : {}), signal: AbortSignal.timeout(90000) })
    if (!response.ok) throw new Error('COGNEE_SMOKE_HTTP_FAILED')
    return await response.json()
  }
  try {
    check('loopback authenticated fresh runtime healthy', (await adapter.health({ stateRoot })).available)
    const network = await dockerRunner(['network', 'inspect', receipt.network])
    check('runtime has no external network route', network.code === 0 && JSON.parse(network.stdout)[0].Internal === true)
    const unauthenticated = await fetch(endpoint + '/api/v1/datasets')
    check('unauthenticated requests refused', unauthenticated.status === 401)
    check('new user has no imported datasets', (await call('/api/v1/datasets')).length === 0)
    const form = new FormData(); form.append('datasetName', dataset); form.append('data', new Blob([`Captain Diesel is a Norwegian Forest cat. Diesel commands Aurora in Cedar Bay. Synthetic package test marker ${marker}.`], { type: 'text/plain' }), 'offline-fixture.txt')
    const uploaded = await call('/api/v1/add', form)
    check('fresh instance uploads synthetic text', typeof uploaded.dataset_id === 'string')
    const started = await call('/api/v1/cognify', { datasetIds: [uploaded.dataset_id], runInBackground: true, chunksPerBatch: 1, dataPerBatch: 1 })
    check('graph processing accepted without claiming completion', !!started[uploaded.dataset_id]?.pipeline_run_id)
    let state
    for (let index = 0; index < 120; index++) {
      state = await call('/api/v1/datasets/status?dataset=' + uploaded.dataset_id)
      if (state[uploaded.dataset_id] === 'DATASET_PROCESSING_COMPLETED') break
      if (/FAILED|ERRORED/u.test(state[uploaded.dataset_id] ?? '')) throw new Error('COGNEE_SMOKE_PROCESSING_FAILED')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    check('local GLiNER and embedding processing actually completed offline', state[uploaded.dataset_id] === 'DATASET_PROCESSING_COMPLETED')
    const search = await call('/api/v1/search', { searchType: 'CHUNKS', datasetIds: [uploaded.dataset_id], query: 'Captain Diesel marker', topK: 5, onlyContext: false })
    check('offline read/query returns source text and own dataset', search.every(row => row.dataset_id === uploaded.dataset_id) && JSON.stringify(search).includes(marker))
    const graph = await call('/api/v1/visualize/json?dataset_id=' + uploaded.dataset_id + '&max_nodes=80&include_session_events=false')
    check('offline graph contains document and relationships', graph.nodes?.length > 1 && graph.links?.length > 0)
    const stopped = await adapter.stop({ stateRoot }); check('owned instance stops without deleting data', stopped.stopped && stopped.dataRetained)
    check('owned instance starts from persisted volume', (await adapter.start({ stateRoot })).ready)
    const persisted = await call('/api/v1/search', { searchType: 'CHUNKS', datasetIds: [uploaded.dataset_id], query: 'Captain Diesel', topK: 5, onlyContext: false })
    check('fresh key and source text survive stop/start', JSON.stringify(persisted).includes(marker))
    success = true
    return { status: 'PASS', checks, endpoint, container: receipt.container, offline: true, syntheticOnly: true, modelApiCalls: 0, oldCogneeTouched: false, graph: { nodes: graph.nodes.length, links: graph.links.length }, datasetId: uploaded.dataset_id }
  } finally {
    // Resource ownership is verified again by the adapter. No other service is stopped.
    await adapter.stop({ stateRoot })
    if (reportPath) await writeFile(reportPath, JSON.stringify({ status: success ? 'PASS' : 'FAIL', checks, endpoint, container: receipt.container, offline: true, syntheticOnly: true }, null, 2) + '\n')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , stateRoot, reportPath] = process.argv
  try { console.log(JSON.stringify(await smokeInstalledCognee({ stateRoot, reportPath }))) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: /^COGNEE_[A-Z_]+$/u.test(error.message ?? '') ? error.message : 'COGNEE_SMOKE_FAILED' })); process.exitCode = 1 }
}
