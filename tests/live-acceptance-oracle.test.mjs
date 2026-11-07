import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateLiveReport, MATRIX, DOC_TOOL } from '../scripts/probe-live-model-orchestration.mjs'

// Synthetic records exercise the evaluator only; they are never live evidence.
function fixture(mcp = false) {
  const route = { ...MATRIX[mcp ? 1 : 0] }, request = { provider: route.provider, model: route.model, effort: route.effort }
  return {
    route, parentId: 'parent', parentRequest: request, originalUnchanged: true, exactCommentChanges: true,
    before: { diagnostics: 3, codes: { SpaceAtStartComment: 2, MissingReturnedValueDescription: 1 } },
    after: { diagnostics: 1, codes: { MissingReturnedValueDescription: 1 } },
    children: ['developer', 'tester'].map((role, index) => ({ id: role, role, local: true, stopReason: 'completed', startedOrder: index * 2 + 1, endedOrder: index * 2 + 2, request: { ...request }, policy: { mode: 'workspace-write', workspaceMatches: true } })),
    tools: [
      { agentId: 'developer', name: 'read', success: true, targetModule: true },
      { agentId: 'developer', name: 'edit', success: true, targetModule: true },
      { agentId: 'tester', name: 'read', success: true, targetModule: true },
      { agentId: 'tester', name: 'bsl_analyze', success: true },
      ...(mcp ? ['parent', 'developer'].map(agentId => ({ agentId, name: DOC_TOOL, success: true })) : []),
    ],
    lint: [{ agentId: 'tester', sourceSha256: 'synthetic-final-hash', diagnostics: 1, codes: { MissingReturnedValueDescription: 1 } }],
    finalSourceSha256: 'synthetic-final-hash', handoffVerified: true, modelRequests: 9, mcpRegistered: mcp ? 1 : 0, deployments: 0,
  }
}

test('oracle requires actual completed local child routes, effort and inherited workspace', () => {
  assert.equal(evaluateLiveReport(fixture()).status, 'PASS')
  for (const mutate of [r => { r.children[0].request = undefined }, r => { r.children[0].request.effort = 'low' }, r => { r.children[0].stopReason = 'cancelled' }, r => { r.children[0].local = false }, r => { r.children[0].policy.workspaceMatches = false }, r => { r.parentRequest = undefined }, r => { r.children[1].startedOrder = 1 }]) {
    const report = fixture(); mutate(report); assert.equal(evaluateLiveReport(report).status, 'FAIL')
  }
})

test('oracle rejects parent-only edits and stale or missing child lint', () => {
  for (const mutate of [r => { r.tools[1].agentId = 'parent' }, r => { r.tools[0].targetModule = false }, r => { r.lint[0].sourceSha256 = 'stale' }, r => { r.lint[0].agentId = 'parent' }, r => { r.tools[3].success = false }, r => { r.handoffVerified = false }]) {
    const report = fixture(); mutate(report); assert.equal(evaluateLiveReport(report).status, 'FAIL')
  }
})

test('MCP requires successful parent and child calls, while the local run admits no MCP', () => {
  assert.equal(evaluateLiveReport(fixture(true)).status, 'PASS')
  const parentOnly = fixture(true); parentOnly.tools = parentOnly.tools.filter(row => row.name !== DOC_TOOL || row.agentId === 'parent')
  assert.equal(evaluateLiveReport(parentOnly).checks.realMcp, false)
  const failedChild = fixture(true); failedChild.tools.at(-1).success = false
  assert.equal(evaluateLiveReport(failedChild).checks.realMcp, false)
  const unexpectedMcp = fixture(); unexpectedMcp.mcpRegistered = 1
  assert.equal(evaluateLiveReport(unexpectedMcp).checks.realMcp, false)
})

test('oracle retains unresolved diagnostics and refuses source drift, deployment or excess requests', () => {
  for (const mutate of [r => { r.after.codes.MissingReturnedValueDescription = 0 }, r => { r.originalUnchanged = false }, r => { r.exactCommentChanges = false }, r => { r.deployments = 1 }, r => { r.modelRequests = 25 }]) {
    const report = fixture(); mutate(report); assert.equal(evaluateLiveReport(report).status, 'FAIL')
  }
})

test('explicit native BOM loss is a partial result and never full PASS', () => {
  const report = fixture()
  report.exactCommentChanges = false
  report.semanticCommentChanges = true
  report.encodingDelta = 'bom-removed'
  assert.equal(evaluateLiveReport(report).status, 'PARTIAL')
  report.semanticCommentChanges = false
  assert.equal(evaluateLiveReport(report).status, 'FAIL')
})
