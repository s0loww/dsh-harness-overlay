import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOfficialUiInstallPlan, DEFAULT_ARTIFACT, OfficialUiInstallerError } from './common.mjs'

function parseArgs(argv) {
  const result = { artifact: DEFAULT_ARTIFACT, json: false, replaceCollisions: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { result.json = true; continue }
    if (key === '--replace-collisions') { result.replaceCollisions = true; continue }
    if (!['--candidate-root', '--artifact'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    result[key.slice(2)] = argv[++index]
  }
  if (!result['candidate-root']) throw new OfficialUiInstallerError('USAGE', '--candidate-root is required')
  return result
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const plan = await buildOfficialUiInstallPlan({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, replaceCollisions: args.replaceCollisions })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: plan.status, artifact: plan.artifact, target: plan.target, operations: plan.operations.map(item => ({ type: item.type, package: item.package, target: item.targetRelative })), collisions: plan.collisions }, null, 2)}\n`)
  else {
    process.stdout.write(`Official UI plan: ${plan.status.toUpperCase()} (read-only)\n`)
    process.stdout.write(`Artifact: ${plan.artifact.id} ${plan.artifact.version}; operations: ${plan.operations.length}\n`)
    for (const item of plan.operations) process.stdout.write(`- ${item.type}: ${item.targetRelative}\n`)
    if (plan.collisions.length) for (const item of plan.collisions) process.stdout.write(`! collision: ${item.target}\n`)
  }
  if (plan.status === 'blocked') process.exitCode = 2
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
