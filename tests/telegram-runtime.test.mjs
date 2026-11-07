import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TOKEN = '123456:synthetic_test_token_no_network'
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'airules-telegram-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(resolve('src/telegram'), root, { recursive: true })
  for (const [name, code] of Object.entries({
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = x => x',
    '@deepseek-ai/dsh-credentials': 'export const credentialKey = (scope,id) => scope + "/" + id',
  })) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
    writeFileSync(join(dir, 'index.js'), code)
  }
  const control = await import(pathToFileURL(join(root, 'lib/telegram-control.js')))
  const bridges = []
  class FakeBridge {
    constructor(ctx, options) { this.ctx = ctx; this.options = options; bridges.push(this) }
    async verifyBot() { return { id: 500, is_bot: true } }
    start() { this.started = true }
    async stop() { this.stopped = true }
    async connectCurrent(ownerId, sessionId) { await this.options.onBindingChanged(ownerId, { workspaceId: 'workspace', sessionId }) }
    async restoreBinding(ownerId, binding) { this.restored = { ownerId, binding } }
    async disconnectCurrent(ownerId) { await this.options.onBindingChanged(ownerId, null) }
  }
  let record
  const credentials = {
    async readRecord() { return record },
    async modifyRecord(_key, update) { return record = update(record) },
  }
  const options = { platform: 'win32', Bridge: FakeBridge, credentials,
    protect: async token => 'dpapi:v1:' + Buffer.from(token).toString('base64'),
    unprotect: async value => Buffer.from(value.slice(9), 'base64').toString(),
  }
  return { root, control, bridges, credentials, options, record: () => record }
}

test('fresh Telegram initialization is offline, ignores legacy environment and has autostart off', async t => {
  const f = await fixture(t)
  const controller = f.control.createTelegramController({}, { ...f.options, env: { DSH_TELEGRAM_TOKEN: TOKEN, DSH_TELEGRAM_ALLOWED_USER_IDS: '77' } })
  const state = await controller.initialize()
  assert.equal(state.configured, false)
  assert.equal(state.autoStart, false)
  assert.equal(state.status, 'stopped')
  assert.equal(f.bridges.length, 0)
  await assert.rejects(controller.dispatch({ action: 'start' }), /Сначала сохраните/)
  assert.equal(f.record(), undefined)
})

test('settings store only protected token and a single numeric owner; public state never exposes secrets', async t => {
  const f = await fixture(t)
  const controller = f.control.createTelegramController({}, f.options)
  await assert.rejects(controller.dispatch({ action: 'save', token: TOKEN, ownerId: true }), /числовой/)
  await assert.rejects(controller.dispatch({ action: 'save', token: TOKEN, ownerId: '77,78' }), /числовой/)
  const state = await controller.dispatch({ action: 'save', token: TOKEN, ownerId: '77' })
  assert.equal(state.tokenStored, true)
  assert.equal(state.autoStart, false)
  assert.equal(f.bridges.length, 0)
  assert.ok(f.record().payload.ciphertext.startsWith('dpapi:v1:'))
  assert.equal(JSON.stringify(f.record()).includes(TOKEN), false)
  assert.equal(JSON.stringify(state).includes('ciphertext'), false)
  assert.equal(JSON.stringify(state).includes(TOKEN), false)
  assert.equal(f.control.telegramPublicError(new Error(TOKEN)).includes(TOKEN), false)
})

test('connect persists exact binding; stop preserves it, restart restores it and disconnect clears it', async t => {
  const f = await fixture(t)
  const controller = f.control.createTelegramController({}, f.options)
  await controller.dispatch({ action: 'save', token: TOKEN, ownerId: 77 })
  const state = await controller.dispatch({ action: 'connect', sessionId: 'native-session' })
  assert.equal(state.status, 'running')
  assert.deepEqual(f.bridges[0].options.allowedUserIds, [77])
  assert.equal(f.bridges[0].options.allowAllUsers, false)
  assert.equal(f.bridges[0].options.preset, '1c-airules')
  assert.equal(f.record().payload.binding.sessionId, 'native-session')
  assert.equal(f.record().payload.binding.botId, 500)
  await controller.dispatch({ action: 'stop' })
  assert.equal(f.bridges[0].stopped, true)
  assert.equal(controller.snapshot().binding.sessionId, 'native-session')
  await controller.dispatch({ action: 'start' })
  assert.equal(f.bridges[1].restored.binding.sessionId, 'native-session')
  await controller.dispatch({ action: 'disconnect' })
  assert.equal(f.record().payload.binding, null)
  await controller.dispose()
})

test('HTTP control uses native admission and per-process CSRF; error and status payloads redact tokens', async t => {
  const f = await fixture(t)
  const controller = f.control.createTelegramController({}, f.options)
  const handler = f.control.createTelegramControlHandler(controller, undefined, { requestRejection: request => request.headers.reject ? 401 : undefined })
  const call = async (method, input, headers = {}) => {
    const request = { method, headers, async *[Symbol.asyncIterator]() { if (input) yield Buffer.from(JSON.stringify(input)) } }
    const response = { writeHead(code) { this.code = code }, end(text) { this.text = text; this.body = JSON.parse(text) } }
    await handler(request, response)
    return response
  }
  assert.equal((await call('GET', null, { reject: true })).code, 403)
  const initial = await call('GET')
  assert.equal(initial.body.status, 'stopped')
  assert.equal((await call('POST', { action: 'save', token: TOKEN, ownerId: 77 })).code, 403)
  const saved = await call('POST', { action: 'save', token: TOKEN, ownerId: 77 }, { 'x-dsh-csrf': initial.body.csrfToken })
  assert.equal(saved.code, 200)
  assert.equal(saved.text.includes(TOKEN), false)
  assert.equal(saved.text.includes('ciphertext'), false)
  const invalid = await call('POST', { action: 'save', token: TOKEN, ownerId: 'bad' }, { 'x-dsh-csrf': initial.body.csrfToken })
  assert.equal(invalid.code, 400)
  assert.equal(invalid.text.includes(TOKEN), false)
})

test('bridge rejects groups and non-owner messages and requires explicit one-call approval button', async t => {
  const f = await fixture(t)
  const { TelegramBridge } = await import(pathToFileURL(join(f.root, 'vendor/dsh-telegram/lib/bridge.js')))
  const sent = [], callbacks = []
  const client = {
    async sendRichMessage(chatId, text, _signal, keyboard) { const result = { message_id: sent.length + 1, chat: { id: chatId, type: 'private' } }; sent.push({ text, keyboard, result }); return result },
    async answerCallbackQuery(...args) { callbacks.push(args) },
    async editMessageReplyMarkup() {}, async deleteMessages() {},
  }
  const ctx = { agents: { get() {} }, logger: { warn() {}, error() {} } }
  const bridge = new TelegramBridge(ctx, { token: TOKEN, allowedUserIds: [77], allowAllUsers: false, client })
  await bridge.handleUpdate({ message: { chat: { id: 77, type: 'group' }, from: { id: 77 }, text: 'task' } })
  assert.equal(sent.length, 0)
  await bridge.handleUpdate({ message: { chat: { id: 78, type: 'private' }, from: { id: 78 }, text: 'task' } })
  assert.match(sent[0].text, /Доступ запрещён/)
  const active = await bridge.bind(77, { id: 'workspace', title: 'Test' }, 'session')
  const promise = bridge.approveThroughTelegram(active, { agent: { session: { id: 'session' } }, toolName: 'write-file', reason: 'test' })
  await new Promise(resolve => setImmediate(resolve))
  const prompt = sent.at(-1)
  const approval = prompt.keyboard.inline_keyboard.flat().find(button => button.text.includes('Разрешить'))
  assert.ok(approval)
  await bridge.handleCallbackQuery({ id: 'unauthorized', from: { id: 78 }, message: prompt.result, data: approval.callback_data })
  assert.equal(bridge.pendingQuestions.size, 1)
  await bridge.handleCallbackQuery({ id: 'stale', from: { id: 77 }, message: { ...prompt.result, message_id: 999 }, data: approval.callback_data })
  assert.equal(bridge.pendingQuestions.size, 1)
  await bridge.handleCallbackQuery({ id: 'valid', from: { id: 77 }, message: prompt.result, data: approval.callback_data })
  assert.equal(await promise, 'allowed-once')
  assert.equal(bridge.pendingQuestions.size, 0)
  assert.ok(callbacks.length >= 3)
})

test('Telegram API transport and API errors redact synthetic token', async t => {
  const f = await fixture(t)
  const { TelegramClient } = await import(pathToFileURL(join(f.root, 'vendor/dsh-telegram/lib/client.js')))
  const transport = new TelegramClient(TOKEN, { fetch: async url => { throw new Error(url) } })
  await assert.rejects(transport.getMe(), error => !error.message.includes(TOKEN) && error.message.includes('***'))
  const api = new TelegramClient(TOKEN, { fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: TOKEN }) }) })
  await assert.rejects(api.getMe(), error => error.code === 401 && !error.message.includes(TOKEN))
})

test('private owner text and follow-up route to the same native session without changing its configuration', async t => {
  const f = await fixture(t)
  const { TelegramBridge } = await import(pathToFileURL(join(f.root, 'vendor/dsh-telegram/lib/bridge.js')))
  const messages = [], steered = [], resolutions = []
  const agent = { status: 'idle', session: { id: 'native-session' }, followup: value => messages.push(value), steer: value => steered.push(value) }
  const ctx = { workspaceRegistry: { archivedSessionIds: [] },
    sessionController: { resolveAgent: async id => { resolutions.push(id); return { agent } } },
    logger: { warn() {}, error() {} } }
  const bridge = new TelegramBridge(ctx, { token: TOKEN, allowedUserIds: [77], client: { sendRichMessage: async () => ({ message_id: 1 }) } })
  await bridge.bind(77, { id: 'workspace', title: 'Test' }, 'native-session')
  const update = text => ({ message: { message_id: 1, chat: { id: 77, type: 'private' }, from: { id: 77 }, text } })
  await bridge.handleUpdate(update('check this change'))
  agent.status = 'running'
  await bridge.handleUpdate(update('/followup then review'))
  assert.deepEqual(resolutions, ['native-session', 'native-session'])
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content[0].text, 'check this change')
  assert.equal(messages[1].content[0].text, 'then review')
  assert.equal(steered.length, 0)
  assert.deepEqual(Object.keys(ctx.sessionController), ['resolveAgent'])
})

test('Windows DPAPI helper round-trips only through anonymous pipes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const secret = await import(pathToFileURL(join(f.root, 'lib/telegram-secret.js')))
  const ciphertext = await secret.protectTelegramToken(TOKEN)
  assert.ok(ciphertext.startsWith('dpapi:v1:'))
  assert.equal(ciphertext.includes(TOKEN), false)
  assert.equal(await secret.unprotectTelegramToken(ciphertext), TOKEN)
})
