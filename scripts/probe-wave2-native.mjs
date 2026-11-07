import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

// Disposable native-profile acceptance only. Never submits a model request or
// invokes MCP, a project runner, a live database, COM, Telegram or deployment.
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const candidate = assertCandidatePath(process.argv[2]), ui = resolve(process.argv[3]), policy = resolve(process.argv[4])
await preflightCandidate({ candidateRoot: candidate, uiArtifactRoot: ui, policyArtifactRoot: policy })
process.env.DSH_HOME = join(candidate, 'home'); process.env.DSH_AGENTS_HOME = join(candidate, 'home-agents')
process.env.DSH_TELEMETRY = 'off'; process.env.DSH_TELEMETRY_DISABLED = '1'
process.chdir(candidate)
const modules = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai'), smoke = join(candidate, 'smoke')
await mkdir(smoke, { recursive: true })
const patch = join(candidate, 'wave2-native-probe.patch.yml')
await writeFile(patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n')
const report = { schemaVersion: 1, checks: [], modelTurns: 0, mcpCallsExecuted: 0, projectRunnersExecuted: 0, deploymentsExecuted: 0 }
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ name, passed: true }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const ONEC = '1c-impact 1c-mechanism-map 1c-code-search 1c-meta-info 1c-form-inspect 1c-platform-help 1c-templates-memory 1c-qa-testing 1c-form-shot 1c-event-journal 1c-debug-runtime mcp-1c-tools onec-check-mcp'.split(' ')
const SHARED = 'api-conventions caveman craft-mermaid document-import office office-docx office-export-pdf office-pptx office-recalculate office-render office-xlsx creating-dsh-plugins telegram'.split(' ')
let app, runtimeFiber
const timer = setTimeout(() => process.exit(2), 540000)
try {
  const { runProfile } = await import(pathToFileURL(join(modules, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await import(pathToFileURL(join(modules, 'dsh-app-boot/lib/index.js')))
  const { setSandboxMode } = await import(pathToFileURL(join(modules, 'dsh-sandbox-policy/lib/index.js')))
  app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidate), patchFiles: [patch], args: [] })
  const ctx = app.ctx
  ctx.on('agent/request', () => { report.modelTurns++; throw new Error('PROBE_MODEL_REQUEST_FORBIDDEN') }, { prepend: true })
  report.unexpectedToolCalls = []
  const allowedTools = new Set(['skill', 'load_workspace_dependencies', 'craft_mermaid_render', 'airules_capabilities', 'airules_debug_case', 'airules_documents', 'airules_office'])
  ctx.tools.guard(execution => {
    if (allowedTools.has(execution.name)) return
    report.unexpectedToolCalls.push(execution.name)
    return 'PROBE_TOOL_OUTSIDE_ALLOWLIST'
  })
  if (!ctx.tools.get('load_workspace_dependencies')) {
    const plugin = await import(pathToFileURL(join(modules, 'dsh-tool-workspace-dependencies/lib/index.js')))
    runtimeFiber = ctx.plugin(plugin, { source: join(candidate, 'install/resources/runtime/primary-runtime'), root: join(candidate, 'home/dsh-runtimes/dsh-primary-runtime') })
    await runtimeFiber.ready
  }
  check('official workspace dependency tool is registered', !!ctx.tools.get('load_workspace_dependencies'))
  const agents = []
  for (const preset of ['1c-airules', 'python-airules', 'sysadmin-airules', 'standard']) {
    const root = join(candidate, 'wave2-fixtures', `${preset}-${randomUUID()}`), id = `wave2-${randomUUID()}`
    await mkdir(join(root, '.git'), { recursive: true }); await mkdir(join(root, 'artifacts')); await mkdir(join(root, 'docs'))
    await ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: preset }, setup: async (_scope, agent) => {
      setSandboxMode(agent.session, 'danger-full-access'); await ctx.agentPresets.select(agent, preset)
    } })
    const agent = ctx.agents.get(id)
    check(`${preset} is natively composed`, ctx.agentPresets.composedPreset(agent.ctx) === preset)
    agents.push({ preset, root, id, agent })
  }
  const onec = agents[0], standard = agents[3]
  const exec = (row, name, args) => row.agent.ctx.tools.execute({ name, arguments: args, agent: row.agent, callId: `wave2-${randomUUID()}`, signal: signal() })
  const tool = (row, name) => row.agent.ctx.tools.get(name, row.agent)
  async function call(row, name, args) { const result = await exec(row, name, args); check(`${name} native execution succeeds`, result.isError === false); return result.value }
  for (const row of agents) {
    for (const name of ['craft_mermaid_render', 'airules_documents', 'airules_office']) check(`${row.preset} scopes ${name}`, !!tool(row, name) === (row.preset !== 'standard'))
    for (const name of ['airules_capabilities', 'airules_debug_case']) check(`${row.preset} scopes ${name}`, !!tool(row, name) === (row.preset === '1c-airules'))
  }
  const installed = join(candidate, 'home/profiles/desktop/node_modules'), rulepack = join(installed, 'airules-dsh-rulepack')
  const manifest = JSON.parse(await readFile(join(rulepack, 'manifest.json'), 'utf8'))
  for (const row of agents) {
    const registry = ctx.agentPresets.serviceFor(row.agent, 'skills') ?? ctx.skills
    const snapshot = await registry.snapshot({ cwd: row.root, scope: row.agent })
    check(`${row.preset} complete skill registry`, snapshot.complete)
    for (const name of ONEC) {
      const available = snapshot.skills.some(item => item.name === name)
      check(`${row.preset} isolates 1C procedure ${name}`, available === (row === onec))
      if (available) {
        const record = manifest.files[`skills/${name}/SKILL.md`], bytes = await readFile(join(rulepack, `skills/${name}/SKILL.md`))
        check(`${name} canonical payload digest`, !!record && record.sha256 === sha(bytes))
        const loaded = await tool(row, 'skill').execute({ name }, { agent: row.agent, signal: signal() })
        check(`${name} loads through native skill tool`, loaded.content.includes(bytes.toString('utf8').split(/\r?\n/u).find(line => line.startsWith('# '))))
      }
    }
    for (const name of SHARED) {
      const available = snapshot.skills.some(item => item.name === name)
      check(`${row.preset} scopes shared wave2 skill ${name}`, available === (row.preset !== 'standard'))
      if (available) {
        const bytes = await readFile(join(rulepack, `skills/${name}/SKILL.md`)), record = manifest.files[`skills/${name}/SKILL.md`]
        check(`${row.preset} ${name} payload matches canonical digest`, record?.sha256 === sha(bytes))
        check(`${row.preset} ${name} shared copy matches canonical`, bytes.equals(await readFile(join(installed, 'airules-dsh-domain-presets/skills/common', name, 'SKILL.md'))))
        const loaded = await tool(row, 'skill').execute({ name }, { agent: row.agent, signal: signal() })
        check(`${row.preset} native load of ${name}`, loaded.content.includes(bytes.toString('utf8').split(/\r?\n/u).find(line => line.startsWith('# '))))
      }
    }
  }
  const origin = ctx.webServer.getOrigin(), login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookies = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('native browser admission', login.status === 303 && !!cookies)
  async function request(path, row, body, csrf) {
    const url = new URL(path, origin); if (!body) url.searchParams.set('sessionId', row.id)
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { cookie: cookies, origin: new URL(origin).origin,
      ...(body ? { 'content-type': 'application/json', 'x-dsh-csrf': csrf ?? '' } : {}) }, ...(body ? { body: JSON.stringify({ sessionId: row.id, ...body }) } : {}) })
    return { status: response.status, ...await response.json() }
  }
  for (const [index, taskType] of ['testing', 'documentation'].entries()) {
    const inventory = await request('/airules/skills', onec)
    check('wave2 assignment defaults exposed by native settings', inventory.ok && [...ONEC, ...SHARED].every(name => Object.hasOwn(inventory.assignments.defaults, name)))
    const changed = await request('/airules/skills', onec, { action: 'task-context', taskType, revision: inventory.assignments.context.revision }, inventory.csrfToken)
    check(`native wave2 task context ${taskType}`, changed.ok)
    const decision = await onec.agent.dispatch.waterfall('agent/pre-step', { messages: [], turn: 1, step: index + 1, signal: signal() }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const catalog = decision.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1), names = catalog?.source.entries.map(row => row.name) ?? []
    check(`${taskType} selects 1C QA procedure by task`, catalog?.source.owner === 'airules-skill-assignments' && names.includes('1c-qa-testing') === (taskType === 'testing'))
    check(`${taskType} selects Office presentation procedure by task`, names.includes('office-pptx') === (taskType === 'documentation'))
    check(`${taskType} preserves opt-in style skill availability`, names.includes('caveman'))
    for (const message of decision.messages.filter(message => message.source?.kind === 'skill-catalog')) onec.agent.session.append('user/message', message, { surfaceOp: 'append' })
    onec.agent.session.append('step/start', { turn: 1, step: index + 1 })
  }
  const automatic = await request('/airules/skills', onec)
  check('preview restores automatic skill task selection', (await request('/airules/skills', onec, { action: 'task-context', taskType: 'auto', revision: automatic.assignments.context.revision }, automatic.csrfToken)).ok)
  let style = await request('/airules/general-tools', onec)
  check('caveman defaults to off', style.ok && style.mode === 'off' && style.supported)
  check('style mutation requires CSRF', (await request('/airules/general-tools', onec, { mode: 'lite', revision: style.revision })).status === 403)
  const previousStyle = style.revision
  style = await request('/airules/general-tools', onec, { mode: 'lite', revision: style.revision }, style.csrfToken)
  check('caveman opt-in persisted through HTTP', style.ok && style.mode === 'lite' && (await request('/airules/general-tools', onec)).revision === style.revision)
  check('stale style rejected', (await request('/airules/general-tools', onec, { mode: 'off', revision: previousStyle }, style.csrfToken)).status === 409)
  const assembled = await onec.agent.ctx.systemPrompt.assemble({ scope: onec.agent, agent: onec.agent })
  check('opt-in style appears in actual scoped system prompt', assembled.sections.some(section => section.name === 'airules:caveman-lite' && section.text.includes('Caveman lite is explicitly enabled')))
  const stdStyle = await request('/airules/general-tools', standard)
  check('Standard never inherits style', stdStyle.ok && !stdStyle.supported && stdStyle.mode === 'off')
  check('Standard style mutation rejected', !(await request('/airules/general-tools', standard, { mode: 'lite', revision: stdStyle.revision }, stdStyle.csrfToken)).ok)
  const standardPrompt = await standard.agent.ctx.systemPrompt.assemble({ scope: standard.agent, agent: standard.agent })
  check('Standard prompt has no caveman contribution', !standardPrompt.sections.some(section => section.name === 'airules:caveman-lite'))
  await writeFile(join(onec.root, 'diagram.mmd'), 'flowchart LR\n  A[Source] --> B[Checks]\n  B --> C[Report]\n')
  setSandboxMode(onec.agent.session, 'read-only')
  const deniedRender = await exec(onec, 'craft_mermaid_render', { input: 'diagram.mmd', outDir: 'artifacts' })
  check('readonly rejects renderer before writing output', deniedRender.isError && (await readdir(join(onec.root, 'artifacts'))).length === 0)
  setSandboxMode(onec.agent.session, 'danger-full-access')
  const rendered = await call(onec, 'craft_mermaid_render', { input: 'diagram.mmd', outDir: 'artifacts' })
  check('Mermaid produces real PNG with reviewed digest', rendered.ok && rendered.visualReview === 'required' && sha(await readFile(rendered.artifacts.png)) === rendered.pngDigest)
  report.mermaidPng = rendered.artifacts.png
  const capabilities = await call(onec, 'airules_capabilities', { category: 'all', query: 'airules_office', limit: 5 })
  check('1C discovery returns actual native definitions without probing', capabilities.execution === 'not-performed' && JSON.stringify(capabilities).includes('airules_office') && JSON.stringify(capabilities).includes('not-probed'))
  await writeFile(join(onec.root, 'source.bsl'), '// synthetic source\n'); await writeFile(join(onec.root, 'observation.txt'), 'synthetic observed value=42\n')
  setSandboxMode(onec.agent.session, 'read-only')
  let notebook = await call(onec, 'airules_debug_case', { action: 'open', title: 'Synthetic runtime investigation', hypotheses: ['Expected value is 42'], paths: ['source.bsl'] })
  const firstRevision = notebook.revision
  notebook = await call(onec, 'airules_debug_case', { action: 'evidence', caseId: notebook.id, expectedRevision: notebook.revision, kind: 'observation', text: 'Synthetic fixture observation only.', paths: ['observation.txt'] })
  check('notebook stores evidence without certification', notebook.certified === false && notebook.sourceFresh && notebook.artifactsFresh)
  check('notebook rejects stale CAS', (await exec(onec, 'airules_debug_case', { action: 'close', caseId: notebook.id, expectedRevision: firstRevision, outcome: 'unresolved' })).isError)
  await writeFile(join(onec.root, 'source.bsl'), '// synthetic changed source\n')
  notebook = await call(onec, 'airules_debug_case', { action: 'status', caseId: notebook.id })
  check('notebook detects stale source', notebook.sourceFresh === false && notebook.certified === false)
  notebook = await call(onec, 'airules_debug_case', { action: 'close', caseId: notebook.id, expectedRevision: notebook.revision, outcome: 'reported-resolved' })
  check('closing case never certifies stale evidence', notebook.status === 'closed' && !notebook.sourceFresh && !notebook.certified)
  check('read-only notebook writes only private metadata', (await readdir(onec.root)).filter(name => name.endsWith('.json')).length === 0)
  setSandboxMode(onec.agent.session, 'danger-full-access')

  let docs = await request('/airules/documents', onec)
  check('document HTTP route admitted', docs.ok && docs.writable && Array.isArray(docs.documents))
  const nativeDocumentStatus = await call(onec, 'airules_documents', { action: 'status' })
  check('document tool executes in the exact active native agent', nativeDocumentStatus.projectRoot === onec.root && nativeDocumentStatus.writable)
  const docsPost = body => request('/airules/documents', onec, body, docs.csrfToken)
  const runtime = await call(onec, 'load_workspace_dependencies', {})
  const { runNative } = await import(pathToFileURL(join(installed, 'airules-dsh-document-workbench/lib/process.js')))
  report.documentWorkerDiagnostics = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = options => {
    const handle = spawn(options)
    if (options.argv.some(value => /(?:^|[\\/])convert-worker\.js$/u.test(value))) {
      const diagnostic = { stdout: '', stderr: '' }; report.documentWorkerDiagnostics.push(diagnostic)
      for (const key of ['stdout', 'stderr']) handle[key].on('data', bytes => { if (diagnostic[key].length < 32768) diagnostic[key] += Buffer.from(bytes).toString('utf8').slice(0, 32768 - diagnostic[key].length) })
    }
    return handle
  }
  const author = join(onec.root, 'make-fixtures.py')
  await writeFile(author, 'from pathlib import Path\nfrom docx import Document\nfrom openpyxl import Workbook\nfrom pptx import Presentation\nroot=Path("docs")\ndoc=Document();doc.add_heading("Wave2 native fixture",0);doc.add_paragraph("WAVE2_MARKER source document");doc.save(root/"fixture.docx")\nw=Workbook();s=w.active;s["A1"]=20;s["A2"]=22;s["A3"]="=SUM(A1:A2)";s["B1"]="WAVE2_MARKER spreadsheet";w.save(root/"fixture.xlsx")\np=Presentation();slide=p.slides.add_slide(p.slide_layouts[0]);slide.shapes.title.text="Captain Diesel slide";slide.placeholders[1].text="WAVE2_MARKER presentation";p.save(root/"fixture.pptx")\n')
  await runNative(ctx, onec.agent, [runtime.python, author], { signal: signal(), writes: true })
  const sourceHashes = Object.fromEntries(await Promise.all(['fixture.docx', 'fixture.xlsx', 'fixture.pptx'].map(async name => [name, sha(await readFile(join(onec.root, 'docs', name)))])))
  const officeRuntime = await docsPost({ kind: 'office', action: 'runtime' })
  report.officeCapabilities = officeRuntime.office
  check('Office uses actual bundled native runtime and stock capabilities', officeRuntime.ok && officeRuntime.local && officeRuntime.office)
  const nativeOfficeRuntime = await call(onec, 'airules_office', { action: 'runtime' })
  check('Office native nested runtime uses the same bundled interpreters', nativeOfficeRuntime.python === runtime.python && nativeOfficeRuntime.node === runtime.node)
  // runProfile imports the stock framework from the review extraction. Also
  // exercise the installed desktop's physical native closure independently.
  const physicalOfficeCli = join(candidate, 'install/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js')
  const physicalCaps = JSON.parse((await runNative(ctx, onec.agent, [runtime.node, physicalOfficeCli, 'capabilities', '--json'], { signal: signal() })).stdout)
  check('installed desktop physical LibreOffice CLI loads its native closure', Array.isArray(physicalCaps.conversions))
  const physicalPdf = join(onec.root, 'artifacts/physical-desktop.pdf')
  await runNative(ctx, onec.agent, [runtime.node, physicalOfficeCli, 'convert', '--input', join(onec.root, 'docs/fixture.docx'), '--output', physicalPdf], { signal: signal(), writes: true })
  check('installed desktop physical LibreOffice exports actual PDF', (await readFile(physicalPdf)).subarray(0, 5).toString() === '%PDF-')
  const pdf = await docsPost({ kind: 'office', action: 'convert', path: 'docs/fixture.docx', output: 'docs/fixture.pdf' })
  report.pdfExport = pdf
  check('Office exports actual PDF', pdf.ok && (await readFile(join(onec.root, 'docs/fixture.pdf'))).subarray(0, 5).toString() === '%PDF-')
  const index = await docsPost({ kind: 'document', action: 'index', path: 'docs' })
  report.documentIndex = index
  check('document backend indexes PDF DOCX XLSX PPTX', index.ok && index.count === 4 && index.failed === 0 && index.documents.every(item => item.status === 'ready'))
  const search = await docsPost({ kind: 'document', action: 'search', query: 'WAVE2_MARKER' })
  check('document search returns source-bound evidence', search.ok && ['fixture.docx', 'fixture.xlsx', 'fixture.pdf', 'fixture.pptx'].every(name => search.matches.some(item => item.path === `docs/${name}` && /^[a-f0-9]{64}$/u.test(item.sha256))))
  const read = await docsPost({ kind: 'document', action: 'read', path: 'docs/fixture.docx', limit: 10 })
  check('document read returns bounded numbered text', read.ok && read.lines.some(item => item.text.includes('WAVE2_MARKER')) && read.lines.every(item => Number.isInteger(item.line)))
  const slideRead = await docsPost({ kind: 'document', action: 'read', path: 'docs/fixture.pptx', limit: 20 })
  check('PPTX extraction reads the actual slide title', slideRead.ok && slideRead.lines.some(item => item.text.includes('Captain Diesel slide')))
  const invalidPages = await docsPost({ kind: 'office', action: 'render', path: 'docs/fixture.pdf', output: 'artifacts/invalid-pages', pages: '0' })
  check('invalid Office page range rejected without an output', !invalidPages.ok && invalidPages.error === 'DOCUMENT_PAGE_RANGE_INVALID' && !(await access(join(onec.root, 'artifacts/invalid-pages')).then(() => true, () => false)))
  const page = await docsPost({ kind: 'office', action: 'render', path: 'docs/fixture.pdf', output: 'artifacts/pdf-pages', pages: '1' })
  report.pdfRender = page
  check('Office renders PDF pages', page.ok)
  const pngNames = (await readdir(join(onec.root, 'artifacts/pdf-pages'), { recursive: true })).filter(name => name.endsWith('.png'))
  check('Office render contains real PNG', pngNames.length > 0 && (await readFile(join(onec.root, 'artifacts/pdf-pages', pngNames[0]))).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
  report.officePng = join(onec.root, 'artifacts/pdf-pages', pngNames[0])
  const slidePdf = await docsPost({ kind: 'office', action: 'convert', path: 'docs/fixture.pptx', output: 'artifacts/slides.pdf' })
  report.slideExport = slidePdf
  check('Office exports PPTX to actual PDF', slidePdf.ok && (await readFile(join(onec.root, 'artifacts/slides.pdf'))).subarray(0, 5).toString() === '%PDF-')
  const slidePage = await docsPost({ kind: 'office', action: 'render', path: 'artifacts/slides.pdf', output: 'artifacts/slide-pages', pages: '1' })
  report.slideRender = slidePage
  const slidePng = slidePage.ok ? (await readdir(join(onec.root, 'artifacts/slide-pages'), { recursive: true })).find(name => name.endsWith('.png')) : null
  check('Office renders first presentation slide to real PNG', !!slidePng && (await readFile(join(onec.root, 'artifacts/slide-pages', slidePng))).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
  report.slidePng = join(onec.root, 'artifacts/slide-pages', slidePng)
  const recalc = await docsPost({ kind: 'office', action: 'recalculate', path: 'docs/fixture.xlsx', output: 'artifacts/recalculated.xlsx' })
  report.recalculation = recalc
  check('Office recalculates a workbook', recalc.ok)
  const formulaCheck = join(onec.root, 'check-formula.py')
  await writeFile(formulaCheck, 'from openpyxl import load_workbook\nimport json\nprint(json.dumps({"value":load_workbook("artifacts/recalculated.xlsx",data_only=True).active["A3"].value}))\n')
  check('real LibreOffice calculated formula equals 42', JSON.parse((await runNative(ctx, onec.agent, [runtime.python, formulaCheck], { signal: signal() })).stdout).value === 42)
  const worksheet = await docsPost({ kind: 'office', action: 'render', path: 'artifacts/recalculated.xlsx', output: 'artifacts/sheet-pages', sheet: 'Sheet', range: 'A1:B3' })
  report.worksheetRender = worksheet
  const worksheetPng = worksheet.ok ? (await readdir(join(onec.root, 'artifacts/sheet-pages'), { recursive: true })).find(name => name.endsWith('.png')) : null
  check('Office renders an exact worksheet cell range to real PNG', !!worksheetPng && (await readFile(join(onec.root, 'artifacts/sheet-pages', worksheetPng))).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
  report.worksheetPng = join(onec.root, 'artifacts/sheet-pages', worksheetPng)
  const wrongWorksheetPages = await docsPost({ kind: 'office', action: 'render', path: 'artifacts/recalculated.xlsx', output: 'artifacts/invalid-sheet-pages', sheet: 'Sheet', pages: '1' })
  check('worksheet rendering rejects physical page selectors without an output', !wrongWorksheetPages.ok && !(await access(join(onec.root, 'artifacts/invalid-sheet-pages')).then(() => true, () => false)))
  check('Office preserves original source bytes', (await Promise.all(Object.entries(sourceHashes).map(async ([name, hash]) => sha(await readFile(join(onec.root, 'docs', name))) === hash))).every(Boolean))
  await writeFile(join(onec.root, 'docs/fixture.pdf'), Buffer.concat([await readFile(join(onec.root, 'docs/fixture.pdf')), Buffer.from('\n% synthetic stale change\n')]))
  const stale = await docsPost({ kind: 'document', action: 'search', query: 'WAVE2_MARKER' })
  check('stale source excluded from document search', stale.ok && !stale.matches.some(item => item.path === 'docs/fixture.pdf') && stale.excluded.some(item => item.path === 'docs/fixture.pdf' && item.status === 'stale'))
  check('document paths cannot escape project', !(await docsPost({ kind: 'document', action: 'read', path: '../outside.docx' })).ok)
  const foreign = await request('/airules/documents', agents[1], { kind: 'document', action: 'search', query: 'WAVE2_MARKER' }, docs.csrfToken)
  check('document index does not leak across project roots', foreign.ok && foreign.matches.length === 0)
  setSandboxMode(onec.agent.session, 'read-only')
  check('readonly rejects document indexing', !(await docsPost({ kind: 'document', action: 'index', path: 'docs' })).ok)
  check('readonly rejects Office writes', !(await docsPost({ kind: 'office', action: 'convert', path: 'docs/fixture.docx', output: 'artifacts/forbidden.pdf' })).ok)
  setSandboxMode(onec.agent.session, 'danger-full-access')
  check('zero model requests', report.modelTurns === 0)
  check('no unexpected tool dispatch including MCP or project runners', report.unexpectedToolCalls.length === 0)
  report.passed = true
  await writeFile(join(smoke, 'wave2-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--serve-preview')) {
    clearTimeout(timer)
    const privateFile = join(smoke, 'wave2-preview.private.json'), stop = join(smoke, 'wave2-preview.stop')
    await rm(stop, { force: true })
    await writeFile(privateFile, JSON.stringify({ url: ctx.connection.authenticatedUrl(origin), sessions: agents.map(({ id, root, preset }) => ({ id, root, preset })), sessionId: onec.id, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 720000
    while (Date.now() < deadline) { if (await access(stop).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 500)) }
    await rm(privateFile, { force: true }); await rm(stop, { force: true })
  }
  await app.ctx.fiber.dispose(); clearTimeout(timer)
  process.stdout.write(`Native wave2: PASS (${report.checks.length} checks); no model/MCP/project runner/deploy calls\n`)
  process.exit(0)
} catch (error) {
  report.passed = false
  await writeFile(join(smoke, 'wave2-native-summary.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
  await writeFile(join(smoke, 'wave2-probe-error.log'), String(error?.stack ?? 'PROBE_ERROR')).catch(() => {})
  try { await app?.ctx?.fiber.dispose() } catch {}
  clearTimeout(timer); process.stderr.write('NATIVE_WAVE2_PROBE_FAILED; inspect isolated probe error log\n'); process.exit(1)
}
