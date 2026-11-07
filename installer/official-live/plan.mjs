import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLivePromotionPlan, DEFAULT_POLICY_ARTIFACT, DEFAULT_UI_ARTIFACT, OfficialUiInstallerError, PROMOTION_BACKUPS_ROOT } from './common.mjs'

export function parsePlanArgs(argv) {
  const args = { 'ui-artifact': DEFAULT_UI_ARTIFACT, 'policy-artifact': DEFAULT_POLICY_ARTIFACT, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { args.json = true; continue }
    if (!['--install-root', '--profile-root', '--backup-root', '--candidate-root', '--ui-artifact', '--policy-artifact', '--release-lock', '--previous-receipt', '--migrate-owned-fragments'].includes(key) || argv[index + 1] === undefined) throw new OfficialUiInstallerError('USAGE')
    args[key.slice(2)] = argv[++index]
  }
  for (const key of ['install-root', 'profile-root', 'backup-root', 'candidate-root']) if (!args[key]) throw new OfficialUiInstallerError('USAGE', `--${key} is required`)
  if (args['migrate-owned-fragments'] !== undefined && !['true', 'false'].includes(args['migrate-owned-fragments'])) throw new OfficialUiInstallerError('USAGE')
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parsePlanArgs(argv)
  const plan = await buildLivePromotionPlan({ installRoot: args['install-root'], profileRoot: args['profile-root'], backupRoot: args['backup-root'], candidateRoot: args['candidate-root'], uiArtifactRoot: args['ui-artifact'], policyArtifactRoot: args['policy-artifact'], releaseLockPath: args['release-lock'], previousReceiptPath: args['previous-receipt'], allowOwnedFragmentMigration: args['migrate-owned-fragments'] === 'true' })
  const output = { status: plan.status, readOnly: true, target: plan.target, artifacts: plan.artifacts, certification: plan.certification, backupRoot: plan.backupRoot, packagesToInstall: plan.packageNames.length, verifiedNoops: plan.dependencyResolution.verifiedNoops, nestedDependencies: plan.dependencyResolution.nested, collisions: plan.collisions, signature: plan.signature }
  process.stdout.write(`${args.json ? JSON.stringify(output, null, 2) : `Live promotion plan: ${plan.status.toUpperCase()}; ${plan.packageNames.length} package mutations, ${plan.dependencyResolution.verifiedNoops.length} verified no-ops; backup ${plan.backupRoot}`}` + '\n')
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })

export { PROMOTION_BACKUPS_ROOT }
