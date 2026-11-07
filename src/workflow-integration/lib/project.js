import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
export const BINDING_PATH = '.airules/workflows.json'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const fail = code => { throw new Error(code) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
export async function readProject(scope, core) {
  const root = await realpath(scope.root), path = join(root, BINDING_PATH)
  try {
    const parent = await lstat(join(root, '.airules'))
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('BINDING_PATH_REJECTED')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || !inside(root, await realpath(path))) fail('BINDING_PATH_REJECTED')
  } catch (error) { if (error.code === 'ENOENT') return { root, configured: false, workflows: {}, runners: {} }; throw error }
  const bytes = await core.safeRead(root, path, 1024 * 1024)
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
  core.canonical(data)
  if (!plain(data) || Object.keys(data).some(key => !['schemaVersion', 'projectId', 'providers', 'inputs', 'workflows', 'runners', 'mcpProviders', 'sourcePaths', 'configPaths'].includes(key))
    || data.schemaVersion !== 1 || typeof data.projectId !== 'string' || !ID.test(data.projectId) || !plain(data.providers) || !plain(data.workflows) || !plain(data.runners)) fail('WORKFLOW_BINDING_INVALID')
  for (const paths of [data.sourcePaths ?? [], data.configPaths ?? []]) {
    if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/u).includes('..') || path.includes('\0'))) fail('WORKFLOW_BINDING_INVALID')
  }
  if (Object.keys(data.runners).length > 32 || Object.keys(data.workflows).length > 32) fail('BINDING_LIMIT')
  if (data.mcpProviders !== undefined && (!plain(data.mcpProviders) || Object.keys(data.mcpProviders).length > 32)) fail('BINDING_LIMIT')
  const workflows = {}, labels = {}
  for (const [id, raw] of Object.entries(data.workflows)) {
    if (!ID.test(id) || !plain(raw)) fail('WORKFLOW_BINDING_INVALID')
    const { label, ...workflow } = raw
    if (label !== undefined && (typeof label !== 'string' || label.length > 160 || /[\r\n\0]/u.test(label))) fail('WORKFLOW_BINDING_INVALID')
    workflows[id] = core.validateWorkflow(workflow)
    if (workflows[id].id !== id) fail('WORKFLOW_BINDING_INVALID')
    labels[id] = label ?? id
  }
  for (const [id, provider] of Object.entries(data.providers)) {
    if (!ID.test(id) || !plain(provider) || Object.keys(provider).some(key => key !== 'adapterId') || typeof provider.adapterId !== 'string' || !ID.test(provider.adapterId)) fail('WORKFLOW_BINDING_INVALID')
  }
  return { root, configured: true, data, workflows, labels, runners: data.runners }
}
