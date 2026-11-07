import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_OUTCOMES = ['pass', 'fail-before', 'partial', 'no-report', 'stale', 'timeout']
const fail = code => { throw new Error(code) }
export async function fixtureDeployment(scope, binding, projectId, core, pwshPath) {
  core.canonical(binding)
  if (binding.schemaVersion !== 1 || binding.kind !== 'deploy-fixture'
    || Object.keys(binding).some(key => !['schemaVersion', 'kind', 'outcome'].includes(key))
    || !FIXTURE_OUTCOMES.includes(binding.outcome ?? 'pass')) fail('DEPLOY_FIXTURE_BINDING_INVALID')
  const root = await realpath(scope.root), targetDigest = core.digest({ fixture: true, root })
  const script = fileURLToPath(new URL('./deploy-fixture.ps1', import.meta.url))
  const profileDigest = core.digest(binding)
  const deployment = { projectId, resultPath: join(root, '.airules/workflow-fixture-reports'),
    sourcePath: root, profileDigest, exactBuild: '0.0.0.0', targetPath: join(root, '.airules/fixture-target'),
    targetDigest, target: { id: `fixture-${targetDigest}`, kind: 'fixture', environment: 'test' } }
  const outcome = binding.outcome ?? 'pass'
  return { deployment, script, digest: createHash('sha256').update(await readFile(script)).digest('hex'),
    operation: { command: pwshPath, inputSchema: { type: 'object', additionalProperties: false },
      fingerprintPaths: [script], effects: ['readsSource', 'startsProcess', 'writesFilesystem', 'writesTargetData', 'changesMetadata'],
      args(_inputs, context) {
        const d = context.deployContext
        return ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
          '-ResultRoot', deployment.resultPath, '-ProjectId', projectId,
          '-RunId', d.runId, '-StepId', d.stepId, '-SourceDigest', d.sourceDigest,
          '-TargetDigest', d.targetDigest, '-ProfileDigest', d.profileDigest, '-Outcome', outcome]
      } } }
}
