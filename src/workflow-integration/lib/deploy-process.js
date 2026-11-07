import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createNativeProcessAdapter } from './native-process.js'

const SHA = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const LIMIT = 1024 * 1024
const fail = code => Object.assign(new Error(code), { code })
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const within = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const emptyProcess = () => ({ exitCode: null, signal: null, timedOut: false, aborted: false,
  outputLimitExceeded: false, stdoutBytes: 0, stderrBytes: 0, startError: 'DEPLOY_PREFLIGHT_REJECTED', terminationConfirmed: true })

export const DEPLOY_RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'operation', 'runId', 'stepId', 'sourceDigest', 'targetId', 'targetDigest', 'profileDigest',
    'complete', 'assertions', 'process', 'terminationConfirmed', 'reportDigest', 'reason'],
  properties: {
    schemaVersion: { const: 1 }, operation: { enum: ['deploy-apply', 'deploy-preview'] }, runId: { type: 'string' }, stepId: { type: 'string' }, sourceDigest: { type: 'string' },
    targetId: { type: 'string' }, targetDigest: { type: 'string' }, profileDigest: { type: 'string' },
    complete: { type: 'boolean' }, terminationConfirmed: { type: 'boolean' },
    reportDigest: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    assertions: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
      required: ['id', 'passed'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, passed: { type: 'boolean' } } } },
    process: { type: 'object', additionalProperties: false,
      required: ['exitCode', 'signal', 'timedOut', 'aborted', 'outputLimitExceeded', 'stdoutBytes', 'stderrBytes', 'startError', 'terminationConfirmed'],
      properties: { exitCode: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, signal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        timedOut: { type: 'boolean' }, aborted: { type: 'boolean' }, outputLimitExceeded: { type: 'boolean' },
        stdoutBytes: { type: 'integer', minimum: 0 }, stderrBytes: { type: 'integer', minimum: 0 },
        startError: { anyOf: [{ type: 'string' }, { type: 'null' }] }, terminationConfirmed: { type: 'boolean' } } },
  },
})

/** Validates normalized evidence only. Raw runner logs, command lines and target paths never leave the adapter. */
export function validateDeployEvidence(data, context = {}) {
  const unknown = reason => ({ status: 'indeterminate', reason })
  if (!data || data.schemaVersion !== 1 || data.runId !== context.runId || data.sourceDigest !== context.sourceDigest) return unknown('DEPLOY_EVIDENCE_PROVENANCE_INVALID')
  const process = data.process
  if (!process || process.terminationConfirmed !== true || data.terminationConfirmed !== true) return unknown('DEPLOY_PROCESS_STOP_UNCONFIRMED')
  if (data.complete !== true) return unknown(/^DEPLOY_[A-Z0-9_]{1,80}$/u.test(data.reason ?? '') ? data.reason : 'DEPLOY_REPORT_UNCONFIRMED')
  if (process.exitCode !== 0 || process.signal !== null || process.startError !== null || process.timedOut || process.aborted || process.outputLimitExceeded) return { status: 'failed', reason: 'DEPLOY_PROCESS_FAILED' }
  if (!Array.isArray(data.assertions) || data.assertions.length === 0 || data.assertions.length > 128) return unknown('DEPLOY_ASSERTIONS_MISSING')
  const seen = new Set()
  for (const assertion of data.assertions) {
    if (!assertion || typeof assertion.id !== 'string' || !assertion.id || seen.has(assertion.id) || typeof assertion.passed !== 'boolean') return unknown('DEPLOY_ASSERTIONS_INVALID')
    seen.add(assertion.id)
  }
  return data.assertions.every(assertion => assertion.passed) ? { status: 'passed' } : { status: 'failed', reason: 'DEPLOY_ASSERTION_FAILED' }
}

/** A reviewed runner writes an invocation-bound report. Native DSH owns process launch, sandbox and cancellation. */
export function createDeployProcessAdapter(options) {
  const { core, deployment, operations, id, version = '1.0.0' } = options
  if (!core?.validateDeployReport || !core?.safeRead || !core?.projectPath || !core?.digest || !core?.validateSchema || !core?.validateDescriptor) throw fail('DEPLOY_RUNTIME_REQUIRED')
  if (!deployment || typeof deployment.projectId !== 'string' || !ID.test(deployment.projectId)
    || !SHA.test(deployment.targetDigest) || !SHA.test(deployment.profileDigest)
    || typeof deployment.target?.id !== 'string' || !ID.test(deployment.target.id)
    || !['test', 'development'].includes(deployment.target.environment) || !['file', 'server', 'fixture'].includes(deployment.target.kind)
    || typeof deployment.resultPath !== 'string' || !deployment.resultPath || deployment.resultPath.includes('\0')
    || (!isAbsolute(deployment.resultPath) && (deployment.resultPath.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/u.test(deployment.resultPath)))
    || (deployment.target.kind === 'server'
      ? typeof deployment.targetServer !== 'string' || !deployment.targetServer || typeof deployment.targetRef !== 'string' || !deployment.targetRef
      : typeof deployment.targetPath !== 'string' || !isAbsolute(deployment.targetPath))
    || typeof deployment.exactBuild !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/u.test(deployment.exactBuild)
    || !operations || !Object.keys(operations).length || Object.keys(operations).some(key => !['deploy-apply', 'deploy-preview'].includes(key))) throw fail('DEPLOY_REGISTRATION_INVALID')
  for (const [name, config] of Object.entries(operations)) {
    if (!config || typeof config.args !== 'function' || !Array.isArray(config.effects)
      || name === 'deploy-apply' && (!config.effects.includes('writesTargetData') || !config.effects.includes('changesMetadata'))
      || name === 'deploy-preview' && config.effects.some(effect => ['writesTargetData', 'changesMetadata', 'serviceLifecycle', 'destructiveRecovery'].includes(effect))) throw fail('DEPLOY_EFFECTS_REQUIRED')
  }
  const expected = structuredClone(deployment)
  if (expected.target.kind === 'server') {
    if (typeof core.normalizeDeployServerTarget !== 'function') throw fail('DEPLOY_SERVER_NORMALIZER_REQUIRED')
    const normalized = core.normalizeDeployServerTarget(expected.targetServer, expected.targetRef)
    if (normalized.server !== expected.targetServer || normalized.ref !== expected.targetRef
      || expected.targetPath != null || core.digest({ kind: 'server', ...normalized }) !== expected.targetDigest
      || expected.target.id !== `onec-${expected.targetDigest}`) throw fail('DEPLOY_SERVER_TARGET_INVALID')
  }
  const native = createNativeProcessAdapter({ ...options, version, operations: Object.fromEntries(Object.entries(operations).map(([name, config]) => [name, { ...config,
    effects: ['readsSource', 'startsProcess', 'writesFilesystem'], validator: 'process-exit', resourcesRequired: true,
    args: (inputs, context) => config.args(inputs, { ...context, deployContext: Object.freeze({
      runId: context.runId, stepId: context.stepId, sourceDigest: context.sourceDigest,
      targetDigest: expected.targetDigest, profileDigest: expected.profileDigest,
      exactBuild: expected.exactBuild, ...(expected.target.kind === 'server'
        ? { targetKind: 'server', targetServer: expected.targetServer, targetRef: expected.targetRef }
        : { targetPath: expected.targetPath }),
    }) }),
  }])) })
  const descriptor = core.validateDescriptor({ protocolVersion: 1, id, version, operations: Object.fromEntries(Object.entries(operations).map(([name, config]) => [name, {
    inputSchema: structuredClone(config.inputSchema), resultSchema: structuredClone(DEPLOY_RESULT_SCHEMA),
    effects: [...config.effects], validator: 'deployment-result', resourcesRequired: true,
  }])) })
  return {
    descriptor: freeze(descriptor),
    async fingerprint() {
      return core.digest({ native: await native.fingerprint(), descriptor, deployment: expected, builders: Object.entries(operations).map(([name, config]) => [name, config.args.toString()]),
        moduleHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') })
    },
    async execute(operation, inputs, context = {}) {
      const config = operations[operation]
      if (!config) throw fail('DEPLOY_OPERATION_UNKNOWN')
      if (!UUID.test(context.runId) || !ID.test(context.stepId) || !SHA.test(context.sourceDigest)) throw fail('DEPLOY_PROVENANCE_REQUIRED')
      const data = { schemaVersion: 1, operation, runId: context.runId, stepId: context.stepId, sourceDigest: context.sourceDigest,
        targetId: expected.target.id, targetDigest: expected.targetDigest, profileDigest: expected.profileDigest,
        complete: false, assertions: [], process: emptyProcess(), terminationConfirmed: true, reportDigest: null, reason: null }
      let invoked = false, processResult, reportPath, startedAfter
      try {
        core.validateSchema(config.inputSchema, inputs)
        const currentPolicy = options.ctx.sandboxPolicy.resolve({ session: options.agent.session })
        if (!['workspace-write', 'danger-full-access'].includes(currentPolicy?.mode)) throw fail('DEPLOY_WRITE_PERMISSION_REQUIRED')
        const root = await realpath(context.cwd)
        const resultRoot = resolve(root, expected.resultPath)
        if (!within(root, resultRoot) || samePath(root, resultRoot)) throw fail('DEPLOY_RESULT_PATH_REJECTED')
        const resultRelative = relative(root, resultRoot)
        await inspectParents(root, resultRelative)
        const directory = join(resultRoot, `workflow-${context.runId}`, context.stepId)
        await inspectParents(root, relative(root, directory))
        await assertAbsent(directory)
        reportPath = join(directory, 'result.json')
        startedAfter = Date.now()
        // No directory or file is created here. The reviewed runner creates the exclusive directory in the native sandbox.
        invoked = true
        processResult = await native.execute(operation, inputs, context)
        data.process = processResult.data; data.terminationConfirmed = processResult.data.terminationConfirmed
        if (data.process.timedOut || data.process.aborted || data.process.terminationConfirmed !== true) throw fail('DEPLOY_PROCESS_INTERRUPTED')
        const file = await core.projectPath(root, relative(root, reportPath))
        const before = await lstat(file)
        if (before.nlink !== 1 || before.isSymbolicLink() || before.size > LIMIT) throw fail('DEPLOY_REPORT_FILE_REJECTED')
        const bytes = await core.safeRead(root, file, LIMIT)
        if ((await lstat(file)).nlink !== 1) throw fail('DEPLOY_REPORT_FILE_REJECTED')
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
        const normalized = core.validateDeployReport(raw, { runId: context.runId, stepId: context.stepId,
          sourceDigest: context.sourceDigest, targetDigest: expected.targetDigest, profileDigest: expected.profileDigest,
          projectId: expected.projectId, operation, startedAfter, finishedBefore: Date.now() })
        if (normalized?.complete !== true || !['not-applied', 'unknown', 'applied'].includes(normalized.mutationState)) throw fail('DEPLOY_REPORT_CONTRACT_INVALID')
        const assertions = normalized.assertions.map(item => ({ id: item.id, passed: item.passed }))
        Object.assign(data, { complete: true, assertions, reportDigest: createHash('sha256').update(bytes).digest('hex') })
        core.validateSchema(DEPLOY_RESULT_SCHEMA, data)
        return { data, mutationState: normalized.mutationState }
      } catch (error) {
        data.reason = /^DEPLOY_[A-Z0-9_]{1,80}$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'DEPLOY_REPORT_UNCONFIRMED'
        if (invoked && !processResult) data.terminationConfirmed = data.process.terminationConfirmed = false
        return { data, mutationState: !invoked || processResult?.mutationState === 'not-applied' ? 'not-applied' : 'unknown' }
      }
    },
  }
}

async function assertAbsent(path) {
  try { await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw fail('DEPLOY_REPORT_PREEXISTING')
}
async function inspectParents(root, rel) {
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    if (part === '..') throw fail('DEPLOY_RESULT_PATH_REJECTED')
    cursor = join(cursor, part)
    let info
    try { info = await lstat(cursor) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(cursor), resolve(cursor))) throw fail('DEPLOY_RESULT_PATH_REJECTED')
  }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
