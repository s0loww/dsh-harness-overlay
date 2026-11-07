import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOfficialPolicyPlan, DEFAULT_ARTIFACT, OfficialUiInstallerError } from './common.mjs'

export async function main(argv = process.argv.slice(2)) {
  const args = { artifact: DEFAULT_ARTIFACT, json: false, replaceCollisions: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') { args.json = true; continue }
    if (argv[i] === '--replace-collisions') { args.replaceCollisions = true; continue }
    if (!['--candidate-root', '--artifact'].includes(argv[i]) || !argv[i + 1]) throw new OfficialUiInstallerError('USAGE')
    args[argv[i++].slice(2)] = argv[i]
  }
  if (!args['candidate-root']) throw new OfficialUiInstallerError('USAGE')
  const plan = await buildOfficialPolicyPlan({ candidateRoot: args['candidate-root'], artifactRoot: args.artifact, replaceCollisions: args.replaceCollisions })
  if (args.json) process.stdout.write(`${JSON.stringify({ status: plan.status, operations: plan.operations.length, collisions: plan.collisions }, null, 2)}\n`)
  else process.stdout.write(`Official policy plan: ${plan.status.toUpperCase()} (${plan.operations.length} operations)\n`)
  if (plan.status !== 'ready') process.exitCode = 2
  return plan
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
