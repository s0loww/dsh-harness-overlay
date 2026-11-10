import { createHash } from 'node:crypto'

export const LIMITS = Object.freeze({ tasks: 3, files: 24, fixtureBytes: 256 * 1024, skillBytes: 128 * 1024, calls: 96, readBytes: 128 * 1024, writeBytes: 128 * 1024, finalBytes: 4096, timeoutMs: 60_000 })
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(code) }
const safeError = error => /^SKILL_EVAL_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'SKILL_EVAL_RUNNER_ERROR'
const plain = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const bytes = text => Buffer.byteLength(text, 'utf8')
const clone = value => JSON.parse(JSON.stringify(value))
const immutable = value => { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value) } return value }
export function fixturePath(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || /[\\:\x00-\x1f]/u.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) fail('SKILL_EVAL_PATH_REJECTED')
  return value
}
function files(value, maxBytes) {
  if (!plain(value) || Object.keys(value).length > LIMITS.files) fail('SKILL_EVAL_FILES_INVALID')
  const result = Object.create(null); let total = 0
  for (const key of Object.keys(value).sort()) {
    fixturePath(key)
    if (typeof value[key] !== 'string' || (total += bytes(value[key])) > maxBytes) fail('SKILL_EVAL_FILES_INVALID')
    result[key] = value[key]
  }
  return result
}
function skill(value) {
  if (!plain(value) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.name ?? '') || typeof value.description !== 'string' || !value.description.trim() || bytes(value.description) > 4096) fail('SKILL_EVAL_SKILL_INVALID')
  const content = files(value.files, LIMITS.skillBytes)
  if (!Object.hasOwn(content, 'SKILL.md')) fail('SKILL_EVAL_SKILL_INVALID')
  const revision = hash(JSON.stringify(content))
  if (value.revision && value.revision !== revision) fail('SKILL_EVAL_REVISION_MISMATCH')
  return { name: value.name, description: value.description, files: content, revision }
}
/** No discovery, project reads, subprocesses, credentials or provider calls occur while planning. */
export function planEvaluation({ current, previous = null, tasks, modelId = null }) {
  const active = skill(current), prior = previous ? skill(previous) : null
  if (prior && prior.name !== active.name) fail('SKILL_EVAL_SKILL_MISMATCH')
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > LIMITS.tasks) fail('SKILL_EVAL_TASK_COUNT')
  if (modelId !== null && (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 160)) fail('SKILL_EVAL_MODEL_INVALID')
  const ids = new Set()
  const normalized = tasks.map(task => {
    if (!plain(task) || !/^[a-z0-9-]{1,64}$/u.test(task.id ?? '') || ids.has(task.id) || typeof task.prompt !== 'string' || !task.prompt.trim() || bytes(task.prompt) > 8192 || !['positive', 'near-miss'].includes(task.kind)) fail('SKILL_EVAL_TASK_INVALID')
    ids.add(task.id)
    const input = files(task.files ?? {}, LIMITS.fixtureBytes), expected = files(task.expectedFiles ?? {}, LIMITS.fixtureBytes)
    if (Object.keys(expected).length === 0 && !task.finalIncludes?.length) fail('SKILL_EVAL_ASSERTIONS_REQUIRED')
    if (task.finalIncludes !== undefined && (!Array.isArray(task.finalIncludes) || task.finalIncludes.length > 12 || task.finalIncludes.some(text => typeof text !== 'string' || !text || bytes(text) > 256))) fail('SKILL_EVAL_ASSERTIONS_INVALID')
    const fixtureSteps = task.fixtureSteps ?? []
    if (!Array.isArray(fixtureSteps) || fixtureSteps.length > 24) fail('SKILL_EVAL_FIXTURE_STEPS_INVALID')
    const steps = fixtureSteps.map(step => {
      if (!plain(step) || !['read', 'read-skill', 'write', 'replace', 'final'].includes(step.op)) fail('SKILL_EVAL_FIXTURE_STEPS_INVALID')
      if (step.whenSkill !== undefined && typeof step.whenSkill !== 'boolean') fail('SKILL_EVAL_FIXTURE_STEPS_INVALID')
      const normalized = { op: step.op, whenSkill: step.whenSkill ?? false }
      if (step.op !== 'final') normalized.path = fixturePath(step.path ?? (step.op === 'read-skill' ? 'SKILL.md' : ''))
      for (const key of step.op === 'replace' ? ['from', 'to'] : ['write', 'final'].includes(step.op) ? ['text'] : []) {
        if (typeof step[key] !== 'string' || bytes(step[key]) > 8192 || (key === 'from' && !step[key])) fail('SKILL_EVAL_FIXTURE_STEPS_INVALID')
        normalized[key] = step[key]
      }
      return normalized
    })
    return { id: task.id, kind: task.kind, prompt: task.prompt, files: input, expectedFiles: expected, finalIncludes: task.finalIncludes ?? [], fixtureSteps: steps }
  })
  if (!normalized.some(task => task.kind === 'near-miss') || !normalized.some(task => task.kind === 'positive')) fail('SKILL_EVAL_NEAR_MISS_REQUIRED')
  const variants = [{ label: 'current', skill: active }, ...(prior ? [{ label: 'previous', skill: prior }] : []), { label: 'no-skill', skill: null }]
  const data = { schemaVersion: 1, name: active.name, modelId, tasks: normalized, variants, limits: LIMITS, sessions: normalized.length * variants.length }
  return immutable({ ...data, planId: hash(JSON.stringify(data)) })
}

function truncate(text, maximum) {
  let value = String(text ?? '')
  while (bytes(value) > maximum) value = value.slice(0, Math.floor(value.length * 0.9))
  return value
}
/** Only paths, sizes and outcomes enter the trace, never file bodies or tool arguments. */
export function createFixtureIO(task, variant, limits = LIMITS) {
  const workspace = new Map(Object.entries(task.files)), skillFiles = new Map(Object.entries(variant.skill?.files ?? {}))
  const trace = []; let readBytes = 0, writeBytes = 0, closed = false, skillRead = false, violation = null
  function call(name, path, body) {
    if (closed) fail('SKILL_EVAL_SESSION_CLOSED')
    if (trace.length >= limits.calls) { violation = 'SKILL_EVAL_TOOL_BUDGET'; fail(violation) }
    const row = { seq: trace.length + 1, name, path: '', bytes: 0, ok: false }; trace.push(row)
    try { row.path = fixturePath(path); const result = body(row); row.ok = true; return result }
    catch (error) { violation ??= String(error.message); throw error }
  }
  function read(map, name, path) {
    return call(name, path, row => {
      if (!map.has(path)) fail('SKILL_EVAL_FILE_MISSING')
      const value = map.get(path); row.bytes = bytes(value)
      if ((readBytes += row.bytes) > limits.readBytes) fail('SKILL_EVAL_READ_BUDGET')
      if (name === 'skill_read') skillRead = true
      return value
    })
  }
  return {
    tools: Object.freeze({
      read: path => read(workspace, 'fixture_read', path),
      readSkill: (path = 'SKILL.md') => read(skillFiles, 'skill_read', path),
      write: (path, content) => call('fixture_write', path, row => {
        if (typeof content !== 'string') fail('SKILL_EVAL_CONTENT_INVALID')
        row.bytes = bytes(content)
        if ((writeBytes += row.bytes) > limits.writeBytes) fail('SKILL_EVAL_WRITE_BUDGET')
        if (!workspace.has(path) && workspace.size >= limits.files) fail('SKILL_EVAL_FILE_BUDGET')
        workspace.set(path, content)
        return { bytes: row.bytes }
      }),
    }),
    close: () => { closed = true },
    inspect: () => ({ trace: clone(trace), skillRead, readBytes, writeBytes, violation, files: Object.fromEntries(workspace) }),
  }
}

function inspectOutcome(task, variant, io, raw) {
  const state = io.inspect(), finalText = truncate(raw?.finalText, LIMITS.finalBytes)
  const assertions = Object.entries(task.expectedFiles).map(([path, text]) => ({ kind: 'file-equals', path, pass: state.files[path] === text, expectedSha256: hash(text), actualSha256: typeof state.files[path] === 'string' ? hash(state.files[path]) : null }))
  assertions.push(...task.finalIncludes.map(text => ({ kind: 'final-includes', expected: text, pass: finalText.includes(text) })))
  const trigger = { expected: variant.skill ? task.kind === 'positive' : false, actual: state.skillRead }
  return { finalText, modelRequests: Number.isSafeInteger(raw?.modelRequests) && raw.modelRequests >= 0 && raw.modelRequests <= 8 ? raw.modelRequests : null, trace: state.trace, skillRead: state.skillRead, trigger: { ...trigger, pass: trigger.expected === trigger.actual }, assertions, error: state.violation, pass: !state.violation && assertions.every(item => item.pass) }
}

/**
 * runner is trusted host code, not a security boundary. A model adapter MUST use
 * native restricted tools and a fresh session, and MUST cancel/dispose on abort.
 * No shell/executable adapter is accepted or launched by this package.
 */
export async function runEvaluation({ plan, runner, authorization = null, signal, timeoutMs = LIMITS.timeoutMs }) {
  if (!plan) fail('SKILL_EVAL_PLAN_CHANGED')
  const validated = planEvaluation({ current: plan.variants?.[0]?.skill, previous: plan.variants?.find(row => row.label === 'previous')?.skill, tasks: plan.tasks, modelId: plan.modelId })
  if (JSON.stringify(plan) !== JSON.stringify(validated)) fail('SKILL_EVAL_PLAN_CHANGED')
  plan = validated
  if (!runner || !['fixture', 'model'].includes(runner.kind) || typeof runner.execute !== 'function') fail('SKILL_EVAL_RUNNER_REQUIRED')
  if (runner.kind === 'model' && (!plan.modelId || runner.modelId !== plan.modelId || authorization?.run !== true || authorization?.planId !== plan.planId || authorization?.modelId !== plan.modelId || typeof runner.cancel !== 'function')) fail('SKILL_EVAL_EXPLICIT_MODEL_RUN_REQUIRED')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) fail('SKILL_EVAL_TIMEOUT_INVALID')
  const rows = []; let interrupted = null
  for (const task of plan.tasks) {
    for (const variant of plan.variants) {
      if (signal?.aborted) { interrupted = 'SKILL_EVAL_CANCELLED'; break }
      const io = createFixtureIO(task, variant), controller = new AbortController(), began = Date.now()
      let timer, abortListener, raw = {}, error = null
      const stopped = new Promise((_, reject) => {
        const stop = code => { controller.abort(); reject(new Error(code)) }
        timer = setTimeout(() => stop('SKILL_EVAL_TIMEOUT'), timeoutMs)
        abortListener = () => stop('SKILL_EVAL_CANCELLED')
        signal?.addEventListener('abort', abortListener, { once: true })
      })
      try {
        // The executor never receives original project/home paths or environment.
        raw = await Promise.race([Promise.resolve().then(() => runner.execute(Object.freeze({ task: immutable(clone({ id: task.id, kind: task.kind, prompt: task.prompt, fixturePaths: Object.keys(task.files) })), variant: immutable(clone({ label: variant.label, name: variant.skill?.name ?? null, revision: variant.skill?.revision ?? null, description: variant.skill?.description ?? null })), tools: io.tools, limits: LIMITS, signal: controller.signal }))), stopped])
      } catch (cause) { error = safeError(cause); if (['SKILL_EVAL_TIMEOUT', 'SKILL_EVAL_CANCELLED'].includes(error)) interrupted = error }
      finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abortListener); io.close()
        if (controller.signal.aborted && runner.kind === 'model') {
          // Do not continue the matrix if native cancellation failed.
          let cancelTimer
          try { await Promise.race([Promise.resolve().then(() => runner.cancel()), new Promise((_, reject) => { cancelTimer = setTimeout(() => reject(new Error('SKILL_EVAL_CANCEL_FAILED')), 5000) })]) }
          catch { interrupted = 'SKILL_EVAL_CANCEL_FAILED' }
          finally { clearTimeout(cancelTimer) }
        }
      }
      const outcome = inspectOutcome(task, variant, io, raw)
      if (runner.kind === 'fixture') outcome.modelRequests = 0
      else if (outcome.modelRequests === null && typeof runner.metrics === 'function') {
        const count = runner.metrics()?.modelRequests
        if (Number.isSafeInteger(count) && count >= 0 && count <= 8) outcome.modelRequests = count
      }
      rows.push({ taskId: task.id, variant: variant.label, revision: variant.skill?.revision ?? null, durationMs: Date.now() - began, ...outcome, error: error ?? outcome.error, pass: !error && outcome.pass })
      if (interrupted) break
    }
    if (interrupted) break
  }
  return immutable({ schemaVersion: 1, planId: plan.planId, name: plan.name, modelId: runner.kind === 'model' ? plan.modelId : null, execution: runner.kind, modelRequests: rows.some(row => row.modelRequests === null) ? null : rows.reduce((sum, row) => sum + row.modelRequests, 0), plannedSessions: plan.sessions, completedSessions: rows.length, interrupted, pass: !interrupted && rows.length === plan.sessions && rows.every(row => row.pass && row.trigger.pass), rows, interpretation: 'One controlled run; assertions and trigger traces are evidence, not proof of general skill quality.' })
}

function cell(value) { return String(value ?? '—').replace(/[|\r\n]/gu, ' ').replace(/[<>]/gu, '') }
export function renderEvaluationReport(result) {
  return ['# Оценка навыка', '', `Навык: ${cell(result.name)}. План: ${cell(result.planId)}.`, `Сессий: ${result.completedSessions}/${result.plannedSessions}. Исполнитель: ${result.execution}.`, '', '| Задание | Вариант | Skill прочитан | Триггер | Проверки | Ошибка |', '|---|---|---|---|---|---|', ...result.rows.map(row => `| ${cell(row.taskId)} | ${cell(row.variant)} | ${row.skillRead ? 'да' : 'нет'} | ${row.trigger.pass ? 'PASS' : 'FAIL'} | ${row.pass ? 'PASS' : 'FAIL'} | ${cell(row.error)} |`), '', 'Один прогон не доказывает улучшение качества. Сравните независимые проверки, near-miss, чтения и стоимость; решение о принятии навыка остаётся за человеком.', 'Трассы содержат только имена инструментов, относительные пути, размеры и исходы. Рассуждения модели не сохраняются.', ''].join('\n')
}
