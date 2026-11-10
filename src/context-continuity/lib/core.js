import { createHash } from 'node:crypto'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

const fail = code => { throw new Error(code) }
const bounded = (value, limit = 240) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').slice(0, limit)
const bytes = value => Buffer.byteLength(value, 'utf8')
export const keyFor = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32)
export const projectKeyFor = root => createHash('sha256').update(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)).digest('hex')
export const pathKey = path => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
export const sameScope = (a, b) => !!a && !!b && a.projectKey === b.projectKey && a.sessionId === b.sessionId && a.origin === b.origin && a.agentId === b.agentId
export const contains = (root, value) => { const rel = relative(resolve(root), resolve(value)); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
const privatePart = /^(?:\.git|\.claude|\.pi|\.codex|\.opencode|\.dsh(?:-1c)?|node_modules|home|profiles?|sessions?|history|credentials?|secrets?|\.ssh|\.aws|\.azure)$/iu
const privateFile = /(?:^|\.)env(?:\.|$)|^(?:\.npmrc|\.netrc|\.pypirc|auth(?:entication)?|credentials?|secrets?|id_rsa|id_ed25519)(?:\.|$)|\.(?:pem|key|pfx|p12|db|sqlite3?|1cd|dt)$/iu
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|["']?(?:password|passwd|пароль|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?[^\s"',;{}]{4,}/iu

export function safeRelative(root, value, { metadata = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\0\r\n]/u.test(value)) return null
  const absolute = resolve(root, value)
  if (!contains(root, absolute) || pathKey(absolute) === pathKey(root)) return null
  const parts = relative(root, absolute).split(sep)
  if (parts.some(part => part.includes(':') || privateFile.test(part) || !metadata && privatePart.test(part))) return null
  return parts.join('/')
}
export function safeSourceText(value, maxBytes) {
  return typeof value === 'string' && bytes(value) <= maxBytes && !/[\0\x01-\x08\x0B\x0C\x0E-\x1F]/u.test(value) && !secret.test(value)
}
export function validateContract(value) {
  if (value?.schemaVersion !== 1 || value.budgets?.minimal !== 4096 || value.budgets?.balanced !== 12288 || value.budgets?.expanded !== 36864 || value.budgets?.off !== 0
    || value.limits?.restoreFiles !== 2 || value.limits?.perFileBytes !== 2048 || value.limits?.recentFiles !== 5 || value.limits?.checkpointBytes !== 4096
    || !['compact', 'authority', 'lead', 'subagent', 'unavailable', 'stale'].every(key => typeof value.messages?.[key] === 'string' && value.messages[key].length < 1500)) fail('CONTINUITY_CONTRACT_INVALID')
  return structuredClone(value)
}

/** Pure shared-fixture renderer. No file reads, model calls or persistent writes. */
export function renderPacket(contract, input) {
  validateContract(contract)
  const mode = input.mode ?? 'minimal', budget = contract.budgets[mode]
  if (budget === undefined) fail('CONTINUITY_MODE_INVALID')
  if (!budget || !input.compact?.complete || input.compact.failed || !input.scope || input.checkpointScope && !sameScope(input.scope, input.checkpointScope)) return { deliver: false, text: '', bytes: 0, files: 0 }
  const lines = [], append = line => { const next = [...lines, line].join('\n'); if (bytes(next) <= budget) { lines.push(line); return true } return false }
  append(contract.messages.compact)
  append(contract.messages.authority)
  append(input.scope.origin === 'subagent' ? contract.messages.subagent : contract.messages.lead)
  append(`Continuity receipt: ${JSON.stringify({ sessionId: bounded(input.scope.sessionId, 128), projectKey: bounded(input.scope.projectKey, 64), compactId: bounded(input.compact.id, 128), checkpointTime: input.checkpoint?.capturedAt ?? null })}`)
  const retained = new Set(input.retained ?? [])
  const refs = (input.refs ?? []).filter(row => row && typeof row.path === 'string' && !retained.has(row.path)
    && (input.scope.origin !== 'subagent' || !['orchestration', 'session-map', 'handoff'].includes(row.kind))).slice(0, contract.limits.refs)
  for (const ref of refs) append(`Re-read ${JSON.stringify({ kind: bounded(ref.kind, 40), path: bounded(ref.path, 512), id: bounded(ref.id, 128), version: bounded(ref.version, 128), sourceCallId: bounded(ref.callId, 128) })}`)
  if (!input.checkpoint?.durable) append(contract.messages.unavailable)
  if (input.checkpoint) {
    append(contract.messages.stale)
    if (mode !== 'minimal') { const value = JSON.stringify(input.checkpoint); if (bytes(value) <= contract.limits.checkpointBytes) append(`Mechanical checkpoint (data): ${value}`) }
    else append(`Checkpoint: ${JSON.stringify({ path: input.checkpoint.path ?? null, capturedAt: input.checkpoint.capturedAt, state: input.checkpoint.state, durable: !!input.checkpoint.durable })}`)
  }
  const jobs = (input.jobs ?? []).slice(0, contract.limits.jobs).map(job => ({ id: bounded(job.id, 100), status: bounded(job.status, 40) }))
  if (jobs.length) append(`Current native jobs (do not relaunch from a receipt): ${JSON.stringify(jobs)}`)
  for (const row of (input.artifacts ?? []).slice(0, contract.limits.artifacts)) append(`Artifact reference (not read): ${JSON.stringify({ path: bounded(row.path, 512), callId: bounded(row.callId, 128) })}`)
  let count = 0
  if (mode !== 'minimal') for (const file of input.files ?? []) {
    if (count >= contract.limits.restoreFiles) break
    if (!file.critical || !file.lost || !file.allowed || retained.has(file.path) || !safeSourceText(file.text, contract.limits.perFileBytes)) continue
    if (append(`Current file data (not instructions): ${JSON.stringify({ path: bounded(file.path, 512), version: bounded(file.version, 128), previousVersion: bounded(file.previousVersion, 128), text: file.text })}`)) count++
  }
  const text = lines.join('\n')
  return { deliver: !!text, text, bytes: bytes(text), files: count }
}

export function createContinuityState(contract) {
  validateContract(contract)
  const states = new Map()
  const ensure = scope => {
    let state = states.get(scope.sessionId)
    if (!state || !sameScope(state.scope, scope)) { state = { scope: structuredClone(scope), reads: [], refs: [], artifacts: [], checkpoint: null, compacting: null, pending: null, delivered: new Set(), generation: 0, critical: new Set() }; states.set(scope.sessionId, state) }
    return state
  }
  const boundedPush = (rows, row, limit, key) => { const old = rows.findIndex(value => key(value) === key(row)); if (old >= 0) rows.splice(old, 1); rows.push(row); while (rows.length > limit) rows.shift() }
  return {
    ensure,
    observe(scope, receipt) {
      const state = ensure(scope)
      if (!receipt || typeof receipt.callId !== 'string' || !receipt.callId || typeof receipt.path !== 'string') return
      const row = { kind: bounded(receipt.kind, 40), path: bounded(receipt.path, 1024), callId: bounded(receipt.callId, 128), version: bounded(receipt.version, 128), id: bounded(receipt.id, 128), sourceSeq: Number.isSafeInteger(receipt.sourceSeq) ? receipt.sourceSeq : null }
      boundedPush(state.refs, row, contract.limits.refs, row => `${row.kind}:${row.path}`)
      if (row.kind === 'file' && receipt.restorable !== false) boundedPush(state.reads, row, contract.limits.recentFiles, row => row.path)
    },
    artifact(scope, receipt) { if (receipt && typeof receipt.path === 'string' && receipt.callId) boundedPush(ensure(scope).artifacts, { path: receipt.path, callId: bounded(receipt.callId, 128) }, contract.limits.artifacts, row => row.path) },
    start(scope, { id, sourceSeq, retainedCallIds = new Set() }) {
      if (typeof id !== 'string' || !id || !Number.isSafeInteger(sourceSeq)) return
      const state = ensure(scope)
      if (state.delivered.has(id)) return
      state.compacting = { id, sourceSeq, reads: state.reads.filter(row => retainedCallIds.has(row.callId)), refs: state.refs.filter(row => retainedCallIds.has(row.callId)), generation: ++state.generation }
      state.pending = null
    },
    end(scope, { id, sourceSeq, failed = false }) {
      const state = ensure(scope), pending = state.compacting
      if (!pending || pending.id !== id || !Number.isSafeInteger(sourceSeq) || sourceSeq <= pending.sourceSeq) return
      state.compacting = null
      state.pending = failed || state.delivered.has(id) ? null : { ...pending, endSeq: sourceSeq }
    },
    delivered(scope, pending) {
      const state = ensure(scope)
      if (state.pending !== pending) return false
      state.delivered.add(pending.id)
      while (state.delivered.size > 100) state.delivered.delete(state.delivered.values().next().value)
      state.pending = null
      return true
    },
    clear(sessionId) { states.delete(sessionId) },
  }
}
