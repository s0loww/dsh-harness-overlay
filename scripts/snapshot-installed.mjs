import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REQUIRED = Object.freeze({
  releaseManifest: 'RELEASE-MANIFEST.json',
  bundlePackage: 'dsh-1c-bundle/package.json',
  packageLock: 'dsh-1c-bundle/package-lock.json',
  pluginCatalog: 'dsh-1c-bundle/diagnostics/plugin-catalog.json',
  presetSource: 'dsh-1c-bundle/lib/project-presets.js',
  developerExperienceSource: 'dsh-1c-bundle/lib/developer-experience.js',
  clientSource: 'dsh-1c-bundle/lib/client.js',
  projectWizardSource: 'dsh-1c-bundle/lib/project-wizard.js',
  projectWizardClient: 'dsh-1c-bundle/node_modules/dsh-1c-project-wizard/lib/client.js',
  projectWizardVendorClient: 'dsh-1c-bundle/vendor/project-wizard/lib/client.js',
  presetRepairSource: 'scripts/repair-agent-preset.mjs',
})

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const canonical = value => JSON.stringify(value, null, 2) + '\n'

function assertInstallRoot(root) {
  const normalized = resolve(root).replaceAll('\\', '/').toLowerCase()
  if (normalized.endsWith('/.desktop-local') || normalized.includes('/.desktop-local/')) {
    throw new Error('Refusing desktop-local runtime state as install root')
  }
  if (normalized.endsWith('/.dsh-1c') || normalized.includes('/.dsh-1c/')) {
    throw new Error('Refusing .dsh-1c runtime state as install root')
  }
}

async function loadInputs(installRoot) {
  assertInstallRoot(installRoot)
  const entries = await Promise.all(Object.entries(REQUIRED).map(async ([name, relative]) => {
    const bytes = await readFile(join(installRoot, relative))
    return [name, { relative, bytes, sha256: sha256(bytes) }]
  }))
  return Object.fromEntries(entries)
}

function json(input, name) {
  try { return JSON.parse(input.bytes.toString('utf8').replace(/^\uFEFF/u, '')) }
  catch (error) { throw new Error(`Invalid JSON in ${name}: ${error.message}`, { cause: error }) }
}

function parseRows(source, exportName) {
  const marker = `export const ${exportName}`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Preset export not found: ${exportName}`)
  const end = source.indexOf('])', start)
  if (end < 0) throw new Error(`Preset export is incomplete: ${exportName}`)
  const block = source.slice(start, end + 2)
  const rows = []
  const rowPattern = /\{\s*id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*description:\s*'([^']+)'\s*\}/gu
  for (const match of block.matchAll(rowPattern)) rows.push({ id: match[1], label: match[2], description: match[3] })
  if (!rows.length) throw new Error(`No presets parsed from ${exportName}`)
  return rows.sort((a, b) => a.id.localeCompare(b.id, 'en'))
}

function safePlugin(row) {
  const result = {}
  for (const key of ['name', 'spec', 'version', 'license', 'mounted', 'disabledWhen']) {
    if (row?.[key] !== undefined) result[key] = row[key]
  }
  return result
}

export async function buildSnapshot(installRoot) {
  const root = resolve(installRoot)
  const input = await loadInputs(root)
  const release = json(input.releaseManifest, REQUIRED.releaseManifest)
  const bundle = json(input.bundlePackage, REQUIRED.bundlePackage)
  const plugins = json(input.pluginCatalog, REQUIRED.pluginCatalog)
  const presetSource = input.presetSource.bytes.toString('utf8')

  const lock = {
    schemaVersion: 1,
    product: release.product,
    releaseId: release.releaseId,
    bundleVersion: release.bundleVersion,
    hostVersion: release.hostVersion,
    platform: release.platform,
    fileCount: release.fileCount,
    totalBytes: release.totalBytes,
    sourceFiles: Object.fromEntries(Object.values(input)
      .sort((a, b) => a.relative.localeCompare(b.relative, 'en'))
      .map(row => [row.relative.replaceAll('\\', '/'), row.sha256])),
  }

  const inventory = {
    schemaVersion: 1,
    releaseId: release.releaseId,
    bundle: {
      name: bundle.name,
      version: bundle.version,
      license: bundle.license ?? null,
      dependencyCount: Object.keys(bundle.dependencies ?? {}).length,
      devDependencyCount: Object.keys(bundle.devDependencies ?? {}).length,
    },
    pluginCatalog: {
      schema: plugins.schema,
      hostVersion: plugins.host_version,
      counts: plugins.counts,
      plugins: [...(plugins.plugins ?? [])].map(safePlugin)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en')),
    },
    projectPresets: {
      visible: parseRows(presetSource, 'PROJECT_PRESETS'),
      compatibility: parseRows(presetSource, 'LEGACY_PROJECT_PRESETS'),
    },
  }
  return { lock, inventory }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, canonical(value), { encoding: 'utf8' })
  await rename(temporary, path)
}

export async function snapshot(installRoot, outputDir) {
  const result = await buildSnapshot(installRoot)
  await writeJsonAtomic(join(outputDir, 'release.lock.json'), result.lock)
  await writeJsonAtomic(join(outputDir, 'component-inventory.json'), result.inventory)
  return result
}

async function main() {
  const installRoot = process.argv[2]
  if (!installRoot) throw new Error('Usage: node scripts/snapshot-installed.mjs <install-root> [output-dir]')
  const outputDir = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'upstream'))
  const { lock, inventory } = await snapshot(installRoot, outputDir)
  process.stdout.write(`Snapshot ${lock.releaseId}: ${inventory.pluginCatalog.plugins.length} plugins, ${inventory.projectPresets.visible.length} visible presets\n`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => { console.error(error.message); process.exitCode = 1 })

