import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { writeProtectedFile } from './protected-file.js'

export const ACP_READY = 'DSH-ACP-READY\n'
const readJson = path => {
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw new Error('ACP_STATE_INVALID')
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
}
const tokenEqual = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(b ?? ''); return x.length === y.length && timingSafeEqual(x, y) }

export function createDesktopAcpController({ home, clientPath, mount, write = writeProtectedFile, platform = process.platform }) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('ACP_HOME_REQUIRED')
  home = resolve(home)
  const key = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 24)
  const pipe = platform === 'win32' ? `\\\\.\\pipe\\airules-dsh-acp-${key}` : join(home, 'airules-acp.sock')
  const endpoint = join(home, 'airules-acp-endpoint.json'), preferences = join(home, 'airules-acp-settings.json')
  let status = 'stopped', error = null, autoStart = false, server, token, disposed = false
  let queue = Promise.resolve()
  const connections = new Map()
  const serialize = work => (queue = queue.then(work, work))
  const snapshot = () => ({ status, autoStart, error, activeConnections: [...connections.values()].filter(c => c.authenticated).length,
    connection: { command: process.execPath, args: [clientPath, '--home', home], env: { ELECTRON_RUN_AS_NODE: '1' } } })
  try { const prefs = readJson(preferences); if (typeof prefs.autoStart !== 'boolean') throw new Error(); autoStart = prefs.autoStart }
  catch (cause) { if (cause.code !== 'ENOENT') { status = 'error'; error = 'ACP_LOCAL_SETTINGS_INVALID' } }
  async function release(socket, current) {
    if (current.releasing) return current.releasing
    clearTimeout(current.timer); socket.destroy()
    current.releasing = (async () => { try { await current.mounting; await current.dispose?.() } finally { connections.delete(socket) } })()
    return current.releasing
  }
  function accept(socket) {
    const current = { authenticated: false }; connections.set(socket, current)
    socket.on('error', () => {})
    socket.once('close', () => { void release(socket, current).catch(() => { error = 'ACP_CONNECTION_CLOSE_FAILED' }) })
    current.timer = setTimeout(() => socket.destroy(), 5000)
    let pending = Buffer.alloc(0)
    const handshake = chunk => {
      pending = Buffer.concat([pending, chunk]); if (pending.length > 1024) return socket.destroy()
      const end = pending.indexOf(10); if (end < 0) return
      socket.pause(); socket.off('data', handshake); clearTimeout(current.timer)
      let supplied
      try { supplied = JSON.parse(pending.subarray(0, end).toString('utf8')).token } catch { return socket.destroy() }
      if (!tokenEqual(supplied, token) || status !== 'running') return socket.destroy()
      const rest = pending.subarray(end + 1); if (rest.length) socket.unshift(rest)
      current.mounting = Promise.resolve().then(() => mount(socket)).then(dispose => {
        current.dispose = dispose
        if (socket.destroyed || status !== 'running') return
        current.authenticated = true; socket.write(ACP_READY); socket.resume()
      }).catch(() => { error = 'ACP_CONNECTION_FAILED'; socket.destroy() })
    }
    socket.on('data', handshake)
  }
  async function stopNow() {
    status = 'stopping'; const current = server; server = undefined
    const closed = current ? new Promise(resolve => current.close(resolve)) : Promise.resolve()
    const results = await Promise.allSettled([...connections].map(([socket, c]) => release(socket, c)))
    await closed
    try { if (token && tokenEqual(readJson(endpoint).token, token)) unlinkSync(endpoint) }
    catch (cause) { if (cause.code !== 'ENOENT') { status = 'error'; error = 'ACP_ENDPOINT_CLEANUP_FAILED'; return snapshot() } }
    token = undefined
    status = results.some(x => x.status === 'rejected') ? 'error' : 'stopped'
    error = status === 'error' ? 'ACP_CONNECTION_CLOSE_FAILED' : null
    return snapshot()
  }
  async function startNow() {
    if (disposed) throw new Error('ACP_DISPOSED')
    if (status === 'running') return snapshot()
    status = 'starting'; error = null; token = randomBytes(32).toString('base64url')
    const candidate = createServer(accept)
    try {
      mkdirSync(home, { recursive: true })
      await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(pipe, () => { candidate.off('error', reject); resolve() }) })
      server = candidate
      candidate.on('error', () => { void serialize(stopNow).then(() => { status = 'error'; error = 'ACP_LISTENER_FAILED' }) })
      write(endpoint, JSON.stringify({ version: 1, pipe, token, pid: process.pid }) + '\n')
      status = 'running'
    } catch {
      if (server === candidate) await stopNow(); else candidate.close(() => {})
      status = 'error'; error = 'ACP_START_FAILED'
    }
    return snapshot()
  }
  return { snapshot, initialize: () => autoStart ? serialize(startNow) : Promise.resolve(snapshot()),
    start: () => serialize(startNow), stop: () => serialize(stopNow),
    setAutoStart: value => serialize(() => { if (typeof value !== 'boolean') throw new Error('ACP_AUTOSTART_INVALID'); mkdirSync(home, { recursive: true }); write(preferences, JSON.stringify({ autoStart: value }) + '\n'); autoStart = value; return snapshot() }),
    dispose: () => serialize(async () => { disposed = true; await stopNow() }) }
}
