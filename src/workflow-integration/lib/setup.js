import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { BINDING_PATH } from './project.js'

const RUNNERS = [
  { id: 'agent-1c', kind: 'agent-1c', runnerPath: 'tools/agent-1c/agent-1c.ps1', profilePath: 'agent-1c.json' },
  { id: 'test-env', kind: 'test-env', runnerPath: 'scripts/RunUnitTests.ps1' },
]
const SETUP_KEYS = new Set(['candidateId', 'scenario', 'sourceKind', 'extensionName', 'exactBuild', 'sourcePath'])
const FIXTURE_ID = 'deploy-fixture'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const build = value => typeof value === 'string' && /^\d+\.\d+\.\d+\.\d+$/u.test(value) && value.length <= 64
const name = value => typeof value === 'string' && /^[\p{L}\p{N}_. -]{1,128}$/u.test(value)
const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'SETUP_INPUT_UNAVAILABLE'
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || isAbsolute(value) || /^[A-Za-z]:/u.test(value)
    || /[\x00-\x1f:*?"<>|]/u.test(value) || value.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')
    || value.split(/[\\/]/u).some(part => part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))) return null
  return value.replaceAll('\\', '/')
}
async function rootOf(scope) {
  if (!scope || typeof scope.root !== 'string' || !isAbsolute(scope.root)) fail('PROJECT_ROOT_REQUIRED')
  if ((await lstat(scope.root)).isSymbolicLink()) fail('SYMLINK_INPUT')
  const root = await realpath(scope.root)
  if (!(await lstat(root)).isDirectory()) fail('PROJECT_ROOT_REQUIRED')
  return root
}
async function fixedFile(root, rel, core, limit) {
  try {
    const path = await core.projectPath(root, rel)
    return await core.safeRead(root, path, limit)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function safeProfile(value, depth = 0) {
  if (depth > 30) fail('PROFILE_DEPTH_EXCEEDED')
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('PROFILE_UNSAFE_KEY')
    if (['password', 'token', 'apikey', 'accesstoken', 'refreshtoken', 'clientsecret'].includes(key.toLowerCase())) fail('INLINE_CREDENTIALS_NOT_SUPPORTED')
    safeProfile(child, depth + 1)
  }
}
function profileFacts(bytes) {
  let profile
  try { profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { fail('PROFILE_JSON_INVALID') }
  if (!plain(profile)) fail('PROFILE_OBJECT_REQUIRED')
  safeProfile(profile)
  const facts = { sourcePaths: [] }
  if (profile.extension?.name !== undefined && profile.extension.name !== null && profile.extension.name !== '') {
    if (!name(profile.extension.name)) fail('EXTENSION_NAME_INVALID')
    facts.sourceKind = 'extension'; facts.extensionName = profile.extension.name
  } else facts.sourceKind = 'configuration'
  const prefix = profile.platform?.versionPrefix
  if (build(prefix)) facts.exactBuild = prefix
  const source = relativePath(profile.sourceDir)
  if (source) facts.sourcePaths = [source]
  if (['file', 'server'].includes(profile.testTarget?.kind) && ['test', 'development', 'production'].includes(profile.testTarget?.environment)) {
    facts.target = { kind: profile.testTarget.kind, environment: profile.testTarget.environment }
  }
  return facts
}
async function bindingExists(root, core) {
  // Inspect the binding path itself, never read or echo its potentially private content.
  try { await core.projectPath(root, BINDING_PATH); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function projectIdOf(root) {
  const base = basename(root).replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[^A-Za-z0-9]+/u, '').slice(0, 100)
  return base || 'onec-project'
}

/** Read-only fixed-path discovery. No runner, credential references or environment files are opened. */
export async function discoverSetup(scope, core) {
  const root = await rootOf(scope), candidates = []
  for (const runner of RUNNERS) {
    try {
      if (!await fixedFile(root, runner.runnerPath, core, 2 * 1024 * 1024)) continue
      const candidate = { ...runner, sourcePaths: [], missingFields: [], reviewStatus: 'needs-review' }
      if (runner.kind === 'agent-1c') {
        const bytes = await fixedFile(root, runner.profilePath, core, 512 * 1024)
        if (bytes === null) candidate.missingFields.push('profilePath')
        else Object.assign(candidate, profileFacts(bytes))
        for (const field of ['sourceKind', 'exactBuild']) if (!candidate[field]) candidate.missingFields.push(field)
        if (!candidate.sourcePaths.length) candidate.missingFields.push('sourcePath')
        if (candidate.sourceKind === 'extension' && !candidate.extensionName) candidate.missingFields.push('extensionName')
      }
      candidates.push(candidate)
    } catch (error) {
      candidates.push({ ...runner, sourcePaths: [], missingFields: [], reviewStatus: 'unavailable', error: codeOf(error) })
    }
  }
  candidates.push({ id: FIXTURE_ID, kind: 'deploy-fixture', sourcePaths: [], missingFields: [], reviewStatus: 'configured' })
  return { bindingPath: BINDING_PATH, existingBinding: await bindingExists(root, core), candidates }
}

/** Build an explicit copyable configuration. It never writes, launches or grants trust. */
export async function previewSetup(scope, core, setup) {
  if (!plain(setup) || Object.keys(setup).some(key => !SETUP_KEYS.has(key))) fail('SETUP_FIELDS_REJECTED')
  core.canonical(setup)
  if (setup.scenario !== undefined && !['checks', 'deploy'].includes(setup.scenario)) fail('SETUP_SCENARIO_INVALID')
  if (setup.candidateId === FIXTURE_ID) {
    if (Object.keys(setup).some(key => key !== 'candidateId')) fail('SETUP_FIELDS_REJECTED')
    // The built-in fixture needs no runner/profile/source/platform discovery and never reads credentials.
    const root = await rootOf(scope), existingBinding = await bindingExists(root, core)
    const configuration = { schemaVersion: 1, projectId: projectIdOf(root), sourcePaths: [], configPaths: [],
      providers: { deploy: { adapterId: 'deploy-stub' } },
      runners: { 'deploy-stub': { schemaVersion: 1, kind: 'deploy-fixture', outcome: 'pass' } },
      workflows: { 'deploy-fixture': { schemaVersion: 1, id: 'deploy-fixture', label: 'Проверка исполнителя на заглушке', version: '0.1.0',
        steps: [{ id: 'apply', adapter: 'deploy', operation: 'deploy-apply', resources: ['deploy-stub'], timeoutMs: 60000 }] } } }
    const notes = ['Подготовлен сценарий встроенной заглушки деплоя: 1С, реальные базы, службы и проектные runners не используются.',
      'Заглушка проверяет путь исполнения и формирование результата. Успешная заглушка не доказывает готовность реального деплоя.',
      'Это только предпросмотр: файл не записан, сценарий не запущен. После сохранения запуск заглушки выполняет агент с текущими правами DSH.']
    if (existingBinding) notes.unshift('Действующие сценарии сохранятся. При конфликте имён новый сценарий получит отдельное имя.')
    return { bindingPath: BINDING_PATH, existingBinding, configuration, notes }
  }
  if (!RUNNERS.some(item => item.id === setup.candidateId)) fail('SETUP_RUNNER_NOT_FOUND')
  if (setup.sourceKind !== undefined && !['configuration', 'extension'].includes(setup.sourceKind)) fail('SOURCE_KIND_REQUIRED')
  if (setup.exactBuild !== undefined && !build(setup.exactBuild)) fail('EXACT_BUILD_REQUIRED')
  if (setup.extensionName !== undefined && setup.extensionName !== '' && !name(setup.extensionName)) fail('EXTENSION_NAME_REQUIRED')
  if (setup.sourcePath !== undefined && !relativePath(setup.sourcePath)) fail('SOURCE_PATH_REQUIRED')
  const discovery = await discoverSetup(scope, core)
  const candidate = discovery.candidates.find(item => item.id === setup.candidateId)
  if (!candidate) fail('SETUP_RUNNER_NOT_FOUND')
  if (candidate.error) fail(candidate.error)
  if (candidate.kind === 'test-env') return { bindingPath: BINDING_PATH, existingBinding: discovery.existingBinding,
    configuration: null, notes: ['TestEnv найден. Его unit-сценарий импортирует конфигурацию и изменяет тестовую базу.',
      'Запуск TestEnv в текущей версии не подключён. Конфигурация готовых проверок для него не создаётся.'] }
  if (candidate.missingFields.includes('profilePath')) fail('PROFILE_REQUIRED')
  const sourceKind = setup.sourceKind ?? candidate.sourceKind
  const exactBuild = setup.exactBuild ?? candidate.exactBuild
  const extensionName = setup.extensionName ?? candidate.extensionName
  const sourcePath = relativePath(setup.sourcePath ?? candidate.sourcePaths[0])
  if (!['configuration', 'extension'].includes(sourceKind)) fail('SOURCE_KIND_REQUIRED')
  if (!build(exactBuild)) fail('EXACT_BUILD_REQUIRED')
  if (!sourcePath) fail('SOURCE_PATH_REQUIRED')
  if (!candidate.sourcePaths[0]) fail('PROFILE_SOURCE_PATH_REQUIRED')
  if (sourcePath !== candidate.sourcePaths[0]) fail('SOURCE_PATH_PROFILE_MISMATCH')
  if (sourceKind === 'extension' && !name(extensionName)) fail('EXTENSION_NAME_REQUIRED')
  if (sourceKind === 'configuration' && extensionName !== undefined && extensionName !== '') fail('CONFIGURATION_EXTENSION_CONFLICT')
  const root = await rootOf(scope)
  const source = await core.projectPath(root, sourcePath)
  if (!(await lstat(source)).isDirectory()) fail('SOURCE_DIRECTORY_REQUIRED')
  const binding = { schemaVersion: 1, kind: 'agent-1c', runnerPath: candidate.runnerPath, profilePath: candidate.profilePath,
    sourceKind, exactBuild, ...(sourceKind === 'extension' ? { extensionName } : {}) }
  const profileBytes = await fixedFile(root, candidate.profilePath, core, 512 * 1024)
  if (profileBytes === null) fail('PROFILE_REQUIRED')
  if (profileFacts(profileBytes).sourcePaths[0] !== sourcePath) fail('SOURCE_PATH_PROFILE_MISMATCH')
  const info = await core.inspectRunnerBinding({ root, binding })
  if (info.profile?.digest !== core.hashBytes(profileBytes)) fail('PROFILE_CHANGED_DURING_SETUP')
  // Project IDs are generated from the directory name only; arbitrary profile fields never leak into the draft.
  let projectId = projectIdOf(root)
  const steps = ['doctor', 'analyze'].filter(id => info.operations[id]?.supported && info.operations[id]?.configured)
    .map((id, index) => ({ id, adapter: 'checks', operation: id, timeoutMs: id === 'doctor' ? 60000 : 300000,
      ...(index ? { dependsOn: ['doctor'].filter(id => info.operations[id]?.supported && info.operations[id]?.configured) } : {}) }))
  if (!steps.length) fail('SETUP_CHECKS_UNSUPPORTED')
  let deployment
  if (setup.scenario === 'deploy') {
    if (!steps.some(step => step.id === 'doctor') || !steps.some(step => step.id === 'analyze')) fail('DEPLOY_CHECKS_REQUIRED')
    if (!info.operations['deploy-apply']?.supported || !info.operations['deploy-apply']?.configured) fail('DEPLOY_PROTOCOL_REQUIRED')
    deployment = await core.inspectDeployBinding({ root, binding })
    if (deployment.profileDigest !== info.profile.digest) fail('PROFILE_CHANGED_DURING_SETUP')
    if (typeof deployment.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(deployment.projectId)) fail('DEPLOY_PROJECT_ID_REQUIRED')
    if (!['file', 'server'].includes(deployment.target?.kind) || !['test', 'development'].includes(deployment.target?.environment)
      || typeof deployment.target?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(deployment.target.id)) fail('DEPLOY_TARGET_ENVIRONMENT_FORBIDDEN')
    projectId = deployment.projectId
    steps.push({ id: 'preview', adapter: 'checks', operation: 'deploy-preview', dependsOn: ['doctor', 'analyze'],
      resources: ['runner-onec'], timeoutMs: 300000 })
    steps.push({ id: 'apply', adapter: 'checks', operation: 'deploy-apply', dependsOn: ['preview'],
      resources: ['runner-onec'], timeoutMs: 1800000 })
  }
  const workflowId = deployment ? 'checked-deploy' : 'static-checks'
  const configuration = { schemaVersion: 1, projectId, sourcePaths: [sourcePath], configPaths: [candidate.profilePath],
    providers: { checks: { adapterId: 'runner-onec' } }, runners: { 'runner-onec': binding },
    workflows: { [workflowId]: { schemaVersion: 1, id: workflowId,
      label: deployment ? 'Проверки и обновление базы' : 'Инструменты и статический анализ', version: '0.1.0', steps } } }
  const notes = ['Это предпросмотр: файл проекта не записан, процессы и база не запускались.',
    'Сохраните сценарий кнопкой ниже. Сохранение настроек не запускает проверки или деплой.',
    'Проверка версии runner выполняется отдельно. Этот мастер не выдаёт доверие к коду и не включает деплой.',
    'Версия платформы и вид исходников заданы вами или взяты из профиля; реальная платформа и база не проверены.']
  if (discovery.existingBinding) notes.unshift('Действующие сценарии сохранятся. При конфликте имён новый сценарий получит отдельное имя.')
  if (deployment) notes.unshift('Подготовлен сценарий: готовность инструментов → статический анализ → предпросмотр → применение. Применение зависит от успешного предпросмотра; подготовка настроек не включает реальное исполнение.')
  return { bindingPath: BINDING_PATH, existingBinding: discovery.existingBinding, configuration, notes,
    inspection: { closureDigest: info.closureDigest, ...(deployment ? { target: { id: deployment.target.id, kind: deployment.target.kind, environment: deployment.target.environment } } : {}),
      operations: steps.map(step => ({ id: step.id, supported: true, configured: true })) } }
}
