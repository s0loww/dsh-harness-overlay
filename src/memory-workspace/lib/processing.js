import { createHash } from 'node:crypto'

const fail = code => { throw new Error(code) }
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
export const DEFAULT_PROCESSING = Object.freeze({ allowed: false, embeddings: { provider: 'fastembed', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 }, extraction: { provider: 'gliner', model: 'fastino/gliner2.5-base-v1' } })
const providers = { embeddings: ['fastembed', 'ollama', 'lmstudio', 'openrouter'], extraction: ['gliner', 'ollama', 'lmstudio', 'openrouter'] }
export const KNOWN_DIMENSIONS = Object.freeze({ 'BAAI/bge-small-en-v1.5': 384, 'openai/text-embedding-3-small': 1536, 'openai/text-embedding-3-large': 3072, 'openai/text-embedding-ada-002': 1536 })
export function localModelEndpoint(value, provider) {
  let url
  try { url = new URL(value || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234')) } catch { fail('PROCESSING_LOCAL_ENDPOINT_INVALID') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/v1'].includes(url.pathname)) fail('PROCESSING_LOCAL_ENDPOINT_REQUIRED')
  return url.origin
}
export function validateProcessing(profile) {
  if (!own(profile, ['allowed', 'embeddings', 'extraction']) || Object.keys(profile).length !== 3 || typeof profile.allowed !== 'boolean') fail('PROCESSING_PROFILE_INVALID')
  const result = { allowed: profile.allowed }
  for (const kind of ['embeddings', 'extraction']) {
    const value = profile[kind]
    if (!own(value, ['provider', 'model', 'endpoint', ...(kind === 'embeddings' ? ['dimensions'] : [])]) || !providers[kind].includes(value.provider) || typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,239}$/u.test(value.model) || value.model.split('/').some(part => part === '..' || part === '.')) fail('PROCESSING_MODEL_INVALID')
    if (value.provider === 'gliner' && value.model !== DEFAULT_PROCESSING.extraction.model) fail('PROCESSING_GLINER_MODEL_UNSUPPORTED')
    const next = { provider: value.provider, model: value.model }
    if (['ollama', 'lmstudio'].includes(value.provider)) next.endpoint = localModelEndpoint(value.endpoint, value.provider)
    else if (value.endpoint) fail('PROCESSING_ENDPOINT_NOT_CONFIGURABLE')
    if (kind === 'embeddings') {
      const dimensions = value.dimensions ?? KNOWN_DIMENSIONS[value.model]
      if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65536)) fail('PROCESSING_DIMENSIONS_INVALID')
      if (KNOWN_DIMENSIONS[value.model] && dimensions !== KNOWN_DIMENSIONS[value.model]) fail('PROCESSING_MODEL_DIMENSIONS_MISMATCH')
      if (dimensions !== undefined) next.dimensions = dimensions
    }
    result[kind] = next
  }
  return result
}
export function processingFingerprint(profile) {
  const { embeddings, extraction } = validateProcessing(profile)
  return createHash('sha256').update(JSON.stringify({ embeddings, extraction })).digest('hex')
}
export function isProcessingReady(configuration) {
  return configuration?.profile?.allowed === true && configuration.applied?.matchesDesired === true && ['observed', 'applied'].includes(configuration.applied.state)
}
async function boundedJson(fetchImpl, url, { signal, body } = {}) {
  const controller = new AbortController(), stop = () => controller.abort(), timer = setTimeout(stop, 4000)
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
  try {
    const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error' })
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('PROCESSING_CATALOG_HTTP'), { status: response.status }) }
    if (!String(response.headers?.get('content-type') ?? '').includes('application/json') || Number(response.headers?.get('content-length') ?? 0) > 2 * 1024 * 1024) fail('PROCESSING_CATALOG_INVALID')
    let bytes = 0, parts = []
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('PROCESSING_CATALOG_LIMIT') }; parts.push(Buffer.from(chunk.value)) } } finally { reader.releaseLock() }
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    }
    const value = await response.json(); if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) fail('PROCESSING_CATALOG_LIMIT'); return value
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
}
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,239}$/u.test(value) && !value.split('/').includes('..')
/** Catalogue metadata only: no generation, embedding inference, pull or model load. */
export async function discoverProcessingModels({ kind, provider, endpoint, signal, fetchImpl = globalThis.fetch, builtinModels } = {}) {
  if (!providers[kind]?.includes(provider)) fail('PROCESSING_CATALOG_KIND_INVALID')
  if (['fastembed', 'gliner'].includes(provider)) {
    const rows = Array.isArray(builtinModels) ? builtinModels.filter(row => row.kind === kind && row.provider === provider && modelId(row.id) && row.state === 'installed').slice(0, 100) : []
    return { available: rows.length > 0, models: rows.map(({ id, kind, state, dimensions }) => ({ id, label: id, kind, state, ...(Number.isSafeInteger(dimensions) ? { dimensions } : {}) })), note: rows.length ? 'Модели найдены в локальном кэше Cognee. Наличие кэша не означает, что модель сейчас загружена.' : 'Установленные модели Cognee ещё не подтверждены. Обновите сведения локального сервера.' }
  }
  try {
    let models = []
    if (provider === 'openrouter') {
      if (endpoint) fail('PROCESSING_ENDPOINT_NOT_CONFIGURABLE')
      const response = await boundedJson(fetchImpl, `https://openrouter.ai/api/v1/${kind === 'embeddings' ? 'embeddings/models' : 'models'}`, { signal })
      if (!Array.isArray(response.data)) fail('PROCESSING_CATALOG_INVALID')
      models = response.data.filter(row => modelId(row.id) && (kind === 'embeddings' ? row.architecture?.output_modalities?.includes('embeddings') : row.architecture?.output_modalities?.includes('text'))).slice(0, 1000).map(row => ({ id: row.id, label: String(row.name ?? row.id).slice(0, 240), kind, state: 'api', ...(KNOWN_DIMENSIONS[row.id] ? { dimensions: KNOWN_DIMENSIONS[row.id] } : {}) }))
    } else if (provider === 'ollama') {
      const origin = localModelEndpoint(endpoint, provider), tags = await boundedJson(fetchImpl, origin + '/api/tags', { signal })
      if (!Array.isArray(tags.models)) fail('PROCESSING_CATALOG_INVALID')
      let loaded = new Set()
      try { const ps = await boundedJson(fetchImpl, origin + '/api/ps', { signal }); loaded = new Set((ps.models ?? []).map(row => row.name ?? row.model)) } catch { signal?.throwIfAborted() }
      const rows = tags.models.filter(row => modelId(row.name ?? row.model)).slice(0, 40)
      for (let offset = 0; offset < rows.length; offset += 8) {
        const batch = await Promise.all(rows.slice(offset, offset + 8).map(async row => {
          const id = row.name ?? row.model
          try {
            const info = await boundedJson(fetchImpl, origin + '/api/show', { signal, body: { model: id, verbose: false } })
            if (!Array.isArray(info.capabilities) || !info.capabilities.includes(kind === 'embeddings' ? 'embedding' : 'completion')) return null
            const dimension = Object.entries(info.model_info ?? {}).find(([key, value]) => key.endsWith('.embedding_length') && Number.isSafeInteger(value))?.[1]
            return { id, label: id, kind, state: loaded.has(id) ? 'loaded' : 'installed', ...(kind === 'embeddings' && dimension ? { dimensions: dimension } : {}) }
          } catch { signal?.throwIfAborted(); return null }
        }))
        models.push(...batch.filter(Boolean))
      }
    } else {
      const origin = localModelEndpoint(endpoint, provider)
      let response
      try { response = await boundedJson(fetchImpl, origin + '/api/v1/models', { signal }) }
      catch (error) { if (error.status !== 404) throw error; response = await boundedJson(fetchImpl, origin + '/api/v0/models', { signal }) }
      const rows = response.models ?? response.data
      if (!Array.isArray(rows)) fail('PROCESSING_CATALOG_INVALID')
      models = rows.filter(row => modelId(row.key ?? row.id) && (kind === 'embeddings' ? ['embedding', 'embeddings', 'embed'].includes(row.type) : ['llm', 'vlm'].includes(row.type))).slice(0, 100).map(row => ({ id: row.key ?? row.id, label: String(row.display_name ?? row.id ?? row.key).slice(0, 240), kind, state: row.state === 'loaded' || row.loaded_instances?.length ? 'loaded' : 'installed', ...(kind === 'embeddings' && Number.isSafeInteger(row.embedding_dimensions) ? { dimensions: row.embedding_dimensions } : {}) }))
    }
    signal?.throwIfAborted()
    return { available: true, models, note: provider === 'openrouter' ? 'Каталог OpenRouter. Генерация и эмбеддинги не запускались; выполнение потребует серверного API-ключа.' : 'Показаны совместимые модели локального сервера. Новые модели не загружались и не устанавливались.' }
  } catch (error) {
    signal?.throwIfAborted()
    if (String(error.message).startsWith('PROCESSING_LOCAL_') || error.message === 'PROCESSING_ENDPOINT_NOT_CONFIGURABLE') throw error
    return { available: false, models: [], note: error.status === 401 || error.status === 403 ? 'Каталог требует авторизации сервера; секреты в этой форме не передаются.' : 'Сервер моделей недоступен или не предоставил совместимый каталог. Проверьте адрес и состояние сервера.' }
  }
}
