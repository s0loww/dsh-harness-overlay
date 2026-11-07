import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../scripts/telegram-secret.ps1', import.meta.url))

/** Windows DPAPI CurrentUser. Secret bytes travel only through anonymous pipes. */
async function transform(mode, value) {
  if (process.platform !== 'win32') throw new Error('TELEGRAM_DPAPI_UNAVAILABLE')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, mode], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '', failed = false
    const fail = () => { failed = true; child.kill(); reject(new Error('TELEGRAM_DPAPI_FAILED')) }
    const timer = setTimeout(fail, 15000)
    child.on('error', fail)
    child.stdin.on('error', () => {})
    child.stderr.resume() // Never relay helper diagnostics or secret-bearing input.
    child.stdout.on('data', data => { output += data.toString('ascii'); if (output.length > 16384) fail() })
    child.once('close', code => {
      clearTimeout(timer)
      if (failed) return
      const encoded = output.trim()
      if (code !== 0 || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reject(new Error('TELEGRAM_DPAPI_FAILED'))
      resolve(encoded)
    })
    child.stdin.end(value + '\n', 'ascii')
  })
}

export async function protectTelegramToken(token) {
  return 'dpapi:v1:' + await transform('protect', Buffer.from(token, 'utf8').toString('base64'))
}

export async function unprotectTelegramToken(ciphertext) {
  if (typeof ciphertext !== 'string' || !/^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) throw new Error('TELEGRAM_DPAPI_FAILED')
  return Buffer.from(await transform('unprotect', ciphertext.slice(9)), 'base64').toString('utf8')
}

