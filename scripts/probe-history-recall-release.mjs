import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { executeProbeTool } from './probe-tool-call.mjs'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'

/** Installed candidate + native registry/session-query acceptance; never calls a model. */
export async function historyRecallAcceptance({ ctx, agents, check, report, candidate, setSandboxMode }) {
  const modules = process.env.AIRULES_PROBE_NATIVE_MODULES ?? resolve('var/asar-extract-rc5/dsh/node_modules')
  const { createUserMessage } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  const root = join(candidate, 'history-recall-fixtures', randomUUID()), id = `history-sysadmin-${randomUUID()}`
  await mkdir(root, { recursive: true })
  await ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: 'sysadmin-airules' }, setup: async (_scope, agent) => { setSandboxMode(agent.session, 'read-only'); await ctx.agentPresets.select(agent, 'sysadmin-airules') } })
  const rows = [...agents, { root, id, agent: ctx.agents.get(id), preset: 'sysadmin-airules' }]
  const invoke = (row, name, args) => executeProbeTool(row.agent.ctx, { name, arguments: args, agent: row.agent, callId: `history-${randomUUID()}`, signal: new AbortController().signal })
  const appendUser = (session, text, options = { surfaceOp: 'append' }) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), options)
  const evidence = []
  for (const row of rows) {
    const expected = row.preset !== 'standard'
    for (const tool of ['history_search', 'history_read']) check(`${row.preset} native ${tool} scoped`, !!row.agent.ctx.tools.get(tool, row.agent) === expected)
    if (!expected) { const refused = await invoke(row, 'history_search', { query: 'absent' }); check('standard cannot execute history recall', refused.isError === true); continue }
    const session = row.agent.session, needle = `recall-evidence-${randomUUID()}`, original = `Original source ${needle} password=fixture-sensitive-value`
    const source = appendUser(session, original)
    appendUser(session, 'Locate current chat source')
    const before = await invoke(row, 'history_search', { query: needle })
    report.historyRecallDiagnostic ??= []; report.historyRecallDiagnostic.push({ preset: row.preset, sourceSeq: source.seq, before })
    await writeFile(join(candidate, 'smoke/history-recall-diagnostic.json'), JSON.stringify(report.historyRecallDiagnostic, null, 2), { mode: 0o600 })
    check(`${row.preset} mounted search reads current native journal`, before.isError === false && before.value?.hits?.length === 1 && before.value.hits[0].event_id === `s:${encodeURIComponent(row.id)}:${source.seq}`)
    const compactId = `recall-native-${randomUUID()}`
    session.append('compaction/start', { compactionId: compactId, turn: null })
    session.append('compaction/summary', { compactionId: compactId,
      summary: [{ type: 'text', text: 'Replacement summary without original needle' }],
      shadowedRange: { start: source.seq, end: source.seq }, shadowedSeqs: [source.seq],
      shadowedTokenCount: 1, provider: 'synthetic-fixture', model: 'no-model' })
    appendUser(session, 'Replacement summary without original needle', { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] })
    session.append('compaction/end', { compactionId: compactId, turn: null })
    appendUser(session, 'Locate the original evidence after compaction')
    const after = await invoke(row, 'history_search', { query: needle })
    check(`${row.preset} mounted search reads original source after native compact replacement`, after.isError === false && after.value?.hits?.length === 1 && after.value.hits[0].event_id === before.value.hits[0].event_id && after.value.snapshot !== before.value.snapshot)
    const hit = after.value?.hits?.[0]
    const read = await invoke(row, 'history_read', { event_id: hit?.event_id })
    check(`${row.preset} mounted read carries provenance and redacts fixture credential`, read.isError === false && read.value?.type === 'user/message' && read.value?.offset === 0 && read.value?.text?.includes(needle) && !read.value?.text?.includes('fixture-sensitive-value') && read.value?.redacted === true)
    const duplicate = await invoke(row, 'history_read', { event_id: hit.event_id })
    check(`${row.preset} duplicate page denied`, duplicate.isError === true)
    const foreign = await invoke(row, 'history_read', { event_id: `s:foreign:0` })
    check(`${row.preset} cross-session evidence denied`, foreign.isError === true)
    const selector = await invoke(row, 'history_search', { query: needle, session_id: 'foreign' })
    check(`${row.preset} cross-session selector denied`, selector.isError === true)
    evidence.push({ preset: row.preset, eventId: hit.event_id, beforeSnapshot: before.value.snapshot, afterSnapshot: after.value.snapshot, sourceSeq: source.seq, readOnly: row.preset === 'sysadmin-airules' })
  }
  report.historyRecall = { nativeCompactEventsAndReplacement: true, modelCompactionAcceptance: false, evidence, modelRequests: 0, deployments: 0 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runReleaseProbe({ ...parseArguments(process.argv.slice(2)), extraAcceptance: historyRecallAcceptance }); console.log(JSON.stringify(result)); process.exit(0) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', code: error.message, reportPath: error.reportPath ?? null })); process.exit(1) }
}
