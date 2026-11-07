import { resolve } from 'node:path'
import { verifyOfficialDesktop } from '../src/targets/official-desktop/target.mjs'

const installRoot = process.argv[2]
if (!installRoot) {
  process.stderr.write('Usage: node scripts/official-verify.mjs <official install root>\n')
  process.exitCode = 1
} else {
  try {
    const { snapshot } = await verifyOfficialDesktop({ installRoot: resolve(installRoot) })
    process.stdout.write(`Official Desktop baseline verified: ${snapshot.hostVersion}; ${Object.keys(snapshot.files).length} files\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
