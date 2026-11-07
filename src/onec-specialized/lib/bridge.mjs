import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export async function bundledRunnerTemplate() {
  const source = await readFile(new URL('../runners/runner.mjs', import.meta.url), 'utf8')
  return { schemaVersion: 1, path: 'tools/onec-specialized/runner.mjs', driverConfigPath: '.dsh/onec-specialized-driver.json',
    sha256: createHash('sha256').update(source).digest('hex'), source }
}
