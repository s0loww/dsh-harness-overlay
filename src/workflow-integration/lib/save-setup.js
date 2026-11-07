import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath, writeFile, rename, unlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { readProject, BINDING_PATH } from './project.js'
import { previewSetup } from './setup.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
export async function bindingRevision(scope, core) {
  try { return hash(await core.safeRead(scope.root, await core.projectPath(scope.root, BINDING_PATH), 1024 * 1024)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function mergeConfiguration(existing, draft, core, fixture) {
  if (!existing) return draft
  if (!fixture && existing.projectId !== draft.projectId) fail('SETUP_PROJECT_ID_CONFLICT')
  const merged = JSON.parse(core.canonical(existing)), runners = {}, providers = {}
  for (const field of ['runners', 'providers', 'workflows']) merged[field] ??= {}
  function register(group, id, value, reserved = new Set()) {
    if (!Object.hasOwn(group, id) && !reserved.has(id)) { group[id] = value; return id }
    if (!reserved.has(id) && Object.hasOwn(group, id) && core.canonical(group[id]) === core.canonical(value)) return id
    const renamed = `${id.slice(0, 95)}-${core.digest(value).slice(0, 16)}`
    const updated = Object.hasOwn(value, 'steps') ? { ...value, id: renamed } : value
    if (reserved.has(renamed) || Object.hasOwn(group, renamed) && core.canonical(group[renamed]) !== core.canonical(updated)) fail('SETUP_MERGE_CONFLICT')
    group[renamed] = updated
    return renamed
  }
  for (const [id, value] of Object.entries(draft.runners)) runners[id] = register(merged.runners, id, value, new Set(Object.keys(existing.mcpProviders ?? {})))
  for (const [id, value] of Object.entries(draft.providers)) providers[id] = register(merged.providers, id, { ...value, adapterId: runners[value.adapterId] })
  const ids = []
  for (const [id, value] of Object.entries(draft.workflows)) {
    const workflow = { ...value, steps: value.steps.map(step => ({ ...step, adapter: providers[step.adapter],
      ...(step.resources ? { resources: step.resources.map(ref => runners[ref] ?? ref) } : {}) })) }
    ids.push(register(merged.workflows, id, workflow))
  }
  for (const field of ['sourcePaths', 'configPaths']) merged[field] = [...new Set([...(existing[field] ?? []), ...(draft[field] ?? [])])]
  return { merged, workflowId: ids[0] }
}

/** User-clicked settings save, scoped by native writable session; never starts a runner. */
export async function saveSetup({ scope, setup, revision, core, stateDir, authorizeWrite }) {
  if (!scope.writable || !(revision === null || typeof revision === 'string' && /^[a-f0-9]{64}$/u.test(revision))) fail('SETUP_WRITE_PERMISSION_REQUIRED')
  const fresh = await previewSetup(scope, core, setup)
  if (!fresh.configuration) fail('SETUP_SCENARIO_UNAVAILABLE')
  if (await bindingRevision(scope, core) !== revision) fail('STALE_BINDING')
  const project = await readProject(scope, core)
  const assembled = mergeConfiguration(project.data, fresh.configuration, core, setup.candidateId === 'deploy-fixture')
  const configuration = assembled.merged ?? assembled
  const workflowId = assembled.workflowId ?? Object.keys(configuration.workflows)[0]
  if (Object.keys(configuration.runners).length > 32 || Object.keys(configuration.workflows).length > 32
    || (configuration.sourcePaths ?? []).length > 64 || (configuration.configPaths ?? []).length > 64) fail('BINDING_LIMIT')
  for (const [id, raw] of Object.entries(configuration.workflows)) {
    const { label, ...workflow } = raw
    if (core.validateWorkflow(workflow).id !== id) fail('WORKFLOW_BINDING_INVALID')
  }
  const bytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`)
  if (bytes.length > 1024 * 1024) fail('BINDING_LIMIT')
  const root = await realpath(scope.root), parent = join(root, '.airules')
  await authorizeWrite()
  await mkdir(parent, { recursive: true })
  if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) fail('BINDING_PATH_REJECTED')
  const lock = join(parent, 'workflows.setup.lock'), temporary = join(parent, `workflows.${randomUUID()}.tmp`)
  try { await writeFile(lock, 'settings-save', { flag: 'wx', mode: 0o600 }) } catch { fail('SETUP_SAVE_BUSY') }
  try {
    if (await bindingRevision(scope, core) !== revision) fail('STALE_BINDING')
    if (revision !== null) {
      const before = await core.safeRead(root, join(parent, 'workflows.json'), 1024 * 1024)
      const backup = join(stateDir, 'setup-backups')
      await mkdir(backup, { recursive: true, mode: 0o700 })
      await writeFile(join(backup, `${randomUUID()}.json`), before, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await authorizeWrite()
    if (await bindingRevision(scope, core) !== revision) fail('STALE_BINDING')
    if (revision === null) {
      try { await link(temporary, join(parent, 'workflows.json')) } catch (error) { if (error.code === 'EEXIST') fail('STALE_BINDING'); throw error }
      await unlink(temporary)
    } else await rename(temporary, join(parent, 'workflows.json'))
    if (hash(await core.safeRead(root, join(parent, 'workflows.json'), 1024 * 1024)) !== hash(bytes)) fail('SETUP_SAVE_VERIFY_FAILED')
    return { saved: true, workflowId, bindingPath: BINDING_PATH, revision: hash(bytes) }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    await unlink(lock)
  }
}
