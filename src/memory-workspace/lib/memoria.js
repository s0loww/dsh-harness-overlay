import { createHash, randomUUID } from 'node:crypto'
import { executeNativeTool } from './native-tools.js'

const fail = code => { throw new Error(code) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const fieldPath = value => typeof value === 'string' && value.length <= 200 && value.split('.').every(key => /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key))
const text = (value, max, code = 'MEMORIA_INPUT_INVALID') => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(code); return value }
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const typeHas = (schema, type) => schema?.type === type || Array.isArray(schema?.type) && schema.type.includes(type)

/** Explicit user/project binding only. No endpoint, secret, server-name guessing or facade requirement. */
export function validateMemoriaBinding(input) {
  if (!plain(input) || Object.keys(input).some(key => !['namespace', 'search', 'remember'].includes(key))) fail('MEMORIA_BINDING_INVALID')
  const output = { namespace: text(input.namespace, 500, 'MEMORIA_NAMESPACE_REQUIRED') }
  for (const kind of ['search', 'remember']) {
    if (input[kind] === undefined || input[kind] === null) continue
    const row = input[kind], fields = kind === 'search' ? ['tool', 'scopeArgument', 'queryArgument'] : ['tool', 'scopeArgument', 'textArgument', 'titleArgument']
    if (!plain(row) || Object.keys(row).some(key => !fields.includes(key)) || typeof row.tool !== 'string' || !/^mcp__[A-Za-z0-9_-]{1,100}__[A-Za-z0-9_-]{1,140}$/u.test(row.tool)) fail('MEMORIA_BINDING_INVALID')
    const required = fields.filter(key => key !== 'tool' && key !== 'titleArgument')
    if (required.some(key => !fieldPath(row[key])) || row.titleArgument !== undefined && !fieldPath(row.titleArgument)) fail('MEMORIA_BINDING_INVALID')
    const paths = fields.filter(key => key !== 'tool' && row[key] !== undefined).map(key => row[key])
    if (paths.some((path, index) => paths.some((other, next) => next !== index && (path === other || path.startsWith(other + '.') || other.startsWith(path + '.'))))) fail('MEMORIA_MAPPING_COLLISION')
    output[kind] = structuredClone(row)
  }
  if (!output.search && !output.remember) fail('MEMORIA_BINDING_INVALID')
  return output
}

function schemaAt(schema, path) {
  let value = schema
  for (const key of path.split('.')) {
    if (!plain(value?.properties) || !Object.hasOwn(value.properties, key)) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
    value = value.properties[key]
    if (!plain(value) || value.$ref || value.anyOf || value.oneOf || value.allOf) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
  }
  return value
}
function schemaValue(schema, path, value, scope = false) {
  const leaf = schemaAt(schema, path)
  let output = value
  if (scope && typeHas(leaf, 'array') && typeHas(leaf.items, 'string')) output = [value]
  else if (!typeHas(leaf, 'string')) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
  if (leaf.enum && !leaf.enum.some(candidate => canonical(candidate) === canonical(output))) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
  if (typeof leaf.maxLength === 'number' && typeof output === 'string' && output.length > leaf.maxLength) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
  return output
}
function assign(target, path, value) {
  const segments = path.split('.'); let node = target
  for (const part of segments.slice(0, -1)) node = node[part] ??= {}
  node[segments.at(-1)] = value
}
function requireMapped(schema, args) {
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) fail('MEMORIA_REQUIRED_MAPPING_MISSING')
  for (const [key, value] of Object.entries(args)) if (plain(value)) requireMapped(schema.properties[key], value)
}
function schemaFor(ctx, agent, mapping) {
  if (!mapping || !ctx.tools?.get(mapping.tool, agent)) fail('MEMORIA_TOOL_UNAVAILABLE')
  const rows = ctx.tools.schemas(agent).filter(row => row.name === mapping.tool)
  if (rows.length !== 1) fail('MEMORIA_TOOL_UNAVAILABLE')
  const schema = rows[0].parameters ?? rows[0].inputSchema
  if (!plain(schema) || schema.$ref || !plain(schema.properties) || !typeHas(schema, 'object')) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
  return { schema, definition: ctx.tools.get(mapping.tool, agent), revision: hash(schema) }
}
function argsFor(schema, mapping, namespace, kind, input) {
  const args = {}
  assign(args, mapping.scopeArgument, schemaValue(schema, mapping.scopeArgument, namespace, true))
  const key = kind === 'search' ? mapping.queryArgument : mapping.textArgument
  assign(args, key, schemaValue(schema, key, kind === 'search' ? input.query : input.text))
  if (kind === 'remember' && mapping.titleArgument) assign(args, mapping.titleArgument, schemaValue(schema, mapping.titleArgument, input.title ?? ''))
  requireMapped(schema, args)
  return args
}

function unwrap(result) {
  if (result?.isError) fail('MEMORIA_REQUEST_FAILED')
  let value = result?.value ?? result
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 256 * 1024) fail('MEMORIA_RESPONSE_LIMIT')
  if (value?.structuredContent !== undefined) value = value.structuredContent
  else if (Array.isArray(value?.content)) {
    const blocks = value.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text)
    if (blocks.length !== 1) fail('MEMORIA_RESPONSE_SCHEMA_REQUIRED')
    try { value = JSON.parse(blocks[0]) } catch { fail('MEMORIA_RESPONSE_SCHEMA_REQUIRED') }
  }
  if (!plain(value) && !Array.isArray(value)) fail('MEMORIA_RESPONSE_SCHEMA_REQUIRED')
  return value
}
function assertResponseScope(value, namespace, scopeArgument, arrayScope = false) {
  const lastKey = scopeArgument.split('.').at(-1), keys = new Set(['namespace', 'namespace_id', 'namespaceId', lastKey])
  let supplied = false, count = 0
  const inspect = (node, depth = 0) => {
    if (depth > 12 || ++count > 20_000) fail('MEMORIA_RESPONSE_LIMIT')
    if (Array.isArray(node)) return node.forEach(item => inspect(item, depth + 1))
    if (!plain(node)) return
    for (const [key, item] of Object.entries(node)) {
      if (keys.has(key)) {
        if (typeof item === 'string') { supplied = true; if (item !== namespace) fail('MEMORIA_FOREIGN_NAMESPACE') }
        else if (Array.isArray(item)) {
          supplied = true
          // Tag/project-membership filters legitimately return additional tags.
          // Reserved namespace identifiers remain exact; a configured array
          // membership field must include the requested project marker.
          const membership = arrayScope && key === lastKey && !['namespace', 'namespace_id', 'namespaceId'].includes(key)
          if (membership ? !item.includes(namespace) : item.length !== 1 || item[0] !== namespace) fail('MEMORIA_FOREIGN_NAMESPACE')
        }
      }
      if (item && typeof item === 'object') inspect(item, depth + 1)
    }
  }
  inspect(value)
  return supplied ? 'response-and-request-filter' : 'request-filter'
}
function recordText(row) { return typeof row === 'string' ? row : typeof row?.text === 'string' ? row.text : typeof row?.content === 'string' ? row.content : typeof row?.memory === 'string' ? row.memory : typeof row?.summary === 'string' ? row.summary : '' }
function rowsOf(value) {
  if (Array.isArray(value)) return value
  for (const key of ['results', 'memories', 'notes', 'items', 'records']) if (Array.isArray(value[key])) return value[key]
  if (plain(value.data)) return rowsOf(value.data)
  if (Array.isArray(value.data)) return value.data
  if (recordText(value)) return [value]
  fail('MEMORIA_RESPONSE_SCHEMA_REQUIRED')
}

/** All dispatches are native nested calls. Root routing owns persistent write intents and approval. */
export function createMemoriaAdapter(ctx, { binding: rawBinding, execution, verifyScope, executeTool = executeNativeTool } = {}) {
  const binding = validateMemoriaBinding(rawBinding)
  if (!execution?.agent || typeof verifyScope !== 'function' || typeof executeTool !== 'function') fail('MEMORIA_NATIVE_SCOPE_REQUIRED')
  const pinned = new Map()
  const check = () => { verifyScope(); execution.signal?.throwIfAborted() }
  function inspect(kind) {
    check()
    const mapping = binding[kind], found = schemaFor(ctx, execution.agent, mapping)
    // Validate namespace and mapped field types without requiring query/text values yet.
    schemaValue(found.schema, mapping.scopeArgument, binding.namespace, true)
    if (!typeHas(schemaAt(found.schema, kind === 'search' ? mapping.queryArgument : mapping.textArgument), 'string')) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
    if (mapping.titleArgument && !typeHas(schemaAt(found.schema, mapping.titleArgument), 'string')) fail('MEMORIA_SCHEMA_MAPPING_INVALID')
    const old = pinned.get(kind)
    if (old && (old.definition !== found.definition || old.revision !== found.revision)) fail('MEMORIA_SCHEMA_CHANGED')
    pinned.set(kind, found)
    return { mapping, ...found }
  }
  async function dispatch(kind, input) {
    check()
    if (typeof execution.token !== 'symbol' || typeof execution.callId !== 'string' || !execution.callId) fail('MEMORIA_NATIVE_EXECUTION_REQUIRED')
    const { mapping, schema, revision, definition } = inspect(kind)
    const args = argsFor(schema, mapping, binding.namespace, kind, input)
    let result
    try {
      result = await executeTool(ctx, { name: mapping.tool, arguments: args, agent: execution.agent, parent: execution.token, rootCallId: execution.rootCallId ?? execution.callId, callId: `${execution.callId}:memoria:${randomUUID()}`, signal: execution.signal })
      check()
      const fresh = schemaFor(ctx, execution.agent, mapping)
      if (fresh.revision !== revision || fresh.definition !== definition) fail('MEMORIA_SCHEMA_CHANGED')
      const response = unwrap(result), scopeEvidence = assertResponseScope(response, binding.namespace, mapping.scopeArgument, typeHas(schemaAt(schema, mapping.scopeArgument), 'array'))
      return { response, scopeEvidence }
    } catch (error) {
      // A remote tool can report an error after committing. Parent journal must
      // retain this uncertainty and reconcile instead of retrying/mirroring.
      if (kind === 'remember') return { unknown: true }
      throw new Error(/^(?:MEMORIA_|MEMORY_|SCOPE_|ABORT)/.test(error?.message ?? '') ? error.message : 'MEMORIA_REQUEST_FAILED')
    }
  }
  return {
    status() {
      check(); const operations = {}, errors = {}
      for (const kind of ['search', 'remember']) {
        try { const found = inspect(kind); operations[kind] = { available: true, tool: found.mapping.tool, schemaRevision: found.revision } }
        catch (error) { operations[kind] = { available: false }; errors[kind] = /^MEMORIA_[A-Z_]+$/.test(error.message) ? error.message : 'MEMORIA_UNAVAILABLE' }
      }
      check()
      return { backend: 'memoria', namespace: binding.namespace, availability: Object.values(operations).some(row => row.available) ? 'catalog-only' : 'unavailable', connected: null, operations, errors }
    },
    async recall({ query, topK = 8 } = {}) {
      text(query, 4000)
      if (!Number.isInteger(topK) || topK < 1 || topK > 30) fail('MEMORIA_INPUT_INVALID')
      const { response, scopeEvidence } = await dispatch('search', { query })
      const rows = rowsOf(response), results = rows.slice(0, topK).map((row, index) => {
        const id = typeof row?.id === 'string' || typeof row?.id === 'number' ? String(row.id) : typeof row?.memory_id === 'string' ? row.memory_id : typeof row?.note_id === 'string' ? row.note_id : null
        const content = recordText(row)
        if (!content) fail('MEMORIA_RESPONSE_SCHEMA_REQUIRED')
        return { backend: 'memoria', namespace: binding.namespace, text: content.slice(0, 6000), source: { tool: binding.search.tool, recordId: id?.slice(0, 300) ?? null, position: index, scopeEvidence }, ...(typeof row?.score === 'number' && Number.isFinite(row.score) ? { score: row.score } : {}) }
      })
      return { backend: 'memoria', namespace: binding.namespace, results, scopeEvidence, truncated: rows.length > topK || rows.slice(0, topK).some(row => recordText(row).length > 6000) || response.truncated === true }
    },
    async remember({ text: content, title = '', operationId } = {}) {
      text(content, 32000); if (typeof title !== 'string' || title.length > 120 || title.includes('\0')) fail('MEMORIA_INPUT_INVALID')
      text(operationId, 200, 'MEMORIA_OPERATION_ID_REQUIRED')
      const sent = await dispatch('remember', { text: content, title })
      if (sent.unknown) return { backend: 'memoria', namespace: binding.namespace, state: 'outcome-unknown', operationId, retrySafe: false, indexed: false }
      const response = sent.response, id = response.id ?? response.memory_id ?? response.note_id ?? response.data?.id
      const idProvided = typeof id === 'string' && !!id.trim() && !id.includes('\0') || typeof id === 'number' && Number.isFinite(id)
      const accepted = response.ok === true || response.success === true || idProvided || ['created', 'saved', 'stored', 'updated'].includes(response.status ?? response.state)
      if (!accepted || response.ok === false || response.success === false || response.error) return { backend: 'memoria', namespace: binding.namespace, state: 'outcome-unknown', operationId, retrySafe: false, indexed: false }
      return { backend: 'memoria', namespace: binding.namespace, state: 'stored', operationId, recordId: id === undefined ? null : String(id).slice(0, 300), scopeEvidence: sent.scopeEvidence, retrySafe: false, indexed: null }
    },
  }
}
