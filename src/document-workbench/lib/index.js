import { randomBytes, timingSafeEqual } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'

import { readFileSync } from 'node:fs'

import { sha } from './paths.js'

import { mkdir } from 'node:fs/promises'

import { createDocumentLibrary } from './library.js'

import { createRuntime } from './runtime.js'

import { documentSession } from './session.js'

export const name = 'airules-dsh-document-workbench'

export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy', 'sandbox', 'subprocess', 'tools', 'dshHomePath', 'agents']

export const API = '/airules/documents'

export function createWorkbench(ctx, stateRoot, runtime = createRuntime(ctx)) {

  const library = createDocumentLibrary({ stateRoot, converterId: `dsh-document-0.1.3:${sha(['convert-worker.js', 'engine-adapter.js', 'runtime.js', 'paths.js'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n'))}`, converter: runtime.convertDocument })

  return { async execute(scope, args, exec = {}) {

    if (args.action === 'show') return library.inventory(scope)

    if (args.action === 'search') return library.search(scope, args.query)

    if (args.action === 'index') return library.index(scope, args.path, exec)

    if (args.action === 'read') return library.read(scope, args, exec)

    if (args.action === 'status') return { projectRoot: scope.root, writable: scope.writable, formats: ['pdf', 'docx', 'xlsx', 'pptx'], local: true, ocr: false, automaticDownload: false }

    throw new Error('DOCUMENT_ACTION_REJECTED')

  }, office: runtime.office }

}

export function handlerFor(ctx, service) {

  const csrfToken = randomBytes(32).toString('base64url')

  return async (req, res) => {

    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)) }

    try {

      if (ctx.connection.requestRejection(req) !== undefined) return send(403, { ok: false, error: 'NATIVE_CONNECTION_REQUIRED' })

      if (req.method === 'GET') {

        const scope = await documentSession(ctx, new URL(req.url, 'http://localhost').searchParams.get('sessionId'))

        return send(200, { ok: true, csrfToken, ...await service.execute(scope, { action: 'status' }), ...await service.execute(scope, { action: 'show' }) })

      }

      if (req.method !== 'POST') return send(405, { ok: false, error: 'METHOD_REJECTED' })

      const supplied = Buffer.from(String(req.headers['x-dsh-csrf'] ?? '')), expected = Buffer.from(csrfToken)

      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok: false, error: 'CSRF_REQUIRED' })

      if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON_REQUIRED')

      let size = 0; const chunks = []

      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 16384) throw new Error('BODY_LIMIT'); chunks.push(Buffer.from(chunk)) }

      const body = JSON.parse(Buffer.concat(chunks).toString())

      if (Object.keys(body).some(key => !['sessionId', 'kind', 'action', 'path', 'query', 'output', 'offset', 'limit', 'pages', 'sheet', 'range'].includes(key))) throw new Error('BODY_REJECTED')

      if (!['document', 'office'].includes(body.kind)) throw new Error('BODY_REJECTED')

      const scope = await documentSession(ctx, body.sessionId, body.action === 'index' || (body.kind === 'office' && body.action !== 'runtime'))

      const agent = ctx.agents.get(body.sessionId)

      const result = await (body.kind === 'office' ? service.office(scope, body, { agent }) : service.execute(scope, body, { agent }))

      send(200, { ok: true, ...result })

    } catch (error) { send(400, { ok: false, error: /^[A-Z_]{2,64}$/u.test(error.message) ? error.message : 'DOCUMENT_UNAVAILABLE', message: ({ ACTIVE_AGENT_REQUIRED: 'Откройте чат выбранного проекта перед обработкой документов.', WORKSPACE_WRITE_REQUIRED: 'Для индекса и результатов Office разрешите запись в рабочей папке.', DOCUMENT_OUTPUT_EXISTS: 'Результат уже существует. Укажите новый путь.', DOCUMENT_PATH_REJECTED: 'Используйте обычный файл внутри выбранного проекта, без ссылок.', DSH_BUNDLED_RUNTIME_REQUIRED: 'Встроенный runtime DSH не подключён.', DOCUMENT_SESSION_REQUIRED: 'Выберите сеанс с пресетом airules.' })[error.message] ?? 'Обработка недоступна: проверьте путь, формат, сеанс и штатные права DSH.' }) }

  }

}

export async function apply(ctx) {

  const stateRoot = ctx.dshHomePath('documents/cache'); await mkdir(stateRoot, { recursive: true, mode: 0o700 })

  const workbench = createWorkbench(ctx, stateRoot)

  class Documents extends Service { constructor(scope) { super(scope, 'airulesDocuments'); Object.assign(this, workbench) } }

  new Documents(ctx)

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: handlerFor(ctx, workbench) }))

}

