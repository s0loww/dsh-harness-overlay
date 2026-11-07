import { resolve } from 'node:path'
import { buildOfficialDesktopPlan, DEFAULT_PROFILE_ROOT } from '../src/targets/official-desktop/target.mjs'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!['--install-root', '--profile-root', '--artifact', '--manifest'].includes(key) || argv[index + 1] === undefined) throw new Error('USAGE')
    result[key.slice(2)] = argv[index + 1]
  }
  if (!result['install-root'] || !result.artifact) throw new Error('USAGE')
  return result
}

try {
  const input = args(process.argv.slice(2))
  const plan = await buildOfficialDesktopPlan({
    installRoot: resolve(input['install-root']),
    profileRoot: input['profile-root'] ? resolve(input['profile-root']) : DEFAULT_PROFILE_ROOT,
    artifactRoot: resolve(input.artifact),
    manifestPath: input.manifest ?? 'official-ui-manifest.json',
  })
  process.stdout.write(`Official Desktop plan: ${plan.status.toUpperCase()} (read-only)\n`)
  process.stdout.write(`Host: ${plan.target.hostVersion}; packages: ${plan.operations.filter(row => row.type === 'copy-directory').length}\n`)
  for (const operation of plan.operations) process.stdout.write(`- ${operation.type}: ${operation.target}\n`)
  for (const blocker of plan.blockers) process.stdout.write(`BLOCKER: ${blocker}\n`)
  if (plan.status !== 'ready') process.exitCode = 2
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = error.message === 'USAGE' ? 2 : 1
}
