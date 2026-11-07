import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, mkdir, writeFile, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateDriverConfig, DRIVER_CONFIG_PATH } from '../runners/runner.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row)
const digest = value => hash(canonical(value))
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const inside = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`) }
export const OPERATIONS = Object.freeze({ repository: ['status', 'history', 'diff', 'lock', 'update', 'commit', 'unlock', 'dump'], 'ai-merge': ['compare', 'cfe-plan'], v8unpack: ['unpack', 'rebuild'] })
const BINDING = '.dsh/onec-specialized.json'
const PROJECT_LOCKS = new Map()
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('SPECIALIZED_FIELDS_INVALID') }
function pathRelative(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || /^[A-Za-z]:/u.test(path) || /[\0\r\n]/u.test(path) || path.split(/[\\/]/u).some(p => !p || p === '.' || p === '..' || /^\.env(?:\.|$)/iu.test(p))) fail('SPECIALIZED_PATH_INVALID')
  return path.replaceAll('\\', '/')
}
async function checked(root, rel, { absent = false } = {}) {
  rel = pathRelative(rel)
  let at = root
  for (const part of rel.split('/')) {
    at = join(at, part)
    try { const s = await lstat(at); if (s.isSymbolicLink() || s.isFile() && s.nlink !== 1) fail('SPECIALIZED_LINK_REFUSED') }
    catch (error) { if (error.code === 'ENOENT' && absent) return resolve(root, rel); throw error }
  }
  return at
}
async function bytes(root, rel, max = 1024 * 1024) {
  const path = await checked(root, rel), before = await lstat(path)
  if (!before.isFile() || before.size > max) fail('SPECIALIZED_FILE_LIMIT')
  const data = await readFile(path), after = await lstat(path)
  if (data.length > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SPECIALIZED_FILE_CHANGED')
  return { path: rel, sha256: hash(data), bytes: data.length, data }
}
const publicFile = ({ data, ...file }) => file
async function tree(root, rel, { artifact = false } = {}) {
  const files = []; let total = 0
  async function walk(path, depth) {
    if (depth > 12) fail('SPECIALIZED_TREE_LIMIT')
    const at = await checked(root, path), info = await lstat(at)
    if (info.isDirectory()) {
      const names = await readdir(at)
      if (names.length > 512) fail('SPECIALIZED_TREE_LIMIT')
      for (const name of names.sort()) await walk(`${path}/${name}`, depth + 1)
    } else {
      if (files.length >= 512) fail('SPECIALIZED_TREE_LIMIT')
      if (!artifact && !/\.(?:xml|bsl|json|txt|html|mxl|bin)$/iu.test(path)) fail('SPECIALIZED_SOURCE_TYPE_UNSUPPORTED')
      const file = await bytes(root, path); total += file.bytes
      if (total > 8 * 1024 * 1024) fail('SPECIALIZED_TREE_LIMIT')
      files.push({ ...publicFile(file), relative: path.slice(rel.length + 1) })
    }
  }
  await walk(pathRelative(rel), 0)
  return files
}
export function classifyChange(current, vendor, baseline, hasBaseline) {
  if (current === vendor) return 'same'
  if (!hasBaseline) return current === undefined ? 'vendor-only' : vendor === undefined ? 'local-only' : 'twice-changed'
  const localChanged = current !== baseline, vendorChanged = vendor !== baseline
  return localChanged && vendorChanged ? 'twice-changed' : localChanged ? 'local-only' : 'vendor-only'
}
function validateRunner(runner, domain) {
  keys(runner, ['protocolVersion', 'kind', 'path', 'sha256', 'operations', 'writeOperations', 'fixture', 'timeoutMs', 'driverConfigPath'])
  if (runner.driverConfigPath !== undefined && (runner.kind !== 'node' || runner.driverConfigPath !== DRIVER_CONFIG_PATH)) fail('SPECIALIZED_DRIVER_CONFIG_PATH_INVALID')
  if (runner.protocolVersion !== 1 || !['node', 'powershell'].includes(runner.kind) || runner.path !== `tools/onec-specialized/runner.${runner.kind === 'node' ? 'mjs' : 'ps1'}` || !/^[a-f0-9]{64}$/u.test(runner.sha256 ?? '') || typeof runner.fixture !== 'boolean' || !Array.isArray(runner.operations) || !runner.operations.length || runner.operations.some(op => !OPERATIONS[domain].includes(op)) || new Set(runner.operations).size !== runner.operations.length || !Array.isArray(runner.writeOperations) || runner.writeOperations.some(op => !runner.operations.includes(op)) || !Number.isInteger(runner.timeoutMs ?? 60000) || (runner.timeoutMs ?? 60000) < 100 || (runner.timeoutMs ?? 60000) > 600000) fail('SPECIALIZED_RUNNER_BINDING_INVALID')
  if (domain === 'repository' && ['lock', 'update', 'commit', 'unlock', 'dump'].some(op => runner.operations.includes(op) && !runner.writeOperations.includes(op)) || domain === 'v8unpack' && runner.operations.some(op => !runner.writeOperations.includes(op)) || domain === 'ai-merge' && runner.operations.some(op => op !== 'compare')) fail('SPECIALIZED_RUNNER_EFFECTS_INVALID')
  return runner
}
function objectId(file) {
  const [kind, name] = file.split('/')
  return `${kind}.${(name ?? kind).replace(/\.xml$/iu, '')}`
}
function group(files) {
  const rows = new Map()
  for (const file of files) { const id = objectId(file.relative); if (!rows.has(id)) rows.set(id, []); rows.get(id).push({ path: file.relative, sha256: file.sha256 }) }
  return new Map([...rows].map(([id, data]) => [id, digest(data)]))
}
function objectList(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100 || new Set(input).size !== input.length || input.some(id => typeof id !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?$/u.test(id))) fail('SPECIALIZED_EXPLICIT_OBJECTS_REQUIRED')
  if (input.includes('Конфигурация') && input.length !== 1) fail('SPECIALIZED_ROOT_OBJECT_MUST_STAND_ALONE')
  return [...input].sort()
}

/** Pure schema/path validation shared by native project setup and runtime load. */
export function validateSpecializedBinding(c) {
  keys(c, ['schemaVersion', 'repository', 'aiMerge', 'v8unpack'])
  if (c.schemaVersion !== 1) fail('SPECIALIZED_BINDING_VERSION_INVALID')
  if (c.repository) { keys(c.repository, ['runner', 'reports', 'allowForce', 'output']); if (c.repository.output) pathRelative(c.repository.output); if (c.repository.runner) validateRunner(c.repository.runner, 'repository'); if (c.repository.allowForce !== undefined && typeof c.repository.allowForce !== 'boolean') fail('SPECIALIZED_FORCE_BINDING_INVALID'); if (c.repository.reports) { keys(c.repository.reports, ['status', 'history', 'diff']); Object.values(c.repository.reports).forEach(pathRelative) } }
  if (c.aiMerge) { keys(c.aiMerge, ['current', 'vendor', 'baseline', 'runner']); ['current', 'vendor'].forEach(k => pathRelative(c.aiMerge[k])); if (c.aiMerge.baseline) pathRelative(c.aiMerge.baseline); if (c.aiMerge.runner) validateRunner(c.aiMerge.runner, 'ai-merge') }
  if (c.v8unpack) { keys(c.v8unpack, ['input', 'output', 'runner']); ['input', 'output'].forEach(k => pathRelative(c.v8unpack[k])); if (c.v8unpack.runner) validateRunner(c.v8unpack.runner, 'v8unpack') }
  return structuredClone(c)
}

/** Local contracts and evidence; execution uses only the injected native adapter. */
export async function createSpecializedService({ projectRoot, evidenceRoot, reconciliationRoot, trustedRunnerDigests = [], trustedPowerShellPath = '', executeProcess, authorize } = {}) {
  if (!isAbsolute(projectRoot ?? '') || (await lstat(projectRoot)).isSymbolicLink()) fail('SPECIALIZED_PROJECT_ROOT_REQUIRED')
  const root = await realpath(projectRoot)
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root
  if (reconciliationRoot && (!isAbsolute(reconciliationRoot) || inside(root, resolve(reconciliationRoot)))) fail('SPECIALIZED_PRIVATE_RECONCILIATION_STORE_REQUIRED')
  const projectDigest = hash(lockKey), guardPath = reconciliationRoot ? join(reconciliationRoot, `${projectDigest}.json`) : null
  if (evidenceRoot && (!isAbsolute(evidenceRoot) || inside(root, resolve(evidenceRoot)))) fail('SPECIALIZED_EVIDENCE_OUTSIDE_PROJECT_REQUIRED')
  if (!Array.isArray(trustedRunnerDigests) || trustedRunnerDigests.some(x => !/^[a-f0-9]{64}$/u.test(x))) fail('SPECIALIZED_TRUST_CONFIG_INVALID')
  const trusted = new Set(trustedRunnerDigests), plans = new Map(), runs = new Map(), requests = new Map(), activeControllers = new Map(); let busy = false
  const reconcileMessage = 'Сверьте состояние хранилища: требуется восстановление. Автоматическое снятие блокировки не поддерживается.'
  async function guardState() {
    if (!guardPath) return { available: false, required: false }
    try {
      const rootInfo = await lstat(reconciliationRoot)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('invalid')
      const info = await lstat(guardPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) throw new Error('invalid')
      const record = JSON.parse(await readFile(guardPath, 'utf8'))
      if (record.schemaVersion !== 1 || record.projectDigest !== projectDigest || !['active', 'reconciliation-required'].includes(record.state) || typeof record.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(record.runId)) throw new Error('invalid')
      return { available: true, required: true, code: 'SPECIALIZED_REPOSITORY_RECONCILIATION_REQUIRED', message: reconcileMessage, record }
    } catch (error) {
      if (error.code === 'ENOENT') return { available: true, required: false }
      return { available: true, required: true, code: 'SPECIALIZED_RECONCILIATION_RECORD_UNAVAILABLE', message: reconcileMessage, record: null }
    }
  }
  async function writeGuard(file, record, exclusive) {
    const handle = await open(file, exclusive ? 'wx' : 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync() } finally { await handle.close() }
  }
  async function startGuard(plan, runId, execution) {
    if (!guardPath) fail('SPECIALIZED_PRIVATE_RECONCILIATION_STORE_REQUIRED')
    await mkdir(reconciliationRoot, { recursive: true })
    if ((await lstat(reconciliationRoot)).isSymbolicLink()) fail('SPECIALIZED_PRIVATE_RECONCILIATION_STORE_REQUIRED')
    const record = { schemaVersion: 1, projectDigest, runId, planDigest: plan.planDigest, domain: plan.domain, operation: plan.operation,
      ownerDigest: hash(execution?.agent?.session?.id ?? 'unscoped'), state: 'active', createdAt: new Date().toISOString() }
    try { await writeGuard(guardPath, record, true) }
    catch (error) { if (error.code === 'EEXIST') fail('SPECIALIZED_REPOSITORY_RECONCILIATION_REQUIRED'); fail('SPECIALIZED_RECONCILIATION_STORE_WRITE_FAILED') }
    return record
  }
  async function finishGuard(owned, result) {
    const current = await guardState()
    if (current.record?.runId !== owned.runId || current.record?.planDigest !== owned.planDigest) {
      result.status = 'failed'; result.reason = 'SPECIALIZED_RECONCILIATION_RECORD_CHANGED'; result.reconciliationRequired = true
      // Missing/tampered state is never permission to repeat a target mutation.
      if (!current.required) await writeGuard(guardPath, { ...owned, state: 'reconciliation-required', reason: result.reason }, true).catch(() => {})
      return
    }
    if (result.status === 'passed' && result.terminationConfirmed === true) {
      await unlink(guardPath); result.reconciliationRequired = false
    } else {
      const temporary = `${guardPath}.${randomUUID()}.tmp`
      await writeGuard(temporary, { ...owned, state: 'reconciliation-required', reason: 'SPECIALIZED_REPOSITORY_RECONCILIATION_REQUIRED', resultStatus: result.status }, true)
      await rename(temporary, guardPath); result.reconciliationRequired = true
    }
  }
  async function driverEvidence(runner, domain) {
    const configFile = await bytes(root, runner.driverConfigPath, 65536)
    let config; try { config = validateDriverConfig(JSON.parse(configFile.data.toString('utf8'))) } catch { fail('SPECIALIZED_DRIVER_CONFIG_INVALID') }
    const target = config[domain]
    if (!target) fail('SPECIALIZED_DRIVER_DOMAIN_UNCONFIGURED')
    const evidence = [publicFile(configFile)], requiredTrustedDigests = []; let environmentSha256
    const reference = async (path, expected, project = false, trustRequired = true) => {
      let file
      if (project) file = await bytes(root, path, 2 * 1024 * 1024)
      else {
        if (!isAbsolute(path)) fail('SPECIALIZED_DRIVER_EXECUTABLE_INVALID')
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256 * 1024 * 1024) fail('SPECIALIZED_DRIVER_EXECUTABLE_INVALID')
        const data = await readFile(path)
        if (data.length > 256 * 1024 * 1024) fail('SPECIALIZED_DRIVER_EXECUTABLE_INVALID')
        file = { path: await realpath(path), sha256: hash(data), bytes: data.length }
      }
      if (file.sha256 !== expected) fail('SPECIALIZED_DRIVER_DEPENDENCY_CHANGED')
      evidence.push(publicFile(file)); if (trustRequired) requiredTrustedDigests.push(file.sha256)
    }
    if (domain === 'repository') {
      if (!runner.fixture) {
        if (target.environmentFile !== '.dev.env') fail('SPECIALIZED_REPO_ENV_BINDING_REQUIRED')
        const environment = await bytes(root, target.environmentFile, 65536)
        evidence.push(publicFile(environment)); environmentSha256 = environment.sha256
      }
      await reference(target.scriptPath, target.scriptSha256, true)
      const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
      const sameMachinePS = trustedPowerShellPath && normalize(trustedPowerShellPath) === normalize(target.powerShellPath)
      await reference(target.powerShellPath, target.powerShellSha256, false, !sameMachinePS)
      for (const file of target.dependencies ?? []) await reference(file.path, file.sha256, true)
    } else if (domain === 'v8unpack') {
      if (inside(root, await realpath(target.pythonPath))) fail('SPECIALIZED_PYTHON_PROJECT_LOCATION_REFUSED')
      await reference(target.pythonPath, target.pythonSha256)
    } else fail('SPECIALIZED_DRIVER_DOMAIN_UNSUPPORTED')
    return { evidence, configSha256: configFile.sha256, environmentSha256, requiredTrustedDigests, trusted: requiredTrustedDigests.every(value => trusted.has(value)) }
  }
  async function load() {
    let file
    try { file = await bytes(root, BINDING, 65536) } catch (error) { if (error.code === 'ENOENT') return { config: {}, evidence: [] }; throw error }
    let c; try { c = JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/u, '')) } catch { fail('SPECIALIZED_BINDING_JSON_INVALID') }
    return { config: validateSpecializedBinding(c), evidence: [publicFile(file)] }
  }
  async function diff() {
    const { config, evidence } = await load(), binding = config.aiMerge
    if (!binding) return { status: 'not-configured', objects: [], execution: 'not-performed' }
    const [current, vendor, baseline] = await Promise.all([tree(root, binding.current), tree(root, binding.vendor), binding.baseline ? tree(root, binding.baseline) : []])
    const [a, b, base] = [current, vendor, baseline].map(group)
    const objects = [...new Set([...a.keys(), ...b.keys(), ...base.keys()])].sort().map(id => ({ id, classification: classifyChange(a.get(id), b.get(id), base.get(id), !!binding.baseline), support: 'not-inspected', mainConfigurationWrite: 'forbidden' }))
    return { status: 'local-comparison', objects, baseline: !!binding.baseline, evidence: [...evidence, ...current, ...vendor, ...baseline], execution: 'not-performed', completeness: 'bounded-top-level-file-groups', supportState: 'not-inspected' }
  }
  async function readReport({ domain = 'repository', kind = 'history', limit = 20 } = {}) {
    if (domain !== 'repository' || !['status', 'history', 'diff'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('SPECIALIZED_REPORT_QUERY_INVALID')
    const { config } = await load(), rel = config.repository?.reports?.[kind]
    if (!rel) return { status: 'not-configured', freshness: 'unknown', records: [], execution: 'not-performed' }
    const file = await bytes(root, rel, 256 * 1024)
    let report; try { report = JSON.parse(file.data.toString('utf8')) } catch { fail('SPECIALIZED_REPORT_JSON_INVALID') }
    if (!Array.isArray(report.records) || report.records.length > 1000) fail('SPECIALIZED_REPORT_SCHEMA_INVALID')
    const records = report.records.slice(0, limit).map(row => {
      keys(row, ['version', 'timestamp', 'objectCount', 'state'])
      if (row.version !== undefined && (!Number.isInteger(row.version) || row.version < 0) || row.timestamp !== undefined && !/^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/u.test(row.timestamp) || row.objectCount !== undefined && (!Number.isInteger(row.objectCount) || row.objectCount < 0) || row.state !== undefined && !['clean', 'changed', 'locked', 'unknown'].includes(row.state)) fail('SPECIALIZED_REPORT_SCHEMA_INVALID')
      return row
    })
    return { status: 'saved-project-report', freshness: 'not-live', records, truncated: report.records.length > limit, evidence: publicFile(file), execution: 'not-performed' }
  }
  async function build(request) {
    keys(request, ['domain', 'operation', 'objects', 'comment', 'force', 'confirmForce', 'confirmDiscardChanges'])
    for (const key of ['force', 'confirmForce', 'confirmDiscardChanges']) if (request[key] !== undefined && typeof request[key] !== 'boolean') fail('SPECIALIZED_BOOLEAN_REQUIRED')
    const { domain, operation } = request
    if (!OPERATIONS[domain]?.includes(operation)) fail('SPECIALIZED_OPERATION_UNSUPPORTED')
    const { config, evidence } = await load(), binding = config[domain === 'ai-merge' ? 'aiMerge' : domain]
    if (!binding) fail('SPECIALIZED_BINDING_REQUIRED')
    const plan = { schemaVersion: 1, domain, operation, effects: [], evidence: [...evidence], execution: 'not-configured', nativeWorkflowRequired: true, reason: 'SPECIALIZED_RUNNER_NOT_REGISTERED', runnerRequest: null }
    if (domain === 'repository') {
      const mutates = ['lock', 'update', 'commit', 'unlock'].includes(operation)
      if (mutates) plan.objects = objectList(request.objects)
      if (operation === 'commit' && (typeof request.comment !== 'string' || !request.comment.trim() || request.comment.length > 1000 || /[\0\r\n]/u.test(request.comment))) fail('SPECIALIZED_COMMIT_COMMENT_REQUIRED')
      if (request.force && (binding.allowForce !== true || request.confirmForce !== true || operation === 'unlock' && request.confirmDiscardChanges !== true)) fail('SPECIALIZED_FORCE_CONFIRMATION_REQUIRED')
      if (request.force && !mutates) fail('SPECIALIZED_FORCE_OPERATION_INVALID')
      plan.effects = mutates ? ['connectsTarget', 'changesRepositoryState', ...(operation === 'update' ? ['changesLocalConfiguration'] : [])] : ['readsSavedReport']
      if (operation === 'dump') plan.effects = ['connectsTarget', 'writesArtifact']
      plan.runnerRequest = { kind: 'repository', operation, explicitObjectList: plan.objects ?? [], force: request.force === true, comment: operation === 'commit' ? request.comment.trim() : null }
      if (operation === 'dump') {
        if (!/\.(?:cf|cfe)$/iu.test(binding.output ?? '')) fail('SPECIALIZED_DUMP_OUTPUT_REQUIRED')
        const output = await checked(root, binding.output, { absent: true })
        try { await lstat(output); fail('SPECIALIZED_OUTPUT_MUST_NOT_EXIST') } catch (error) { if (error.code !== 'ENOENT') throw error }
        plan.runnerRequest.output = binding.output
      }
    } else if (domain === 'ai-merge') {
      const comparison = await diff(); plan.evidence = comparison.evidence; plan.objects = comparison.objects
      plan.effects = ['readsSource']; plan.nativeWorkflowRequired = operation === 'cfe-plan'
      plan.execution = 'local-plan-only'; plan.reason = 'NO_MERGE_APPLY_IMPLEMENTED'
      plan.recommendations = plan.objects.filter(row => row.classification === 'twice-changed').map(row => ({ id: row.id, action: 'review-cfe-borrow-and-method-patch', supportPreflightRequired: true }))
    } else {
      const input = operation === 'unpack' ? [publicFile(await bytes(root, binding.input, 64 * 1024 * 1024))] : await tree(root, binding.input, { artifact: true })
      if (!/\.(?:cf|cfe|epf|erf)$/iu.test(binding.input) && operation === 'unpack') fail('SPECIALIZED_BINARY_ARTIFACT_REQUIRED')
      const output = await checked(root, binding.output, { absent: true })
      if (inside(resolve(root, binding.input), resolve(root, binding.output)) || inside(resolve(root, binding.output), resolve(root, binding.input))) fail('SPECIALIZED_IN_PLACE_REFUSED')
      try { await lstat(output); fail('SPECIALIZED_OUTPUT_MUST_NOT_EXIST') } catch (error) { if (error.code !== 'ENOENT') throw error }
      plan.evidence.push(...input); plan.effects = ['readsArtifact', 'startsProcess', 'writesArtifact']
      plan.runnerRequest = { kind: 'v8unpack', operation, input: binding.input, output: binding.output }
    }
    if (binding.runner) {
      const runner = validateRunner(binding.runner, domain), file = await bytes(root, runner.path, 2 * 1024 * 1024)
      if (file.sha256 !== runner.sha256) fail('SPECIALIZED_RUNNER_DIGEST_MISMATCH')
      plan.evidence.push(publicFile(file)); plan.runner = structuredClone(runner)
      if (runner.operations.includes(operation)) {
        plan.execution = !trusted.has(file.sha256) ? 'needs-runner-review' : typeof executeProcess !== 'function' ? 'native-executor-unavailable' : 'configured'
        plan.reason = plan.execution === 'configured' ? null : plan.execution === 'needs-runner-review' ? 'SPECIALIZED_RUNNER_REVIEW_REQUIRED' : 'SPECIALIZED_NATIVE_PROCESS_REQUIRED'
        plan.approvalRequired = runner.writeOperations.includes(operation)
        plan.fixture = runner.fixture
        if (domain === 'repository' && ['status', 'history', 'diff'].includes(operation)) plan.effects = ['readsTarget', 'connectsTarget', 'startsProcess', 'writesArtifact']
        if (runner.driverConfigPath) {
          const driver = await driverEvidence(runner, domain)
          plan.evidence.push(...driver.evidence); plan.driverEvidence = driver.evidence
          plan.requiredTrustedDigests = [...new Set([runner.sha256, ...driver.requiredTrustedDigests])]
          plan.runnerRequest.driverConfigSha256 = driver.configSha256
          if (driver.environmentSha256) plan.runnerRequest.environmentSha256 = driver.environmentSha256
          if (!driver.trusted) { plan.execution = 'needs-driver-review'; plan.reason = 'SPECIALIZED_DRIVER_REVIEW_REQUIRED' }
        }
      }
    }
    if (plan.domain === 'repository' && plan.approvalRequired) {
      const guard = await guardState()
      if (guard.required) { plan.execution = 'blocked-reconciliation'; plan.reason = guard.code; plan.message = reconcileMessage }
      else if (!plan.fixture && !guard.available) { plan.execution = 'blocked-reconciliation'; plan.reason = 'SPECIALIZED_PRIVATE_RECONCILIATION_STORE_REQUIRED'; plan.message = reconcileMessage }
    }
    return { ...plan, planDigest: digest(plan), actualProcesses: 0, actualTargetWrites: 0 }
  }
  return {
    async status() {
      const { config } = await load(), domains = []
      for (const [domain, binding] of Object.entries({ repository: config.repository, 'ai-merge': config.aiMerge, v8unpack: config.v8unpack })) {
        const row = { domain, configured: !!binding, operations: OPERATIONS[domain], runnerOperations: binding?.runner?.operations ?? [], runnerKind: binding?.runner?.kind ?? null, runnerSha256: binding?.runner?.sha256 ?? null, driverConfigPath: binding?.runner?.driverConfigPath ?? null, execution: domain === 'ai-merge' && binding ? 'local-plan-only' : 'not-configured', fixture: binding?.runner?.fixture ?? null, reason: binding ? 'SPECIALIZED_RUNNER_NOT_REGISTERED' : 'SPECIALIZED_BINDING_REQUIRED' }
        if (binding?.runner) {
          try {
            const file = await bytes(root, binding.runner.path, 2 * 1024 * 1024)
            if (file.sha256 !== binding.runner.sha256) fail('SPECIALIZED_RUNNER_DIGEST_MISMATCH')
            row.requiredTrustedDigests = [file.sha256]
            row.execution = !trusted.has(file.sha256) ? 'needs-runner-review' : typeof executeProcess !== 'function' ? 'native-executor-unavailable' : 'configured'
            row.reason = row.execution === 'configured' ? null : row.execution === 'needs-runner-review' ? 'SPECIALIZED_RUNNER_REVIEW_REQUIRED' : 'SPECIALIZED_NATIVE_PROCESS_REQUIRED'
            if (binding.runner.driverConfigPath) {
              const driver = await driverEvidence(binding.runner, domain)
              row.requiredTrustedDigests.push(...driver.requiredTrustedDigests)
              if (!driver.trusted) { row.execution = 'needs-driver-review'; row.reason = 'SPECIALIZED_DRIVER_REVIEW_REQUIRED' }
            }
          } catch (error) { row.execution = 'unavailable'; row.reason = /^[A-Z0-9_]+$/u.test(error.code ?? error.message ?? '') ? error.code ?? error.message : 'SPECIALIZED_RUNNER_INSPECTION_FAILED' }
        }
        domains.push(row)
      }
      const guard = await guardState()
      const reconciliation = { available: guard.available, required: guard.required, ...(guard.required ? { code: guard.code, message: guard.message, runId: guard.record?.runId ?? null } : {}) }
      return { schemaVersion: 1, domains, reconciliation, activeRuns: [...runs.values()].filter(row => row.status === 'running').map(row => ({ runId: row.runId, domain: row.domain, operation: row.operation })), mcpRequired: false }
    },
    history: options => readReport({ ...options, kind: 'history' }), readReport,
    diff: async ({ domain = 'ai-merge' } = {}) => domain === 'repository' ? readReport({ domain, kind: 'diff' }) : domain === 'ai-merge' ? diff() : fail('SPECIALIZED_DIFF_UNSUPPORTED'),
    async plan(request) {
      if (busy) fail('SPECIALIZED_PLAN_BUSY'); busy = true
      try {
        if (plans.size >= 100) fail('SPECIALIZED_PLAN_CAPACITY')
        const plan = await build(request); plans.set(plan.planDigest, structuredClone(request))
        if (evidenceRoot) { const file = join(evidenceRoot, `${plan.planDigest}.json`); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error }) }
        return plan
      } finally { busy = false }
    },
    async validatePlan({ planDigest }) { if (!plans.has(planDigest)) fail('SPECIALIZED_PLAN_UNKNOWN'); const current = await build(plans.get(planDigest)); if (current.planDigest !== planDigest) fail('SPECIALIZED_PLAN_STALE'); return { valid: true, planDigest, execution: current.execution } },
    async run({ planDigest, requestId }, execution) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(requestId ?? '')) fail('SPECIALIZED_REQUEST_ID_INVALID')
      if (!plans.has(planDigest)) fail('SPECIALIZED_PLAN_UNKNOWN')
      if (requests.has(requestId)) { const previous = runs.get(requests.get(requestId)); if (previous.planDigest !== planDigest) fail('SPECIALIZED_REQUEST_ID_CONFLICT'); return structuredClone(previous) }
      if (runs.size >= 100) fail('SPECIALIZED_RUN_CAPACITY')
      if (PROJECT_LOCKS.has(lockKey)) fail('SPECIALIZED_PROJECT_BUSY')
      const plan = await build(plans.get(planDigest))
      const guard = await guardState()
      if (plan.domain === 'repository' && plan.approvalRequired && guard.required) fail(guard.code)
      if (plan.planDigest !== planDigest) fail('SPECIALIZED_PLAN_STALE')
      if (plan.execution !== 'configured') fail(plan.reason ?? 'SPECIALIZED_RUNNER_NOT_REGISTERED')
      if (typeof authorize !== 'function' || await authorize({ plan, execution }) !== true) fail('SPECIALIZED_NATIVE_PERMISSION_REQUIRED')
      if ((await build(plans.get(planDigest))).planDigest !== planDigest) fail('SPECIALIZED_PLAN_STALE')
      if (PROJECT_LOCKS.has(lockKey)) fail('SPECIALIZED_PROJECT_BUSY')
      const runId = randomUUID(), controller = new AbortController(), relay = () => controller.abort()
      const durableGuard = plan.domain === 'repository' && !plan.fixture && plan.approvalRequired ? await startGuard(plan, runId, execution) : null
      const result = { schemaVersion: 1, runId, requestId, planDigest, domain: plan.domain, operation: plan.operation, fixture: plan.fixture, status: 'running', terminationConfirmed: true, projectCertified: false }
      PROJECT_LOCKS.set(lockKey, runId); requests.set(requestId, runId); runs.set(runId, result)
      activeControllers.set(runId, controller)
      execution?.signal?.addEventListener('abort', relay, { once: true }); if (execution?.signal?.aborted) relay()
      const rel = `.dsh/onec-specialized-runs/${runId}`, requestRel = `${rel}/request.json`, resultRel = `${rel}/result.json`
      try {
        const folder = await checked(root, rel, { absent: true }); await mkdir(folder, { recursive: true })
        const request = { schemaVersion: 1, runId, planDigest, domain: plan.domain, operation: plan.operation, fixture: plan.fixture, parameters: plan.runnerRequest, objects: plan.objects ?? [], sourceEvidenceDigest: digest(plan.evidence) }
        const requestDigest = digest(request); request.requestDigest = requestDigest
        await writeFile(await checked(root, requestRel, { absent: true }), JSON.stringify(request) + '\n', { flag: 'wx' })
        result.terminationConfirmed = false
        const process = await executeProcess({ projectRoot: root, runner: plan.runner, fingerprintPaths: (plan.driverEvidence ?? []).map(file => isAbsolute(file.path) ? file.path : resolve(root, file.path)), requestPath: resolve(root, requestRel), resultPath: resolve(root, resultRel), runId, signal: controller.signal, timeoutMs: plan.runner.timeoutMs ?? 60000, execution })
        result.process = process; result.terminationConfirmed = process?.terminationConfirmed === true
        if (/^BRIDGE_[A-Z0-9_]+$/u.test(process?.bridgeError ?? '')) result.reason = process.bridgeError
        result.status = process?.aborted ? 'cancelled' : process?.timedOut ? 'timed-out' : 'failed'
        if (process?.exitCode === 0 && !process.aborted && !process.timedOut && !process.outputLimitExceeded && !process.startError && result.terminationConfirmed) {
          const reportFile = await bytes(root, resultRel, 128 * 1024)
          let report; try { report = JSON.parse(reportFile.data.toString('utf8')) } catch { fail('SPECIALIZED_REPORT_JSON_INVALID') }
          keys(report, ['schemaVersion', 'runId', 'planDigest', 'requestDigest', 'domain', 'operation', 'fixture', 'complete', 'assertions'])
          if (report.schemaVersion !== 1 || report.runId !== runId || report.planDigest !== planDigest || report.requestDigest !== requestDigest || report.domain !== plan.domain || report.operation !== plan.operation || report.fixture !== plan.fixture || report.complete !== true || !Array.isArray(report.assertions) || !report.assertions.length || report.assertions.length > 100 || report.assertions.some(row => !plain(row) || Object.keys(row).some(k => !['id', 'passed'].includes(k)) || !/^[A-Za-z0-9_.-]{1,80}$/u.test(row.id ?? '') || row.passed !== true)) fail('SPECIALIZED_REPORT_BINDING_INVALID')
          if (plan.domain === 'v8unpack') {
            result.artifacts = plan.operation === 'rebuild' ? [publicFile(await bytes(root, plan.runnerRequest.output, 64 * 1024 * 1024))] : await tree(root, plan.runnerRequest.output, { artifact: true })
            if (!result.artifacts.length) fail('SPECIALIZED_OUTPUT_EMPTY')
          }
          if (plan.domain === 'repository' && plan.operation === 'dump') result.artifacts = [publicFile(await bytes(root, plan.runnerRequest.output, 64 * 1024 * 1024))]
          result.status = 'passed'; result.report = publicFile(reportFile); result.assertions = report.assertions
        }
      } catch (error) { result.status = 'failed'; result.reason = /^[A-Z0-9_]+$/u.test(error.code ?? error.message ?? '') ? error.code ?? error.message : 'SPECIALIZED_EXECUTION_FAILED' }
      finally {
        execution?.signal?.removeEventListener('abort', relay)
        activeControllers.delete(runId)
        if (durableGuard) {
          try { await finishGuard(durableGuard, result) }
          catch { result.status = 'failed'; result.reconciliationRequired = true; result.reason = 'SPECIALIZED_RECONCILIATION_STORE_WRITE_FAILED' }
        }
        if (result.terminationConfirmed && PROJECT_LOCKS.get(lockKey) === runId) PROJECT_LOCKS.delete(lockKey)
        result.lockRetained = PROJECT_LOCKS.get(lockKey) === runId || result.reconciliationRequired === true
      }
      return structuredClone(result)
    },
    async result({ runId }) { if (!runs.has(runId)) fail('SPECIALIZED_RUN_UNKNOWN'); return structuredClone(runs.get(runId)) },
    async cancel({ runId }) { const run = runs.get(runId); if (!run) fail('SPECIALIZED_RUN_UNKNOWN'); if (run.status !== 'running') return { runId, cancelRequested: false, terminationConfirmed: run.terminationConfirmed }; const active = activeControllers.get(runId); active?.abort(); return { runId, cancelRequested: true, terminationConfirmed: false } },
  }
}
