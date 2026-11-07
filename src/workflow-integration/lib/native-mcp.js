import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const BOOT_ID = randomUUID()
const GENERATIONS = new WeakMap()
const LIMIT = 1024 * 1024
const TOOL = /^mcp__[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u
const KEYS = new Set(['schemaVersion', 'tool', 'revision', 'operation', 'inputSchema', 'format', 'effects'])
const fail = code => { throw new Error(code) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)

const assertionSchema = {
  type: 'object', additionalProperties: false, required: ['complete', 'assertions'],
  properties: { complete: { type: 'boolean' }, assertions: { type: 'array', maxItems: 10000, items: {
    type: 'object', additionalProperties: false, required: ['id', 'passed'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 160 }, passed: { type: 'boolean' } },
  } } },
}
const summarySchema = {
  type: 'object', additionalProperties: false,
  required: ['complete', 'runId', 'sourceDigest', 'tests', 'failures', 'errors', 'skipped'],
  properties: { complete: { type: 'boolean' }, runId: { type: 'string', minLength: 1, maxLength: 256 },
    sourceDigest: { type: 'string', minLength: 1, maxLength: 256 }, tests: { type: 'integer', minimum: 0 },
    failures: { type: 'integer', minimum: 0 }, errors: { type: 'integer', minimum: 0 }, skipped: { type: 'integer', minimum: 0 } },
}

/** Existing native MCP tools only. No transport, endpoint or connection is created here. */
export function createNativeMcpProvider({ ctx, execution, id, binding, core, onRunStart, allowedTools = [] }) {
  try {
    if (!plain(binding) || Object.keys(binding).some(key => !KEYS.has(key)) || binding.schemaVersion !== 1 ||
        typeof binding.tool !== 'string' || binding.tool.length > 128 || !TOOL.test(binding.tool) ||
        !text(binding.revision) || (binding.operation !== undefined && binding.operation !== 'check') ||
        !['assertions-json', 'test-summary-json'].includes(binding.format) ||
        !Array.isArray(binding.effects) || binding.effects.length !== 1 || binding.effects[0] !== 'readsSource' ||
        typeof core?.createMcpAdapter !== 'function' || typeof core?.digest !== 'function' ||
        typeof core?.validateSchema !== 'function' || typeof core?.canonical !== 'function' ||
        (onRunStart !== undefined && typeof onRunStart !== 'function') || !Array.isArray(allowedTools) ||
        allowedTools.length > 256 || allowedTools.some(tool => typeof tool !== 'string' || tool.length > 128 || !TOOL.test(tool))) fail('NATIVE_MCP_BINDING_INVALID')
    core.canonical(binding)
  } catch { fail('NATIVE_MCP_BINDING_INVALID') }
  const config = JSON.parse(core.canonical(binding))
  const approvedTools = [...new Set(allowedTools)].sort()
  const approved = approvedTools.includes(config.tool)
  const operation = config.operation ?? 'check'
  const resultSchema = config.format === 'assertions-json' ? assertionSchema : summarySchema
  const adapter = core.createMcpAdapter({ id, connectionRef: config.tool, connectionRevision: config.revision,
    operations: { [operation]: { tool: config.tool, inputSchema: config.inputSchema, resultSchema,
      effects: ['readsSource'], validator: config.format === 'assertions-json' ? 'assertions' : 'test-summary',
      mapResult(raw, context) {
        const data = parseNativeResult(raw, core)
        core.validateSchema(resultSchema, data)
        if (config.format === 'test-summary-json' && (data.runId !== context.runId || data.sourceDigest !== context.sourceDigest)) fail('NATIVE_MCP_PROVENANCE_MISMATCH')
        return { data, mutationState: 'not-applied' }
      } } },
    async call({ arguments: argumentsValue, signal, context }) {
      if (!approved) fail('NATIVE_MCP_READONLY_APPROVAL_REQUIRED')
      if (!execution?.agent?.session || !text(execution.callId) || typeof execution.token !== 'symbol' ||
          (execution.rootCallId !== undefined && !text(execution.rootCallId)) ||
          !ctx?.tools || typeof ctx.tools.get !== 'function' || typeof ctx.tools.execute !== 'function') fail('NATIVE_MCP_EXECUTION_REQUIRED')
      if (execution.signal !== undefined && !(execution.signal instanceof AbortSignal)) fail('NATIVE_MCP_EXECUTION_REQUIRED')
      if (!definition(ctx, config.tool, execution.agent)) fail('NATIVE_MCP_TOOL_UNAVAILABLE')
      const signals = [signal, execution.signal].filter(Boolean)
      const effectiveSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      effectiveSignal?.throwIfAborted()
      if (onRunStart) await onRunStart(context.runId)
      effectiveSignal?.throwIfAborted()
      const result = await ctx.tools.execute({ name: config.tool, agent: execution.agent,
        callId: `${execution.callId}:workflow:${context.stepId}`, rootCallId: execution.rootCallId ?? execution.callId,
        parent: execution.token, arguments: argumentsValue, signal: effectiveSignal })
      effectiveSignal?.throwIfAborted()
      return result
    },
  })
  const original = adapter.fingerprint.bind(adapter)
  adapter.fingerprint = async () => {
    const visible = definition(ctx, config.tool, execution?.agent)
    let generation = 'missing'
    if (visible) {
      if (!GENERATIONS.has(visible)) GENERATIONS.set(visible, randomUUID())
      generation = GENERATIONS.get(visible)
    }
    return core.digest({ adapter: await original(), binding: config, approvedTools, approved,
      module: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), boot: BOOT_ID, generation })
  }
  Object.defineProperty(adapter, 'readOnlyApproved', { value: approved, enumerable: true })
  return adapter
}

function definition(ctx, name, agent) {
  try {
    const value = ctx?.tools?.get(name, agent)
    return value !== null && ['object', 'function'].includes(typeof value) ? value : null
  } catch { return null }
}

export function parseNativeResult(result, core) {
  if (!plain(result) || result.isError === true || (result.isError !== undefined && result.isError !== false) || !plain(result.value)) fail('NATIVE_MCP_RESULT_REJECTED')
  const value = result.value
  if (value.isError === true) fail('NATIVE_MCP_RESULT_REJECTED')
  let data
  if (Object.hasOwn(value, 'structuredContent')) data = value.structuredContent
  else {
    if (!Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text' ||
        typeof value.content[0].text !== 'string' || Buffer.byteLength(value.content[0].text, 'utf8') > LIMIT) fail('NATIVE_MCP_RESULT_REJECTED')
    try { data = JSON.parse(value.content[0].text) } catch { fail('NATIVE_MCP_RESULT_REJECTED') }
  }
  checkBudget(data)
  if (!plain(data) || Buffer.byteLength(core.canonical(data), 'utf8') > LIMIT) fail('NATIVE_MCP_RESULT_REJECTED')
  return data
}

function checkBudget(value) {
  let nodes = 0, bytes = 0
  const visited = new Set()
  function visit(item, depth = 0) {
    if (++nodes > 50000 || depth > 32 || bytes > LIMIT) fail('NATIVE_MCP_RESULT_REJECTED')
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8')
    else if (item && typeof item === 'object') {
      if ((!Array.isArray(item) && !plain(item)) || visited.has(item)) fail('NATIVE_MCP_RESULT_REJECTED')
      visited.add(item)
      for (const key of Object.keys(item)) {
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (!Object.hasOwn(property, 'value')) fail('NATIVE_MCP_RESULT_REJECTED')
        bytes += Buffer.byteLength(key, 'utf8')
        visit(property.value, depth + 1)
      }
      visited.delete(item)
    }
    if (bytes > LIMIT) fail('NATIVE_MCP_RESULT_REJECTED')
  }
  visit(value)
}
