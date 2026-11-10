import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { executeProbeTool } from './probe-tool-call.mjs'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'

/** Mounted candidate acceptance; synthetic session records, mocked memory
 * transport only. No model, network, database write or real project facts. */
export async function reviewedKnowledgeAcceptance({ ctx, agents, check, report, candidate, installed, setSandboxMode }) {
  const modules = process.env.AIRULES_PROBE_NATIVE_MODULES ?? resolve('var/asar-extract-rc5/dsh/node_modules')
  const { createUserMessage } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  const { datasetForRoot } = await import(pathToFileURL(join(installed, 'airules-dsh-memory-workspace/lib/core.js')))
  check('knowledge global native service mounted', typeof ctx.airulesKnowledge?.act === 'function')
  const memory = ctx.airulesMemory, originalConfig = memory.configuration, originalAct = memory.act, calls = []
  memory.configuration = async () => ({ config: { enabled: true }, revision: 'synthetic-memory-config' })
  memory.act = async (input, exec) => {
    calls.push({ input, sessionId: exec.agent.session.id })
    return { state: 'uploaded', indexed: false, needsProcessing: true, dataset: datasetForRoot(exec.agent.session.header.cwd), contentHash: 'b'.repeat(64) }
  }
  try {
    const root = join(candidate, 'knowledge-release-fixtures', randomUUID()), id = `knowledge-sysadmin-${randomUUID()}`
    await mkdir(root, { recursive: true })
    await ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: 'sysadmin-airules' }, setup: async (_scope, agent) => { setSandboxMode(agent.session, 'workspace-write'); await ctx.agentPresets.select(agent, 'sysadmin-airules') } })
    const rows = [...agents, { root, id, agent: ctx.agents.get(id), preset: 'sysadmin-airules' }], evidence = []
    const invoke = (row, args) => executeProbeTool(row.agent.ctx, { name: 'airules_knowledge', arguments: args, agent: row.agent, callId: `knowledge-${randomUUID()}`, signal: new AbortController().signal })
    const append = (session, text, source = { kind: 'user' }) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
    for (const row of rows) {
      const expected = row.preset !== 'standard'
      check(`${row.preset} knowledge tool scoped`, !!row.agent.ctx.tools.get('airules_knowledge', row.agent) === expected)
      if (!expected) { check('standard knowledge unavailable', (await invoke(row, { action: 'list' })).isError === true); continue }
      setSandboxMode(row.agent.session, 'workspace-write'); append(row.agent.session, 'Review the isolated synthetic lesson fixture.')
      const created = await invoke(row, { action: 'create', proposal: { kind: 'fact', title: 'Synthetic reviewed lesson', statement: `Synthetic fixture ${randomUUID()}; no live project fact.`, appliesTo: { scope: 'isolated native release fixture', version: '1' }, evidence: [{ kind: 'test', ref: 'probe-reviewed-knowledge-release.mjs', observedAt: new Date().toISOString() }] } })
      if (created.isError !== false || created.value?.record?.state !== 'draft') await writeFile(join(candidate, 'smoke/knowledge-create.private.json'), JSON.stringify(created), { mode: 0o600 })
      check(`${row.preset} mounted knowledge creates draft with native scope`, created.isError === false && created.value?.record?.state === 'draft' && created.value.record.content.appliesTo.project === row.root)
      const draft = created.value.record, review = await invoke(row, { action: 'review', id: draft.id, expectedRevision: draft.revision, findings: 'Synthetic fixture source verified.', evidenceVerified: true, applicabilityVerified: true, secretsChecked: true })
      check(`${row.preset} mounted knowledge review produces user checkpoint`, review.isError === false && typeof review.value?.approvalRequest === 'string')
      const reviewed = review.value.record, approve = { action: 'approve', id: reviewed.id, expectedRevision: reviewed.revision }
      check(`${row.preset} model cannot approve itself`, (await invoke(row, approve)).isError === true)
      append(row.agent.session, review.value.approvalRequest, { kind: 'airules-continuity' })
      check(`${row.preset} generated context cannot approve lesson`, (await invoke(row, approve)).isError === true)
      const checkpoint = append(row.agent.session, review.value.approvalRequest), approved = await invoke(row, approve)
      check(`${row.preset} genuine native user checkpoint approves exact revision`, approved.isError === false && approved.value?.record?.state === 'approved' && approved.value.approvalEvidence.eventSeq === checkpoint.seq)
      const record = approved.value.record, planned = await invoke(row, { action: 'plan', id: record.id, expectedRevision: record.revision, destination: 'cognee' })
      check(`${row.preset} publication preview binds current configuration`, planned.isError === false && planned.value?.previewOnly === true && planned.value.memoryConfigRevision === 'synthetic-memory-config')
      const publish = { action: 'publish', id: record.id, expectedRevision: record.revision, destination: 'cognee', expectedMemoryRevision: planned.value.memoryConfigRevision }
      const before = calls.length
      check(`${row.preset} changed memory configuration refused`, (await invoke(row, { ...publish, expectedMemoryRevision: 'stale' })).isError === true && calls.length === before)
      const written = await invoke(row, publish), repeated = await invoke(row, publish)
      check(`${row.preset} mocked memory dispatch uses existing scoped controller`, written.isError === false && written.value?.publication?.state === 'uploaded' && written.value.publication.indexed === false && calls.length === before + 1 && calls.at(-1).input.expectedRevision === 'synthetic-memory-config' && calls.at(-1).sessionId === row.id)
      check(`${row.preset} duplicate publication does not redispatch`, repeated.isError === false && repeated.value?.repeated === true && calls.length === before + 1)
      setSandboxMode(row.agent.session, 'read-only')
      check(`${row.preset} native read-only forbids lesson invalidation`, (await invoke(row, { action: 'stale', id: record.id, expectedRevision: record.revision, why: 'Synthetic version changed.' })).isError === true)
      evidence.push({ preset: row.preset, proposalId: record.id, approvalEventSeq: checkpoint.seq, memoryAdapterMocked: true })
    }
    report.reviewedKnowledge = { evidence, nativeUserCheckpoint: true, existingMemoryAdapterDispatch: true, memoryAdapterMocked: true, realMemoryWrites: 0, models: 0, deployments: 0 }
  } finally { memory.configuration = originalConfig; memory.act = originalAct }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runReleaseProbe({ ...parseArguments(process.argv.slice(2)), extraAcceptance: reviewedKnowledgeAcceptance }))); process.exit(0) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', code: error.message, reportPath: error.reportPath ?? null })); process.exit(1) }
}
