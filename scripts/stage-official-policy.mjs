import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPackageClosure, stagePackageClosure } from './stage-package-closure.mjs'
import { stageSharedSkills, SHARED_SKILLS } from './stage-shared-skills.mjs'
import { stageDocumentClosure } from './stage-document-closure.mjs'
import { stageNativeFsCompat, COMPAT_PACKAGE } from './stage-native-fs-compat.mjs'
import { stageProviderExtensionsDependencies } from './stage-provider-extensions.mjs'
import {stageGitMaintenanceRuntime} from './stage-git-maintenance-runtime.mjs'
import { adaptOnecLspPackage } from '../src/onec-lsp-compat/patch.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_LOCK = join(REPO, 'upstream', 'official-desktop', 'release.lock.json')
const PROVIDER = join(REPO, 'src', 'airules-provider')
const PRESET = join(REPO, 'src', 'official-preset')
const ONEC_MECHANICS = join(REPO, 'src', 'official-onec-mechanics')
const OPENSPEC = join(REPO, 'src', 'openspec-workflow')
const OPENSPEC_LOCK = join(REPO, 'upstream', 'openspec-closure.lock.json')
const TELEGRAM = join(REPO, 'src', 'telegram')
const ACP = join(REPO, 'src', 'acp')
const ACP_LOCK = join(REPO, 'upstream', 'acp-closure.lock.json')
const SUBSCRIPTIONS = join(REPO, 'src', 'subscriptions')
const SUBSCRIPTIONS_LOCK = join(REPO, 'upstream', 'subscriptions-closure.lock.json')
const MOBILE = join(REPO, 'src', 'mobile-access')
const MOBILE_LOCK = join(REPO, 'upstream', 'mobile-closure.lock.json')
const MCP_MANAGER = join(REPO, 'src', 'mcp-manager')
const ADDITIONAL_PROVIDERS = join(REPO, 'src', 'additional-providers')
const CONTEXT_CONTINUITY = join(REPO, 'src', 'context-continuity')
const MEMORY_WORKSPACE = join(REPO, 'src', 'memory-workspace')
const PORTABLE_MEMORY = [['includeHistoryRecall','airules-dsh-history-recall','history-recall'], ['includeSkillEvaluation','airules-dsh-skill-evaluation','skill-evaluation'], ['includeReviewedKnowledge','airules-reviewed-knowledge','reviewed-knowledge'], ['includeEvidenceLinks','airules-dsh-evidence-links','evidence-links'], ['includeRuntimeUtilities','airules-dsh-runtime-utilities','runtime-utilities']]
const ONEC_PANELS = join(REPO, 'src', 'onec-panels')
const PROJECT_SETTINGS = join(REPO, 'src', 'project-settings')
const MODEL_ORCHESTRATION = join(REPO, 'src', 'model-orchestration')
const DOMAIN_PRESETS = join(REPO, 'src', 'domain-presets')
const WORKFLOWS = join(REPO, 'src', 'workflow-integration')
const AGENT_IMPORT = join(REPO, 'src', 'agent-import')
const SKILLS_MANAGER = join(REPO, 'src', 'skills-integration')
const GENERAL_TOOLS = join(REPO, 'src', 'general-tools')
const DOCUMENT_WORKBENCH = join(REPO, 'src', 'document-workbench')
const ONEC_CAPABILITIES = join(REPO, 'src', 'onec-capability-workflows')
const PROVIDER_EXTENSIONS = join(REPO, 'src', 'provider-extensions')
const CURSOR_PROVIDER = join(REPO, 'src', 'cursor-provider')
const ONEC_SPECIALIZED = join(REPO, 'src', 'onec-specialized')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonicalData = value => Array.isArray(value) ? `[${value.map(canonicalData).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalData(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const digestData = value => sha256(Buffer.from(canonicalData(value)))
const WORKFLOW_RUNTIME_ROOTS = ['core/tools/workflow', 'overlays/1c/tools/workflow-onec', 'overlays/1c/tools/workflow-runners']
const runtimeExcluded = name => ['test', 'tests', '__tests__', 'node_modules', '.git'].includes(name)
  || /^\.env(?:\.|$)/iu.test(name) || /\.env$/iu.test(name)
const portable = value => typeof value === 'string' && value !== '' && !isAbsolute(value)
  && !value.split(/[\\/]/u).some(part => part === '..' || part === '')

async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
}

async function pathKind(path) {
  try {
    const value = await lstat(path)
    if (value.isDirectory()) return 'directory'
    if (value.isFile()) return 'file'
    return 'other'
  } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error }
}

/** Select only an explicitly supplied build input; never discover a user install. */
export async function resolvePolicySourceBundle(sourceBundle, environment = process.env) {
  const selected = sourceBundle === undefined ? environment.AIRULES_DSH_SOURCE_BUNDLE : sourceBundle
  if (typeof selected !== 'string' || !selected.trim() || selected.includes('\0')) {
    throw new Error('SOURCE_BUNDLE_REQUIRED: provide --source-bundle or AIRULES_DSH_SOURCE_BUNDLE')
  }
  const bundle = resolve(selected)
  for (const [path, code] of [[bundle, 'SOURCE_BUNDLE_DIRECTORY_REQUIRED'], [join(bundle, 'node_modules'), 'SOURCE_BUNDLE_NODE_MODULES_REQUIRED']]) {
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') throw new Error(code); throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code)
  }
  return bundle
}

async function filesOf(root) {
  const result = {}
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const rel = relative(root, path).split(sep).join('/')
        const bytes = await readFile(path)
        result[rel] = { bytes: bytes.length, sha256: sha256(bytes) }
      } else throw new Error(`UNSUPPORTED_PAYLOAD_ENTRY: ${entry.name}`)
    }
  }
  await visit(root)
  return result
}

// Reviewed npm-ci closure for the Windows x64 desktop artifact. The npm lock
// pins upstream tarball integrities; this digest additionally pins the actual
// installed JS/native/license bytes, including npm's installed-package receipt.
const MERMAID_LOCK_SHA256 = '99b7925020d3ea1d422995d19b8dffe9a5b19fd0fbe4310611c5ef973f85a329'
const MERMAID_MODULES_SHA256 = 'fcb4d1b2c3c547a102f1c26ebc2817a33d8a6775da8c5572e79667e0a097af57'
const MERMAID_INSTALLED = ['node_modules/@resvg/resvg-js', 'node_modules/@resvg/resvg-js-win32-x64-msvc',
  'node_modules/beautiful-mermaid', 'node_modules/elkjs', 'node_modules/entities']

export async function verifyMermaidRuntime(rulepackRoot, packageRoot) {
  const canonicalRoot = join(rulepackRoot, 'skills', 'craft-mermaid')
  const runtimeRoot = join(packageRoot, 'runtime', 'mermaid')
  for (const root of [canonicalRoot, runtimeRoot]) {
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MERMAID_SOURCE_DIRECTORY_REQUIRED')
  }
  const sourceInventory = async root => {
    const files = {}
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), rel = relative(root, path).split(sep).join('/')
        if (rel === 'SKILL.md' || rel === 'scripts/runtime/node_modules') continue
        if (entry.isSymbolicLink()) throw new Error('MERMAID_SOURCE_LINK_FORBIDDEN')
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) { const bytes = await readFile(path); files[rel] = { bytes: bytes.length, sha256: sha256(bytes) } }
        else throw new Error('MERMAID_SOURCE_REGULAR_FILE_REQUIRED')
      }
    }
    await visit(root)
    return files
  }
  const canonicalFiles = await sourceInventory(canonicalRoot), runtimeFiles = await sourceInventory(runtimeRoot)
  if (!Object.keys(canonicalFiles).length || digestData(canonicalFiles) !== digestData(runtimeFiles)) throw new Error('MERMAID_CANONICAL_SOURCE_DRIFT')
  const runtime = join(runtimeRoot, 'scripts', 'runtime'), lockBytes = await readFile(join(runtime, 'package-lock.json'))
  if (sha256(lockBytes) !== MERMAID_LOCK_SHA256) throw new Error('MERMAID_NPM_LOCK_DRIFT')
  const lock = JSON.parse(lockBytes), manifest = await readJson(join(runtime, 'package.json'))
  if (manifest.dependencies?.['beautiful-mermaid'] !== '1.1.3' || manifest.dependencies?.['@resvg/resvg-js'] !== '2.6.2' ||
      digestData(manifest.dependencies) !== digestData(lock.packages?.['']?.dependencies)) throw new Error('MERMAID_DEPENDENCY_VERSION_DRIFT')
  const modulesRoot = join(runtime, 'node_modules'), info = await lstat(modulesRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MERMAID_MODULES_DIRECTORY_REQUIRED')
  const installed = await readJson(join(modulesRoot, '.package-lock.json'))
  if (digestData(Object.keys(installed.packages ?? {}).sort()) !== digestData([...MERMAID_INSTALLED].sort())) throw new Error('MERMAID_INSTALLED_PACKAGE_DRIFT')
  const packages = []
  for (const rel of MERMAID_INSTALLED) {
    const expected = lock.packages?.[rel], actual = installed.packages[rel]
    const packageManifest = await readJson(join(runtime, rel, 'package.json'))
    if (!expected || typeof expected.integrity !== 'string' || !expected.integrity.startsWith('sha512-') ||
        ['version', 'resolved', 'integrity'].some(key => actual[key] !== expected[key]) ||
        packageManifest.name !== rel.slice('node_modules/'.length) || packageManifest.version !== expected.version) throw new Error('MERMAID_INSTALLED_PACKAGE_DRIFT')
    packages.push({ name: packageManifest.name, version: packageManifest.version, integrity: expected.integrity, license: packageManifest.license ?? null })
  }
  const modulesFiles = await filesOf(modulesRoot), modulesDigest = digestData(modulesFiles)
  if (modulesDigest !== MERMAID_MODULES_SHA256) throw new Error('MERMAID_INSTALLED_BYTES_DRIFT')
  const provenance = { schemaVersion: 1, target: 'win32-x64', source: 'embedded-rulepack/skills/craft-mermaid',
    canonicalSourceDigest: digestData(canonicalFiles), canonicalFiles,
    npmLockSha256: MERMAID_LOCK_SHA256, installedModulesDigest: modulesDigest,
    installedFiles: Object.keys(modulesFiles).length, packages }
  await writeFile(join(packageRoot, 'runtime', 'mermaid-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  return provenance
}

async function canonicalDirectory(root, rel) {
  let directory = root
  for (const part of ['', ...rel.split('/')]) {
    if (part) directory = join(directory, part)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CANONICAL_WORKFLOW_DIRECTORY_REQUIRED')
  }
  return directory
}

async function workflowFiles(root, { runner = false } = {}) {
  const files = {}; let visited = 0
  async function visit(directory, depth = 0) {
    if (++visited > 4096 || depth > 32) throw new Error('WORKFLOW_SOURCE_LIMIT')
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      if (runtimeExcluded(entry.name)) continue
      const path = join(directory, entry.name), stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('WORKFLOW_REPARSE_FORBIDDEN')
      if (stat.isDirectory()) await visit(path, depth + 1)
      else if (stat.isFile()) {
        const rel = relative(root, path).split(sep).join('/')
        if (runner && !/\.(?:ps1|psm1)$/iu.test(rel) && rel !== 'toolchain.lock.json') continue
        if (stat.size > 16 * 1024 * 1024) throw new Error('WORKFLOW_SOURCE_LIMIT')
        const bytes = await readFile(path)
        files[rel] = { bytes: bytes.length, sha256: sha256(bytes) }
      } else throw new Error('WORKFLOW_REGULAR_FILE_REQUIRED')
    }
  }
  await visit(root)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

async function stageWorkflowRuntime(canonicalRoot, packageTarget) {
  const inventories = []
  for (const rel of WORKFLOW_RUNTIME_ROOTS) {
    const source = await canonicalDirectory(canonicalRoot, rel)
    const inventory = await workflowFiles(source)
    if (!inventory['index.mjs'] || !Object.keys(inventory).length) throw new Error('CANONICAL_WORKFLOW_RUNTIME_REQUIRED')
    const target = join(packageTarget, 'runtime', rel)
    await mkdir(target, { recursive: true })
    for (const path of Object.keys(inventory)) {
      await mkdir(dirname(join(target, path)), { recursive: true })
      await cp(join(source, path), join(target, path), { force: false, errorOnExist: true })
    }
    if (canonicalData(await workflowFiles(source)) !== canonicalData(inventory)
      || canonicalData(await filesOf(target)) !== canonicalData(inventory)) throw new Error('CANONICAL_WORKFLOW_COPY_DRIFT')
    inventories.push({ source: rel, target: `runtime/${rel}`, files: Object.keys(inventory).length, inventoryDigest: digestData(inventory), inventory })
  }
  const runnerRoot = await canonicalDirectory(canonicalRoot, 'overlays/1c/tools/agent-1c')
  const inventory = await workflowFiles(runnerRoot, { runner: true })
  if (!inventory['agent-1c.ps1'] || !inventory['toolchain.lock.json'] || !inventory['lib/1c-guard.ps1']) throw new Error('REVIEWED_RUNNER_CLOSURE_REQUIRED')
  const files = Object.entries(inventory).map(([path, value]) => ({ path: `tools/agent-1c/${path}`, digest: value.sha256, bytes: value.bytes }))
  const closure = { kind: 'agent-1c', files }
  const reviewedDigest = digestData(closure)
  // Ship the exact reviewed code as well as its lock. A recipient need not have
  // the private canonical checkout to provision a new project runner.
  const bundledRunner = join(packageTarget, 'bundled', 'agent-1c')
  await mkdir(bundledRunner, { recursive: true })
  for (const [path, expected] of Object.entries(inventory)) {
    const bytes = await readFile(join(runnerRoot, path))
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('REVIEWED_RUNNER_COPY_DRIFT')
    const target = join(bundledRunner, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
  }
  if (canonicalData(await filesOf(bundledRunner)) !== canonicalData(inventory)) throw new Error('REVIEWED_RUNNER_COPY_DRIFT')
  if (canonicalData(await workflowFiles(runnerRoot, { runner: true })) !== canonicalData(inventory)) throw new Error('REVIEWED_RUNNER_COPY_DRIFT')
  await writeFile(join(packageTarget, 'runtime', 'reviewed-runners.json'), `${JSON.stringify({ schemaVersion: 1,
    policyOwner: 'project_rules', reviewedDigests: [reviewedDigest], codeClosure: closure,
    operations: ['doctor', 'analyze'], deployEnabled: false }, null, 2)}\n`, 'utf8')
  return { package: 'airules-dsh-workflows', nativeSandbox: true, deployEnabled: false, policyOwner: 'project_rules',
    provenance: { source: 'project_rules', layout: 'canonical-relative', roots: inventories },
    reviewedRunners: { kind: 'agent-1c', files: files.length, digest: reviewedDigest, operations: ['doctor', 'analyze'] } }
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) throw new Error(`ADAPTATION_ANCHOR_INVALID: ${label}`)
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

async function adaptBslEditor(editorRoot) {
  const indexPath = join(editorRoot, 'lib', 'index.js')
  const clientPath = join(editorRoot, 'lib', 'client.js')
  const source = await readFile(indexPath, 'utf8')
  const clientSource = await readFile(clientPath, 'utf8')
  const importStart = 'const { findSessionProjectRoot } = await import("dsh-1c-bundle/project-root").catch((error) => {'
  const start = source.indexOf(importStart)
  const end = start < 0 ? -1 : source.indexOf('});', start)
  if (start < 0 || end < 0 || source.indexOf(importStart, start + importStart.length) >= 0) throw new Error('EDITOR_PROJECT_ROOT_ANCHOR_INVALID')
  let adapted = source.slice(0, start) + 'import { findSessionProjectRoot } from "./airules-project-root.js";' + source.slice(end + 3)
  const sessionAnchor = 'if (!header || header.id !== sessionId || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) throw new Error("BSL_SESSION_UNAVAILABLE");'
  adapted = replaceOnce(adapted, sessionAnchor, `${sessionAnchor}\n      if (header.agentPreset !== "1c-airules") throw new Error("BSL_PRESET_REQUIRED");`, 'editor preset gate')
  const bridgeStart = clientSource.indexOf('// R130: единственный onec-bsl-intelligence, текущий буфер и отмена stale ответов.')
  const bridgeEndMarker = 'editor.onDidDispose(() => { bridgeDisposed = true; clearTimeout(diagnosticTimer); diagModelSub.dispose(); diagChangeSub.dispose(); hoverBridge.dispose(); });'
  const bridgeEnd = bridgeStart < 0 ? -1 : clientSource.indexOf(bridgeEndMarker, bridgeStart)
  if (bridgeStart < 0 || bridgeEnd < 0 || clientSource.indexOf('/onec/bsl-intelligence', bridgeEnd + bridgeEndMarker.length) >= 0) {
    throw new Error('EDITOR_PRIVATE_BSL_BRIDGE_ANCHOR_INVALID')
  }
  const clientAdapted = clientSource.slice(0, bridgeStart)
    + '// Official mechanics: diagnostics/hover are provided by composition-scoped dsh-lsp-actions.\n          '
    + clientSource.slice(bridgeEnd + bridgeEndMarker.length)
  await writeFile(indexPath, adapted, 'utf8')
  await writeFile(clientPath, clientAdapted, 'utf8')
  await cp(join(ONEC_MECHANICS, 'project-root.js'), join(editorRoot, 'lib', 'airules-project-root.js'), { force: false, errorOnExist: true })
  return {
    sourceIndexSha256: sha256(Buffer.from(source)),
    stagedIndexSha256: sha256(Buffer.from(adapted)),
    sourceClientSha256: sha256(Buffer.from(clientSource)),
    stagedClientSha256: sha256(Buffer.from(clientAdapted)),
    presetGate: 'header.agentPreset === 1c-airules',
    privateProjectRootImportRemoved: !adapted.includes('dsh-1c-bundle/project-root'),
    privateBslIntelligenceBridgeRemoved: !clientAdapted.includes('/onec/bsl-intelligence'),
  }
}

function args(argv) {
  const out = {}
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--rulepack', '--output', '--source-bundle', '--target-lock', '--artifact-version', '--include-telegram', '--include-acp', '--include-subscriptions', '--include-mobile', '--include-mcp-manager', '--include-additional-providers', '--include-onec-panels', '--include-project-settings', '--include-model-orchestration', '--include-domain-presets', '--domain-rules-root', '--include-workflows', '--workflow-rules-root', '--include-agent-import', '--include-skills-manager', '--include-shared-skills', '--include-general-tools', '--include-document-workbench', '--include-onec-capabilities', '--include-native-fs-compat', '--native-modules', '--include-provider-extensions', '--include-cursor-provider', '--include-onec-specialized', '--include-memory-workspace', '--include-context-continuity', '--continuity-rules-root', '--include-history-recall', '--include-skill-evaluation', '--include-reviewed-knowledge', '--include-evidence-links', '--include-runtime-utilities', '--include-project-context'].includes(key) || value === undefined) throw new Error('USAGE')
    if (key.startsWith('--include-') && !['true', 'false'].includes(value)) throw new Error('BOOLEAN_OPTION_REQUIRED')
    out[key.slice(2)] = value
  }
  if (!out.rulepack || !out.output || !out['artifact-version']) throw new Error('USAGE')
  return out
}

export async function stageOfficialPolicy({ rulepack, output, sourceBundle, artifactVersion, targetLock = DEFAULT_LOCK, includeOpenSpec = true, includeTelegram = false, includeAcp = false, includeSubscriptions = false, includeMobile = false, includeMcpManager = false, includeAdditionalProviders = false, includeOnecPanels = false, includeProjectSettings = false, includeModelOrchestration = false, includeDomainPresets = false, domainRulesRoot, includeWorkflows = false, workflowRulesRoot, includeAgentImport = false, includeSkillsManager = false, includeSharedSkills = false, includeGeneralTools = false, includeDocumentWorkbench = false, includeOnecCapabilities = false, includeNativeFsCompat = false, nativeModules, includeProviderExtensions = false, includeCursorProvider = false, includeOnecSpecialized = false, includeMemoryWorkspace = false, includeContextContinuity = false, continuityRulesRoot, includeHistoryRecall = false, includeSkillEvaluation = false, includeReviewedKnowledge = false, includeEvidenceLinks = false, includeRuntimeUtilities = false, includeProjectContext = false, includeLive2dCompanion = false, includeCaptainCompanion = false, includeGitMaintenance = false }) {
  const portableMemoryOptions = { includeHistoryRecall, includeSkillEvaluation, includeReviewedKnowledge, includeEvidenceLinks, includeRuntimeUtilities }
  if (Object.values(portableMemoryOptions).some(value => typeof value !== "boolean")) throw new Error("BOOLEAN_OPTION_REQUIRED")
  if (includeReviewedKnowledge && !includeMemoryWorkspace) throw new Error('REVIEWED_KNOWLEDGE_REQUIRES_MEMORY_WORKSPACE')
  if ([includeGitMaintenance, includeLive2dCompanion, includeCaptainCompanion, includeProjectContext, includeOpenSpec, includeTelegram, includeAcp, includeSubscriptions, includeMobile, includeMcpManager, includeAdditionalProviders, includeOnecPanels, includeProjectSettings, includeModelOrchestration, includeDomainPresets, includeWorkflows, includeAgentImport, includeSkillsManager, includeSharedSkills, includeGeneralTools, includeDocumentWorkbench, includeOnecCapabilities,includeProviderExtensions,includeCursorProvider,includeOnecSpecialized,includeMemoryWorkspace,includeContextContinuity].some(value => typeof value !== 'boolean')) throw new Error('BOOLEAN_OPTION_REQUIRED')
  if(includeGitMaintenance&&(!includeProjectContext||!workflowRulesRoot))throw new Error('GIT_MAINTENANCE_PROJECT_CONTEXT_AND_CANONICAL_REQUIRED')
  if(includeProviderExtensions&&(!includeAcp||!includeAdditionalProviders))throw new Error('PROVIDER_EXTENSIONS_REQUIRE_ACP_AND_ADDITIONAL_PROVIDERS')
  if(includeProviderExtensions&&(typeof nativeModules!=='string'||!isAbsolute(nativeModules)))throw new Error('PROVIDER_EXTENSIONS_EXPLICIT_NATIVE_MODULES_REQUIRED')
  if(includeOnecSpecialized&&(!includeWorkflows||!includeOnecPanels))throw new Error('ONEC_SPECIALIZED_REQUIRE_WORKFLOWS_AND_ONEC_PANELS')
  if (includeSharedSkills && !includeDomainPresets) throw new Error('SHARED_SKILLS_REQUIRE_DOMAIN_PRESETS')
  if (typeof includeNativeFsCompat !== 'boolean') throw new Error('BOOLEAN_OPTION_REQUIRED')
  if (includeNativeFsCompat && (typeof nativeModules !== 'string' || !isAbsolute(nativeModules))) throw new Error('NATIVE_FS_EXPLICIT_MODULES_REQUIRED')
  if (includeDomainPresets && (typeof domainRulesRoot !== 'string' || await pathKind(resolve(domainRulesRoot)) !== 'directory')) throw new Error('CANONICAL_DOMAIN_RULES_REQUIRED')
  if (includeWorkflows && (typeof workflowRulesRoot !== 'string' || !isAbsolute(workflowRulesRoot) || await pathKind(resolve(workflowRulesRoot)) !== 'directory')) throw new Error('CANONICAL_WORKFLOW_RULES_REQUIRED')
  if (typeof artifactVersion !== 'string' || !/^[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?$/u.test(artifactVersion)) {
    throw new Error('ARTIFACT_VERSION_REQUIRED')
  }
  const rulepackRoot = resolve(rulepack)
  const destination = resolve(output)
  const expectedDirectory = `airules-official-policy-${artifactVersion}`
  if (basename(destination) !== expectedDirectory) throw new Error('OUTPUT_VERSION_MISMATCH')
  if (await pathKind(destination) !== 'missing') throw new Error('OUTPUT_EXISTS')
  if (await pathKind(rulepackRoot) !== 'directory') throw new Error('RULEPACK_MISSING')
  const rulepackManifest = await readJson(join(rulepackRoot, 'manifest.json'))
  if (rulepackManifest.package?.id !== 'airules-dsh-rulepack') throw new Error('RULEPACK_ID_INVALID')
  if (rulepackManifest.mcp?.mode !== 'logical-only' || Object.keys(rulepackManifest.mcp).some(key => !['mode', 'logical_roles'].includes(key))) {
    throw new Error('RULEPACK_MCP_NOT_LOGICAL_ONLY')
  }
  const lockBytes = await readFile(targetLock)
  const lock = JSON.parse(lockBytes.toString('utf8').replace(/^\uFEFF/u, ''))
  if (lock.target !== 'official-desktop' || !['0.2.1-rc.5','0.2.2-rc.1'].includes(lock.hostVersion)) throw new Error('TARGET_LOCK_INVALID')

  let standardSha256='0d398d2a6872a73a106cb3bd19303ecccf1637e1fcad4d0bf9d8a72d2c2c68f5'
  if(lock.hostVersion==='0.2.2-rc.1') {
    if(typeof nativeModules!=='string'||!isAbsolute(nativeModules))throw new Error('NATIVE_MODULES_REQUIRED')
    const standard=await readFile(join(nativeModules,'@deepseek-ai/dsh-web-app/presets/standard.patch.yml'))
    standardSha256=sha256(standard)
    if(standardSha256!=='3006cc3780cddaa7fb0089e5854e6bbef4409cf1d425930fd835226b95660afd')throw new Error('NATIVE_STANDARD_DRIFT')
  }
  const bundle = await resolvePolicySourceBundle(sourceBundle)
  const sourceNodeModules = join(bundle, 'node_modules')
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  const stage = join(parent, `.${destination.split(sep).at(-1)}.staging-${randomUUID()}`)
  await mkdir(stage)
  try {
    let nativeFsIntegration, continuityIntegration
    const packages = [
      ['airules-dsh-provider', PROVIDER],
      ['airules-dsh-rulepack', rulepackRoot],
      ['airules-official-preset', PRESET],
      ['airules-official-onec-mechanics', ONEC_MECHANICS],
      ['dsh-bsl-editor', join(sourceNodeModules, 'dsh-bsl-editor')],
      ['dsh-lsp-actions', join(sourceNodeModules, 'dsh-lsp-actions')],
      ['schemastery', join(sourceNodeModules, 'schemastery')],
      ...(includeOpenSpec ? [['dsh-openspec-workflow', OPENSPEC]] : []),
      ...(includeTelegram ? [['airules-dsh-telegram', TELEGRAM]] : []),
      ...(includeAcp ? [['airules-dsh-acp', ACP]] : []),
      ...(includeAcp ? [['@zaimokuza/dsh-acp-adapter', join(sourceNodeModules, '@zaimokuza', 'dsh-acp-adapter')]] : []),
      ...(includeSubscriptions ? [['airules-dsh-subscriptions', SUBSCRIPTIONS]] : []),
      ...(includeMobile ? [['airules-dsh-mobile-access', MOBILE]] : []),
      ...(includeMcpManager ? [['airules-dsh-mcp-manager', MCP_MANAGER]] : []),
      ...(includeAdditionalProviders ? [['airules-dsh-additional-providers', ADDITIONAL_PROVIDERS]] : []),
      ...(includeOnecPanels ? [['airules-dsh-onec-panels', ONEC_PANELS]] : []),
      ...(includeMemoryWorkspace ? [['airules-dsh-memory-workspace', MEMORY_WORKSPACE]] : []),
      ...PORTABLE_MEMORY.filter(([option]) => portableMemoryOptions[option]).map(([,name,directory]) => [name,join(REPO,'src',directory)]),
      ...(includeContextContinuity ? [['airules-dsh-context-continuity', CONTEXT_CONTINUITY]] : []),
      ...(includeProjectContext ? [['airules-dsh-project-context', join(REPO,'src/project-context')]] : []),
      ...(includeLive2dCompanion ? [['airules-dsh-live2d-companion', join(REPO,'src/live2d-companion')]] : []),
      ...(includeCaptainCompanion ? [['airules-dsh-captain-companion', join(REPO,'src/captain-companion')]] : []),
      ...(includeGitMaintenance ? [['airules-dsh-git-maintenance', join(REPO,'src/git-maintenance')]] : []),
      ...(includeProjectSettings ? [['airules-dsh-project-settings', PROJECT_SETTINGS]] : []),
      ...(includeModelOrchestration ? [['airules-dsh-model-orchestration', MODEL_ORCHESTRATION]] : []),
      ...(includeDomainPresets ? [['airules-dsh-domain-presets', DOMAIN_PRESETS]] : []),
      ...(includeWorkflows ? [['airules-dsh-workflows', WORKFLOWS]] : []),
      ...(includeAgentImport ? [['airules-dsh-agent-import', AGENT_IMPORT]] : []),
      ...(includeSkillsManager ? [['airules-dsh-skills', SKILLS_MANAGER]] : []),
      ...(includeGeneralTools ? [['airules-dsh-general-tools', GENERAL_TOOLS]] : []),
      ...(includeDocumentWorkbench ? [['airules-dsh-document-workbench', DOCUMENT_WORKBENCH]] : []),
      ...(includeOnecCapabilities ? [['airules-dsh-onec-capability-workflows', ONEC_CAPABILITIES]] : []),
      ...(includeNativeFsCompat ? [[COMPAT_PACKAGE, join(REPO, 'src/native-fs-compat')]] : []),
      ...(includeProviderExtensions ? [['airules-dsh-provider-extensions', PROVIDER_EXTENSIONS]] : []),
      ...(includeCursorProvider ? [['airules-dsh-cursor-provider', CURSOR_PROVIDER]] : []),
      ...(includeOnecSpecialized ? [['airules-dsh-onec-specialized', ONEC_SPECIALIZED]] : []),
    ]
    for (const [name, source] of packages) {
      if (!portable(name) || await pathKind(source) !== 'directory') throw new Error(`PACKAGE_SOURCE_INVALID: ${name}`)
      // The adapter is materialized only from its verified closure below.
      if (name === '@zaimokuza/dsh-acp-adapter') continue
      const target = join(stage, 'payload', 'packages', name)
      await mkdir(dirname(target), { recursive: true })
      if (name === COMPAT_PACKAGE) { nativeFsIntegration = await stageNativeFsCompat({nativeModules, target,hostVersion:lock.hostVersion}); continue }
      await cp(source, target, { recursive: true, force: false, errorOnExist: true,
        ...(['airules-dsh-onec-panels','airules-dsh-provider-extensions','airules-dsh-cursor-provider','airules-dsh-onec-specialized'].includes(name) ? { filter: async path => {
          const parts=relative(source,path).split(sep)
          if(parts.some(runtimeExcluded))return false
          if((await lstat(path)).isSymbolicLink())throw new Error('OPTIONAL_PACKAGE_REPARSE_FORBIDDEN')
          return true
        } } : {}),
        ...(name === 'airules-dsh-workflows' ? { filter: async path => {
          const parts = relative(source, path).split(sep)
          if (parts.some(runtimeExcluded) || parts[0] === 'runtime') return false
          if ((await lstat(path)).isSymbolicLink()) throw new Error('WORKFLOW_REPARSE_FORBIDDEN')
          return true
        } } : {}) })
      if(['airules-dsh-workflows','airules-dsh-onec-panels','airules-dsh-general-tools','dsh-openspec-workflow','airules-dsh-document-workbench','airules-dsh-memory-workspace'].includes(name)){
        const source=join(REPO,'src/native-tools-compat',lock.hostVersion==='0.2.2-rc.1'?'rc022.js':'rc5.js')
        await writeFile(join(target,'lib/native-tools.js'),await readFile(source))
      }
      if (name === 'airules-dsh-context-continuity') {
        if (typeof continuityRulesRoot !== 'string' || !isAbsolute(continuityRulesRoot)) throw new Error('CONTINUITY_CANONICAL_ROOT_REQUIRED')
        const source=join(continuityRulesRoot,'core/tools/continuity'), runtime=join(target,'runtime/continuity')
        await mkdir(runtime,{recursive:true})
        const files={}
        for(const file of ['contract.json','checkpoint.schema.json','fixtures.json']){
          const path=join(source,file),info=await lstat(path)
          if(!info.isFile()||info.isSymbolicLink())throw new Error('CONTINUITY_CANONICAL_FILE_REJECTED')
          const bytes=await readFile(path);JSON.parse(bytes)
          const embedded=await readFile(join(rulepackRoot,'contract/continuity',file))
          if(!bytes.equals(embedded))throw new Error('CONTINUITY_RULEPACK_CANONICAL_MISMATCH')
          await writeFile(join(runtime,file),bytes,{flag:'wx'});files[file]={sha256:sha256(bytes),bytes:bytes.length}
        }
        continuityIntegration={package:name,policyOwner:'project_rules',mode:'minimal',memoryWrites:false,canonical:{files,digest:digestData(files)}}
      }
      if(name==='airules-dsh-git-maintenance')await stageGitMaintenanceRuntime({packageRoot:target,canonicalRoot:workflowRulesRoot,rulepackManifest,artifactVersion})
      if(includeProjectContext && ['airules-dsh-memory-workspace','airules-dsh-document-workbench','airules-dsh-project-settings','airules-dsh-agent-import','airules-dsh-skills','airules-dsh-general-tools','airules-dsh-workflows','airules-dsh-onec-specialized','dsh-openspec-workflow'].includes(name)){
        const path=join(target,'package.json'),pkg=await readJson(path);if(!pkg.dsh?.client)throw new Error('PROJECT_CLIENT_REQUIRED');pkg.dsh.client.inject=[...new Set([...(pkg.dsh.client.inject??[]),'airules-dsh-project-context'])];await writeFile(path,JSON.stringify(pkg,null,2)+'\n')
      }
      if (lock.hostVersion==='0.2.2-rc.1' && name!=='airules-dsh-rulepack') {
        const path=join(target,'package.json'),pkg=await readJson(path)
        for(const key of Object.keys(pkg.peerDependencies??{})) if(pkg.peerDependencies[key]==='0.2.1-rc.5' && key.startsWith('@deepseek-ai/')){
          const native=await readJson(join(nativeModules,key,'package.json'))
          if(native.name!==key||native.version!==lock.hostVersion)throw new Error('NATIVE_HOST_PEER_MISMATCH')
          pkg.peerDependencies[key]=lock.hostVersion
        }
        await writeFile(path,JSON.stringify(pkg,null,2)+'\n')
      }
      if (name === 'airules-dsh-general-tools') await verifyMermaidRuntime(join(stage, 'payload', 'packages', 'airules-dsh-rulepack'), target)
      if (name === 'airules-dsh-domain-presets') {
        if(lock.hostVersion==='0.2.2-rc.1') {
          const file=join(target,'standard.plugins.json'),base=await readJson(file)
          base.find(row=>row.id==='tool-fs').config={applyPatch:false}
          const subagent=base.find(row=>row.id==='subagents')??base.find(row=>Array.isArray(row.config)&&row.config.some(x=>x.id==='tool-subagent'))
          if(!subagent)throw new Error('DOMAIN_SUBAGENT_BASE_MISSING')
          subagent.config=subagent.config.filter(row=>row.id!=='tool-subagent-list-agents')
          const config=subagent.config.find(row=>row.id==='tool-subagent').config
          delete config.modelSelectionSettings;config.modelSelection=true;config.modelDiscovery=true
          await writeFile(file,JSON.stringify(base,null,2)+'\n')
        }
        for (const domain of ['python', 'sysadmin']) for (const kind of ['rules', 'skills']) {
          const canonicalSource = join(resolve(domainRulesRoot), domain, kind)
          if (await pathKind(canonicalSource) !== 'directory') throw new Error('CANONICAL_DOMAIN_RULES_REQUIRED')
          const canonicalFiles = await filesOf(canonicalSource)
          if (!Object.keys(canonicalFiles).length) throw new Error('CANONICAL_DOMAIN_RULES_EMPTY')
          const assetTarget = join(target, kind, domain)
          if (JSON.stringify(Object.keys(canonicalFiles)) !== JSON.stringify(Object.keys(await filesOf(assetTarget)))) throw new Error('CANONICAL_DOMAIN_INVENTORY_MISMATCH')
          await rm(assetTarget, { recursive: true, force: true })
          await cp(canonicalSource, assetTarget, { recursive: true, force: false, errorOnExist: true })
          if (JSON.stringify(await filesOf(assetTarget)) !== JSON.stringify(canonicalFiles)) throw new Error('CANONICAL_DOMAIN_COPY_DRIFT')
        }
        if (includeSharedSkills) await stageSharedSkills(join(stage, 'payload', 'packages', 'airules-dsh-rulepack'), target, [
          ...SHARED_SKILLS,
          ...(includeMemoryWorkspace ? ['memory-workspace'] : []),
          ...(includeGeneralTools ? ['caveman', 'api-conventions', 'craft-mermaid', 'creating-dsh-plugins'] : []),
          ...(includeDocumentWorkbench ? ['document-import', 'office', 'office-docx', 'office-xlsx', 'office-pptx', 'office-render', 'office-recalculate', 'office-export-pdf'] : []),
          ...(includeOnecCapabilities && includeTelegram ? ['telegram'] : []),
        ])
      }
    }
    const workflowIntegration = includeWorkflows ? await stageWorkflowRuntime(resolve(workflowRulesRoot), join(stage, 'payload', 'packages', 'airules-dsh-workflows')) : undefined
    let openSpecIntegration
    if (includeOpenSpec) {
      const closureLock = await readJson(OPENSPEC_LOCK)
      const closure = await stagePackageClosure({ modulesRoot: sourceNodeModules,
        targetModulesRoot: join(stage, 'payload', 'packages', 'dsh-openspec-workflow', 'node_modules'), lock: closureLock })
      openSpecIntegration = { package: 'dsh-openspec-workflow', cliVersion: '1.12.0',
        dependencyLockSha256: sha256(await readFile(OPENSPEC_LOCK)),
        privateRuntimePackages: closure.packages.length, policyOwner: 'project_rules', atlassian: false }
    }
    let acpIntegration
    if (includeAcp) {
      const closureLock = await readJson(ACP_LOCK)
      const modules = join(stage, '.acp-source-closure', 'node_modules')
      const closure = await stagePackageClosure({ modulesRoot: sourceNodeModules, targetModulesRoot: modules, lock: closureLock })
      const adapter = join(stage, 'payload', 'packages', '@zaimokuza', 'dsh-acp-adapter')
      await mkdir(dirname(adapter), { recursive: true })
      await cp(join(modules, '@zaimokuza', 'dsh-acp-adapter'), adapter, { recursive: true, force: false, errorOnExist: true })
      const adapterModules = join(adapter, 'node_modules')
      await mkdir(adapterModules, { recursive: true })
      // Re-hoist only the locked source closure below the top-level adapter.
      // Existing private versions (SDK 1.5.1 / yaml 2.9.0) win over siblings.
      for (const row of closure.packages.filter(row => !row.path.includes('/node_modules/') && row.name !== '@zaimokuza/dsh-acp-adapter')) {
        const target = join(adapterModules, row.name)
        if (await pathKind(target) !== 'missing') continue
        await mkdir(dirname(target), { recursive: true })
        await cp(join(modules, row.path), target, { recursive: true, force: false, errorOnExist: true })
      }
      const adapterManifestBytes=await readFile(join(adapter,'package.json'))
      const adapterManifest = JSON.parse(adapterManifestBytes)
      let engineAdaptation
      if(lock.hostVersion==='0.2.2-rc.1'){
        if(adapterManifest.engines?.dsh!=='0.2.1-rc.3 || 0.2.1-rc.5')throw new Error('ACP_SOURCE_ENGINE_DRIFT')
        if(sha256(adapterManifestBytes)!=='940e499d84127eb1634ebd684e5d722150f7b54b05c675d28644717269927736')throw new Error('ACP_SOURCE_MANIFEST_DRIFT')
        adapterManifest.engines.dsh=lock.hostVersion
        const stagedManifestBytes=Buffer.from(JSON.stringify(adapterManifest,null,2)+'\n')
        if(sha256(stagedManifestBytes)!=='7cf400f2cd2b713a7bf44086948467035994df0d7766acfd8174ac1e2bc376ac')throw new Error('ACP_STAGED_MANIFEST_DRIFT')
        engineAdaptation={sourceManifestSha256:sha256(adapterManifestBytes),stagedManifestSha256:sha256(stagedManifestBytes),fromEngine:'0.2.1-rc.3 || 0.2.1-rc.5',toEngine:lock.hostVersion}
        await writeFile(join(adapter,'package.json'),stagedManifestBytes)
      }
      const nativeClosure = await inspectPackageClosure({ modulesRoot: adapterModules, roots: adapterManifest.dependencies })
      const wrapperModules = join(stage, 'payload', 'packages', 'airules-dsh-acp', 'node_modules')
      const sdk = join(wrapperModules, '@agentclientprotocol', 'sdk')
      await mkdir(dirname(sdk), { recursive: true })
      await cp(join(adapterModules, '@agentclientprotocol', 'sdk'), sdk, { recursive: true, force: false, errorOnExist: true })
      const sdkManifest = await readJson(join(sdk, 'package.json'))
      if (sdkManifest.name !== '@agentclientprotocol/sdk' || sdkManifest.version !== '1.5.1') throw new Error('ACP_SDK_VERSION_MISMATCH')
      await mkdir(join(sdk, 'node_modules'), { recursive: true })
      await cp(join(adapterModules, 'zod'), join(sdk, 'node_modules', 'zod'), { recursive: true, force: false, errorOnExist: true })
      const registry = join(adapter, 'lib', 'host', 'composition', 'installed-profile-registry.js')
      const source = await readFile(registry, 'utf8')
      const adapted = replaceOnce(source,
        "import { resolveBundledAcpAgents } from '../../../../../../lib/acp-outbound.js'; // dsh1c-acp-bundled-r61",
        "import { resolveBundledAcpAgents } from 'airules-dsh-acp/outbound'; // airules standalone adapter",
        'ACP standalone outbound import')
      await writeFile(registry, adapted, 'utf8')
      acpIntegration = { package: 'airules-dsh-acp', defaultEnabled: false, inbound: 'local-named-pipe', outbound: 'native-external-agent',
        adapterVersion: '0.2.1-rc.3.1', sdkVersion: '1.5.1', dependencyLockSha256: sha256(await readFile(ACP_LOCK)),
        privateRuntimePackages: nativeClosure.packages.length + 2,
        adaptation: { sourceSha256: sha256(Buffer.from(source)), stagedSha256: sha256(Buffer.from(adapted)) },
        ...(engineAdaptation?{engineAdaptation}:{}) }
      await rm(join(stage, '.acp-source-closure'), { recursive: true })
    }
    const optionalIntegrations = {}
    if(includeProviderExtensions){
      const dependencies=await stageProviderExtensionsDependencies({modulesRoot:sourceNodeModules,
        targetRoot:join(stage,'payload','packages','airules-dsh-provider-extensions'),nativeModulesRoot:nativeModules,hostVersion:lock.hostVersion})
      optionalIntegrations.providerExtensions={package:'airules-dsh-provider-extensions',providers:['google','muse'],transport:'native-acp',
        runtime:'explicit-installed-executable',authentication:'explicit-user-action',defaultEnabled:false,bootstrap:false,
        dependencyLockSha256:dependencies.dependencyLockSha256,privateRuntimePackages:dependencies.privateRuntimePackages.length,nativePiAiVersion:dependencies.externalPeers[0].version}
    }
    if (includeDocumentWorkbench) await stageDocumentClosure({ modulesRoot: sourceNodeModules,
      targetModulesRoot: join(stage, 'payload', 'packages', 'airules-dsh-document-workbench', 'node_modules') })
    if (includeOnecPanels) {
      const lock = await readJson(join(REPO, 'upstream', 'onec-panels-closure.lock.json'))
      await stagePackageClosure({ modulesRoot: join(sourceNodeModules, 'dsh-bsl-editor', 'node_modules'),
        targetModulesRoot: join(stage, 'payload', 'packages', 'airules-dsh-onec-panels', 'node_modules'), lock })
    }
    for (const [enabled, key, name, sourceModules, lockPath, metadata] of [
      [includeSubscriptions, 'subscriptions', 'airules-dsh-subscriptions', join(sourceNodeModules, 'dsh-plugin-subscriptions', 'node_modules'), SUBSCRIPTIONS_LOCK,
        { defaultEnabled: false, state: 'isolated', credentials: 'excluded' }],
      [includeMobile, 'mobile', 'airules-dsh-mobile-access', sourceNodeModules, MOBILE_LOCK,
        { defaultEnabled: false, autostart: false, listener: 'explicit-start-https', firewallChanges: false }],
    ]) {
      if (!enabled) continue
      const lock = await readJson(lockPath)
      const closure = await stagePackageClosure({ modulesRoot: sourceModules, targetModulesRoot: join(stage, 'payload', 'packages', name, 'node_modules'), lock })
      optionalIntegrations[key] = { package: name, ...metadata, dependencyLockSha256: sha256(await readFile(lockPath)), privateRuntimePackages: closure.packages.length }
    }
    // Keep schemastery's MIT runtime closure private to the package. This
    // avoids claiming or replacing a profile-wide scoped dependency.
    const schemasteryModules = join(stage, 'payload', 'packages', 'schemastery', 'node_modules')
    await mkdir(join(schemasteryModules, '@standard-schema'), { recursive: true })
    await cp(join(sourceNodeModules, '@standard-schema', 'spec'), join(schemasteryModules, '@standard-schema', 'spec'), { recursive: true, force: false, errorOnExist: true })
    await cp(join(sourceNodeModules, 'cosmokit'), join(schemasteryModules, 'cosmokit'), { recursive: true, force: false, errorOnExist: true })
    // dsh-lsp-actions imports the official scoped Schemastery peer directly.
    // Vendor it below that package so the policy artifact remains standalone
    // without claiming a profile-wide @deepseek-ai namespace.
    const lspModules = join(stage, 'payload', 'packages', 'dsh-lsp-actions', 'node_modules')
    await mkdir(join(lspModules, '@deepseek-ai'), { recursive: true })
    await mkdir(join(lspModules, '@standard-schema'), { recursive: true })
    await cp(join(sourceNodeModules, '@deepseek-ai', 'schemastery'), join(lspModules, '@deepseek-ai', 'schemastery'), { recursive: true, force: false, errorOnExist: true })
    await cp(join(sourceNodeModules, '@deepseek-ai', 'cosmokit'), join(lspModules, '@deepseek-ai', 'cosmokit'), { recursive: true, force: false, errorOnExist: true })
    await cp(join(sourceNodeModules, '@standard-schema', 'spec'), join(lspModules, '@standard-schema', 'spec'), { recursive: true, force: false, errorOnExist: true })
    const editorAdaptation = await adaptBslEditor(join(stage, 'payload', 'packages', 'dsh-bsl-editor'))
    const lspActionsAdaptation = await adaptOnecLspPackage(join(stage,'payload','packages','dsh-lsp-actions'),{hostVersion:lock.hostVersion})
    let fragment = await readFile(join(PRESET, 'cordis.patch.yml'), 'utf8')
    if(lock.hostVersion==='0.2.2-rc.1'){
      fragment=replaceOnce(fragment,"          - id: tool-fs\n            name: '@deepseek-ai/dsh-tool-fs'\n","          - id: tool-fs\n            name: '@deepseek-ai/dsh-tool-fs'\n            config:\n              applyPatch: false\n",'022 native patch optout')
      fragment=replaceOnce(fragment,"              - id: tool-subagent-list-agents\n                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n",'','022 native consolidated subagent control')
      fragment=replaceOnce(fragment,'                  modelSelectionSettings: true\n','                  modelSelection: true\n                  modelDiscovery: true\n','022 native model discovery')
    }

    fragment = replaceOnce(fragment,
      '          # Optional project workflow tools are inserted by the policy builder.\n',
      includeWorkflows ? '          - id: airules-workflow-tools\n            name: airules-dsh-workflows/tools\n' : '',
      'workflow composition tools')
    fragment = replaceOnce(fragment,
      '          # Optional portable workbench tools are inserted by the policy builder.\n',
      [includeGeneralTools ? '          - id: airules-general-tools-agent\n            name: airules-dsh-general-tools/tools\n' : '',
        includeDocumentWorkbench ? '          - id: airules-document-tools\n            name: airules-dsh-document-workbench/tools\n' : '',
        includeOnecCapabilities ? '          - id: airules-onec-capability-tools\n            name: airules-dsh-onec-capability-workflows/tools\n' : '',
        includeOnecPanels ? '          - id: airules-onec-workbench-tools\n            name: airules-dsh-onec-panels/tools\n' : '',
        includeContextContinuity ? '          - id: airules-continuity-agent\n            name: airules-dsh-context-continuity/agent\n' : '',
        includeMemoryWorkspace ? '          - id: airules-memory-tools\n            name: airules-dsh-memory-workspace/tools\n' : '',
        ...PORTABLE_MEMORY.filter(([option]) => portableMemoryOptions[option]).map(([,name,directory]) => `          - id: airules-${directory}\n            name: ${name}/agent\n`),
        includeOnecSpecialized ? '          - id: airules-onec-specialized-tools\n            name: airules-dsh-onec-specialized/tools\n' : ''].join(''),
      'portable workbench tools')
    const newHosts=[
      [includeLive2dCompanion,'airules-live2d-companion','airules-dsh-live2d-companion'],
      [includeCaptainCompanion,'airules-captain-companion','airules-dsh-captain-companion'],
      [includeProjectContext,'airules-project-context','airules-dsh-project-context'],
      [includeGitMaintenance,'airules-git-maintenance','airules-dsh-git-maintenance'],
      [includeRuntimeUtilities,'airules-runtime-utilities-host','airules-dsh-runtime-utilities'],
      [includeReviewedKnowledge,'airules-reviewed-knowledge-host','airules-reviewed-knowledge/host'],
      [includeContextContinuity,'airules-continuity','airules-dsh-context-continuity'],
      [includeMemoryWorkspace,'airules-memory','airules-dsh-memory-workspace'],
      [includeProviderExtensions,'airules-provider-extensions','airules-dsh-provider-extensions'],
      [includeCursorProvider,'airules-cursor-provider','airules-dsh-cursor-provider'],
      [includeOnecSpecialized,'airules-onec-specialized','airules-dsh-onec-specialized'],
    ]
    fragment=replaceOnce(fragment,'    - id: airules-onec-bsl-editor\n',
      newHosts.filter(([enabled])=>enabled).map(([,id,name])=>`    - id: ${id}\n      name: ${name}\n`).join('')+'    - id: airules-onec-bsl-editor\n','optional specialized host mounts')
    if (!includeModelOrchestration) {
      fragment = replaceOnce(fragment,
        "              - id: airules-managed-delegation\n                name: airules-dsh-model-orchestration/delegation\n                config:\n                  rulepackRoot: !!js dshHomePath('profiles/desktop/node_modules/airules-dsh-rulepack')\n",
        '', 'managed delegation disabled mount')
    }
    if (!includeOpenSpec) {
      fragment = replaceOnce(fragment,
        '    - id: airules-openspec\n      name: dsh-openspec-workflow\n      config:\n        timeoutMs: 15000\n',
        '', 'OpenSpec disabled mount')
    }
    for (const [enabled, id, name] of [
      [includeTelegram, 'airules-telegram', 'airules-dsh-telegram'],
      [includeAcp, 'airules-acp', 'airules-dsh-acp'],
      [includeSubscriptions, 'airules-subscriptions', 'airules-dsh-subscriptions'],
      [includeMobile, 'airules-mobile', 'airules-dsh-mobile-access'],
      [includeMcpManager, 'airules-mcp-manager', 'airules-dsh-mcp-manager'],
      [includeAdditionalProviders, 'airules-additional-providers', 'airules-dsh-additional-providers'],
      [includeOnecPanels, 'airules-onec-panels', 'airules-dsh-onec-panels'],
      [includeProjectSettings, 'airules-project-settings', 'airules-dsh-project-settings'],
      [includeModelOrchestration, 'airules-model-orchestration', 'airules-dsh-model-orchestration'],
      [includeDomainPresets, 'airules-domain-presets', 'airules-dsh-domain-presets'],
      [includeWorkflows, 'airules-workflows', 'airules-dsh-workflows'],
      [includeAgentImport, 'airules-agent-import', 'airules-dsh-agent-import'],
      [includeSkillsManager, 'airules-skills', 'airules-dsh-skills'],
      [includeGeneralTools, 'airules-general-tools', 'airules-dsh-general-tools'],
      [includeDocumentWorkbench, 'airules-documents', 'airules-dsh-document-workbench'],
      [includeOnecCapabilities, 'airules-onec-capabilities', 'airules-dsh-onec-capability-workflows'],
      ...newHosts,
    ]) {
      const mount = `    - id: ${id}\n      name: ${name}\n`
      if (!enabled && fragment.includes(mount)) fragment = replaceOnce(fragment, mount, '', `${id} disabled mount`)
      if (enabled && !fragment.includes(mount)) throw new Error(`INTEGRATION_MOUNT_MISSING: ${id}`)
    }
    if (includeDomainPresets && (includeWorkflows || includeSharedSkills || includeGeneralTools || includeDocumentWorkbench || includeMemoryWorkspace || includeContextContinuity || Object.values(portableMemoryOptions).some(Boolean))) fragment = replaceOnce(fragment,
      '    - id: airules-domain-presets\n      name: airules-dsh-domain-presets\n',
      `    - id: airules-domain-presets\n      name: airules-dsh-domain-presets\n      config:\n${includeWorkflows ? '        workflows: true\n' : ''}${includeSharedSkills ? '        sharedSkills: true\n' : ''}${includeGeneralTools ? '        generalTools: true\n' : ''}${includeDocumentWorkbench ? '        documents: true\n' : ''}${includeMemoryWorkspace ? '        memory: true\n' : ''}${includeContextContinuity ? '        continuity: true\n' : ''}${includeHistoryRecall ? '        historyRecall: true\n' : ''}${includeSkillEvaluation ? '        skillEvaluation: true\n' : ''}${includeReviewedKnowledge ? '        reviewedKnowledge: true\n' : ''}${includeEvidenceLinks ? '        evidenceLinks: true\n' : ''}${includeRuntimeUtilities ? '        runtimeUtilities: true\n' : ''}`, 'domain workflow tools and shared skills')
    const adapterMount = "    - id: airules-acp-adapter\n      name: '@zaimokuza/dsh-acp-adapter'\n      inject: [llm, sessions, subprocess, dshHomePath, attachments, sessionProjections, permissionPresets, acpPermissionPolicy]\n      config:\n        agents: {}\n        toolApprovalDefault: ask\n"
    if (!includeAcp && fragment.includes(adapterMount)) fragment = replaceOnce(fragment, adapterMount, '', 'ACP native adapter disabled mount')
    if (includeAcp && !fragment.includes(adapterMount)) throw new Error('INTEGRATION_MOUNT_MISSING: airules-acp-adapter')
    if (/https?:\/\/|\b(?:endpoint|headers|api[_-]?key|token|secret)\s*:/iu.test(fragment)) throw new Error('PRESET_CONNECTION_DATA_FORBIDDEN')
    if (includeNativeFsCompat) {
      fragment = replaceOnce(fragment, '    - id: airules-onec-bsl-editor\n', '    - id: airules-native-fs\n      name: airules-dsh-native-fs\n    - id: airules-onec-bsl-editor\n', 'native filesystem provider mount')
      fragment += "\n- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n  disabled: true\n"
    }
    await writeFile(join(stage, 'cordis.policy.fragment.yml'), fragment, 'utf8')
    const operations = packages.map(([name]) => ({
      kind: 'package-copy',
      source: `payload/packages/${name}`,
      target: `node_modules/${name}`,
    }))
    operations.push({ kind: 'cordis-merge', source: 'cordis.policy.fragment.yml', target: 'cordis.patch.yml' })
    const files = await filesOf(stage)
    const manifest = {
      schemaVersion: 1,
      artifact: { id: 'airules-official-policy-overlay', version: artifactVersion },
      target: {
        kind: 'official-desktop',
        hostVersion: lock.hostVersion,
        buildCommit: lock.buildCommit,
        appAsarSha256: lock.files['resources/app.asar'].sha256,
        releaseLockSha256: sha256(lockBytes),
        unknownTargetPolicy: 'block',
      },
      separation: { mcpBindings: 'excluded', credentials: 'excluded', runtimeState: 'excluded', olegFullCanon: 'excluded' },
      preset: {
        id: '1c-airules', label: '1С', extensionPoint: '@deepseek-ai/dsh-agent-preset', scope: 'composition',
        base: { id: 'standard', hostVersion: lock.hostVersion, sourceSha256: standardSha256 },
      },
      rulepack: { version: rulepackManifest.package.version, sourceDirty: rulepackManifest.source?.dirty === true, counts: rulepackManifest.counts },
      ...((includeGitMaintenance || includeLive2dCompanion || includeCaptainCompanion || includeProjectContext || openSpecIntegration || includeTelegram || includeAcp || includeSubscriptions || includeMobile || includeMcpManager || includeAdditionalProviders || includeOnecPanels || includeProjectSettings || includeModelOrchestration || includeDomainPresets || includeWorkflows || includeAgentImport || includeSkillsManager || includeGeneralTools || includeDocumentWorkbench || includeOnecCapabilities || includeNativeFsCompat || includeProviderExtensions || includeCursorProvider || includeOnecSpecialized || includeMemoryWorkspace || includeContextContinuity || Object.values(portableMemoryOptions).some(Boolean)) ? { integrations: {
        ...(continuityIntegration ? {contextContinuity:continuityIntegration} : {}),
        ...(nativeFsIntegration ? {nativeFsCompat: nativeFsIntegration} : {}),
        ...(openSpecIntegration ? { openspec: openSpecIntegration } : {}),
        ...(includeTelegram ? { telegram: { package: 'airules-dsh-telegram', defaultEnabled: false, autostart: false, secretStorage: 'windows-dpapi-current-user', transport: 'single-owner-long-polling' } } : {}),
        ...(acpIntegration ? { acp: acpIntegration } : {}),
        ...optionalIntegrations,
        ...Object.fromEntries(PORTABLE_MEMORY.filter(([option]) => portableMemoryOptions[option]).map(([option,name]) => [option.slice(7,8).toLowerCase()+option.slice(8),{package:name,scope:"custom-presets-only",automaticWrites:false}])),
        ...(includeMcpManager ? { mcpManager: { package: 'airules-dsh-mcp-manager', bindings: 'machine-or-project-external', defaultServers: 0, authority: 'native-loopback-csrf' } } : {}),
        ...(includeAdditionalProviders ? { additionalProviders: { package: 'airules-dsh-additional-providers', authentication: 'explicit-user-action', bootstrap: false } } : {}),
        ...(includeGitMaintenance ? {gitMaintenance:{package:'airules-dsh-git-maintenance',sources:'github-or-local-or-embedded',projectScope:'registered-project',updates:'certified-release-on-exit',mcp:false}} : {}),
        ...(includeLive2dCompanion ? { live2dCompanion:{package:'airules-dsh-live2d-companion',defaultEnabled:false,assets:'local-only',modelCalls:false} } : {}),
        ...(includeCaptainCompanion ? { captainCompanion:{package:'airules-dsh-captain-companion',speech:'local-curated',modelCalls:false,avatar:'existing-native-pet'} } : {}),
        ...(includeProjectContext ? { projectContext:{package:'airules-dsh-project-context',scope:'registered-project',execution:'native-pinned',automaticResume:false} } : {}),
        ...(includeMemoryWorkspace ? { memoryWorkspace: {package:'airules-dsh-memory-workspace',defaultEnabled:false,endpoint:'machine-loopback',scope:'native-project-dataset',processing:'explicit-local',migration:false,policyOwner:'project_rules'} } : {}),
        ...(includeOnecPanels ? { onecPanels: { package: 'airules-dsh-onec-panels', metadataReadOnly: true, root: 'selected-session',background:'native-jobs-reviewed-mcp',defaultBackgroundTools:0 } } : {}),
        ...(includeProjectSettings ? { projectSettings: { package: 'airules-dsh-project-settings', bindings: 'project-local', deploy: false, mcp: false } } : {}),
        ...(includeModelOrchestration ? { modelOrchestration: { package: 'airules-dsh-model-orchestration', enabledByUser: true, bindings: 'role-and-pool', globalInterception: false } } : {}),
        ...(includeDomainPresets ? { domainPresets: { package: 'airules-dsh-domain-presets', presets: ['python-airules', 'sysadmin-airules'], mcp: false, policyOwner: 'project_rules' } } : {}),
        ...(workflowIntegration ? { workflows: workflowIntegration } : {}),
        ...(includeAgentImport ? { agentImport: { package: 'airules-dsh-agent-import', scopes: ['project', 'global'], chats: false, mcp: false, credentials: false } } : {}),
        ...(includeSkillsManager ? { skillsManager: { package: 'airules-dsh-skills', storage: 'native', scopes: ['project', 'global'], bundledAssets: false } } : {}),
        ...(includeGeneralTools ? { generalTools: { package: 'airules-dsh-general-tools', defaultStyle: 'off', style: 'opt-in-lite', renderer: 'native-sandbox' } } : {}),
        ...(includeDocumentWorkbench ? { documentWorkbench: { package: 'airules-dsh-document-workbench', cache: 'project-scoped', conversion: 'local', cloud: false } } : {}),
        ...(includeOnecCapabilities ? { onecCapabilities: { package: 'airules-dsh-onec-capability-workflows', scope: '1c-airules', discovery: 'native-schemas', liveCalls: false } } : {}),
        ...(includeCursorProvider?{cursorProvider:{package:'airules-dsh-cursor-provider',provider:'airules-cursor',authentication:'explicit-user-action',sdkVersion:'1.0.38',sdkBundled:false,bootstrap:false,nativeAccess:'build-and-native'}}:{}),
        ...(includeOnecSpecialized?{onecSpecialized:{package:'airules-dsh-onec-specialized',scope:'1c-airules',execution:'native-sandbox',runners:'explicit-project-bindings',externalDefaultTrustedRunners:0,bundledRunner:'exact-managed-sha256',domains:['repository','ai-merge','v8unpack'],policyOwner:'project_rules'}}:{}),
      } } : {}),
      onecMechanics: {
        scope: '1c-airules-only',
        capabilities: ['xml-edt-tree', 'bsl-xml-editing', 'bsl-lsp-actions', 'bsl-diagnostics', 'safe-project-root', 'project-local-settings-contract'],
        packages: {
          'dsh-bsl-editor': { version: '0.4.0', license: 'MIT', source: 'pinned Oleg vendor copy of public package', adaptation: editorAdaptation },
          'dsh-lsp-actions': { version: '0.4.6', license: 'Apache-2.0', source: 'pinned public package', adaptation: lspActionsAdaptation },
          dependencyClosure: ['fast-xml-parser@4.5.7 (nested)', 'strnum@1.1.2 (nested)', 'schemastery@3.18.0', '@standard-schema/spec@1.1.0 (nested)', 'cosmokit@1.8.1 (nested)', '@deepseek-ai/schemastery@3.18.5 (nested)', '@deepseek-ai/cosmokit@1.8.6 (nested)'],
        },
        lspServer: { bundled: false, mode: 'external-command-or-clean-degraded', env: ['ONEC_BSL_LS_COMMAND', 'ONEC_BSL_LS_ARGS', 'ONEC_LSP_TOOLS'] },
        projectWizard: { included: false, reason: 'vendor wizard couples Oleg Full policy, MCP management and database preparation' },
        excluded: ['deploy', 'database-mutation', 'mcp-canon', 'private-metadata-mcp', 'vendor-java-runtime', 'vendor-bsl-language-server-jar'],
      },
      operations,
      files,
    }
    await writeFile(join(stage, 'official-policy-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(stage, destination)
    return manifest
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = args(process.argv)
    const manifest = await stageOfficialPolicy({ rulepack: options.rulepack, output: options.output, sourceBundle: options['source-bundle'], artifactVersion: options['artifact-version'], targetLock: options['target-lock'] ?? DEFAULT_LOCK,
      includeGitMaintenance: options['include-git-maintenance'] === 'true', includeLive2dCompanion: options['include-live2d-companion'] === 'true', includeCaptainCompanion: options['include-captain-companion'] === 'true', includeProjectContext: options['include-project-context'] === 'true', includeEvidenceLinks: options['include-evidence-links'] === 'true', includeRuntimeUtilities: options['include-runtime-utilities'] === 'true', includeHistoryRecall: options['include-history-recall'] === 'true', includeSkillEvaluation: options['include-skill-evaluation'] === 'true', includeReviewedKnowledge: options['include-reviewed-knowledge'] === 'true',
      includeTelegram: options['include-telegram'] === 'true', includeAcp: options['include-acp'] === 'true', includeNativeFsCompat: options['include-native-fs-compat'] === 'true', nativeModules: options['native-modules'],
      includeSubscriptions: options['include-subscriptions'] === 'true', includeMobile: options['include-mobile'] === 'true',
      includeProviderExtensions:options['include-provider-extensions']==='true',includeCursorProvider:options['include-cursor-provider']==='true',includeOnecSpecialized:options['include-onec-specialized']==='true',includeMemoryWorkspace:options['include-memory-workspace']==='true',includeContextContinuity:options['include-context-continuity']==='true',continuityRulesRoot:options['continuity-rules-root'],
      includeMcpManager: options['include-mcp-manager'] === 'true', includeAdditionalProviders: options['include-additional-providers'] === 'true', includeOnecPanels: options['include-onec-panels'] === 'true', includeProjectSettings: options['include-project-settings'] === 'true', includeModelOrchestration: options['include-model-orchestration'] === 'true', includeDomainPresets: options['include-domain-presets'] === 'true', domainRulesRoot: options['domain-rules-root'], includeWorkflows: options['include-workflows'] === 'true', workflowRulesRoot: options['workflow-rules-root'], includeAgentImport: options['include-agent-import'] === 'true', includeSkillsManager: options['include-skills-manager'] === 'true', includeSharedSkills: options['include-shared-skills'] === 'true', includeGeneralTools: options['include-general-tools'] === 'true', includeDocumentWorkbench: options['include-document-workbench'] === 'true', includeOnecCapabilities: options['include-onec-capabilities'] === 'true' })
    process.stdout.write(`Staged ${manifest.artifact.id} ${manifest.artifact.version}: ${Object.keys(manifest.files).length} files\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
