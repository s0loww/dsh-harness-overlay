import { resolve } from 'node:path'
import { snapshotOfficialDesktop } from '../src/targets/official-desktop/target.mjs'

const installRoot = process.argv[2]
if (!installRoot) {
  process.stderr.write('Usage: node scripts/official-snapshot.mjs <official install root>\n')
  process.exitCode = 1
} else {
  try { process.stdout.write(`${JSON.stringify(await snapshotOfficialDesktop({ installRoot: resolve(installRoot) }), null, 2)}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
