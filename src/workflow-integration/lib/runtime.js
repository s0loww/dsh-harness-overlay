import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export async function loadRuntime(base = new URL('../runtime/', import.meta.url)) {
  const [engine, contracts, process, runners, snapshot, mcp] = await Promise.all([
    import(new URL('core/tools/workflow/index.mjs', base)),
    import(new URL('core/tools/workflow/lib/contracts.mjs', base)),
    import(new URL('core/tools/workflow/lib/local-process.mjs', base)),
    import(new URL('overlays/1c/tools/workflow-runners/index.mjs', base)),
    import(new URL('core/tools/workflow/lib/snapshot.mjs', base)),
    import(new URL('core/tools/workflow/lib/mcp-adapter.mjs', base)),
  ])
  const hash = createHash('sha256')
  for (const path of ['overlays/1c/tools/workflow-runners/index.mjs', 'overlays/1c/tools/workflow-runners/deploy.mjs', 'overlays/1c/tools/workflow-onec/index.mjs']) hash.update(await readFile(new URL(path, base)))
  return { ...engine, ...contracts, ...process, ...runners, ...snapshot, ...mcp, runtimeDigest: hash.digest('hex') }
}
