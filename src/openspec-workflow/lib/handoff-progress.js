import { createHandoff } from '@j1nn0/agent-handoff'
import { judgeProgress } from '@j1nn0/agent-progress'

const OPEN_SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VALID_TASK_STATUS = new Set(['pending', 'in-progress', 'done', 'blocked', 'cancelled'])

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function stableId(value, code) {
  if (typeof value !== 'string' || !OPEN_SPEC_ID.test(value)) fail(code)
  return value
}

function nonBlank(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code)
  return value
}

function taskFacts(change) {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) fail('OPENSPEC_CHANGE_REQUIRED')
  const changeId = stableId(change.id, 'OPENSPEC_CHANGE_ID_REJECTED')
  if (!Array.isArray(change.taskItems)) fail('OPENSPEC_TASKS_REQUIRED')
  const seen = new Set()
  const tasks = change.taskItems.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail('OPENSPEC_TASK_REJECTED')
    const taskId = stableId(item.id, 'OPENSPEC_TASK_ID_REJECTED')
    if (seen.has(taskId)) fail('OPENSPEC_TASK_ID_DUPLICATE')
    seen.add(taskId)
    if (!VALID_TASK_STATUS.has(item.status)) fail('OPENSPEC_TASK_STATUS_REJECTED')
    const evidence = item.evidence === null || item.evidence === undefined
      ? null
      : nonBlank(item.evidence, 'OPENSPEC_TASK_EVIDENCE_REJECTED')
    return Object.freeze({
      id: taskId,
      ref: `${changeId}:${taskId}`,
      status: item.status,
      evidence,
    })
  })
  return Object.freeze({ changeId, tasks: Object.freeze(tasks) })
}

function uniqueStrings(values, code) {
  if (values === undefined) return []
  if (!Array.isArray(values)) fail(code)
  const seen = new Set()
  const result = []
  for (const value of values) {
    const item = nonBlank(value, code)
    if (!seen.has(item)) {
      seen.add(item)
      result.push(item)
    }
  }
  return result
}

function frozenVerdict(scope, verdict) {
  const value = { scope, ...verdict }
  for (const key of ['newMilestones', 'withdrawnMilestones', 'recordedMilestones']) {
    if (Array.isArray(value[key])) value[key] = Object.freeze([...value[key]])
  }
  return Object.freeze(value)
}

/**
 * Narrow DSH/OpenSpec adapter over the dependency-free Agent Handoff and Agent
 * Progress cores. It owns no goal or subagent lifecycle; the host services do.
 */
export class HandoffProgressController {
  constructor({ maxScopes = 64, maxMilestones = 512 } = {}) {
    if (!Number.isSafeInteger(maxScopes) || maxScopes < 1 || maxScopes > 256) fail('PROGRESS_SCOPE_BOUND_REJECTED')
    if (!Number.isSafeInteger(maxMilestones) || maxMilestones < 1 || maxMilestones > 4096) fail('PROGRESS_MILESTONE_BOUND_REJECTED')
    this.maxScopes = maxScopes
    this.maxMilestones = maxMilestones
    this.recordedByScope = new Map()
  }

  observeOpenSpec(change, options = {}) {
    const { changeId, tasks } = taskFacts(change)
    const namespace = options.namespace === undefined ? '' : nonBlank(options.namespace, 'PROGRESS_NAMESPACE_REJECTED')
    const scopeKey = namespace === '' ? changeId : `${namespace}\0${changeId}`
    const currentMilestones = tasks.filter((task) => task.status === 'done').map((task) => task.ref)
    const externalBaseline = Object.hasOwn(options, 'hasBaseline')
    const previousMilestones = externalBaseline
      ? options.hasBaseline === true ? options.recordedMilestones : undefined
      : this.recordedByScope.get(scopeKey)
    if (externalBaseline && typeof options.hasBaseline !== 'boolean') fail('PROGRESS_BASELINE_FLAG_REJECTED')
    const verdict = judgeProgress({
      ...(previousMilestones === undefined ? {} : { previous: { milestones: previousMilestones } }),
      current: { milestones: currentMilestones },
    })
    if (verdict.recordedMilestones.length > this.maxMilestones) fail('PROGRESS_MILESTONE_BOUND_EXCEEDED')
    if (!this.recordedByScope.has(scopeKey) && this.recordedByScope.size >= this.maxScopes) {
      const oldest = this.recordedByScope.keys().next().value
      this.recordedByScope.delete(oldest)
    }
    this.recordedByScope.delete(scopeKey)
    this.recordedByScope.set(scopeKey, Object.freeze([...verdict.recordedMilestones]))
    return frozenVerdict(changeId, verdict)
  }

  createOpenSpecHandoff({ id, source, destination, goal, change, constraints } = {}) {
    if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) fail('NATIVE_GOAL_REQUIRED')
    const objective = nonBlank(goal.objective, 'NATIVE_GOAL_OBJECTIVE_REQUIRED')
    const phase = nonBlank(goal.phase, 'NATIVE_GOAL_PHASE_REQUIRED')
    const { changeId, tasks } = taskFacts(change)
    const optionalDestination = destination === undefined
      ? {}
      : { destination: nonBlank(destination, 'HANDOFF_DESTINATION_REJECTED') }
    const callerConstraints = uniqueStrings(constraints, 'HANDOFF_CONSTRAINT_REJECTED')
    const openItems = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').map((task) => task.ref)
    const evidenceReferences = tasks
      .filter((task) => task.status === 'done' && task.evidence !== null)
      .map((task) => `${task.ref}:${task.evidence}`)
    const packet = createHandoff({
      schemaVersion: 1,
      id: stableId(id, 'HANDOFF_ID_REJECTED'),
      source: nonBlank(source, 'HANDOFF_SOURCE_REJECTED'),
      ...optionalDestination,
      goal: objective,
      constraints: [
        `openspec-change:${changeId}`,
        `goal-phase:${phase}`,
        'handoff-does-not-complete-task',
        ...tasks.filter(task => task.status === 'cancelled').map(task => `cancelled-task:${task.ref}`),
        ...callerConstraints,
      ],
      openItems,
      evidenceReferences,
    })
    return Object.freeze({
      status: 'handoff_recorded',
      taskCompleted: false,
      packet: Object.freeze(packet),
    })
  }

  clear() {
    this.recordedByScope.clear()
  }
}

function abortError() {
  const error = new Error('CHILD_CANCELLATION_ABORTED')
  error.name = 'AbortError'
  return error
}

async function boundedWait(promise, signal, timeoutMs) {
  if (signal?.aborted) throw signal.reason ?? abortError()
  let timer
  let onAbort
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('CHILD_CANCELLATION_TIMEOUT')), timeoutMs)
    timer.unref?.()
  })
  const aborted = new Promise((_, reject) => {
    if (!signal) return
    onAbort = () => reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Interrupt every currently registered native descendant and wait until each
 * live Agent reaches `idle`. The handoff caller must await this barrier before
 * emitting a packet; timeout/abort is a hard failure, never a partial handoff.
 */
export async function settleNativeChildren(services, parent, signal, { timeoutMs = 15_000, maxPasses = 8 } = {}) {
  if (!services?.agents || !services?.subagents || typeof services.subagents.listDescendants !== 'function') {
    fail('NATIVE_SUBAGENT_SERVICES_REQUIRED')
  }
  if (!parent || typeof parent.id !== 'string' || parent.id.length === 0) fail('NATIVE_PARENT_AGENT_REQUIRED')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('CHILD_CANCELLATION_TIMEOUT_REJECTED')
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 32) fail('CHILD_CANCELLATION_PASS_BOUND_REJECTED')

  const observed = new Set()
  let cancelled = 0
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (signal?.aborted) throw signal.reason ?? abortError()
    const descendants = await services.subagents.listDescendants(parent.id, signal)
    if (!Array.isArray(descendants)) fail('NATIVE_DESCENDANT_LIST_REJECTED')
    let acted = false
    for (const entry of descendants) {
      const childId = typeof entry === 'string' ? entry : entry?.id
      if (typeof childId !== 'string' || childId.length === 0) fail('NATIVE_DESCENDANT_ID_REJECTED')
      const child = services.agents.get(childId)
      if (!child) continue
      observed.add(childId)
      if (child.status === 'idle') continue
      acted = true
      try {
        services.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
      } catch (error) {
        if (child.status !== 'idle') throw error
      }
      child.cancel({ kind: 'parent' }, { keepInbox: true })
      cancelled += 1
      await boundedWait(Promise.resolve(child.whenIdle()), signal, timeoutMs)
      if (child.status !== 'idle') fail('CHILD_CANCELLATION_NOT_SETTLED')
    }
    const liveNotIdle = [...observed].some((id) => {
      const child = services.agents.get(id)
      return child && child.status !== 'idle'
    })
    if (!acted && !liveNotIdle) {
      return Object.freeze({ status: 'settled', observed: Object.freeze([...observed]), cancelled })
    }
  }
  fail('CHILD_CANCELLATION_PASS_BOUND_EXCEEDED')
}
