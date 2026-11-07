import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { createGuard, DOC_TOOL, DOC_ARGS } from '../scripts/probe-live-model-orchestration.mjs'
import { bootNativeHost } from '../scripts/live-native-host.mjs'

function fixture(mcp = false) {
  const runRoot = resolve('var/live-guard-unit'), target = join(runRoot, 'src/Module.bsl'), observations = []
  const guard = createGuard({ runRoot, target, mcp, parentId: () => 'parent', observations })
  const call = (name, args = {}, id = 'parent') => guard({ name, arguments: args, agent: { id } })
  return { runRoot, target, observations, call }
}

test('live admission limits source writes and denies shell/deploy independently of the model prompt', () => {
  const f = fixture()
  assert.equal(f.call('read', { file_path: f.target }), undefined)
  assert.equal(f.call('edit', { file_path: f.target }, 'developer'), undefined)
  assert.equal(f.call('edit', { file_path: f.target }), 'PARENT_SOURCE_WRITE_DENIED')
  assert.equal(f.call('write', { file_path: join(f.runRoot, 'artifacts/handoff.md') }), undefined)
  assert.equal(f.call('write', { file_path: resolve(f.runRoot, '../original/Module.bsl') }), 'LIVE_PATH_DENIED')
  for (const name of ['pwsh', 'bash', 'spawn', 'deploy', 'workflow_run']) assert.equal(f.call(name), 'LIVE_TOOL_DENIED')
  assert.equal(f.call('read', {}), 'LIVE_PATH_REQUIRED')
  assert.ok(f.observations.length >= 6)
})

test('MCP admission requires the exact read-only server tool and exact public query', () => {
  assert.equal(fixture(false).call(DOC_TOOL, DOC_ARGS), 'LIVE_TOOL_DENIED')
  const f = fixture(true)
  assert.equal(f.call(DOC_TOOL, DOC_ARGS), undefined)
  assert.equal(f.call(DOC_TOOL, { ...DOC_ARGS, max_chars: 999999 }), 'LIVE_DOC_ARGUMENTS_DENIED')
  assert.equal(f.call('mcp__1C-docs-mcp__arbitrary_write', {}), 'LIVE_TOOL_DENIED')
})

test('delegation is limited to the two authorized roles, the parent and the same workspace', () => {
  const f = fixture()
  for (const role of ['developer', 'tester']) assert.equal(f.call('airules_delegate', { role, task: 'bounded', cwd: f.runRoot }), undefined)
  assert.equal(f.call('airules_delegate', { role: 'developer', task: 'bounded' }, 'child'), 'LIVE_DELEGATION_DENIED')
  assert.equal(f.call('airules_delegate', { role: 'architect', task: 'bounded' }), 'LIVE_DELEGATION_DENIED')
  assert.equal(f.call('airules_delegate', { role: 'developer', cwd: resolve(f.runRoot, '..') }), 'LIVE_DELEGATION_CWD_DENIED')
})

test('live model host rejects a real profile or arbitrary root before importing or starting native services', async () => {
  const root = resolve('var/live-guard-unit')
  await assert.rejects(bootNativeHost({ candidateRoot: root, runRoot: root, authStorePath: join(root, 'auth.json'), credentialsPath: join(root, 'credentials.yaml'), provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', guard: () => undefined }), /CANDIDATE_PATH_FORBIDDEN/)
})
