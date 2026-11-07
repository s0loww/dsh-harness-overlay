import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function optionalService(ctx, name) {
  try { return ctx?.get?.(name) ?? ctx?.[name] } catch { return undefined }
}

export function projectFeatures(ctx, target) {
  const header = target?.session?.header ?? target?.header ?? target
  const cwd = header?.cwd
  const preset = header?.agentPreset
  if (preset !== '1c-airules' || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    return { openspec: false, atlassian: false, full: false }
  }
  let enabled = true
  const binding = join(cwd, '.ai-rules.json')
  if (existsSync(binding)) {
    try {
      const stat = lstatSync(binding)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('INVALID_BINDING')
      const parsed = JSON.parse(readFileSync(binding, 'utf8').replace(/^\uFEFF/u, ''))
      const choice = parsed?.integrations?.openspec
      if (choice === false || choice?.enabled === false) enabled = false
      else if (choice !== undefined && choice !== true && (choice === null || typeof choice !== 'object' || Array.isArray(choice))) throw new Error('INVALID_BINDING')
      else if (choice?.enabled !== undefined && typeof choice.enabled !== 'boolean') throw new Error('INVALID_BINDING')
    } catch { enabled = false }
  }
  return { openspec: enabled, atlassian: false, full: false }
}

export function openSpecEnabled(ctx, target) {
  return projectFeatures(ctx, target).openspec === true
}

export function requireOpenSpec(ctx, target) {
  if (!openSpecEnabled(ctx, target)) throw new Error('OPENSPEC_DISABLED: OpenSpec отключён для этого чата. Включите плагин в настройках проекта и создайте новый чат.')
}

export function agentEffectiveMode(agent, ctx = agent?.ctx) {
  if (!agent?.session) return 'ask'
  const scope = agent.ctx ?? ctx
  const planService = optionalService(scope, 'planMode') ?? optionalService(ctx, 'planMode')
  if (typeof planService?.get === 'function') {
    const state = planService.get(agent)
    return (state.pending ?? state.active) ? 'plan' : 'build'
  }
  const projections = optionalService(scope, 'sessionProjections') ?? optionalService(ctx, 'sessionProjections')
  const state = projections?.stateOf?.(agent.session, 'plan')
  if (!state || typeof state.active !== 'boolean') return 'ask'
  const wanted = state.running?.wanted ?? state.wanted ?? state.active
  return wanted ? 'plan' : 'build'
}

export function requireBuild(ctx, agent) {
  if (!agent?.session) throw new Error('OPENSPEC_BUILD_REQUIRED')
  requireOpenSpec(ctx, agent)
  if (agentEffectiveMode(agent, ctx) !== 'build') throw new Error('OPENSPEC_BUILD_REQUIRED')
  const sandbox = optionalService(agent?.ctx, 'sandboxPolicy') ?? optionalService(ctx, 'sandboxPolicy')
  const policy = sandbox?.resolve?.({ session: agent.session })
  if (!['workspace-write', 'danger-full-access'].includes(policy?.mode)) throw new Error('OPENSPEC_WRITE_ACCESS_REQUIRED')
  if (policy.mode === 'workspace-write' && resolve(policy.workspaceRoot ?? '') !== resolve(agent.session.header.cwd)) throw new Error('OPENSPEC_WRITE_ACCESS_REQUIRED')
}

export function taskModeFor(ctx, agent) {
  if (!projectFeatures(ctx, agent).full) return null
  return optionalService(ctx, 'projectPresets')?.modeFor?.(agent)?.taskMode ?? null
}

export function taskModeLabel(mode) {
  return ({ spec: 'Спецификация', doc: 'Документация', full: 'Полный цикл', analysis: 'Анализ' })[mode] ?? mode
}

export const neutralizeTemplates = text => String(text).replace(/\{\{/gu, '{ {').replace(/\}\}/gu, '} }')
export const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve('@fission-ai/openspec'))))
export const CLI_PATH = join(CLI_ROOT, 'bin', 'openspec.js')
export const CLI_MANIFEST_PATH = join(CLI_ROOT, 'package.json')

export function buildChildPolicy({ role = 'openspec' } = {}) {
  return Object.freeze({ role, model: null, toolPolicy: 'inherit', timeoutMs: 120_000,
    cancellation: true, provenance: true, allowQuestions: false, partialIsCompleted: false })
}
