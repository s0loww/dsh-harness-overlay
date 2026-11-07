import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => { const rel = relative(root, file); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }

/** Copy one explicitly selected real BSL module; never copy configs or connections. */
export async function snapshotSource(projectRoot, sourceRelative, workspace) {
  const root = resolve(projectRoot)
  if (typeof sourceRelative !== 'string' || !sourceRelative || isAbsolute(sourceRelative) || /^[A-Za-z]:/u.test(sourceRelative)
    || sourceRelative.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') || !sourceRelative.toLowerCase().endsWith('.bsl')) throw new Error('BSL_SOURCE_RELATIVE_REQUIRED')
  const original = resolve(root, sourceRelative)
  if (!inside(root, original) || inside(root, resolve(workspace))) throw new Error('ORIGINAL_PROJECT_MUST_REMAIN_READ_ONLY')
  let at = root
  for (const part of ['', ...relative(root, original).split(sep)]) {
    if (part) at = join(at, part)
    const info = await lstat(at)
    if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new Error('SOURCE_LINK_REJECTED')
  }
  const info = await lstat(original)
  if (!info.isFile() || info.size < 1 || info.size > 256 * 1024) throw new Error('BOUNDED_BSL_MODULE_REQUIRED')
  const bytes = await readFile(original)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|(?:password|access_token|api_key)\s*[:=]\s*["']?[^\s"'<${][^\s"']{7,}/iu.test(text)) throw new Error('SOURCE_MAY_CONTAIN_CREDENTIALS')
  const after = await lstat(original)
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('SOURCE_CHANGED_DURING_SNAPSHOT')
  // Fresh workspace is mandatory, even if a preceding probe failed.
  await mkdir(workspace)
  // Native project discovery needs a repository boundary; never inherit the
  // overlay checkout's skill root from this nested ignored fixture directory.
  await mkdir(join(workspace, '.git'))
  const moduleRelative = 'src/CommonModules/AcceptanceModule/Ext/Module.bsl', target = join(workspace, moduleRelative)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' })
  await mkdir(join(workspace, 'artifacts'))
  await writeFile(join(workspace, 'AGENTS.md'), '# Isolated DSH acceptance snapshot\n\nPROJECT_ACCEPTANCE_POLICY: Project-specific constraints take priority over embedded airules defaults.\nOnly this copied module and artifacts are writable. No database, MCP, COM, deployment or external messages. Original project is read-only.\n', { flag: 'wx' })
  return { original, sourceRelative: sourceRelative.replaceAll('\\', '/'), sourceHash: hash(bytes), sourceBytes: bytes.length, workspace: resolve(workspace), target, moduleRelative }
}

export async function assertOriginalUnchanged(snapshot) {
  if (hash(await readFile(snapshot.original)) !== snapshot.sourceHash) throw new Error('ORIGINAL_SOURCE_CHANGED')
  return true
}

export function summarizeLint(report) {
  if (!report || !Array.isArray(report.fileinfos) || report.fileinfos.length !== 1) throw new Error('BOUNDED_LINT_REPORT_REQUIRED')
  const file = report.fileinfos[0]
  if (!Array.isArray(file.diagnostics) || !file.metrics || file.metrics.functions !== 1) throw new Error('REAL_BSL_DIAGNOSTICS_REQUIRED')
  const codes = {}
  for (const diagnostic of file.diagnostics) {
    if (typeof diagnostic.code !== 'string') throw new Error('INVALID_BSL_DIAGNOSTIC')
    codes[diagnostic.code] = (codes[diagnostic.code] ?? 0) + 1
  }
  return { files: 1, functions: file.metrics.functions, diagnostics: file.diagnostics.length, codes }
}

export function assessAcceptance({ mechanicalPassed, modelTurns, delegatedRuns }) {
  return { status: mechanicalPassed ? 'PARTIAL' : 'FAIL', mechanicalExecution: mechanicalPassed ? 'PASS' : 'FAIL',
    modelOrchestration: modelTurns > 0 && delegatedRuns > 0 ? 'UNASSESSED' : 'NOT_RUN',
    projectVerification: 'NOT_CERTIFIED', realDeploy: 'NOT_RUN',
    note: 'Programmed local acceptance proves native tool/runtime integration, not model planning, delegation quality or the business correctness of the project.' }
}

function parse(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--candidate-root', '--ui-artifact', '--policy-artifact', '--project-root', '--source-relative', '--bsl-ls', '--require-precedence-note'].includes(argv[i]) || !argv[i + 1]) throw new Error('USAGE')
    args[argv[i].slice(2)] = argv[i + 1]
  }
  if (['candidate-root', 'ui-artifact', 'policy-artifact', 'project-root', 'source-relative', 'bsl-ls'].some(key => !args[key])) throw new Error('ALL_EXPLICIT_PROBE_ARGUMENTS_REQUIRED')
  if (args['require-precedence-note'] !== undefined && !['true', 'false'].includes(args['require-precedence-note'])) throw new Error('BOOLEAN_REQUIRED')
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parse(argv), candidate = assertCandidatePath(args['candidate-root'])
  await preflightCandidate({ candidateRoot: candidate, uiArtifactRoot: resolve(args['ui-artifact']), policyArtifactRoot: resolve(args['policy-artifact']) })
  const evidenceRoot = join(REPO, 'var/project-acceptance')
  await mkdir(evidenceRoot, { recursive: true })
  const runRoot = join(evidenceRoot, `run-${randomUUID()}`)
  const source = await snapshotSource(args['project-root'], args['source-relative'], runRoot)
  const report = { schemaVersion: 1, source: { relativePath: source.sourceRelative, sha256: source.sourceHash, bytes: source.sourceBytes },
    checks: [], modelTurns: 0, delegatedRuns: 0, unexpectedToolCalls: [], mcpCalls: 0, deployments: 0 }
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); assert.ok(passed, name) }
  process.env.DSH_HOME = join(candidate, 'home'); process.env.DSH_AGENTS_HOME = join(candidate, 'home-agents')
  process.env.DSH_TELEMETRY = 'off'; process.env.DSH_TELEMETRY_DISABLED = '1'
  process.chdir(candidate)
  const modules = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
  const patch = join(runRoot, 'probe.patch.yml')
  await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
  let app
  const timer = setTimeout(() => process.exit(2), 240000)
  try {
    const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
    const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
    const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
    app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
    const ctx = app.ctx, id = `project-acceptance-${randomUUID()}`
    ctx.on('agent/request', () => { report.modelTurns++; throw new Error('MODEL_TURN_NOT_AUTHORIZED_BY_OFFLINE_PROBE') }, { prepend: true })
    const allowed = new Set(['read', 'edit', 'write', 'skill', 'airules_rule', 'airules_role', 'airules_capabilities'])
    ctx.tools.guard(exec => {
      if (!allowed.has(exec.name)) { report.unexpectedToolCalls.push(exec.name); return 'PROJECT_ACCEPTANCE_TOOL_DENIED' }
      const target = exec.arguments?.file_path
      if (typeof target === 'string' && !inside(runRoot, resolve(runRoot, target))) return 'PROJECT_ACCEPTANCE_PATH_DENIED'
    })
    await ctx.agents.create({ sessionId: id, meta: { cwd: runRoot, agentPreset: '1c-airules' }, setup: async (_scope, agent) => {
      setSandboxMode(agent.session, 'read-only'); await ctx.agentPresets.select(agent, '1c-airules')
    } })
    const agent = ctx.agents.get(id), signal = () => new AbortController().signal
    const execute = (name, arguments_) => agent.ctx.tools.execute({ name, arguments: arguments_, agent, callId: `acceptance-${randomUUID()}`, signal: signal() })
    const call = async (name, arguments_) => { const value = await execute(name, arguments_); check(`native ${name} execution`, value.isError === false); return value.value }
    check('1C preset mounted', ctx.agentPresets.composedPreset(agent.ctx) === '1c-airules')
    await agent.dispatch.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: signal() }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const instructionInbox = JSON.stringify(agent.inbox.nextStep)
    check('native project AGENTS supplied to actual scoped inbox', instructionInbox.includes('PROJECT_ACCEPTANCE_POLICY'))
    report.projectPolicy = { instructionsBound: true, semanticModelCompliance: 'NOT_ASSESSED', sameIdFileOverride: 'NOT_SUPPORTED_BY_EMBEDDED_RULE_TOOL' }
    const prompt = await agent.ctx.systemPrompt.assemble({ scope: agent, agent })
    const contract = prompt.sections.find(section => section.name === 'airules:contract')?.text ?? ''
    report.projectPolicy.precedenceNoteBound = contract.includes('Apply the active project instructions, project facts and explicit local overrides ahead of overridable embedded defaults.')
    if (args['require-precedence-note'] !== 'false') check('embedded contract explicitly binds project precedence', report.projectPolicy.precedenceNoteBound)
    for (const name of ['read', 'edit', 'write', 'skill', 'airules_role', 'airules_delegate']) check(`${name} actually registered`, !!agent.ctx.tools.get(name, agent))
    const observed = await call('read', { file_path: source.target, offset: 1, limit: 50 })
    check('bounded real source read', observed.lines?.length > 0 && observed.lines.length <= 50)
    check('native tool cannot reach original project outside snapshot', (await execute('read', { file_path: source.original, offset: 1, limit: 5 })).isError)
    const persona = await call('airules_role', { id: 'developer' })
    check('canonical developer persona loaded', typeof persona.text === 'string' && persona.text.length > 100)
    const rules = join(runRoot, 'rules'); await mkdir(rules)
    await writeFile(join(rules, 'subagent-pipeline.md'), 'PROJECT_SAME_ID_RULE_MARKER\n')
    const packagedRule = await call('airules_rule', { id: 'subagent-pipeline' })
    check('embedded airules_rule does not silently substitute same-id project file', typeof packagedRule.text === 'string' && !packagedRule.text.includes('PROJECT_SAME_ID_RULE_MARKER'))
    const registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.skills
    const override = join(runRoot, '.dsh/skills/handoff'); await mkdir(override, { recursive: true })
    await writeFile(join(override, 'SKILL.md'), '---\nname: handoff\ndescription: Project acceptance handoff override\n---\nPROJECT_HANDOFF_SKILL_MARKER\n')
    registry.invalidateCache()
    const skill = await call('skill', { name: 'handoff' })
    report.skillOverride = { valueKeys: Object.keys(skill ?? {}), markerVisible: JSON.stringify(skill).includes('PROJECT_HANDOFF_SKILL_MARKER'), candidates: (await registry.snapshot({ cwd: runRoot, scope: agent })).skills.filter(item => item.name === 'handoff').map(item => ({ name: item.name, path: item.path, source: item.source })) }
    check('native project skill overrides bundled skill with identical name', skill.content?.includes('PROJECT_HANDOFF_SKILL_MARKER'))
    const edit = { file_path: source.target, old_string: '//+', new_string: '// +' }
    check('read-only blocks editing snapshot', (await execute('edit', edit)).isError)
    check('read-only refusal preserves snapshot bytes', hash(await readFile(source.target)) === source.sourceHash)
    setSandboxMode(agent.session, 'workspace-write')
    const workflowRoot = join(candidate, 'home/profiles/desktop/node_modules/airules-dsh-workflows')
    const { createNativeProcessAdapter } = await import(pathToFileURL(join(workflowRoot, 'lib/native-process.js')))
    const { loadRuntime } = await import(pathToFileURL(join(workflowRoot, 'lib/runtime.js')))
    const { scrubbedParentEnv } = await import(pathToFileURL(join(modules, 'dsh-subprocess/lib/index.js')))
    const { classifyRunnerFailure, matchesSignature } = await import(pathToFileURL(join(modules, 'dsh-sandbox/lib/index.js')))
    const executable = await realpath(args['bsl-ls'])
    check('explicit installed BSL binary', (await lstat(executable)).isFile() && executable.toLowerCase().endsWith('.exe'))
    report.bslBinary = { name: 'bsl-language-server', sha256: hash(await readFile(executable)) }
    const core = await loadRuntime(), reports = ['before', 'after']
    let activePhase
    report.lintWarnings = {}
    const observedContext = { sandboxPolicy: ctx.sandboxPolicy, sandbox: ctx.sandbox, subprocess: {
      spawn(options) {
        const phase = activePhase, handle = ctx.subprocess.spawn(options)
        const warnings = { parseWarningsObserved: false, jvmCompatibilityWarningsObserved: false, categories: [], observedBytes: 0 }
        report.lintWarnings[phase] = warnings
        let tail = ''
        handle.stderr.on('data', data => {
          const bytes = Buffer.from(data); warnings.observedBytes += bytes.length
          // Keep only a short rolling fragment for split warning keywords.
          // Raw stderr, source text and absolute paths are never persisted.
          const text = tail + bytes.subarray(0, Math.max(0, 32768 - Math.min(32768, warnings.observedBytes - bytes.length))).toString('utf8')
          if (/token recognition error|syntax error/iu.test(text)) warnings.parseWarningsObserved = true
          if (/terminally deprecated|restricted method|sun\.misc\.Unsafe/iu.test(text)) warnings.jvmCompatibilityWarningsObserved = true
          tail = text.slice(-128)
          warnings.categories = [warnings.parseWarningsObserved && 'bsl-lexer-warning', warnings.jvmCompatibilityWarningsObserved && 'jvm-compatibility-warning'].filter(Boolean)
        })
        return handle
      },
    } }
    const adapter = createNativeProcessAdapter({ ctx: observedContext, agent, callId: `bsl-acceptance-${id}`, id: 'acceptance.bsl', core,
      nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature }, operations: { analyze: {
        command: executable, args: input => ['analyze', '-s', join(runRoot, 'src'), '-r', 'json', '-o', join(runRoot, 'artifacts', input.phase)],
        inputSchema: { type: 'object', required: ['phase'], properties: { phase: { type: 'string', enum: reports } }, additionalProperties: false },
        effects: ['startsProcess', 'readsSource', 'writesFilesystem'], validator: 'process-exit',
      } } })
    async function analyze(phase) {
      activePhase = phase
      await mkdir(join(runRoot, 'artifacts', phase))
      const result = await adapter.execute('analyze', { phase }, { cwd: runRoot, timeoutMs: 60000, runId: id, stepId: phase, artifactDir: join(runRoot, 'artifacts', phase), signal: signal() })
      report[`${phase}Process`] = result.data
      check(`${phase} BSL native process successful and terminated`, result.data.exitCode === 0 && result.data.terminationConfirmed && !result.data.startError)
      const raw = JSON.parse(await readFile(join(runRoot, 'artifacts', phase, 'bsl-json.json'), 'utf8'))
      return summarizeLint(raw)
    }
    report.before = await analyze('before')
    check('real baseline reports comment-spacing diagnostics', report.before.codes.SpaceAtStartComment === 2)
    // Native process execution conservatively invalidates file observations.
    // Refresh through the native reader rather than bypassing edit admission.
    await call('read', { file_path: source.target, offset: 1, limit: 50 })
    await call('edit', edit)
    await call('edit', { file_path: source.target, old_string: '//-', new_string: '// -' })
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(source.original))
    const changedText = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(source.target))
    check('only the two intended comment markers changed', changedText === originalText.replace('//+', '// +').replace('//-', '// -'))
    report.after = await analyze('after')
    check('targeted comment diagnostics removed', (report.after.codes.SpaceAtStartComment ?? 0) === 0)
    check('other real diagnostics retained in report', report.after.diagnostics === report.before.diagnostics - 2)
    check('unrelated diagnostic code remains unchanged', report.after.codes.MissingReturnedValueDescription === report.before.codes.MissingReturnedValueDescription)
    check('original project source unchanged', await assertOriginalUnchanged(source))
    check('unexpected tool calls absent', report.unexpectedToolCalls.length === 0)
    report.acceptance = assessAcceptance({ mechanicalPassed: true, modelTurns: report.modelTurns, delegatedRuns: report.delegatedRuns })
    await call('write', { file_path: join(runRoot, 'artifacts', 'handoff.md'), content: '# Acceptance handoff\n\nNative tools and BSL runtime passed on a copied real module. Original source unchanged. Model planning and delegation NOT RUN; project correctness NOT CERTIFIED; no MCP/database/deploy.\n' })
    await writeFile(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(`Project acceptance mechanical PASS (${report.checks.length} checks); model cycle NOT RUN; report ${join(runRoot, 'summary.json')}\n`)
    return report
  } catch (error) {
    report.error = String(error.message); report.acceptance = assessAcceptance({ mechanicalPassed: false, modelTurns: report.modelTurns, delegatedRuns: report.delegatedRuns })
    report.originalUnchanged = await assertOriginalUnchanged(source).catch(() => false)
    await writeFile(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    throw error
  } finally { clearTimeout(timer); await app?.ctx?.fiber.dispose() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
