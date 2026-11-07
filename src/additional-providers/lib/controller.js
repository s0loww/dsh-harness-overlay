export const PROVIDER = 'airules-kimi-coding'
export const noEnvironment = Object.freeze({ env: async () => undefined, fileExists: async () => false })

// Only this package's credential is visible. Never read native/provider/CLI profiles.
export function isolatedCredentialStore(credentials, key, allowed = () => true, allowCreate = true) {
  return {
    async read(id) { return id === PROVIDER ? (await credentials.readRecord(key))?.payload : undefined },
    async list() { return (await credentials.describeRecord(key)).configured === true ? [{ providerId: PROVIDER, type: 'oauth' }] : [] },
    async modify(id, update) {
      if (id !== PROVIDER || !allowed()) throw new Error('CREDENTIAL_SCOPE_REJECTED')
      const record = await credentials.modifyRecord(key, async current => {
        if (!allowCreate && !current) throw new Error('CREDENTIAL_DISCONNECTED')
        const next = await update(current?.payload)
        if (!allowed()) throw new Error('LOGIN_CANCELLED')
        return next === undefined ? undefined : { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) }
      })
      return record?.payload
    },
    async delete(id) {
      if (id !== PROVIDER || !allowed()) throw new Error('CREDENTIAL_SCOPE_REJECTED')
      await credentials.deleteRecord(key)
    },
  }
}

export function createController({ credentials, key, modelsFactory, provider, changed = () => {} }) {
  let attempt, phase = 'idle', notice, error
  const store = isolatedCredentialStore(credentials, key, () => true, false)
  const snapshot = async () => ({ provider: PROVIDER, connected: (await credentials.describeRecord(key)).configured === true, phase, ...(notice ? { notice } : {}), ...(error ? { error } : {}) })
  function cancel() { attempt?.abort(); attempt = undefined; phase = 'idle'; notice = undefined; error = undefined }
  function login() {
    if (attempt) throw new Error('LOGIN_ALREADY_RUNNING')
    const current = new AbortController(); attempt = current; phase = 'pending'; notice = undefined; error = undefined
    const models = modelsFactory({ credentials: isolatedCredentialStore(credentials, key, () => attempt === current && !current.signal.aborted), authContext: noEnvironment })
    models.clearProviders(); models.setProvider(provider)
    void Promise.resolve().then(() => models.login(PROVIDER, 'oauth', {
      signal: AbortSignal.any([current.signal, AbortSignal.timeout(15 * 60_000)]),
      notify(value) {
        if (attempt !== current || value.type !== 'device_code') return
        try {
          const url = new URL(value.verificationUri)
          if (url.protocol !== 'https:' || url.hostname !== 'auth.kimi.com' || url.username || url.password) throw new Error('UNTRUSTED_AUTH_URL')
          notice = { url: url.href, code: String(value.userCode).slice(0, 100) }
        } catch { current.abort(); phase = 'error'; error = 'AUTH_URL_REJECTED' }
      },
      prompt: async () => { throw new Error('INTERACTIVE_PROMPT_UNSUPPORTED') },
    })).then(() => {
      if (attempt === current && !current.signal.aborted) { phase = 'idle'; notice = undefined; changed() }
    }).catch(() => {
      if (attempt === current) { phase = 'error'; error ??= 'KIMI_LOGIN_FAILED'; notice = undefined }
    }).finally(() => { if (attempt === current) attempt = undefined })
  }
  return {
    store, snapshot,
    async action(input) {
      if (input.action === 'login') login()
      else if (input.action === 'cancel') cancel()
      else if (input.action === 'logout') { cancel(); await store.delete(PROVIDER); changed() }
      else throw new Error('ACTION_REJECTED')
      return snapshot()
    },
    close: cancel,
  }
}
