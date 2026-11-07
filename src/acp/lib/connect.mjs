// Stdio bridge to the already running local Desktop. It never starts an agent.
import { connect } from 'node:net'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

try {
  const index = process.argv.indexOf('--home')
  const value = index < 0 ? null : process.argv[index + 1]
  if (!value || !isAbsolute(value)) throw new Error('ACP_HOME_REQUIRED')
  const home = resolve(value), path = join(home, 'airules-acp-endpoint.json')
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('ACP_ENDPOINT_INVALID')
  const endpoint = JSON.parse(readFileSync(path, 'utf8'))
  if (endpoint.version !== 1 || typeof endpoint.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(endpoint.token) || typeof endpoint.pipe !== 'string') throw new Error('ACP_ENDPOINT_INVALID')
  if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\airules-dsh-acp-[a-f0-9]{24}$/u.test(endpoint.pipe) : endpoint.pipe !== join(home, 'airules-acp.sock')) throw new Error('ACP_ENDPOINT_INVALID')
  const socket = connect(endpoint.pipe)
  const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1 }, 5000)
  let accepted = false, pending = Buffer.alloc(0)
  socket.once('connect', () => socket.write(JSON.stringify({ token: endpoint.token }) + '\n'))
  const handshake = chunk => {
    pending = Buffer.concat([pending, chunk]); if (pending.length > 1024) return socket.destroy()
    const end = pending.indexOf(10); if (end < 0) return
    if (pending.subarray(0, end).toString('utf8') !== 'DSH-ACP-READY') return socket.destroy()
    socket.off('data', handshake); clearTimeout(timer); accepted = true
    const rest = pending.subarray(end + 1); if (rest.length) process.stdout.write(rest)
    socket.pipe(process.stdout); process.stdin.pipe(socket)
  }
  socket.on('data', handshake)
  socket.on('error', () => { process.exitCode = 1 })
  socket.once('close', () => { clearTimeout(timer); if (!accepted) process.exitCode = 1; process.stdin.unpipe(socket); process.stdin.destroy() })
} catch { console.error('ACP_LOCAL_CONNECTION_FAILED: включите ACP в настройках работающего Desktop.'); process.exitCode = 1 }
