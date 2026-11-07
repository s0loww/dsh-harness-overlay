import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyReceiptIntegrity } from '../installer/receipt.mjs'
import { DEFAULT_RELEASE_LOCK, verifyOfficialDesktop } from '../src/targets/official-desktop/target.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CANDIDATES_ROOT = join(REPO_ROOT, 'var', 'candidate')
const DEFAULT_CANDIDATE = join(CANDIDATES_ROOT, 'official-desktop-rc5-02')
const DEFAULT_UI_ARTIFACT = join(REPO_ROOT, 'dist', 'airules-ui-overlay-0.1.0-dev4')
const DEFAULT_POLICY_ARTIFACT = join(REPO_ROOT, 'dist', 'airules-official-policy-0.12.0-dev7')
const LIVE_REFERENCES = [
  'c:/users/s0lo/.dsh',
  'c:/users/s0lo/appdata/local/programs/deepseek harness',
]

export class CandidateSmokeError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

const normalize = value => String(value).replaceAll('\\', '/').toLowerCase()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function readJson(path, code) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new CandidateSmokeError(code, `${path}: ${error.message}`) }
}

function beneath(root, rel, label) {
  if (typeof rel !== 'string' || rel === '' || resolve(rel) === rel) throw new CandidateSmokeError('UNSAFE_RELATIVE_PATH', label)
  const result = resolve(root, rel)
  const child = relative(root, result)
  if (child === '..' || child.startsWith(`..${sep}`) || resolve(child) === child) throw new CandidateSmokeError('PATH_ESCAPE', label)
  return result
}

export function assertCandidatePath(candidateRoot) {
  const root = resolve(String(candidateRoot ?? DEFAULT_CANDIDATE))
  if (dirname(root).toLowerCase() !== CANDIDATES_ROOT.toLowerCase() || root.toLowerCase() === CANDIDATES_ROOT.toLowerCase()) {
    throw new CandidateSmokeError('CANDIDATE_PATH_FORBIDDEN')
  }
  return root
}

async function assertDirectoryNotLink(path, code) {
  let info
  try { info = await lstat(path) }
  catch { throw new CandidateSmokeError(code, path) }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CandidateSmokeError(code, path)
  if (resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new CandidateSmokeError(code, path)
}

function descriptor(kind, manifest) {
  if (kind === 'ui') return {
    artifact: manifest.artifact,
    hostVersion: manifest.target?.hostVersion,
    packages: manifest.packages?.map(item => item.name),
    fragment: manifest.cordisFragment,
  }
  const packages = manifest.operations?.filter(item => item.kind === 'package-copy').map(item => {
    const marker = 'node_modules/'
    if (!item.target?.startsWith(marker)) throw new CandidateSmokeError('POLICY_PACKAGE_TARGET_INVALID', item.target)
    return item.target.slice(marker.length)
  })
  return {
    artifact: manifest.artifact,
    hostVersion: manifest.target?.hostVersion,
    packages,
    fragment: manifest.operations?.find(item => item.kind === 'cordis-merge')?.source,
  }
}

function cordisIds(text) {
  const result = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*-\s+id:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/u.exec(line)
    if (match) result.push(match[1])
  }
  return result
}

export function assertCordisIds(cordis, fragments) {
  const expected = fragments.flatMap(cordisIds)
  if (!expected.length || new Set(expected).size !== expected.length) throw new CandidateSmokeError('CORDIS_FRAGMENT_IDS_INVALID')
  const current = cordisIds(cordis)
  for (const id of expected) {
    const count = current.filter(value => value === id).length
    if (count !== 1) throw new CandidateSmokeError('CORDIS_ID_COUNT_INVALID', `${id}=${count}`)
  }
  return expected
}

export function assertNoLiveReferences(entries) {
  for (const [label, text] of entries) {
    const normalized = normalize(text)
    for (const marker of LIVE_REFERENCES) if (normalized.includes(marker)) throw new CandidateSmokeError('LIVE_REFERENCE_DETECTED', label)
  }
}

export async function validatePackage(profileRoot, name) {
  const root = beneath(join(profileRoot, 'node_modules'), name, `package ${name}`)
  await assertDirectoryNotLink(root, 'PACKAGE_ROOT_INVALID')
  const packageJsonPath = join(root, 'package.json')
  let pkg, identity = 'package.json'
  try {
    if (!(await lstat(packageJsonPath)).isFile()) throw new CandidateSmokeError('PACKAGE_JSON_INVALID', name)
    pkg = await readJson(packageJsonPath, 'PACKAGE_JSON_INVALID')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (name !== 'airules-dsh-rulepack') throw new CandidateSmokeError('PACKAGE_JSON_INVALID', name)
    const manifest = await readJson(join(root, 'manifest.json'), 'RULEPACK_MANIFEST_INVALID')
    pkg = { name: manifest.package?.id, version: manifest.package?.version, dependencies: {} }
    identity = 'manifest.json#package'
  }
  if (pkg.name !== name || typeof pkg.version !== 'string' || pkg.version === '') throw new CandidateSmokeError('PACKAGE_IDENTITY_MISMATCH', name)
  if (typeof pkg.main === 'string') {
    const main = beneath(root, pkg.main, `${name} main`)
    try { if (!(await lstat(main)).isFile()) throw new Error('not a file') }
    catch { throw new CandidateSmokeError('PACKAGE_MAIN_MISSING', `${name}:${pkg.main}`) }
  }
  const clientExport = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : pkg.exports?.['./client']?.default
  if (typeof clientExport === 'string') {
    const client = beneath(root, clientExport, `${name} client export`)
    try { if (!(await lstat(client)).isFile()) throw new Error('not a file') }
    catch { throw new CandidateSmokeError('PACKAGE_CLIENT_EXPORT_MISSING', `${name}:${clientExport}`) }
  }
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const candidates = [
      beneath(join(root, 'node_modules'), dependency, `${name} nested dependency ${dependency}`),
      beneath(join(profileRoot, 'node_modules'), dependency, `${name} profile dependency ${dependency}`),
    ]
    let dependencyRoot
    for (const candidate of candidates) {
      try {
        const info = await lstat(candidate)
        if (info.isDirectory() && !info.isSymbolicLink()) { dependencyRoot = candidate; break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!dependencyRoot) throw new CandidateSmokeError('PACKAGE_DEPENDENCY_MISSING', `${name}:${dependency}`)
    await assertDirectoryNotLink(dependencyRoot, 'PACKAGE_DEPENDENCY_INVALID')
    const dependencyPackage = await readJson(join(dependencyRoot, 'package.json'), 'PACKAGE_DEPENDENCY_INVALID')
    if (dependencyPackage.name !== dependency) throw new CandidateSmokeError('PACKAGE_DEPENDENCY_IDENTITY_MISMATCH', `${name}:${dependency}`)
  }
  if (name === 'dsh-openspec-workflow') {
    await validatePrivateClosure(root, { '@fission-ai/openspec': '1.12.0', '@j1nn0/agent-handoff': '0.1.1', '@j1nn0/agent-progress': '0.1.1' })
  }
  if (name === 'airules-dsh-acp') await validatePrivateClosure(root, { '@agentclientprotocol/sdk': '1.5.1' })
  if (name === '@zaimokuza/dsh-acp-adapter') await validatePrivateClosure(root, {
    '@agentclientprotocol/sdk': '1.5.1', '@modelcontextprotocol/client': '2.3.0',
    '@modelcontextprotocol/node': '2.1.1', '@modelcontextprotocol/server': '2.3.0', yaml: '2.9.0', zod: '4.4.3',
  })
  if (name === 'airules-dsh-subscriptions') await validatePrivateClosure(root, { undici: '7.29.1' })
  if (name === 'airules-dsh-mobile-access') await validatePrivateClosure(root, { 'dsh-relay': '0.2.1' })
  return { name, version: pkg.version, identity, clientExport: clientExport ?? null }
}

export async function validatePrivateClosure(packageRoot, roots) {
  const root = resolve(packageRoot), visited = new Set()
  async function locate(from, name) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new CandidateSmokeError('PRIVATE_DEPENDENCY_NAME_INVALID')
    for (let current = from; ; current = dirname(current)) {
      const candidate = beneath(join(current, 'node_modules'), name, 'private dependency')
      try { await lstat(candidate); await assertDirectoryNotLink(candidate, 'PRIVATE_DEPENDENCY_INVALID'); return candidate }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (current === root) break
    }
    throw new CandidateSmokeError('PRIVATE_DEPENDENCY_MISSING', name)
  }
  async function visit(directory, expectedName, expectedVersion) {
    const pkg = await readJson(join(directory, 'package.json'), 'PRIVATE_DEPENDENCY_INVALID')
    if (pkg.name !== expectedName || (expectedVersion && pkg.version !== expectedVersion)) throw new CandidateSmokeError('PRIVATE_DEPENDENCY_IDENTITY_MISMATCH', expectedName)
    if (visited.has(directory)) return
    visited.add(directory)
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      await visit(await locate(directory, dependency), dependency)
    }
  }
  for (const [name, version] of Object.entries(roots)) await visit(await locate(root, name), name, version)
  return visited.size
}

async function loadLayer({ kind, candidateRoot, markerName, artifactRoot, artifactManifestName, receiptManifestName = artifactManifestName }) {
  const marker = await readJson(join(candidateRoot, markerName), `${kind.toUpperCase()}_READY_MISSING`)
  if (marker.schemaVersion !== 1 || marker.status !== `${kind}-ready` || !marker.artifact || typeof marker.receipt !== 'string') {
    throw new CandidateSmokeError(`${kind.toUpperCase()}_READY_INVALID`)
  }
  const receiptPath = beneath(candidateRoot, marker.receipt, `${kind} receipt`)
  const receipt = await readJson(receiptPath, `${kind.toUpperCase()}_RECEIPT_INVALID`)
  if (!verifyReceiptIntegrity(receipt) || receipt.status !== 'applied') throw new CandidateSmokeError(`${kind.toUpperCase()}_RECEIPT_INTEGRITY`)
  const manifestPath = join(resolve(artifactRoot), artifactManifestName)
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/u, ''))
  const receiptManifestBytes = await readFile(join(resolve(artifactRoot), receiptManifestName))
  const info = descriptor(kind, manifest)
  if (marker.artifact.id !== info.artifact?.id || marker.artifact.version !== info.artifact?.version) throw new CandidateSmokeError(`${kind.toUpperCase()}_ARTIFACT_MISMATCH`)
  if (receipt.artifact?.id !== info.artifact.id || receipt.artifact?.version !== info.artifact.version || receipt.artifactManifestSha256 !== sha256(receiptManifestBytes)) {
    throw new CandidateSmokeError(`${kind.toUpperCase()}_RECEIPT_ARTIFACT_MISMATCH`)
  }
  if (!Array.isArray(info.packages) || !info.packages.length || new Set(info.packages).size !== info.packages.length) throw new CandidateSmokeError(`${kind.toUpperCase()}_PACKAGE_ALLOWLIST_INVALID`)
  if (JSON.stringify([...receipt.packageNames].sort()) !== JSON.stringify([...info.packages].sort())) throw new CandidateSmokeError(`${kind.toUpperCase()}_PACKAGE_ALLOWLIST_MISMATCH`)
  return { marker, receipt, info, fragment: await readFile(join(resolve(artifactRoot), info.fragment), 'utf8') }
}

export async function preflightCandidate({ candidateRoot = DEFAULT_CANDIDATE, uiArtifactRoot = DEFAULT_UI_ARTIFACT, policyArtifactRoot = DEFAULT_POLICY_ARTIFACT, releaseLockPath = DEFAULT_RELEASE_LOCK } = {}) {
  const root = assertCandidatePath(candidateRoot)
  await assertDirectoryNotLink(root, 'CANDIDATE_ROOT_INVALID')
  const candidate = await readJson(join(root, 'candidate-manifest.json'), 'CANDIDATE_MANIFEST_INVALID')
  const expected = { install: 'install', dshHome: 'home', profile: 'home/profiles/desktop', electronUserData: 'electron-user-data' }
  for (const [key, value] of Object.entries(expected)) if (candidate.candidate?.[key] !== value) throw new CandidateSmokeError('CANDIDATE_LAYOUT_INVALID', key)
  const installRoot = beneath(root, expected.install, 'candidate install')
  const homeRoot = beneath(root, expected.dshHome, 'candidate home')
  const profileRoot = beneath(root, expected.profile, 'candidate profile')
  const userDataRoot = beneath(root, expected.electronUserData, 'candidate user data')
  for (const path of [installRoot, homeRoot, profileRoot, userDataRoot]) await assertDirectoryNotLink(path, 'CANDIDATE_LAYOUT_INVALID')
  const verified = await verifyOfficialDesktop({ installRoot, releaseLockPath })
  if (candidate.source?.hostVersion !== verified.lock.hostVersion) throw new CandidateSmokeError('CANDIDATE_HOST_VERSION_MISMATCH')
  const ui = await loadLayer({ kind: 'ui', candidateRoot: root, markerName: 'ui-ready.json', artifactRoot: uiArtifactRoot, artifactManifestName: 'official-ui-manifest.json', receiptManifestName: 'ui-overlay-manifest.json' })
  const policy = await loadLayer({ kind: 'policy', candidateRoot: root, markerName: 'policy-ready.json', artifactRoot: policyArtifactRoot, artifactManifestName: 'official-policy-manifest.json' })
  if (ui.info.hostVersion !== verified.lock.hostVersion || policy.info.hostVersion !== verified.lock.hostVersion) throw new CandidateSmokeError('ARTIFACT_HOST_VERSION_MISMATCH')
  const names = [...new Set([...ui.info.packages, ...policy.info.packages])].sort()
  const packages = []
  for (const name of names) packages.push(await validatePackage(profileRoot, name))
  const cordis = await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8')
  const ids = assertCordisIds(cordis, [ui.fragment, policy.fragment])
  assertNoLiveReferences([
    ['candidate manifest', JSON.stringify(candidate)],
    ['profile package', await readFile(join(profileRoot, 'package.json'), 'utf8')],
    ['profile workspace', await readFile(join(profileRoot, 'pnpm-workspace.yaml'), 'utf8')],
    ['profile Cordis', cordis],
    ['UI marker', JSON.stringify(ui.marker)], ['UI receipt', JSON.stringify(ui.receipt)],
    ['policy marker', JSON.stringify(policy.marker)], ['policy receipt', JSON.stringify(policy.receipt)],
  ])
  return Object.freeze({ status: 'ready-for-hidden-smoke', root, installRoot, homeRoot, profileRoot, userDataRoot, executable: join(installRoot, 'DeepSeek Harness.exe'), hostVersion: verified.lock.hostVersion, packages: Object.freeze(packages), cordisIds: Object.freeze(ids) })
}

const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const alive = child => child.exitCode === null && child.signalCode === null
async function waitForExit(child, timeoutMs) {
  if (!alive(child)) return true
  return Promise.race([new Promise(resolvePromise => child.once('exit', () => resolvePromise(true))), wait(timeoutMs).then(() => false)])
}

async function logNames(directory) {
  try { return new Set((await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name)) }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error }
}

export async function launchCandidateSmoke({ visible = false, timeoutMs = 20_000, ...options } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) throw new CandidateSmokeError('SMOKE_TIMEOUT_INVALID')
  const preflight = await preflightCandidate(options)
  const smokeRoot = join(preflight.root, 'smoke')
  await mkdir(smokeRoot, { recursive: true })
  const stdoutPath = join(smokeRoot, 'candidate.stdout.log')
  const stderrPath = join(smokeRoot, 'candidate.stderr.log')
  const electronLog = join(smokeRoot, 'electron.log')
  const reportPath = join(smokeRoot, 'launch-report.json')
  const crashLogRoot = join(preflight.userDataRoot, 'logs')
  const crashLogsBefore = await logNames(crashLogRoot)
  const stdout = openSync(stdoutPath, 'a'), stderr = openSync(stderrPath, 'a')
  const startedAt = new Date().toISOString()
  const args = [`--user-data-dir=${preflight.userDataRoot}`, '--enable-logging=file', `--log-file=${electronLog}`]
  const child = spawn(preflight.executable, args, { cwd: preflight.installRoot, env: { ...process.env, DSH_HOME: preflight.homeRoot, DSH_TELEMETRY: 'off' }, windowsHide: !visible, stdio: ['ignore', stdout, stderr] })
  const started = await Promise.race([new Promise((resolvePromise, reject) => { child.once('spawn', () => resolvePromise(true)); child.once('error', reject) }), wait(5_000).then(() => false)])
  if (!started) throw new CandidateSmokeError('CANDIDATE_START_TIMEOUT')
  const metadata = { schemaVersion: 1, status: 'running', pid: child.pid, visible, startedAt, executable: relative(preflight.root, preflight.executable).replaceAll('\\', '/'), args }
  await writeFile(reportPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  try {
    await wait(Math.min(timeoutMs, 15_000))
    if (!alive(child)) throw new CandidateSmokeError('CANDIDATE_EXITED_EARLY', `exit=${child.exitCode} signal=${child.signalCode}`)
    child.kill()
    if (!await waitForExit(child, 10_000)) throw new CandidateSmokeError('CANDIDATE_GRACEFUL_STOP_TIMEOUT', `pid=${child.pid}`)
    const logs = []
    for (const [label, path] of [['stdout', stdoutPath], ['stderr', stderrPath], ['electron', electronLog]]) {
      try { logs.push([label, await readFile(path, 'utf8')]) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const name of await logNames(crashLogRoot)) {
      if (!crashLogsBefore.has(name)) logs.push([`crash/${name}`, await readFile(join(crashLogRoot, name), 'utf8')])
    }
    assertNoLiveReferences(logs)
    const activationFailure = logs.find(([, content]) => /web boot: .*did not activate|entries did not activate/iu.test(content))
    if (activationFailure) throw new CandidateSmokeError('CANDIDATE_WEB_ACTIVATION_FAILED', activationFailure[0])
    const complete = { ...metadata, status: visible ? 'passed-visible-startup' : 'passed-hidden-startup', stoppedAt: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode, logs: logs.map(([label]) => `${label}.log`) }
    await writeFile(reportPath, `${JSON.stringify(complete, null, 2)}\n`, 'utf8')
    return Object.freeze({ preflight, reportPath, report: Object.freeze(complete) })
  } catch (error) {
    if (alive(child)) {
      child.kill()
      await waitForExit(child, 10_000)
    }
    const failed = { ...metadata, status: 'failed', stoppedAt: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode, error: { code: error.code ?? 'SMOKE_FAILED', message: error.message } }
    await writeFile(reportPath, `${JSON.stringify(failed, null, 2)}\n`, 'utf8')
    throw error
  } finally { closeSync(stdout); closeSync(stderr) }
}

function parseArgs(argv) {
  const result = { launch: false, visible: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--launch') { result.launch = true; continue }
    if (key === '--visible') { result.visible = true; continue }
    if (!['--candidate-root', '--ui-artifact', '--policy-artifact', '--release-lock', '--timeout-ms'].includes(key) || argv[index + 1] === undefined) throw new CandidateSmokeError('USAGE')
    result[key.slice(2)] = argv[++index]
  }
  if (result.visible && !result.launch) throw new CandidateSmokeError('VISIBLE_REQUIRES_LAUNCH')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const options = { candidateRoot: args['candidate-root'], uiArtifactRoot: args['ui-artifact'], policyArtifactRoot: args['policy-artifact'], releaseLockPath: args['release-lock'] }
  if (!args.launch) {
    const result = await preflightCandidate(options)
    process.stdout.write(`Candidate smoke preflight: READY; host ${result.hostVersion}; packages ${result.packages.length}; Cordis ids ${result.cordisIds.length}\n`)
    return
  }
  const result = await launchCandidateSmoke({ ...options, visible: args.visible, timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : 20_000 })
  process.stdout.write(`Candidate ${args.visible ? 'visible' : 'hidden'} startup smoke: PASS; report ${result.reportPath}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
