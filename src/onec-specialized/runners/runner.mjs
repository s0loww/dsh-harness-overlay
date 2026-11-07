import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DRIVER_CONFIG_PATH = '.dsh/onec-specialized-driver.json'
const sha = data => createHash('sha256').update(data).digest('hex')
const fail = code => { throw new Error(code) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('BRIDGE_CONFIG_FIELDS_INVALID') }
const digest = x => sha(JSON.stringify(x, (_key, row) => plain(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row))
const SHA = /^[a-f0-9]{64}$/u
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const relativePath = path => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/u.test(path) || /[\0\r\n]/u.test(path) || path.split(/[\\/]/u).some(part => !part || part === '..' || part === '.' || /^\.env(?:\.|$)/iu.test(part))) fail('BRIDGE_PROJECT_PATH_INVALID')
  return path
}
export function validateDriverConfig(config) {
  keys(config, ['schemaVersion', 'repository', 'v8unpack'])
  if (config.schemaVersion !== 1) fail('BRIDGE_CONFIG_VERSION_INVALID')
  if (config.repository) {
    const r = config.repository
    keys(r, ['format', 'scriptPath', 'scriptSha256', 'powerShellPath', 'powerShellSha256', 'dependencies', 'environmentFile'])
    if (r.environmentFile !== undefined && r.environmentFile !== '.dev.env') fail('BRIDGE_REPOSITORY_ENV_BINDING_INVALID')
    if (r.format !== 'repo-ops-v1.1-text' || !/\.ps1$/iu.test(relativePath(r.scriptPath)) || !SHA.test(r.scriptSha256 ?? '') || !isAbsolute(r.powerShellPath ?? '') || !SHA.test(r.powerShellSha256 ?? '')) fail('BRIDGE_REPOSITORY_CONFIG_INVALID')
    if (r.dependencies !== undefined && (!Array.isArray(r.dependencies) || r.dependencies.length > 64)) fail('BRIDGE_DEPENDENCIES_INVALID')
    for (const row of r.dependencies ?? []) { keys(row, ['path', 'sha256']); relativePath(row.path); if (!SHA.test(row.sha256 ?? '')) fail('BRIDGE_DEPENDENCIES_INVALID') }
  }
  if (config.v8unpack) {
    const r = config.v8unpack
    keys(r, ['format', 'pythonPath', 'pythonSha256', 'version'])
    if (r.format !== 'v8unpack-cli' || !isAbsolute(r.pythonPath ?? '') || !SHA.test(r.pythonSha256 ?? '') || !/^1\.\d+\.\d+$/u.test(r.version ?? '')) fail('BRIDGE_V8UNPACK_CONFIG_INVALID')
  }
  return structuredClone(config)
}
async function safeFile(path, max = 256 * 1024 * 1024) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) fail('BRIDGE_FILE_REFUSED')
  const bytes = await readFile(path)
  if (bytes.length > max) fail('BRIDGE_FILE_REFUSED')
  return bytes
}
async function projectPath(root, rel, absent = false) {
  relativePath(rel); let at = root
  for (const part of rel.split(/[\\/]/u)) {
    at = join(at, part)
    try { if ((await lstat(at)).isSymbolicLink()) fail('BRIDGE_PROJECT_LINK_REFUSED') }
    catch (error) { if (error.code === 'ENOENT' && absent) return resolve(root, rel); throw error }
  }
  return at
}
export function scrubDriverEnvironment(parent = process.env) {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL']) if (typeof parent[name] === 'string') env[name] = parent[name]
  return env
}
export function decodePlatformText(bytes) {
  if (bytes.length > 1024 * 1024) fail('BRIDGE_TEXT_LIMIT')
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
/** Known repo-ops v1.1 transport verdict; never invent per-object/revision facts. */
export function verifyRepoOpsText({ operation, stdout, stderr, reportBytes }) {
  const out = decodePlatformText(stdout), err = decodePlatformText(stderr)
  if (/\[error\]|\bError:|completed unsuccessfully|failed \(code|захвачен.*другим пользователем|Locked by other|Ошибка/iu.test(`${out}\n${err}`)) fail('BRIDGE_REPO_ERROR_OR_CONFLICT')
  if (!out.split(/\r?\n/u).some(line => line.trim() === `Repository operation '${operation}' completed successfully`)) fail('BRIDGE_REPO_VERDICT_UNKNOWN')
  if (['status', 'history', 'diff'].includes(operation)) {
    if (!(reportBytes instanceof Uint8Array) || !reportBytes.length || !decodePlatformText(reportBytes).trim()) fail('BRIDGE_REPO_REPORT_MISSING')
  }
  return [{ id: 'repo-ops.known-text-verdict', passed: true }, { id: 'repo-ops.no-observed-error-or-conflict', passed: true },
    ...(['status', 'history', 'diff'].includes(operation) ? [{ id: 'repo-ops.fresh-bounded-report', passed: true }] : [])]
}
async function runChild({ command, args, cwd, env, timeoutMs = 300000 }) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []; let total = 0, exceeded = false, timedOut = false
    for (const [stream, list] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => { total += chunk.length; if (total > 1024 * 1024) { exceeded = true; child.kill(); return }; list.push(Buffer.from(chunk)) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); if (exceeded || timedOut) reject(new Error(exceeded ? 'BRIDGE_OUTPUT_LIMIT' : 'BRIDGE_TIMEOUT')); else done({ exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }) })
  })
}
/** The injected processRunner is a test seam; the CLI always uses real spawn. */
export async function executeBridge({ requestPath, resultPath, root = process.cwd(), processRunner = runChild }) {
  root = await realpath(root)
  if (!inside(root, resolve(requestPath)) || !inside(root, resolve(resultPath)) || dirname(resolve(requestPath)) !== dirname(resolve(resultPath))) fail('BRIDGE_JOB_PATH_INVALID')
  await projectPath(root, relative(root, resolve(requestPath)))
  await projectPath(root, relative(root, resolve(resultPath)), true)
  const jobRoot = dirname(resolve(requestPath)), request = JSON.parse((await safeFile(requestPath, 128 * 1024)).toString('utf8'))
  const { requestDigest, ...requestContent } = request
  if (request.schemaVersion !== 1 || requestDigest !== digest(requestContent) || !SHA.test(request.planDigest ?? '') || !/^[a-f0-9-]{36}$/u.test(request.runId ?? '') || typeof request.fixture !== 'boolean' || !plain(request.parameters)) fail('BRIDGE_REQUEST_INVALID')
  if (relative(root, jobRoot).replaceAll('\\', '/') !== `.dsh/onec-specialized-runs/${request.runId}`) fail('BRIDGE_JOB_PATH_INVALID')
  const configBytes = await safeFile(await projectPath(root, DRIVER_CONFIG_PATH), 65536)
  if (sha(configBytes) !== request.parameters.driverConfigSha256) fail('BRIDGE_CONFIG_CHANGED')
  const config = validateDriverConfig(JSON.parse(configBytes.toString('utf8')))
  const env = scrubDriverEnvironment(), assertions = []
  if (request.domain === 'repository') {
    const r = config.repository, p = request.parameters
    if (!r || !['status', 'history', 'diff', 'lock', 'update', 'commit', 'unlock', 'dump'].includes(request.operation)) fail('BRIDGE_REPOSITORY_OPERATION_INVALID')
    const script = await projectPath(root, r.scriptPath)
    if (!request.fixture) {
      if (r.environmentFile !== '.dev.env' || !SHA.test(p.environmentSha256 ?? '') || sha(await safeFile(await projectPath(root, r.environmentFile), 65536)) !== p.environmentSha256) fail('BRIDGE_REPOSITORY_ENV_BINDING_CHANGED')
    }
    for (const [path, expected] of [[script, r.scriptSha256], [r.powerShellPath, r.powerShellSha256], ...(r.dependencies ?? []).map(row => [resolve(root, row.path), row.sha256])]) if (sha(await safeFile(path)) !== expected) fail('BRIDGE_DEPENDENCY_CHANGED')
    if (!Array.isArray(p.explicitObjectList) || p.explicitObjectList.some(value => typeof value !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?$/u.test(value))) fail('BRIDGE_OBJECT_SCOPE_INVALID')
    if (['lock', 'update', 'commit', 'unlock'].includes(request.operation) && !p.explicitObjectList.length) fail('BRIDGE_OBJECT_SCOPE_INVALID')
    // Keep the transient report under the actual native workspace fence.
    // The host's unrelated OS-temp ACL may not admit the confined token.
    const temporary = await mkdtemp(join(jobRoot, 'repository-private-'))
    try {
      const rawReport = join(temporary, 'repository-report.txt')
      const args = ['-NoProfile', '-NonInteractive', '-File', script, '-Operation', request.operation, '-TimeoutSeconds', '240', '-MaxReportChars', '2000']
      if (p.explicitObjectList.length) args.push('-Objects', p.explicitObjectList.join(','))
      if (request.operation === 'commit') { if (typeof p.comment !== 'string' || !p.comment.trim() || /[\0\r\n]/u.test(p.comment)) fail('BRIDGE_COMMIT_COMMENT_REQUIRED'); args.push('-Comment', p.comment) }
      if (p.force === true) { args.push('-Force'); args.push(request.operation === 'unlock' ? '-ConfirmDiscardChanges' : '-ConfirmForce') }
      if (['status', 'history', 'diff'].includes(request.operation)) args.push('-ReportFile', rawReport)
      if (request.operation === 'dump') { const output = await projectPath(root, p.output, true); try { await lstat(output); fail('BRIDGE_OUTPUT_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }; args.push('-OutputFile', output) }
      const result = await processRunner({ command: r.powerShellPath, args, cwd: root, env })
      if (result.exitCode !== 0) fail(result.exitCode === 3221225794 || result.exitCode === -1073741502 ? 'BRIDGE_POWERSHELL_INITIALIZATION_FAILED' : 'BRIDGE_REPOSITORY_PROCESS_FAILED')
      const reportBytes = ['status', 'history', 'diff'].includes(request.operation) ? await safeFile(rawReport, 1024 * 1024) : undefined
      assertions.push(...verifyRepoOpsText({ operation: request.operation, stdout: result.stdout, stderr: result.stderr, reportBytes }))
      // Raw stdout/stderr/report may contain secrets. Persist only bounded facts,
      // never a raw report or a cosmetic regex-masked copy.
      await writeFile(join(jobRoot, 'repository-report-summary.json'), JSON.stringify({ format: r.format, reportBytes: reportBytes?.length ?? 0, reportSha256: reportBytes ? sha(reportBytes) : null, liveRevision: 'not-parsed', perObjectResult: 'not-parsed' }) + '\n', { flag: 'wx' })
    } finally { await rm(temporary, { recursive: true, force: true }) }
  } else if (request.domain === 'v8unpack') {
    const r = config.v8unpack, p = request.parameters
    if (!r || !['unpack', 'rebuild'].includes(request.operation) || sha(await safeFile(r.pythonPath)) !== r.pythonSha256) fail('BRIDGE_PYTHON_CHANGED_OR_UNCONFIGURED')
    if (inside(root, await realpath(r.pythonPath))) fail('BRIDGE_PYTHON_PROJECT_LOCATION_REFUSED')
    const input = await projectPath(root, p.input), output = await projectPath(root, p.output, true)
    if (inside(input, output) || inside(output, input)) fail('BRIDGE_IN_PLACE_REFUSED')
    try { await lstat(output); fail('BRIDGE_OUTPUT_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const cwd = join(jobRoot, 'python-isolated-workspace'); await mkdir(cwd)
    const metadata = await processRunner({ command: r.pythonPath, args: ['-I', '-c', "import json,sys,importlib.util; from importlib.metadata import version; s=importlib.util.find_spec('v8unpack'); print(json.dumps({'version':version('v8unpack'),'origin':None if s is None else s.origin,'paths':sys.path}))"], cwd, env })
    let observed; try { observed = JSON.parse(decodePlatformText(metadata.stdout)) } catch { fail('BRIDGE_V8UNPACK_VERSION_UNVERIFIED') }
    if (metadata.exitCode !== 0 || observed.version !== r.version || !isAbsolute(observed.origin ?? '') || inside(root, await realpath(observed.origin)) || !Array.isArray(observed.paths) || observed.paths.some(path => !isAbsolute(path) || inside(root, resolve(path)))) fail('BRIDGE_V8UNPACK_VERSION_UNVERIFIED')
    const args = ['-I', '-m', 'v8unpack', request.operation === 'unpack' ? '-E' : '-B', input, output, '--processes', '1']
    if (request.operation === 'unpack') args.push('--temp', join(cwd, 'intermediate'))
    const result = await processRunner({ command: r.pythonPath, args, cwd, env })
    if (result.exitCode !== 0 || !await lstat(output).then(() => true, () => false)) fail('BRIDGE_V8UNPACK_OUTPUT_UNVERIFIED')
    assertions.push({ id: 'v8unpack.exact-isolated-installed-version', passed: true }, { id: 'v8unpack.command-completed-output-present', passed: true })
  } else fail('BRIDGE_DOMAIN_UNSUPPORTED')
  await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, runId: request.runId, planDigest: request.planDigest, requestDigest, domain: request.domain, operation: request.operation, fixture: request.fixture, complete: true, assertions }) + '\n', { flag: 'wx' })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--result') throw new Error('BRIDGE_FIXED_ARGUMENTS_REQUIRED')
  executeBridge({ requestPath: args[1], resultPath: args[3] }).catch(error => {
    const syscall = String(error.syscall ?? '').split(' ')[0]
    const operation = /^(?:open|stat|lstat|spawn|unlink|rmdir|mkdir|read|chmod|realpath|scandir)$/u.test(syscall) ? `${syscall.toUpperCase()}_` : ''
    process.stderr.write(`${/^BRIDGE_[A-Z0-9_]+$/u.test(error.message ?? '') ? error.message : /^[A-Z][A-Z0-9_]+$/u.test(error.code ?? '') ? `BRIDGE_HOST_${operation}${error.code}` : 'SPECIALIZED_BRIDGE_FAILED'}\n`)
    process.exitCode = 1
  })
}
