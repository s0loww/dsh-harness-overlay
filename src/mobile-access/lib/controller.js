import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Config, RelayStore, Authenticator, HarnessSession, startListener, loadCertificate,
  certificateSans, localAddresses, relayAuthorities, pairingPayload, createQrDataUrl } from 'dsh-relay/desktop'

const execute = promisify(execFile)
export const MOBILE_ACCESS_DENIED_PATHS = Object.freeze([
  '/airules', '/airules-subscriptions-auth', '/mcp-manager',
  '/onec/mobile-access', '/onec/telegram-control', '/onec/acp-control',
  '/api/settings', '/api/credentials', '/api/account', '/api/dshAcp',
  '/onec/subscriptions', '/onec/claude-max', '/onec/provider-settings',
  '/relay/password', '/relay/pair/new', '/relay/devices', '/relay/signout-everywhere',
])
const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535
const problem = message => Object.assign(new Error(message), { publicMessage: message })
const safeMessage = error => error?.publicMessage || (error?.code === 'EADDRINUSE'
  ? 'Этот порт уже занят. Выберите другой порт.' : error?.code === 'EACCES' || error?.code === 'EPERM'
    ? 'Недостаточно прав для локального состояния или выбранного порта.'
    : 'Не удалось изменить доступ с телефона. Проверьте порт и повторите действие.')

/** Restrict only the dedicated directory. Windows chmod(0600) does not protect secrets. */
export async function protectRelayDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw problem('Каталог доступа с телефона не должен быть ссылкой.')
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return }
  const script = `$ErrorActionPreference = 'Stop'
$path = $env:DSH_RELAY_PRIVATE_DIR
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($owner, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($path, $acl)
`
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15000, env: { ...process.env, DSH_RELAY_PRIVATE_DIR: directory },
    })
  } catch { throw problem('Не удалось защитить локальное состояние доступа с телефона правами Windows.') }
}

/** One relay in the existing Desktop process; the ready package owns TLS/auth/proxy. */
export function createMobileAccessController({ home, context, addresses = localAddresses, protectDirectory = protectRelayDirectory, relayApi = { Config, RelayStore, Authenticator, HarnessSession, startListener, loadCertificate, certificateSans, relayAuthorities, pairingPayload, createQrDataUrl } }) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw problem('Не определён локальный каталог состояния DSH Desktop.')
  const { Config, RelayStore, Authenticator, HarnessSession, startListener, loadCertificate, certificateSans, relayAuthorities, pairingPayload, createQrDataUrl } = relayApi
  const directory = join(resolve(home), 'airules-mobile-access')
  const relayDirectory = join(directory, 'relay')
  const preferencesPath = join(directory, 'settings.json')
  let settings = { version: 1, autoStart: false, port: 3443 }
  let store, auth, listener, initialized = false, disposed = false
  let status = 'stopped', message = 'Доступ с телефона выключен.', urls = [], qrDataUrl = null, pairing
  let queue = Promise.resolve()
  const config = () => Config({ stateDir: relayDirectory, bind: '0.0.0.0', port: settings.port,
    mdns: false, uiLink: false, privilegedMethods: 'loopback-only', compat: { addressGrants: false, plainPort: 0 }, extraProxyPaths: ['/onec'] })
  function snapshot() {
    const invitation = pairing && auth?.pairing.peek(Date.now())?.code === pairing.code ? pairing : undefined
    return {
      running: !!listener, status, autoStart: settings.autoStart, port: settings.port,
      hasPassword: auth?.hasPassword ?? false, urls: [...urls], url: urls[0] ?? null, qrDataUrl,
      fingerprint: store?.state.certificate?.fingerprint ?? null,
      devices: (auth?.devices ?? []).filter(device => device.expiresAt > Date.now()).map(device => ({
        id: device.id, name: device.name, createdAt: device.createdAt,
        ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }), expiresAt: device.expiresAt,
      })),
      ...(invitation ? { pairing: { ...invitation } } : {}), message,
    }
  }
  const serialize = work => {
    const result = queue.then(async () => {
      if (disposed) throw problem('Управление доступом с телефона уже закрыто.')
      try { return await work() } catch (error) {
        status = 'error'; message = safeMessage(error)
        throw problem(message)
      }
    })
    queue = result.catch(() => {})
    return result
  }
  async function ensureState() {
    if (initialized) return
    await protectDirectory(directory)
    try {
      const saved = JSON.parse((await readFile(preferencesPath, 'utf8')).replace(/^\uFEFF/, ''))
      if (saved.version !== 1 || typeof saved.autoStart !== 'boolean' || !validPort(saved.port)) throw new Error('invalid preferences')
      settings = { version: 1, autoStart: saved.autoStart, port: saved.port }
    } catch (error) {
      if (error.code !== 'ENOENT') throw problem('Не удалось прочитать сохранённые настройки доступа с телефона.')
    }
    try { store = await RelayStore.open(relayDirectory) }
    catch { throw problem('Не удалось прочитать сохранённый пароль и устройства доступа с телефона.') }
    auth = new Authenticator(store, config())
    initialized = true
  }
  async function saveSettings(next) {
    const temporary = `${preferencesPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 })
    await rename(temporary, preferencesPath)
    settings = next
  }
  async function stopNow() {
    if (listener) {
      const current = listener
      await current.close()
      listener = undefined
    }
    urls = []; qrDataUrl = null; pairing = undefined
    auth?.pairing.clear()
    status = 'stopped'; message = 'Доступ с телефона выключен.'
    return snapshot()
  }
  async function startNow() {
    await ensureState()
    if (listener) { status = 'running'; message = 'Доступ с телефона включён.'; return snapshot() }
    if (!auth.hasPassword) throw problem('Сначала сохраните пароль для входа с телефона.')
    const host = context.webServer?.host
    const port = context.webServer?.port
    if (!['localhost', '127.0.0.1'].includes(host) || !Number.isInteger(port) || port < 1) {
      throw problem('Внутренний веб-сервер DSH ещё не готов или слушает не localhost.')
    }
    status = 'starting'; message = 'Включаем доступ с телефона…'
    const session = await HarnessSession.load(context)
    if (!session) throw problem('Внутренняя авторизация DSH ещё не готова. Дождитесь запуска интерфейса и повторите.')
    const tls = await loadCertificate({ mode: 'self-signed', dir: relayDirectory, certPath: '', keyPath: '',
      sans: certificateSans([]), existing: store.state.certificate })
    if (!tls) throw problem('Не удалось подготовить HTTPS для телефона.')
    if (store.state.certificate?.fingerprint !== tls.record.fingerprint) {
      await store.update(draft => { draft.certificate = tls.record })
    }
    // QR work happens before bind, so a QR failure cannot leave a hidden listener running.
    const candidates = [...new Set(addresses())].filter(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) && !address.startsWith('127.'))
    const nextUrls = candidates.map(address => `https://${address}:${settings.port}`)
    const nextQr = nextUrls[0] ? await createQrDataUrl(nextUrls[0]) : null
    listener = await startListener({ bind: '0.0.0.0', port: settings.port, tls,
      authorities: relayAuthorities({ trustedHosts: candidates, publicHostnames: [] }),
      runtime: { auth, config: config(), target: { host: '127.0.0.1', port, timeoutMs: 120000, session },
        fingerprint: tls.record.fingerprint, requireCredentials: true, deniedPaths: MOBILE_ACCESS_DENIED_PATHS,
        log() {},
      },
    })
    urls = nextUrls; qrDataUrl = nextQr; status = 'running'
    message = urls.length ? 'Доступ с телефона включён. Откройте адрес в той же сети или через VPN.'
      : 'Доступ включён. Подключите компьютер к локальной сети, чтобы получить адрес для телефона.'
    return snapshot()
  }
  async function restartIfRunning(work) {
    const wasRunning = !!listener
    await work()
    if (wasRunning) { await stopNow(); return startNow() }
    status = 'stopped'; message = 'Настройки сохранены. Доступ с телефона выключен.'
    return snapshot()
  }
  return {
    snapshot,
    initialize: () => serialize(async () => { await ensureState(); return settings.autoStart ? startNow() : snapshot() }).catch(() => snapshot()),
    start: () => serialize(startNow),
    stop: () => serialize(stopNow),
    setAutoStart: enabled => serialize(async () => {
      if (typeof enabled !== 'boolean') throw problem('Автозапуск должен быть включён или выключен.')
      await ensureState(); await saveSettings({ ...settings, autoStart: enabled })
      message = enabled ? 'Автозапуск доступа с телефона включён.' : 'Автозапуск доступа с телефона выключен.'
      status = listener ? 'running' : 'stopped'; return snapshot()
    }),
    setPort: port => serialize(async () => {
      if (!validPort(port)) throw problem('Укажите целый номер порта от 1024 до 65535.')
      await ensureState()
      return restartIfRunning(() => saveSettings({ ...settings, port }))
    }),
    setPassword: password => serialize(async () => {
      if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw problem('Пароль должен содержать от 10 до 1024 символов.')
      await ensureState()
      return restartIfRunning(async () => { await auth.setPassword(password); await auth.signOutEverywhere(); pairing = undefined })
    }),
    createPairing: () => serialize(async () => {
      if (!listener || !urls[0]) throw problem('Сначала включите доступ и подключитесь к локальной сети.')
      const code = auth.pairing.issue(8, 300000, Date.now())
      pairing = { ...code, qrDataUrl: await createQrDataUrl(JSON.stringify(pairingPayload({ url: urls[0], fingerprint: store.state.certificate?.fingerprint, code }))) }
      message = 'Код создан для совместимого токенного клиента. Для браузера используйте адрес и пароль.'
      return snapshot()
    }),
    revoke: deviceId => serialize(async () => {
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 128) throw problem('Не указано устройство для отключения.')
      await ensureState()
      return restartIfRunning(async () => { if (!await auth.revoke(deviceId, Date.now())) throw problem('Устройство уже отключено или не найдено.') })
    }),
    revokeAll: () => serialize(async () => { await ensureState(); return restartIfRunning(() => auth.signOutEverywhere()) }),
    dispose: () => {
      const result = queue.then(async () => {
        disposed = true
        try { await stopNow() } finally { auth?.dispose(); await store?.close() }
      })
      queue = result.catch(() => {})
      return result
    },
  }
}
