import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adaptOnecLspPackage, verifyOnecLspCompatibility, ONEC_LSP_STAGED_MANIFEST_SHA256 } from '../src/onec-lsp-compat/patch.mjs'
import { createHash } from 'node:crypto'
import { assertCandidatePath } from './smoke-official-candidate.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SDK = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
const TOOLS = ['lsp_diagnostics', 'lsp_completion', 'lsp_format', 'lsp_code_action', 'lsp_symbols', 'lsp_signature', 'lsp_inlay_hints', 'lsp_rename']
export async function probeLspCompatibility(candidateRoot) {
  const candidate = assertCandidatePath(candidateRoot), originalProfile = join(candidate, 'home/profiles/desktop')
  const runRoot = join(REPO, 'var/onec-lsp-compat', randomUUID()), home = join(runRoot, 'home'), profile = join(home, 'profiles/desktop'), workspace = join(runRoot, 'project')
  await mkdir(profile, { recursive: true }); await mkdir(join(workspace, '.git'), { recursive: true })
  for (const name of ['package.json', 'cordis.yml']) await cp(join(originalProfile, name), join(profile, name))
  let patch = await readFile(join(originalProfile, 'cordis.patch.yml'), 'utf8')
  const source = /^([ \t]*)servers: !!js .*\.lspActionsServers\(\)[ \t]*\r?$/gmu
  assert.equal([...patch.matchAll(source)].length, 1)
  patch = patch.replace(source, (_line, indent) => `${indent}servers: {}`)
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  await mkdir(join(profile, 'node_modules'))
  for (const entry of await readdir(join(originalProfile, 'node_modules'), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'dsh-lsp-actions') await cp(join(originalProfile, 'node_modules', entry.name), join(profile, 'node_modules', entry.name), { recursive: true })
    else if (entry.name.startsWith('@')) {
      await mkdir(join(profile, 'node_modules', entry.name))
      for (const child of await readdir(join(originalProfile, 'node_modules', entry.name))) await symlink(join(originalProfile, 'node_modules', entry.name, child), join(profile, 'node_modules', entry.name, child), 'junction')
    } else await symlink(join(originalProfile, 'node_modules', entry.name), join(profile, 'node_modules', entry.name), 'junction')
  }
  const localPackage = join(profile, 'node_modules/dsh-lsp-actions')
  const localManifest = await readFile(join(localPackage, 'package.json'))
  const adaptation = createHash('sha256').update(localManifest).digest('hex') === ONEC_LSP_STAGED_MANIFEST_SHA256
    ? verifyOnecLspCompatibility(localManifest, await readFile(join(localPackage, 'lib/index.js')))
    : await adaptOnecLspPackage(localPackage)
  const disabled = ['airules-subscriptions', 'airules-telegram', 'airules-mobile', 'airules-mcp-manager', 'airules-acp', 'airules-acp-adapter',
    'airules-additional-providers', 'airules-agent-import', 'session-title-llm', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics',
    'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'llm-retry', 'hmr', 'plugin-manager']
  const overlay = join(runRoot, 'probe.patch.yml')
  await writeFile(overlay, disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
  process.env.DSH_HOME = home; process.env.DSH_AGENTS_HOME = join(runRoot, 'agents'); process.env.DSH_TELEMETRY_DISABLED = '1'; process.env.DSH_TELEMETRY = 'off'
  const report = { schemaVersion: 1, adaptation, checks: [], modelAttempts: 0, subprocessAttempts: 0, serverConfigurations: 0, serverValidation: 'NOT_RUN', mcpCalls: 0 }
  const check = (name, ok) => { report.checks.push({ name, passed: !!ok }); assert.ok(ok, name) }
  let app
  const timer = setTimeout(() => process.exit(2), 120000)
  try {
    const { runProfile } = await import(pathToFileURL(join(SDK, 'dsh/lib/profile-boot.js')))
    const { loadLayeredEnv, evaluatePluginCompatibility } = await import(pathToFileURL(join(SDK, 'dsh-app-boot/lib/index.js')))
    const { setSandboxMode } = await import(pathToFileURL(join(SDK, 'dsh-sandbox-policy/lib/index.js')))
    const pkg = JSON.parse(await readFile(join(profile, 'node_modules/dsh-lsp-actions/package.json'), 'utf8'))
    check('exact rc5 own engine passes real native admission', evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.5') === undefined)
    check('next host version remains denied', !!evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.6'))
    app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [overlay], args: [] })
    const ctx = app.ctx
    ctx.on('agent/request', () => { report.modelAttempts++; throw new Error('LSP_COMPAT_PROBE_NO_MODELS') }, { prepend: true })
    ctx.subprocess.spawn = () => { report.subprocessAttempts++; throw new Error('LSP_COMPAT_PROBE_NO_SUBPROCESS') }
    ctx.tools.guard(exec => exec.name === 'lsp_diagnostics' ? undefined : 'LSP_COMPAT_PROBE_TOOL_REFUSED')
    const create = async preset => {
      const id = `lsp-compat-${preset}-${randomUUID()}`
      await ctx.agents.create({ sessionId: id, meta: { cwd: workspace, agentPreset: preset }, setup: async (_scope, agent) => { setSandboxMode(agent.session, 'read-only'); await ctx.agentPresets.select(agent, preset) } })
      return ctx.agents.get(id)
    }
    const onec = await create('1c-airules'), standard = await create('standard')
    report.tools = TOOLS.filter(name => onec.ctx.tools.get(name, onec))
    check('all eight actual LSP tools register in 1C agent scope', report.tools.length === TOOLS.length)
    check('standard preset receives no 1C LSP tools', TOOLS.every(name => !standard.ctx.tools.get(name, standard)))
    const composition = (await ctx.agentPresets.compositionInventory()).find(row => row.id === '1c-airules')
    report.activation = composition?.rows?.find(row => row.entryId === 'onec-lsp-actions') ?? null
    check('native scoped onec-lsp-actions fiber is enabled and active', report.activation?.enabled === true && report.activation?.fiberState === 2)
    report.module = ctx.agentPresets.inspectCompositions(onec.ctx).flatMap(row => row.modules).filter(row => JSON.stringify(row).includes('lsp-actions'))
    check('actual scoped native composition contains LSP action module', report.module.length > 0)
    await writeFile(join(workspace, 'Module.bsl'), 'Процедура Пример()\nКонецПроцедуры\n')
    const result = await onec.ctx.tools.execute({ name: 'lsp_diagnostics', arguments: { file_path: join(workspace, 'Module.bsl') }, agent: onec, callId: `lsp-empty-${randomUUID()}`, signal: new AbortController().signal })
    report.emptyServerResult = { isError: result.isError, code: result.error?.info?.code ?? null }
    check('empty server route returns honest unavailable result', result.isError === true && JSON.stringify(result.error ?? result.content).includes('LSP_ACTION_UNAVAILABLE'))
    check('no language server, MCP or model was launched', report.subprocessAttempts === 0 && report.modelAttempts === 0 && report.mcpCalls === 0)
    report.status = 'PASS'
  } catch (error) { report.status = 'FAIL'; report.error = error.message; throw error }
  finally { clearTimeout(timer); await writeFile(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2) + '\n'); await app?.ctx?.fiber.dispose() }
  return { report, reportPath: join(runRoot, 'summary.json') }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  probeLspCompatibility(resolve(process.argv[2] ?? 'var/candidate/official-desktop-rc5-26')).then(({ report, reportPath }) => process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath }) + '\n'), error => { process.stderr.write(`LSP compatibility probe failed: ${error.message}\n`); process.exitCode = 1 })
}
