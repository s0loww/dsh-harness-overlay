import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHistoryRecall } from '../src/history-recall/lib/core.js'
for (const [label, location] of [['rc5', 'var/asar-extract-rc5/dsh/node_modules'], ['022', 'var/host-upgrade/rc022/asar/dsh/node_modules']]) test(`real ${label} SessionQuery observation and native tool schema/scope registration`, async t => {
  const sdk = resolve(location), native = name => import(pathToFileURL(join(sdk, '@deepseek-ai', name, 'lib/index.js')))
  const { Context } = await native('cordis'), { Session } = await native('dsh-session'), { createUserMessage } = await native('dsh-llm'), { SessionQueryEngine } = await native('dsh-session-query'), { default: ToolsService } = await native('dsh-tools')
  const workspace = resolve('var/recall-fixture'), session = Session.create(`history-${label}`, undefined, { version: 4, id: `history-${label}`, createdAt: Date.now(), isSeeded: false, cwd: workspace })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'needle native source' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary replacement' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'find source' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  ctx.provide('sessions', { get: id => id === session.id ? session : undefined, list: () => [session] })
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const query = new SessionQueryEngine(ctx), realTools = new ToolsService(ctx)
  const agent = { id: session.id, session, ctx }, registry = new Map([[session.id, agent]])
  let policy = { mode: 'read-only', sessionId: session.id, workspaceRoot: workspace }
  ctx.provide('agents', registry); ctx.provide('agentPresets', { composedPreset: () => '1c-airules' }); ctx.provide('sandboxPolicy', { resolve: () => policy })
  const root = await mkdtemp(join(tmpdir(), 'airules-recall-')); t.after(() => rm(root, { recursive: true, force: true }))
  await cp('src/history-recall/lib', join(root, 'lib'), { recursive: true }); await writeFile(join(root, 'package.json'), '{"type":"module"}'); await symlink(sdk, join(root, 'node_modules'), 'junction')
  const plugin = await import(pathToFileURL(join(root, 'lib/agent.js')))
  const scoped = ctx.plugin({ ...plugin }); await scoped.await(); assert.equal(scoped.state, 2)
  assert.ok(realTools.view().visible.has('history_search')); assert.ok(realTools.view().visible.has('history_read'))
  const exec = { agent, signal: new AbortController().signal }, history = createHistoryRecall(query, { validateScope: input => plugin.validateNativeScope(ctx, input) })
  const found = await history.search({ query: 'needle' }, exec)
  assert.equal(found.hits.length, 1); assert.equal(found.hits[0].event_id, `s:history-${label}:0`)
  assert.equal((await history.read({ event_id: found.hits[0].event_id }, exec)).text, 'needle native source')
  policy = { ...policy, workspaceRoot: resolve('var/foreign') }
  await assert.rejects(history.search({ query: 'source' }, exec), /HISTORY_NATIVE_POLICY_REQUIRED/)
  policy = { ...policy, workspaceRoot: workspace }; registry.delete(session.id)
  await assert.rejects(history.search({ query: 'source' }, exec), /HISTORY_ACTIVE_SCOPE_REQUIRED/)
})
