import { createHash } from 'node:crypto'

// A proposal is transport inside the existing native session, not a knowledge DB.
// This module has no filesystem, network, environment or model access.
const fail = code => { throw new Error(code) }
const digest = text => createHash('sha256').update(text).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (value, max, code = 'KNOWLEDGE_INPUT_INVALID') => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) fail(code)
  return value.trim()
}
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  fail('KNOWLEDGE_INPUT_INVALID')
}
function stamp(value) {
  const result = { ...value, revision: digest(canonical(value)) }
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) fail('KNOWLEDGE_RECORD_LIMIT')
  return structuredClone(result)
}
function checked(record, expectedRevision) {
  if (!plain(record) || record.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(record.revision ?? '')) fail('KNOWLEDGE_RECORD_INVALID')
  const { revision, ...body } = record
  if (digest(canonical(body)) !== revision || expectedRevision !== revision) fail('KNOWLEDGE_REVISION_CHANGED')
  if (!['draft', 'review', 'approved', 'stale', 'superseded'].includes(record.state) || digest(canonical(record.content)) !== record.contentHash || !/^lesson-[a-f0-9]{24}$/.test(record.id ?? '')) fail('KNOWLEDGE_RECORD_INVALID')
  return structuredClone(body)
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('KNOWLEDGE_TIME_INVALID')
  return value
}
function actor(context, lead = false) {
  if (!plain(context) || (lead && (context.isLead !== true || context.writable !== true))) fail('KNOWLEDGE_LEAD_WRITER_REQUIRED')
  const value = text(context.actorId, 100, 'KNOWLEDGE_ACTOR_INVALID')
  if (!/^[\p{L}\p{N}._:@/-]+$/u.test(value)) fail('KNOWLEDGE_ACTOR_INVALID')
  return value
}
function applicability(value) {
  if (!plain(value)) fail('KNOWLEDGE_APPLICABILITY_REQUIRED')
  const project = text(value.project, 500), scope = text(value.scope, 1000)
  return { project, scope, ...(value.version !== undefined ? { version: text(value.version, 150) } : {}), ...(value.expiresAt !== undefined ? { expiresAt: date(value.expiresAt) } : {}) }
}
function evidence(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail('KNOWLEDGE_EVIDENCE_REQUIRED')
  return value.map(item => {
    if (!plain(item) || !['source', 'test', 'history', 'memory', 'user'].includes(item.kind)) fail('KNOWLEDGE_EVIDENCE_INVALID')
    // Reference IDs, not arbitrary payloads, commands, credentials or transcripts.
    const ref = text(item.ref, 800), observedAt = date(item.observedAt)
    if (/^[a-z][a-z\d+.-]*:\/\/[^\s/]*@/i.test(ref)) fail('KNOWLEDGE_EVIDENCE_INVALID')
    if (item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256)) fail('KNOWLEDGE_EVIDENCE_INVALID')
    return { kind: item.kind, ref, observedAt, ...(item.sha256 ? { sha256: item.sha256 } : {}) }
  })
}
function reason(value) { return text(value, 2000, 'KNOWLEDGE_REASON_REQUIRED') }
function event(record, state, by, now, extra = {}) {
  if (record.audit.length >= 32) fail('KNOWLEDGE_AUDIT_LIMIT')
  if (now < record.updatedAt) fail('KNOWLEDGE_TIME_REVERSED')
  return stamp({ ...record, state, updatedAt: now, ...extra, audit: [...record.audit, { state, actor: by, at: now }] })
}

export function createDraft(input, context) {
  const by = actor(context), now = date(context.now)
  if (!plain(input) || !['fact', 'decision', 'procedure', 'rule'].includes(input.kind)) fail('KNOWLEDGE_INPUT_INVALID')
  const content = { kind: input.kind, title: text(input.title, 160), statement: text(input.statement, 16000), appliesTo: applicability(input.appliesTo), evidence: evidence(input.evidence) }
  const contentHash = digest(canonical(content))
  return stamp({ schemaVersion: 1, id: `lesson-${contentHash.slice(0, 24)}`, content, contentHash, state: 'draft', createdAt: now, updatedAt: now, audit: [{ state: 'draft', actor: by, at: now }], review: null, approval: null, invalidation: null })
}

export function reviewDraft(record, { expectedRevision, findings, evidenceVerified, applicabilityVerified, secretsChecked }, context) {
  const body = checked(record, expectedRevision), by = actor(context, true), now = date(context.now)
  if (body.state !== 'draft') fail('KNOWLEDGE_TRANSITION_INVALID')
  if (evidenceVerified !== true || applicabilityVerified !== true || secretsChecked !== true) fail('KNOWLEDGE_REVIEW_INCOMPLETE')
  const review = { actor: by, at: now, contentHash: body.contentHash, findings: reason(findings), evidenceVerified: true, applicabilityVerified: true, secretsChecked: true }
  return event(body, 'review', by, now, { review })
}

export function approveReviewed(record, { expectedRevision, decision }, context) {
  const body = checked(record, expectedRevision), by = actor(context, true), now = date(context.now)
  if (body.state !== 'review' || body.review?.contentHash !== body.contentHash) fail('KNOWLEDGE_TRANSITION_INVALID')
  if (body.content.appliesTo.expiresAt && now >= body.content.appliesTo.expiresAt) fail('KNOWLEDGE_ALREADY_EXPIRED')
  return event(body, 'approved', by, now, { approval: { actor: by, at: now, contentHash: body.contentHash, decision: reason(decision) } })
}

export function invalidateKnowledge(record, { expectedRevision, state = 'stale', why, supersededBy }, context) {
  const body = checked(record, expectedRevision), by = actor(context, true), now = date(context.now)
  if (!['review', 'approved'].includes(body.state) || !['stale', 'superseded'].includes(state)) fail('KNOWLEDGE_TRANSITION_INVALID')
  if (state === 'superseded' && (!/^lesson-[a-f0-9]{24}$/.test(supersededBy ?? '') || supersededBy === body.id)) fail('KNOWLEDGE_SUPERSESSION_INVALID')
  return event(body, state, by, now, { invalidation: { reason: reason(why), ...(state === 'superseded' ? { supersededBy } : {}) } })
}

export function publicationPlan(record, { expectedRevision, destination, targetScope, targetPath, expectedTargetRevision }, context) {
  const body = checked(record, expectedRevision), by = actor(context, true), now = date(context.now)
  if (body.state !== 'approved' || body.approval?.contentHash !== body.contentHash || body.review?.contentHash !== body.contentHash) fail('KNOWLEDGE_APPROVAL_REQUIRED')
  if (body.content.appliesTo.expiresAt && now >= body.content.appliesTo.expiresAt) fail('KNOWLEDGE_ALREADY_EXPIRED')
  if (!['cognee', 'memoria', 'airules'].includes(destination)) fail('KNOWLEDGE_DESTINATION_REQUIRED')
  if (['procedure', 'rule'].includes(body.content.kind) && destination !== 'airules') fail('KNOWLEDGE_RULE_OWNER_REQUIRED')
  const scope = text(targetScope, 500)
  if (scope !== body.content.appliesTo.project) fail('KNOWLEDGE_SCOPE_MISMATCH')
  let patch = null
  if (destination === 'airules') {
    const file = text(targetPath, 500)
    if (!/^(?:core|overlays|targets)\/[\p{L}\p{N}._/-]+\.(?:md|json)$/u.test(file) || file.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('KNOWLEDGE_RULE_PATH_INVALID')
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(expectedTargetRevision ?? '')) fail('KNOWLEDGE_TARGET_REVISION_REQUIRED')
    patch = { path: file, expectedRevision: expectedTargetRevision, proposedText: body.content.statement }
  }
  const value = { schemaVersion: 1, proposalId: body.id, proposalRevision: record.revision, contentHash: body.contentHash, destination, targetScope: scope, actor: by, plannedAt: now, operation: destination === 'airules' ? 'review-patch' : 'remember', content: body.content, ...(patch ? { patch } : {}), requiresNativeApproval: true, automaticallyMirror: false }
  return { ...value, intentId: `knowledge-${digest(canonical(value))}` }
}

/**
 * The ledger must be the existing native session journal (CAS claim+settle),
 * never a second fact store. No default adapter, credentials or fallback route.
 * Store outcome-unknown BEFORE dispatch so an interrupted/uncertain send cannot
 * be blindly retried. A backend receipt is not evidence of searchable indexing.
 */
export async function executePublication(plan, { authorize, adapter, ledger, signal } = {}) {
  if (!plain(plan) || !/^knowledge-[a-f0-9]{64}$/.test(plan.intentId ?? '')) fail('KNOWLEDGE_PLAN_INVALID')
  const { intentId, ...body } = plan
  if (intentId !== `knowledge-${digest(canonical(body))}` || !['cognee', 'memoria', 'airules'].includes(plan.destination) || plan.automaticallyMirror !== false || plan.requiresNativeApproval !== true) fail('KNOWLEDGE_PLAN_INVALID')
  if (typeof authorize !== 'function' || typeof adapter !== 'function' || typeof ledger?.claim !== 'function' || typeof ledger?.settle !== 'function') fail('KNOWLEDGE_NATIVE_ADAPTER_REQUIRED')
  const guard = async () => { if (signal?.aborted) fail('KNOWLEDGE_CANCELLED'); if (await authorize(structuredClone(plan)) !== true) fail('KNOWLEDGE_NATIVE_APPROVAL_REQUIRED'); if (signal?.aborted) fail('KNOWLEDGE_CANCELLED') }
  await guard()
  const identity = { proposalId: plan.proposalId, proposalRevision: plan.proposalRevision, destination: plan.destination, targetScope: plan.targetScope, contentHash: plan.contentHash }
  // A distinct plan timestamp must not evade the duplicate key.
  const operationId = `knowledge-write-${digest(canonical(identity))}`
  if (await ledger.claim(operationId, { ...identity, state: 'outcome-unknown' }) !== true) fail('KNOWLEDGE_PUBLICATION_RECONCILE_REQUIRED')
  try { await guard() }
  catch (error) { await ledger.settle(operationId, { state: 'not-sent' }); throw error }
  let result
  try { result = await adapter(structuredClone(plan), { signal, operationId }) }
  catch { return { operationId, destination: plan.destination, state: 'outcome-unknown', retrySafe: false, indexed: false } }
  // An adapter must give the actual destination/scope and an opaque source ID.
  // Upstream text/errors are not reflected into the session receipt.
  if (!plain(result) || result.destination !== plan.destination || result.targetScope !== plan.targetScope || !['accepted', 'review-patch-created'].includes(result.state) || typeof result.sourceId !== 'string' || !result.sourceId || result.sourceId.length > 256 || /[\r\n\0]/.test(result.sourceId) || (plan.destination === 'airules') !== (result.state === 'review-patch-created')) {
    return { operationId, destination: plan.destination, state: 'outcome-unknown', retrySafe: false, indexed: false }
  }
  const receipt = { operationId, destination: plan.destination, targetScope: plan.targetScope, state: result.state, sourceId: result.sourceId, retrySafe: false, indexed: false }
  try { await ledger.settle(operationId, receipt) }
  catch { return { operationId, destination: plan.destination, state: 'outcome-unknown', retrySafe: false, indexed: false } }
  return receipt
}
