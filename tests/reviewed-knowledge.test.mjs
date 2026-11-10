import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraft, reviewDraft, approveReviewed, invalidateKnowledge, publicationPlan, executePublication } from '../src/reviewed-knowledge/lib/core.js'

const at = '2026-11-11T10:00:00.000Z'
const lead = { actorId: 'orchestrator', isLead: true, writable: true, now: at }
const worker = { actorId: 'developer', isLead: false, writable: true, now: at }
const input = { kind: 'fact', title: 'Sandbox requirement', statement: 'The fixture runner requires its sandbox write capability.', appliesTo: { project: 'fixture-project', scope: 'runner v2', version: '2.0' }, evidence: [{ kind: 'test', ref: 'tests/runner.test.mjs#case-3', observedAt: at, sha256: 'a'.repeat(64) }] }
function reviewed(draft = createDraft(input, worker)) { return reviewDraft(draft, { expectedRevision: draft.revision, findings: 'Observed in the isolated fixture; current version checked.', evidenceVerified: true, applicabilityVerified: true, secretsChecked: true }, lead) }
function approved() { const record = reviewed(); return approveReviewed(record, { expectedRevision: record.revision, decision: 'Preserve for this project.' }, lead) }
function plan(destination = 'cognee', record = approved()) { return publicationPlan(record, { expectedRevision: record.revision, destination, targetScope: 'fixture-project', ...(destination === 'airules' ? { targetPath: 'core/skills/fixture/SKILL.md', expectedTargetRevision: 'b'.repeat(64) } : {}) }, lead) }
function io(overrides = {}) {
  const rows = new Map(), calls = []
  return { rows, calls, options: {
    authorize: async () => true,
    ledger: { claim: async (id, value) => { if (rows.has(id)) return false; rows.set(id, value); return true }, settle: async (id, value) => rows.set(id, value) },
    adapter: async (value, meta) => { calls.push({ value, meta }); return { destination: value.destination, targetScope: value.targetScope, state: value.destination === 'airules' ? 'review-patch-created' : 'accepted', sourceId: 'fixture-source-1' } }, ...overrides },
  }
}

test('a delegated candidate remains a draft and only the lead can review/approve', () => {
  const draft = createDraft(input, worker)
  assert.equal(draft.state, 'draft'); assert.equal(draft.review, null)
  assert.throws(() => reviewDraft(draft, { expectedRevision: draft.revision }, worker), /LEAD_WRITER/)
  assert.throws(() => approveReviewed(draft, { expectedRevision: draft.revision, decision: 'ok' }, lead), /TRANSITION/)
  const review = reviewed(draft), approvedRecord = approveReviewed(review, { expectedRevision: review.revision, decision: 'Checked current source.' }, lead)
  assert.equal(approvedRecord.state, 'approved'); assert.equal(approvedRecord.audit.length, 3)
  assert.equal(approvedRecord.approval.contentHash, draft.contentHash)
  assert.notEqual(approvedRecord.revision, draft.revision)
})

test('review requires evidence, applicability and secret inspection; content mutations invalidate revision', () => {
  const draft = createDraft(input, lead)
  assert.throws(() => reviewDraft(draft, { expectedRevision: draft.revision, findings: 'ok', evidenceVerified: true, applicabilityVerified: true }, lead), /INCOMPLETE/)
  const changed = structuredClone(draft); changed.content.statement = 'Do something else'
  assert.throws(() => reviewed(changed), /REVISION_CHANGED/)
  assert.throws(() => reviewDraft(draft, { expectedRevision: '0'.repeat(64) }, lead), /REVISION_CHANGED/)
  assert.throws(() => createDraft({ ...input, evidence: [] }, lead), /EVIDENCE_REQUIRED/)
})

test('stale/superseded records retain lineage and cannot be published', () => {
  const record = approved()
  const stale = invalidateKnowledge(record, { expectedRevision: record.revision, why: 'Version changed.' }, lead)
  assert.equal(stale.state, 'stale'); assert.equal(stale.contentHash, record.contentHash)
  assert.throws(() => plan('cognee', stale), /APPROVAL_REQUIRED/)
  assert.throws(() => invalidateKnowledge(record, { expectedRevision: record.revision, state: 'superseded', why: 'newer' }, lead), /SUPERSESSION/)
  const next = createDraft({ ...input, statement: 'A newer finding.' }, lead)
  const superseded = invalidateKnowledge(record, { expectedRevision: record.revision, state: 'superseded', supersededBy: next.id, why: 'Rechecked on v3.' }, lead)
  assert.equal(superseded.invalidation.supersededBy, next.id)
})

test('expired evidence is never approved/published as current; timestamps cannot go backwards', () => {
  const draft = createDraft({ ...input, appliesTo: { ...input.appliesTo, expiresAt: '2026-11-10T10:00:00.000Z' } }, lead)
  const review = reviewed(draft)
  assert.throws(() => approveReviewed(review, { expectedRevision: review.revision, decision: 'ok' }, lead), /ALREADY_EXPIRED/)
  assert.throws(() => reviewDraft(createDraft(input, lead), { expectedRevision: createDraft(input, lead).revision, findings: 'checked', evidenceVerified: true, applicabilityVerified: true, secretsChecked: true }, { ...lead, now: '2026-11-10T10:00:00.000Z' }), /TIME_REVERSED/)
})

test('exactly one explicit destination is chosen; procedures and rules follow airules ownership', () => {
  assert.throws(() => plan(['cognee', 'memoria']), /DESTINATION_REQUIRED/)
  assert.equal(plan('memoria').automaticallyMirror, false)
  const draft = createDraft({ ...input, kind: 'procedure' }, lead), review = reviewed(draft)
  const record = approveReviewed(review, { expectedRevision: review.revision, decision: 'Reusable method.' }, lead)
  assert.throws(() => plan('cognee', record), /RULE_OWNER/)
  const patch = plan('airules', record)
  assert.equal(patch.operation, 'review-patch'); assert.equal(patch.patch.expectedRevision, 'b'.repeat(64))
  assert.equal(patch.patch.proposedText, input.statement)
  for (const targetPath of ['../.env', 'core/../../secrets.md', 'C:/some/file.md', 'core//skills/test.md', 'core/.env']) {
    assert.throws(() => publicationPlan(record, { expectedRevision: record.revision, destination: 'airules', targetScope: 'fixture-project', targetPath, expectedTargetRevision: 'b'.repeat(64) }, lead), /PATH_INVALID/)
  }
  assert.throws(() => publicationPlan(record, { expectedRevision: record.revision, destination: 'airules', targetScope: 'another-project' }, lead), /SCOPE_MISMATCH/)
})

test('publication dispatch requires native approval and existing session CAS journal; no default I/O', async () => {
  await assert.rejects(executePublication(plan()), /NATIVE_ADAPTER_REQUIRED/)
  const denied = io({ authorize: async () => false })
  await assert.rejects(executePublication(plan(), denied.options), /NATIVE_APPROVAL_REQUIRED/)
  assert.equal(denied.rows.size, 0); assert.equal(denied.calls.length, 0)
  const options = io(), receipt = await executePublication(plan('memoria'), options.options)
  assert.equal(options.calls.length, 1); assert.equal(receipt.destination, 'memoria'); assert.equal(receipt.indexed, false)
  assert.equal(options.rows.get(receipt.operationId).state, 'accepted')
})

test('revoked permission after journal claim cancels before backend dispatch', async () => {
  let guards = 0
  const options = io({ authorize: async () => ++guards === 1 })
  await assert.rejects(executePublication(plan(), options.options), /NATIVE_APPROVAL_REQUIRED/)
  assert.equal(options.calls.length, 0); assert.equal([...options.rows.values()][0].state, 'not-sent')
})

test('unknown outcome is not retried or mirrored, even under a newly timestamped plan', async () => {
  const options = io({ adapter: async () => { throw new Error('private upstream payload') } }), record = approved()
  const first = plan('cognee', record), result = await executePublication(first, options.options)
  assert.equal(result.state, 'outcome-unknown'); assert.equal(result.retrySafe, false)
  assert.equal(JSON.stringify(result).includes('private'), false)
  const later = publicationPlan(record, { expectedRevision: record.revision, destination: 'cognee', targetScope: 'fixture-project' }, { ...lead, now: '2026-11-11T10:01:00.000Z' })
  assert.notEqual(later.intentId, first.intentId)
  await assert.rejects(executePublication(later, options.options), /RECONCILE_REQUIRED/)
})

test('foreign scope, malformed receipts and receipt-journal failures remain unknown', async () => {
  for (const result of [{ destination: 'cognee', targetScope: 'foreign', state: 'accepted', sourceId: 'x' }, { destination: 'cognee', targetScope: 'fixture-project', state: 'accepted', sourceId: 'secret\nline' }, { destination: 'cognee', targetScope: 'fixture-project', state: 'complete', sourceId: 'x' }]) {
    const options = io({ adapter: async () => result })
    assert.equal((await executePublication(plan(), options.options)).state, 'outcome-unknown')
    assert.equal([...options.rows.values()][0].state, 'outcome-unknown')
  }
  const options = io(); options.options.ledger.settle = async () => { throw new Error('disk full') }
  assert.equal((await executePublication(plan(), options.options)).state, 'outcome-unknown')
})

test('adapter cannot mutate the reviewed plan; review-patch creation is not applied rules', async () => {
  const original = plan('airules'), options = io()
  const receipt = await executePublication(original, { ...options.options, adapter: async value => { value.content.statement = 'changed locally'; return { destination: 'airules', targetScope: 'fixture-project', state: 'review-patch-created', sourceId: 'review/fixture.diff' } } })
  assert.equal(original.content.statement, input.statement)
  assert.equal(receipt.state, 'review-patch-created'); assert.equal(receipt.indexed, false)
  const changed = structuredClone(original); changed.targetScope = 'foreign'
  await assert.rejects(executePublication(changed, options.options), /PLAN_INVALID/)
})
