import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSnapshot } from './snapshot-installed.mjs'

const canonical = value => JSON.stringify(value, null, 2) + '\n'

export async function verify(installRoot, upstreamDir) {
  const expectedLock = await readFile(join(upstreamDir, 'release.lock.json'), 'utf8')
  const expectedInventory = await readFile(join(upstreamDir, 'component-inventory.json'), 'utf8')
  const actual = await buildSnapshot(installRoot)
  const problems = []
  if (canonical(actual.lock) !== expectedLock) problems.push('release.lock.json differs')
  if (canonical(actual.inventory) !== expectedInventory) problems.push('component-inventory.json differs')
  return problems
}

async function main() {
  const installRoot = process.argv[2]
  if (!installRoot) throw new Error('Usage: node scripts/verify-baseline.mjs <install-root> [upstream-dir]')
  const upstreamDir = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'upstream'))
  const problems = await verify(installRoot, upstreamDir)
  if (problems.length) throw new Error(`Baseline verification failed: ${problems.join('; ')}`)
  process.stdout.write('Baseline verification passed\n')
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => { console.error(error.message); process.exitCode = 1 })

