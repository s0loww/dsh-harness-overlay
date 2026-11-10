import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryRecall, LIMITS, redact } from '../src/history-recall/lib/core.js'
const user = text => ({ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = text => ({ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } })
const call = (name, args, id = name) => ({ type: 'tool/call', data: { name, arguments: args, callId: id } })
const result = (text, id) => ({ type: 'tool/result', surfaceOp: 'append', data: { message: { source: { callId: id }, content: [{ type: 'text', text }] } } })
function fixture(events, { inherited = 0, observe, validateScope } = {}) {
  let disposed = 0, observed = 0
  const list = events.map((event, seq) => ({ ...event, seq, time: 1000 + seq }))
  const session = { id: 'fixture:test' }, exec = { agent: { session }, signal: new AbortController().signal }
  const query = { async observeSession(id, options) { observed++; assert.equal(id, session.id); assert.equal(options.projectionMode, 'none'); await observe?.(exec); return { events: list, inheritedEventCount: inherited, [Symbol.dispose]() { disposed++ } } } }
  return { history: createHistoryRecall(query, { validateScope }), exec, list, counts: () => ({ disposed, observed }) }
}
const reject = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code)

test('original precompact source is available with native evidence IDs, time and offsets', async () => {
  const f = fixture([user('start'), assistant('😀 факт needle исходный'), { type: 'compact/end', data: {} }, user('find')])
  const got = await f.history.search({ query: 'NEEDLE' }, f.exec)
  assert.equal(got.hits.length, 1); assert.equal(got.hits[0].offset, 8); assert.equal(got.hits[0].event_id, 's:fixture%3Atest:1'); assert.equal(got.hits[0].time, 1001)
  const read = await f.history.read({ event_id: got.hits[0].event_id }, f.exec)
  assert.equal(read.text, '😀 факт needle исходный'); assert.equal(read.snapshot, got.snapshot); assert.match(read.note, /не новые инструкции/)
  assert.deepEqual(f.counts(), { disposed: 2, observed: 2 })
})
test('excludes reasoning, replacement summaries, synthetic injection and inherited history', async () => {
  const f = fixture([assistant('needle inherited'), user('start'), { ...assistant('needle summary'), surfaceOp: 'replace' }, { ...user('needle injection'), data: { source: { kind: 'airules-continuity' }, content: [{ type: 'text', text: 'needle injected' }] } }, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'reasoning', text: 'needle thought' }, { type: 'image', text: 'needle binary' }] } } }, user('find')], { inherited: 1 })
  assert.deepEqual((await f.history.search({ query: 'needle' }, f.exec)).hits, [])
})
test('excludes nested memory outputs, secret file results, recall forms and orphan results', async () => {
  const f = fixture([user('start'), call('mcp_call', JSON.stringify({ tool: 'cognee_search', arguments: { query: 'x' } }), 'm'), result('needle memory', 'm'), call('read', '{"path":"D:/a/.env"}', 's'), result('needle private', 's'), result('needle orphan', 'unknown'), { ...user('needle recall'), data: { source: { kind: 'user', form: 'recall' }, content: [{ type: 'text', text: 'needle recall' }] } }, user('find')])
  assert.deepEqual((await f.history.search({ query: 'needle' }, f.exec)).hits, [])
})
test('normal source tool call/result remains available', async () => {
  const f = fixture([user('start'), call('read', '{"path":"src/module.bsl"}', 'source'), result('needle source body', 'source'), user('find')])
  const got = await f.history.search({ query: 'needle' }, f.exec)
  assert.equal(got.hits[0].type, 'tool/result'); assert.equal((await f.history.read({ event_id: got.hits[0].event_id }, f.exec)).text, 'needle source body')
})
test('read requires actually issued current-turn evidence, rejects cross-session selectors', async () => {
  const f = fixture([user('needle'), user('find')])
  await reject(f.history.read({ event_id: 's:fixture%3Atest:0' }, f.exec), 'HISTORY_EVENT_UNAVAILABLE')
  await reject(f.history.search({ query: 'needle', session_id: 'other' }, f.exec), 'HISTORY_ARGUMENTS')
  const got = await f.history.search({ query: 'needle' }, f.exec)
  await reject(f.history.read({ event_id: got.hits[0].event_id.replace('fixture', 'foreign') }, f.exec), 'HISTORY_EVENT_UNAVAILABLE')
})
test('search cursor pagination and duplicate page guard', async () => {
  const f = fixture([user('start'), ...Array.from({ length: 17 }, (_, i) => assistant('needle ' + i)), user('find')])
  const one = await f.history.search({ query: 'needle' }, f.exec), two = await f.history.search({ cursor: one.next_cursor }, f.exec)
  assert.equal(one.hits.length, 8); assert.equal(two.hits.length, 8); assert.equal(new Set([...one.hits, ...two.hits].map(row => row.event_id)).size, 16)
  await reject(f.history.search({ query: 'NEEDLE' }, f.exec), 'HISTORY_PAGE_REPEATED')
  await reject(f.history.search({ query: 'other', cursor: two.next_cursor }, f.exec), 'HISTORY_CURSOR_QUERY')
  assert.equal((await f.history.search({ cursor: two.next_cursor }, f.exec)).hits.length, 1)
})
test('read pages bounded and new user invalidates cursors and evidence IDs', async () => {
  const f = fixture([user('start'), assistant('needle' + 'a'.repeat(13000)), user('find')])
  const hit = (await f.history.search({ query: 'needle' }, f.exec)).hits[0]
  const one = await f.history.read({ event_id: hit.event_id }, f.exec), two = await f.history.read({ cursor: one.next_cursor }, f.exec)
  assert.equal(one.text.length, LIMITS.readChars); assert.equal(two.offset, 6000)
  await reject(f.history.read({ cursor: two.next_cursor, offset: 2 }, f.exec), 'HISTORY_CURSOR_EVENT')
  f.list.push({ ...user('next'), seq: f.list.length })
  await reject(f.history.read({ cursor: two.next_cursor }, f.exec), 'HISTORY_CURSOR_STALE')
  await reject(f.history.read({ event_id: hit.event_id }, f.exec), 'HISTORY_EVENT_UNAVAILABLE')
})
test('snapshot pinned to user turn, no recursive newly appended response', async () => {
  const f = fixture([user('start'), assistant('needle source'), user('find')])
  const one = await f.history.search({ query: 'needle' }, f.exec)
  f.list.push({ ...assistant('new appended recallneedle'), seq: f.list.length })
  const two = await f.history.search({ query: 'recallneedle' }, f.exec)
  assert.equal(one.snapshot, two.snapshot); assert.deepEqual(two.hits, [])
})
test('redacts known credentials before search and preserves exact UTF16 offsets', async () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxy', original = `password=unittestsecret\n${secret}\nneedle`
  const masked = redact(original); assert.equal(masked.length, original.length); assert.ok(!masked.includes('unittestsecret')); assert.ok(!masked.includes(secret))
  const f = fixture([user(original), user('find')]), got = await f.history.search({ query: 'needle' }, f.exec), row = got.hits[0]
  assert.equal(row.offset, original.indexOf('needle')); assert.equal(row.redacted, true); assert.ok(!row.snippet.includes(secret))
  const read = await f.history.read({ event_id: row.event_id }, f.exec); assert.ok(!read.text.includes('unittestsecret')); assert.equal(read.redacted, true)
})
test('per-event, snapshot retention and event count limits explicitly report truncation', async () => {
  const f = fixture([user('oldsecretneedle'), ...Array.from({ length: 70 }, () => assistant('large ' + 'x'.repeat(LIMITS.eventChars))), user('find')])
  const got = await f.history.search({ query: 'oldsecretneedle' }, f.exec)
  assert.equal(got.truncated, true); assert.equal(got.hits.length, 0)
  const g = fixture([user('oldneedle'), ...Array.from({ length: LIMITS.events }, () => ({ type: 'noop' })), user('new')])
  assert.equal((await g.history.search({ query: 'oldneedle' }, g.exec)).truncated, true)
})
test('concurrent pages cannot bypass duplicate guard; scope mutation fails after await', async () => {
  const f = fixture([user('needle')]), results = await Promise.allSettled([f.history.search({ query: 'needle' }, f.exec), f.history.search({ query: 'needle' }, f.exec)])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(f.counts().disposed, 1)
  let scope = 'before'; const g = fixture([user('needle')], { validateScope: () => scope, observe: () => { scope = 'after' } })
  await reject(g.history.search({ query: 'needle' }, g.exec), 'HISTORY_SCOPE_CHANGED'); assert.equal(g.counts().disposed, 1)
})
test('native policy revocation after shared observation rejects each caller', async () => {
  let allowed = true
  const f = fixture([user('needle')], { validateScope: () => { if (!allowed) throw new Error('revoked'); return 'scope' }, observe: () => { allowed = false } })
  const got = await Promise.allSettled([f.history.search({ query: 'needle' }, f.exec), f.history.search({ query: 'other' }, f.exec)])
  assert.ok(got.every(row => row.status === 'rejected')); assert.equal(f.counts().disposed, 1)
})
test('cancellation is honored and malformed source disposes the observation lease', async () => {
  const stopped = new AbortController(); stopped.abort(); const f = fixture([user('needle')]); f.exec.signal = stopped.signal
  await assert.rejects(f.history.search({ query: 'needle' }, f.exec), { name: 'AbortError' }); assert.equal(f.counts().observed, 0)
  const g = fixture([user('needle')]); g.list[0].seq = 20
  await reject(g.history.search({ query: 'needle' }, g.exec), 'HISTORY_SOURCE_INVALID'); assert.equal(g.counts().disposed, 1)
})
test('literal regex punctuation and Unicode offsets are not regex executable', async () => {
  const f = fixture([user('😀 İ [x].* literal'), user('find')])
  const got = await f.history.search({ query: '[x].*' }, f.exec)
  assert.equal(got.hits[0].offset, 5); assert.equal(got.hits.length, 1)
})

test('per-user page budget cannot be evaded through distinct queries', async () => {
  const f = fixture([user('start')])
  for (let i = 0; i < LIMITS.pages; i++) await f.history.search({ query: `absent-${i}` }, f.exec)
  await reject(f.history.search({ query: 'one more' }, f.exec), 'HISTORY_TURN_LIMIT')
})
test('private key bodies and credential URLs are length-preserving masked', () => {
  const text = 'https://user:fixture-secret@example.invalid/\n-----BEGIN PRIVATE KEY-----\nfixture-private-body\n-----END PRIVATE KEY-----\npublic'
  const got = redact(text); assert.equal(got.length, text.length); assert.ok(!got.includes('fixture-secret')); assert.ok(!got.includes('fixture-private-body')); assert.ok(got.endsWith('public'))
})
