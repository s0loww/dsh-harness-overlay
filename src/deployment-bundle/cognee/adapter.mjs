import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, lstat, realpath, readdir, rm } from 'node:fs/promises'
import { finished, pipeline } from 'node:stream/promises'
import { dirname, join, resolve, isAbsolute, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { COGNEE_LOCK, COGNEE_IMAGE_IDS } from './lock.mjs'

export { COGNEE_LOCK, COGNEE_IMAGE_IDS }
const HERE = dirname(fileURLToPath(import.meta.url))
const LABEL = 'ru.airules.cognee.owner'
const fail = code => { throw new Error(code) }
const json = value => JSON.stringify(value, null, 2) + '\n'
const secret = () => randomBytes(32).toString('hex')
const identity = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{7,39}$/u.test(value)
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
export function validatePort(port) { if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail('COGNEE_INSTALL_PORT_INVALID'); return port }
export async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
async function fileInfo(path) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('COGNEE_INSTALL_FILE_REJECTED'); return info }
async function privateJson(path, value) { await writeFile(path, json(value), { mode: 0o600, flag: 'wx' }) }
async function safeDirectory(path, { create = false } = {}) {
  if (!isAbsolute(path ?? '') || resolve(path) === parse(resolve(path)).root) fail('COGNEE_INSTALL_PATH_INVALID')
  path = resolve(path)
  let current = path, missing = []
  for (;;) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(current), current)) fail('COGNEE_INSTALL_PATH_LINK'); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) throw error; missing.unshift(current); current = dirname(current) }
  }
  for (const folder of missing) await mkdir(folder)
  if (!samePath(await realpath(path), path)) fail('COGNEE_INSTALL_PATH_LINK')
  return path
}
export function validateAssetManifest(value) {
  if (!value || Object.keys(value).some(key => !['schemaVersion','lock','files','contents','userDataIncluded','credentialsIncluded'].includes(key)) || value.userDataIncluded !== undefined && value.userDataIncluded !== false || value.credentialsIncluded !== undefined && value.credentialsIncluded !== false || value.schemaVersion !== 1 || JSON.stringify(value.lock) !== JSON.stringify(COGNEE_LOCK) || !Array.isArray(value.files) || value.files.length !== 2) fail('COGNEE_ASSET_MANIFEST_INVALID')
  const paths = new Set()
  for (const row of value.files) {
    if (!row || Object.keys(row).sort().join(',') !== 'path,sha256,size' || !['cognee-image.tar', 'cognee-models.tar'].includes(row.path) || paths.has(row.path) || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '') || !Number.isSafeInteger(row.size) || row.size < 512 || row.size > 10 * 1024 ** 3) fail('COGNEE_ASSET_MANIFEST_INVALID')
    paths.add(row.path)
  }
  return value
}
export async function verifyAssets(assetsRoot) {
  assetsRoot = await safeDirectory(assetsRoot)
  const manifestPath = join(assetsRoot, 'assets.json'); await fileInfo(manifestPath)
  const manifest = validateAssetManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  for (const row of manifest.files) { const path = join(assetsRoot, row.path), info = await fileInfo(path); if (info.size !== row.size || await hashFile(path) !== row.sha256) fail('COGNEE_ASSET_HASH_MISMATCH') }
  return manifest
}
/** The binary stream never enters a JS string. Docker errors are deliberately sanitized. */
export async function dockerRunner(args, { cwd, inputFile, outputFile, timeoutMs = 180000 } = {}) {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) if (name.startsWith('DOCKER_')) delete environment[name]
  const host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock'
  const child = spawn('docker', ['--host', host, ...args], { cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = 0, stdout = [], bytes = 0, overflow = false
  child.stderr.on('data', chunk => { stderr += chunk.length })
  const output = outputFile ? createWriteStream(outputFile, { flags: 'wx', mode: 0o600 }) : null
  const outputDone = output ? finished(output) : Promise.resolve()
  if (output) child.stdout.pipe(output)
  else child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) stdout.push(chunk); else { overflow = true; child.kill() } })
  const inputDone = inputFile ? pipeline(createReadStream(inputFile), child.stdin) : Promise.resolve(child.stdin.end())
  child.stdin.on('error', () => {})
  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [code] = await Promise.all([new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), outputDone, inputDone])
    if (overflow) fail('COGNEE_DOCKER_OUTPUT_LIMIT')
    return { code, stdout: Buffer.concat(stdout).toString('utf8'), stderrBytes: stderr }
  } catch { child.kill(); output?.destroy(); fail('COGNEE_DOCKER_COMMAND_FAILED') }
  finally { clearTimeout(timer) }
}
export function renderCompose({ instanceId, ownerToken, port, memoryGiB = 5, offline = false, proxyScript }) {
  if (!identity(instanceId) || !/^[a-f0-9]{64}$/u.test(ownerToken ?? '') || typeof offline !== 'boolean' || ![3, 4, 5, 6, 8].includes(memoryGiB)) fail('COGNEE_INSTALL_IDENTITY_INVALID')
  validatePort(port)
  if (offline && (typeof proxyScript !== 'string' || !proxyScript.includes("asyncio.open_connection('cognee', 8000)"))) fail('COGNEE_PROXY_REQUIRED')
  const ports = `    ports:\n      - "127.0.0.1:${port}:8000"\n`
  const proxy = offline ? `  loopback:\n    image: ${COGNEE_LOCK.localImage}\n    pull_policy: never\n    container_name: airules-cognee-${instanceId}-loopback\n    restart: unless-stopped\n    entrypoint: ["python"]\n    command: ["-u", "-c", ${JSON.stringify(proxyScript)}]\n${ports}    read_only: true\n    mem_limit: 64m\n    cpus: 0.25\n    labels:\n      ${LABEL}: "${ownerToken}"\n    networks: [default, access]\n` : ''
  return `# airules-owned-cognee-v1
name: airules-${instanceId}
services:
  cognee:
    image: ${COGNEE_LOCK.localImage}
    pull_policy: never
    container_name: airules-cognee-${instanceId}
    restart: unless-stopped
    stop_grace_period: 30s
    env_file:
      - .env
${offline ? '' : ports}    extra_hosts:
      - "host.docker.internal:host-gateway"
    labels:
      ${LABEL}: "${ownerToken}"
    volumes:
      - storage:/cognee-storage
    cpus: 2.0
    mem_limit: ${memoryGiB}g
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 12
      start_period: 120s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
${proxy}volumes:
  storage:
    external: true
    name: airules-cognee-${instanceId}-storage
networks:
  default:
    internal: ${offline}
    labels:
      ${LABEL}: "${ownerToken}"
${offline ? `  access:\n    labels:\n      ${LABEL}: "${ownerToken}"\n` : ''}`
}
export function freshServerEnvironment() {
  return {
    DEFAULT_USER_PASSWORD: secret(), FASTAPI_USERS_JWT_SECRET: secret(), FASTAPI_USERS_RESET_PASSWORD_TOKEN_SECRET: secret(), FASTAPI_USERS_VERIFICATION_TOKEN_SECRET: secret(),
    ENABLE_BACKEND_ACCESS_CONTROL: 'true', GRAPH_EXTRACTOR: 'gliner_demo', AUTO_FEEDBACK: 'false', TELEMETRY_DISABLED: '1',
    HF_HOME: '/cognee-storage/models/huggingface', FASTEMBED_CACHE_PATH: '/cognee-storage/models/fastembed', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    GLINER_INFERENCE_THREADS: '1', OMP_NUM_THREADS: '2', TOKENIZERS_PARALLELISM: 'false', LOG_LEVEL: 'INFO',
  }
}
export function createCogneeAdapter({ run = dockerRunner, fetchImpl = globalThis.fetch } = {}) {
  const execute = async (args, options) => { const result = await run(args, options); if (result.code !== 0) fail('COGNEE_DOCKER_COMMAND_FAILED'); return result.stdout }
  async function detect() {
    try {
      const response = JSON.parse(await execute(['info', '--format', '{{json .}}']))
      if (response.OSType !== 'linux') return { available: false, linuxEngine: false, prerequisite: 'Docker Desktop Linux containers' }
      const composeVersion = (await execute(['compose', 'version', '--short'])).trim()
      if (!/^v?[2-9]\d*\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/u.test(composeVersion)) fail('COGNEE_COMPOSE_REQUIRED')
      return { available: true, linuxEngine: true, composeVersion, serverVersion: response.ServerVersion, memoryBytes: response.MemTotal, cpus: response.NCPU }
    }
    catch { return { available: false, linuxEngine: false, prerequisite: 'Docker Desktop with Linux containers and Compose v2' } }
  }
  async function inspect(kind, name) { const result = await run([kind, 'inspect', name]); if (result.code !== 0) return null; try { return JSON.parse(result.stdout)[0] } catch { fail('COGNEE_DOCKER_INSPECT_INVALID') } }
  async function exportOfflineAssets({ destination, sourceContainer = 'dsh_cognee_local' }) {
    destination = await safeDirectory(destination, { create: true })
    if ((await readdir(destination)).length) fail('COGNEE_EXPORT_NOT_EMPTY')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u.test(sourceContainer)) fail('COGNEE_SOURCE_CONTAINER_INVALID')
    const source = await inspect('container', sourceContainer)
    if (!source || !COGNEE_IMAGE_IDS.includes(source.Image)) fail('COGNEE_SOURCE_IMAGE_MISMATCH')
    await execute(['image', 'tag', COGNEE_LOCK.image, COGNEE_LOCK.localImage])
    await execute(['image', 'save', '--output', join(destination, 'cognee-image.tar'), COGNEE_LOCK.localImage], { timeoutMs: 600000 })
    const program = await readFile(join(HERE, 'export-cache.py'), 'utf8')
    await execute(['exec', sourceContainer, 'python', '-c', program, JSON.stringify(COGNEE_LOCK.models)], { outputFile: join(destination, 'cognee-models.tar'), timeoutMs: 600000 })
    const files = []
    for (const path of ['cognee-image.tar', 'cognee-models.tar']) files.push({ path, size: (await fileInfo(join(destination, path))).size, sha256: await hashFile(join(destination, path)) })
    const manifest = { schemaVersion: 1, lock: COGNEE_LOCK, files, contents: 'pinned-image-and-public-model-snapshots-only', userDataIncluded: false, credentialsIncluded: false }
    await privateJson(join(destination, 'assets.json'), manifest)
    return manifest
  }
  async function owned(stateRoot) {
    stateRoot = await safeDirectory(stateRoot)
    const path = join(stateRoot, 'receipt.json'); await fileInfo(path)
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    if (receipt.schemaVersion !== 1 || !identity(receipt.instanceId) || !/^[a-f0-9]{64}$/u.test(receipt.ownerToken ?? '') || !samePath(receipt.stateRoot, stateRoot) || receipt.container !== `airules-cognee-${receipt.instanceId}` || receipt.volume !== `${receipt.container}-storage` || receipt.network !== `airules-${receipt.instanceId}_default` || !/^[a-f0-9]{64}$/u.test(receipt.composeHash ?? '') || receipt.endpoint !== `http://127.0.0.1:${validatePort(receipt.port)}`) fail('COGNEE_OWNERSHIP_INVALID')
    if (receipt.offline === true && (receipt.proxy !== `${receipt.container}-loopback` || receipt.accessNetwork !== `airules-${receipt.instanceId}_access`)) fail('COGNEE_OWNERSHIP_INVALID')
    return receipt
  }
  async function assertOwned(kind, name, receipt, { optional = false } = {}) {
    const entity = await inspect(kind, name)
    if (!entity && optional) return null
    const label = kind === 'container' ? entity?.Config?.Labels?.[LABEL] : entity?.Labels?.[LABEL]
    if (!entity || label !== receipt.ownerToken) fail('COGNEE_FOREIGN_RESOURCE_REFUSED')
    return entity
  }
  async function api(endpoint, route, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetchImpl(endpoint + route, { ...options, signal: controller.signal, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); fail('COGNEE_PROVISION_HTTP_FAILED') }
      const text = await response.text(); if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail('COGNEE_PROVISION_RESPONSE_LIMIT')
      return JSON.parse(text)
    } catch (error) { if (error.message.startsWith('COGNEE_')) throw error; fail('COGNEE_PROVISION_UNAVAILABLE') }
    finally { clearTimeout(timer) }
  }
  async function waitReady(receipt, attempts = 120) {
    for (let index = 0; index < attempts; index++) {
      const entity = await assertOwned('container', receipt.container, receipt)
      if (!entity.State?.Running) fail('COGNEE_CONTAINER_STOPPED')
      try { const value = await api(receipt.endpoint, '/health'); if (['ready', 'healthy', 'ok'].includes(value.status) && String(value.version ?? '').startsWith(COGNEE_LOCK.version)) return value } catch {}
      await tick(1000)
    }
    fail('COGNEE_HEALTH_TIMEOUT')
  }
  async function start({ stateRoot }) {
    const receipt = await owned(stateRoot)
    await assertOwned('volume', receipt.volume, receipt)
    const existing = await assertOwned('container', receipt.container, receipt, { optional: true })
    const proxy = receipt.offline ? await assertOwned('container', receipt.proxy, receipt, { optional: true }) : null
    if (existing) {
      if (receipt.offline && !proxy) fail('COGNEE_OFFLINE_PROXY_MISSING')
      await execute(['container', 'start', receipt.container])
      if (proxy) await execute(['container', 'start', receipt.proxy])
    }
    else {
      const image = await inspect('image', COGNEE_LOCK.localImage)
      if (!image || !COGNEE_IMAGE_IDS.includes(image.Id)) fail('COGNEE_LOADED_IMAGE_MISMATCH')
      const path = join(stateRoot, 'service/compose.yaml'); await fileInfo(path)
      if (await hashFile(path) !== receipt.composeHash) fail('COGNEE_COMPOSE_CHANGED')
      if (await inspect('network', receipt.network)) await assertOwned('network', receipt.network, receipt)
      if (receipt.offline && await inspect('network', receipt.accessNetwork)) await assertOwned('network', receipt.accessNetwork, receipt)
      await execute(['compose', '-f', path, 'up', '-d', '--no-build', '--pull', 'never'], { cwd: join(stateRoot, 'service') })
    }
    const server = await waitReady(receipt)
    return { endpoint: receipt.endpoint, ready: true, version: server.version, container: receipt.container }
  }
  async function install({ stateRoot, assetsRoot, instanceId = randomUUID().replaceAll('-', '').slice(0, 16), port = 18080, memoryGiB = 5, offline = false, ownerSid } = {}) {
    validatePort(port)
    if (!identity(instanceId) || ownerSid !== undefined && !/^S-1-(?:\d+-){1,14}\d+$/u.test(ownerSid)) fail('COGNEE_INSTALL_IDENTITY_INVALID')
    const manifest = await verifyAssets(assetsRoot)
    if (!(await detect()).available) fail('COGNEE_DOCKER_DESKTOP_REQUIRED')
    await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error('COGNEE_INSTALL_PORT_OCCUPIED'))); server.listen(port, '127.0.0.1', () => server.close(resolve)) })
    stateRoot = await safeDirectory(stateRoot, { create: true })
    if ((await readdir(stateRoot)).length) fail('COGNEE_INSTALL_STATE_NOT_EMPTY')
    const ownerToken = secret(), proxyScript = offline ? await readFile(join(HERE, 'loopback-proxy.py'), 'utf8') : undefined
    const compose = renderCompose({ instanceId, ownerToken, port, memoryGiB, offline, proxyScript })
    const receipt = { schemaVersion: 1, stateRoot, instanceId, ownerToken, container: `airules-cognee-${instanceId}`, volume: `airules-cognee-${instanceId}-storage`, network: `airules-${instanceId}_default`, ...(offline ? { proxy: `airules-cognee-${instanceId}-loopback`, accessNetwork: `airules-${instanceId}_access` } : {}), composeHash: createHash('sha256').update(compose).digest('hex'), port, endpoint: `http://127.0.0.1:${port}`, image: COGNEE_LOCK.localImage, imageId: COGNEE_LOCK.imageId, offline, status: 'installing', assetHashes: manifest.files }
    await privateJson(join(stateRoot, 'receipt.json'), receipt)
    const serviceHome = join(stateRoot, 'service'), memoryHome = join(stateRoot, 'memory-workspace')
    await mkdir(serviceHome); await mkdir(memoryHome)
    await writeFile(join(serviceHome, 'compose.yaml'), compose, { flag: 'wx' })
    await writeFile(join(serviceHome, '.env'), Object.entries(freshServerEnvironment()).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    const cachedImage = await inspect('image', COGNEE_LOCK.localImage)
    if (cachedImage && !COGNEE_IMAGE_IDS.includes(cachedImage.Id)) fail('COGNEE_EXISTING_IMAGE_MISMATCH')
    if (!cachedImage) await execute(['image', 'load', '--input', join(assetsRoot, 'cognee-image.tar')], { timeoutMs: 600000 })
    const image = await inspect('image', COGNEE_LOCK.localImage)
    if (!image || !COGNEE_IMAGE_IDS.includes(image.Id)) fail('COGNEE_LOADED_IMAGE_MISMATCH')
    if (await inspect('volume', receipt.volume) || await inspect('container', receipt.container)) fail('COGNEE_EXISTING_RESOURCE_REFUSED')
    await execute(['volume', 'create', '--label', `${LABEL}=${receipt.ownerToken}`, receipt.volume])
    const seed = await readFile(join(HERE, 'seed-cache.py'), 'utf8')
    await execute(['run', '--rm', '-i', '--network', 'none', '--mount', `type=volume,source=${receipt.volume},target=/cognee-storage`, '--entrypoint', 'python', COGNEE_LOCK.localImage, '-c', seed, JSON.stringify(COGNEE_LOCK.models)], { inputFile: join(assetsRoot, 'cognee-models.tar') })
    await start({ stateRoot })
    const account = { email: `dsh-${instanceId}@localhost.example`, password: secret() }
    await privateJson(join(stateRoot, 'provisioning.private.json'), account)
    await api(receipt.endpoint, '/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) })
    const login = await api(receipt.endpoint, '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: account.email, password: account.password }) })
    const created = await api(receipt.endpoint, '/api/v1/auth/api-keys', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${login.access_token}` }, body: JSON.stringify({ name: 'DSH local project memory' }) })
    if (typeof created.key !== 'string' || !created.key || /[\r\n\0]/u.test(created.key)) fail('COGNEE_PROVISION_KEY_INVALID')
    const configPath = join(memoryHome, 'config.json'), authPath = join(memoryHome, 'auth.json'), processingBindingPath = join(memoryHome, 'processing-binding.json'), processingPath = join(memoryHome, 'processing.json')
    await privateJson(configPath, { enabled: true, endpoint: receipt.endpoint, localProcessing: true })
    await privateJson(authPath, { apiKey: created.key })
    await privateJson(processingBindingPath, { schemaVersion: 1, composeDir: serviceHome, composeFile: 'compose.yaml', envFile: '.env', container: receipt.container, service: 'cognee', ...(ownerSid ? { ownerSid } : {}) })
    await privateJson(processingPath, { allowed: true, embeddings: { provider: 'fastembed', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 }, extraction: { provider: 'gliner', model: 'fastino/gliner2.5-base-v1' } })
    await rm(join(stateRoot, 'provisioning.private.json'))
    receipt.status = 'installed'; await writeFile(join(stateRoot, 'receipt.json'), json(receipt), { mode: 0o600 })
    return { instanceId, endpoint: receipt.endpoint, container: receipt.container, volume: receipt.volume, stateRoot, memoryHome, configPath, authPath, processingBindingPath, processingPath, enabled: true, localProcessing: true, offline, existingUserDataImported: false }
  }
  async function health({ stateRoot }) {
    const receipt = await owned(stateRoot), entity = await assertOwned('container', receipt.container, receipt, { optional: true })
    if (!entity?.State?.Running) return { available: false, endpoint: receipt.endpoint, reason: 'stopped' }
    try { const server = await api(receipt.endpoint, '/health'); return { available: server.status === 'ready', endpoint: receipt.endpoint, version: server.version, state: server.status } }
    catch { return { available: false, endpoint: receipt.endpoint, reason: 'unavailable' } }
  }
  async function stop({ stateRoot }) {
    const receipt = await owned(stateRoot), entity = await assertOwned('container', receipt.container, receipt, { optional: true })
    const proxy = receipt.offline ? await assertOwned('container', receipt.proxy, receipt, { optional: true }) : null
    if (proxy?.State?.Running) await execute(['container', 'stop', '--time', '10', receipt.proxy])
    if (entity?.State?.Running) await execute(['container', 'stop', '--time', '30', receipt.container])
    return { stopped: true, container: receipt.container, dataRetained: true }
  }
  async function uninstall({ stateRoot, purgeData = false }) {
    if (typeof purgeData !== 'boolean') fail('COGNEE_PURGE_INVALID')
    const receipt = await owned(stateRoot)
    await stop({ stateRoot })
    if (receipt.offline && await assertOwned('container', receipt.proxy, receipt, { optional: true })) await execute(['container', 'rm', receipt.proxy])
    if (await assertOwned('container', receipt.container, receipt, { optional: true })) await execute(['container', 'rm', receipt.container])
    if (await assertOwned('network', receipt.network, receipt, { optional: true })) await execute(['network', 'rm', receipt.network])
    if (receipt.offline && await assertOwned('network', receipt.accessNetwork, receipt, { optional: true })) await execute(['network', 'rm', receipt.accessNetwork])
    if (purgeData && await assertOwned('volume', receipt.volume, receipt, { optional: true })) await execute(['volume', 'rm', receipt.volume])
    // Keep machine receipt/config/private credentials for explicit recovery; the bundle installer
    // owns removal of its separately receipt-bound DSH profile files. Never delete a shared image.
    return { uninstalled: true, container: receipt.container, dataRetained: !purgeData, stateRetained: true, imageRetained: true }
  }
  return { detect, exportOfflineAssets, install, start, health, stop, uninstall }
}

