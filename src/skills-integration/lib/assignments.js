import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, mkdir, writeFile, rename, unlink, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safePath } from './core.js'

export const ROLES = Object.freeze(['analytic', 'arch-reviewer', 'architect', 'code-reviewer', 'developer', 'doc-writer', 'error-fixer', 'explorer', 'metadata-manager', 'performance-optimizer', 'planner', 'refactoring', 'tester'])
export const TASK_TYPES = Object.freeze({ analysis: 'Анализ', planning: 'Планирование', specification: 'Спецификация / OpenSpec', architecture: 'Архитектура', implementation: 'Реализация', bugfix: 'Исправление ошибки', 'spec-review': 'Проверка по спецификации', 'code-review': 'Ревью кода', testing: 'Тестирование', verification: 'Итоговая проверка', documentation: 'Документация', refactoring: 'Рефакторинг / производительность', operations: 'Эксплуатация' })
export const ACCESS_MODES = Object.freeze({ 'read-only': 'Только чтение', 'workspace-write': 'Запись в рабочую папку', 'danger-full-access': 'Полный доступ' })
export const ROLE_TASKS = Object.freeze({ analytic: 'analysis', 'arch-reviewer': 'architecture', architect: 'architecture', 'code-reviewer': 'code-review', developer: 'implementation', 'doc-writer': 'documentation', 'error-fixer': 'bugfix', explorer: 'analysis', 'metadata-manager': 'implementation', 'performance-optimizer': 'refactoring', planner: 'planning', refactoring: 'refactoring', tester: 'testing' })
const assignments = taskTypes => ({ taskTypes, roles: [], accessModes: [] })
export const DEFAULTS = Object.freeze({
  handoff: assignments([]),
  'skill-maintainer': assignments(['documentation', 'refactoring', 'verification']),
  'security-baseline': assignments(['analysis', 'architecture', 'spec-review', 'code-review', 'verification', 'operations']),
  'architecture-evolution': assignments(['architecture', 'planning', 'refactoring', 'spec-review', 'code-review']),
  'technical-debt': assignments(['analysis', 'planning', 'architecture', 'code-review', 'refactoring']),
  caveman: assignments([]),
  'api-conventions': assignments(['architecture', 'implementation', 'code-review', 'spec-review', 'refactoring']),
  'craft-mermaid': assignments(['analysis', 'planning', 'architecture', 'documentation']),
  'creating-dsh-plugins': assignments(['architecture', 'implementation', 'bugfix', 'code-review']),
  'document-import': assignments(['analysis', 'specification', 'documentation', 'verification']),
  office: assignments(['analysis', 'documentation']),
  'office-docx': assignments(['documentation']),
  'office-xlsx': assignments(['analysis', 'documentation', 'verification']),
  'office-pptx': assignments(['documentation']),
  'office-render': assignments(['documentation', 'verification']),
  'office-recalculate': assignments(['analysis', 'documentation', 'verification']),
  'office-export-pdf': assignments(['documentation', 'verification']),
  telegram: assignments(['operations']),
  '1c-impact': assignments(['analysis', 'planning', 'architecture', 'implementation', 'bugfix', 'code-review', 'refactoring']),
  '1c-mechanism-map': assignments(['analysis', 'planning', 'architecture', 'documentation']),
  '1c-code-search': assignments(['analysis', 'implementation', 'bugfix', 'code-review', 'refactoring']),
  '1c-meta-info': assignments(['analysis', 'planning', 'architecture', 'implementation', 'code-review']),
  '1c-form-inspect': assignments(['analysis', 'implementation', 'bugfix', 'testing', 'verification']),
  '1c-platform-help': assignments(['analysis', 'implementation', 'bugfix', 'code-review']),
  '1c-templates-memory': assignments(['planning', 'implementation', 'bugfix', 'refactoring']),
  '1c-qa-testing': assignments(['planning', 'testing', 'verification']),
  '1c-form-shot': assignments(['testing', 'verification', 'documentation']),
  '1c-event-journal': assignments(['analysis', 'bugfix', 'testing', 'verification', 'operations']),
  '1c-debug-runtime': assignments(['bugfix', 'testing']),
  'mcp-1c-tools': assignments(['analysis', 'implementation', 'testing', 'operations']),
  'onec-check-mcp': assignments(['testing', 'verification', 'operations']),
  '1c-business-tests': assignments(['implementation', 'bugfix', 'testing', 'verification']),
  '1c-ui-regression': assignments(['implementation', 'bugfix', 'testing', 'verification']),
  '1c-verify-project': assignments(['planning', 'testing', 'verification', 'operations']),
  '1c-config-docs': assignments(['documentation', 'analysis', 'architecture', 'planning', 'spec-review', 'code-review', 'verification']),
  '1c-metadata-manage': assignments(['analysis', 'planning', 'architecture', 'implementation', 'bugfix', 'refactoring', 'testing', 'verification']),
  '1c-tj-analysis': assignments(['analysis', 'bugfix', 'testing', 'verification', 'operations']),
  archify: assignments(['architecture', 'analysis', 'planning', 'spec-review', 'code-review', 'refactoring']),
  'ibcmd-ibsrv': assignments(['operations', 'implementation', 'bugfix', 'testing', 'verification']),
  'img-grid-analysis': assignments(['analysis', 'spec-review', 'code-review', 'testing', 'verification', 'documentation']),
  'mermaid-diagrams': assignments(['analysis', 'planning', 'specification', 'architecture', 'documentation']),
  'openspec-propose': assignments(['planning', 'specification', 'architecture', 'documentation']),
  'openspec-explore': assignments(['analysis', 'planning', 'specification', 'architecture']),
  'openspec-apply-change': assignments(['implementation', 'bugfix', 'refactoring', 'testing']),
  'openspec-archive-change': assignments(['verification', 'documentation', 'spec-review', 'code-review']),
  'openspec-sync': assignments(['specification', 'planning', 'documentation', 'spec-review', 'code-review']),
  'openspec-update': assignments(['planning', 'specification', 'documentation', 'spec-review', 'code-review']),
  'powershell-windows': assignments([]),
  'python-airules-workflow': assignments(['planning', 'implementation', 'bugfix', 'testing', 'verification', 'refactoring']),
  'python-airules-review': assignments(['code-review', 'testing', 'verification']),
  'sysadmin-airules-review': assignments(['analysis', 'code-review', 'testing', 'verification']),
  'sysadmin-airules-operations': assignments(['operations', 'analysis', 'bugfix', 'implementation', 'testing', 'verification']),
})
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(code) }
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const known = (input, keys) => record(input) && !Object.keys(input).some(key => !keys.includes(key))
export function validateAssignment(input) {
  if (!known(input, ['taskTypes', 'roles', 'accessModes'])) fail('ASSIGNMENTS_INVALID')
  const output = {}
  for (const [axis, values] of [['taskTypes', Object.keys(TASK_TYPES)], ['roles', ROLES], ['accessModes', Object.keys(ACCESS_MODES)]]) {
    const selected = input[axis]
    if (!Array.isArray(selected) || selected.length > values.length || new Set(selected).size !== selected.length || selected.some(value => !values.includes(value))) fail('ASSIGNMENTS_INVALID')
    output[axis] = values.filter(value => selected.includes(value))
  }
  return output
}
function validateStore(input) {
  if (!known(input, ['schemaVersion', 'overrides']) || input.schemaVersion !== 1 || !record(input.overrides) || Object.keys(input.overrides).length > 2000) fail('ASSIGNMENTS_INVALID')
  const overrides = {}
  for (const [name, value] of Object.entries(input.overrides)) {
    if (!namePattern.test(name) || name.length > 100) fail('ASSIGNMENTS_INVALID')
    overrides[name] = validateAssignment(value)
  }
  return { schemaVersion: 1, overrides }
}
async function readDocument(anchor, file, validate) {
  await safePath(anchor, file)
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) fail('ASSIGNMENTS_INVALID')
    const raw = await readFile(file, 'utf8')
    let value; try { value = JSON.parse(raw) } catch { fail('ASSIGNMENTS_INVALID') }
    return { value: validate(value), revision: hash(raw), raw }
  } catch (error) { if (error.code === 'ENOENT') return { value: null, revision: null, raw: null }; throw error }
}
async function writeDocument({ anchor, file, revision, value, backupRoot, validate }) {
  await safePath(anchor, file)
  await mkdir(dirname(file), { recursive: true })
  await safePath(anchor, file)
  const lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(lock, 'wx').catch(error => { if (error.code === 'EEXIST') fail('ASSIGNMENTS_BUSY'); throw error })
  try {
    const current = await readDocument(anchor, file, validate)
    if (current.revision !== revision) fail('STALE_ASSIGNMENTS')
    const data = validate(value)
    const raw = `${JSON.stringify(data, null, 2)}\n`
    if (Buffer.byteLength(raw) > 512 * 1024) fail('ASSIGNMENTS_INVALID')
    const folder = join(backupRoot, randomUUID())
    await safePath(dirname(backupRoot), folder); await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'receipt.json'), JSON.stringify({ schemaVersion: 1, file, revision: current.revision }), { flag: 'wx', mode: 0o600 })
    if (current.raw !== null) await writeFile(join(folder, 'settings.json'), current.raw, { flag: 'wx', mode: 0o600 })
    await writeFile(temp, raw, { flag: 'wx', mode: 0o600 })
    await safePath(anchor, file)
    if ((await readDocument(anchor, file, validate)).revision !== revision) fail('STALE_ASSIGNMENTS')
    await rename(temp, file)
    return { value: data, revision: hash(raw) }
  } finally { await unlink(temp).catch(() => {}); await handle.close(); await unlink(lock).catch(() => {}) }
}
export function effectiveAssignments(common = {}, project = {}) { return { ...DEFAULTS, ...common, ...project } }
export function selectCatalog(entries, context, rules) {
  return entries.filter(entry => {
    const assignment = Object.hasOwn(rules, entry.name) ? rules[entry.name] : undefined
    if (!assignment) return true
    return (!assignment.taskTypes.length || context.taskType === 'all' || assignment.taskTypes.includes(context.taskType))
      && (!assignment.roles.length || !context.role || assignment.roles.includes(context.role))
      && (!assignment.accessModes.length || assignment.accessModes.includes(context.accessMode))
  })
}
export function delegatedRole(session) {
  if (!session?.header?.parentSession || typeof session.eventAt !== 'function' || !Number.isInteger(session.seq)) return null
  const start = Math.max(0, session.inheritedEventCount ?? session.header.inheritedEventCount ?? 0)
  // Never interpret a parent's inherited descriptor or a chat/prompt string.
  for (let index = start; index < session.seq; index++) {
    const event = session.eventAt(index)
    if (event?.type !== 'subagent/descriptor') continue
    const data = event.data
    if (data?.version !== 3 || data.provider !== 'spawn' || !['one-shot', 'continuable'].includes(data.mode) || typeof data.label !== 'string') return null
    const role = data.label.startsWith('airules-role:') ? data.label.slice('airules-role:'.length) : null
    return ROLES.includes(role) ? role : null
  }
  return null
}
export function taskContext({ selected = 'auto', role = null, plan = false, accessMode }) {
  if (!['auto', 'all', ...Object.keys(TASK_TYPES)].includes(selected) || !Object.hasOwn(ACCESS_MODES, accessMode)) fail('ASSIGNMENTS_INVALID')
  const taskType = selected !== 'auto' ? selected : plan ? 'planning' : Object.hasOwn(ROLE_TASKS, role) ? ROLE_TASKS[role] : 'all'
  return { selectedTaskType: selected, taskType, role, accessMode, nativePlan: plan, source: selected !== 'auto' ? 'session' : plan ? 'native-plan' : role ? 'delegated-role' : 'full-catalog' }
}
export function createAssignmentStore(home) {
  const commonFile = join(home, 'skill-assignments', 'settings.json'), backupRoot = join(home, 'skill-assignments', 'backups')
  const target = (root, scope) => scope === 'global' ? { anchor: home, file: commonFile }
    : scope === 'project' && root ? { anchor: root, file: join(root, '.dsh', 'skill-assignments.json') } : fail('ASSIGNMENTS_INVALID')
  return {
    async snapshot(root) {
      const common = await readDocument(home, commonFile, validateStore)
      const project = root ? await readDocument(root, join(root, '.dsh', 'skill-assignments.json'), validateStore) : { value: null, revision: null }
      return { common: { revision: common.revision, overrides: common.value?.overrides ?? {} }, project: { revision: project.revision, overrides: project.value?.overrides ?? {} }, effective: effectiveAssignments(common.value?.overrides, project.value?.overrides), defaults: DEFAULTS }
    },
    async save(root, body) {
      if (!['project', 'global'].includes(body.scope) || typeof body.skill !== 'string' || !namePattern.test(body.skill) || body.skill.length > 100 || !['set', 'reset'].includes(body.change)) fail('ASSIGNMENTS_INVALID')
      const location = target(root, body.scope), current = await readDocument(location.anchor, location.file, validateStore)
      if (body.revision !== current.revision) fail('STALE_ASSIGNMENTS')
      const overrides = { ...current.value?.overrides }
      if (body.change === 'reset') delete overrides[body.skill]
      else overrides[body.skill] = validateAssignment(body.assignment)
      return writeDocument({ ...location, revision: body.revision, value: { schemaVersion: 1, overrides }, backupRoot, validate: validateStore })
    },
    async context(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) fail('SESSION_REQUIRED')
      const file = join(home, 'skill-assignments', 'sessions', `${hash(sessionId)}.json`)
      const validate = value => { if (!known(value, ['schemaVersion', 'sessionId', 'taskType']) || value.schemaVersion !== 1 || value.sessionId !== sessionId || !['auto', 'all', ...Object.keys(TASK_TYPES)].includes(value.taskType)) fail('ASSIGNMENTS_INVALID'); return value }
      const doc = await readDocument(home, file, validate)
      return { selected: doc.value?.taskType ?? 'auto', revision: doc.revision, file, validate }
    },
    async setContext(sessionId, body) {
      const context = await this.context(sessionId)
      return writeDocument({ anchor: home, file: context.file, revision: body.revision, value: { schemaVersion: 1, sessionId, taskType: body.taskType }, backupRoot, validate: context.validate })
    },
  }
}
