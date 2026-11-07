import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRulepack } from '../src/airules-provider/core.mjs'
import { assertPatchMatchesBaseline } from '../src/release-patch.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROVIDER = join(REPO, 'src', 'airules-provider')
const BASELINE = join(REPO, 'upstream', 'release.lock.json')
const RELEASE_PATCH = join(REPO, 'patches', '20261103-134539', 'project-preset-1c-airules.json')
const OVERLAY_ID = 'airules-dsh-overlay'
const PROVIDER_TARGET = 'profiles/node_modules/airules-dsh-provider'
const RULEPACK_TARGET = 'profiles/node_modules/airules-dsh-rulepack'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, null, 2) + '\n'

async function json(path) {
  const value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`JSON object expected: ${path}`)
  return value
}

async function exists(path) {
  try { await stat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function files(root) {
  const { readdir } = await import('node:fs/promises')
  const result = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  await walk(root)
  return result
}

async function verifyRulepackFiles(rulepackRoot, pack) {
  const actual = new Set((await files(rulepackRoot)).map(path => relative(rulepackRoot, path).replaceAll('\\', '/')))
  actual.delete('manifest.json')
  const declared = new Set(Object.keys(pack.manifest.files ?? {}))
  if (actual.size !== declared.size || [...actual].some(path => !declared.has(path))) {
    throw new Error('RULEPACK_FILE_SET_MISMATCH')
  }
  for (const path of [...declared].sort()) {
    const bytes = await readFile(join(rulepackRoot, path))
    const record = pack.manifest.files[path]
    if (sha256(bytes) !== record.sha256 || bytes.byteLength !== record.bytes) {
      throw new Error(`RULEPACK_FILE_MISMATCH: ${path}`)
    }
  }
}

function cordisFragment() {
  return [
    '# Generated airules overlay fragment. Merge into the staged Cordis patch only.',
    '- insert:',
    '    - id: airules-policy',
    '      name: airules-dsh-provider',
    '      inject: [skills, systemPrompt, tools, projectPresets]',
    '      config:',
    `        rulepackRoot: !!js dshHomePath('${RULEPACK_TARGET}')`,
    '',
  ].join('\n')
}

async function managedFiles(stage) {
  const result = {}
  for (const path of await files(stage)) {
    const rel = relative(stage, path).replaceAll('\\', '/')
    if (rel === 'overlay-manifest.json') continue
    const bytes = await readFile(path)
    result[rel] = { sha256: sha256(bytes), bytes: bytes.byteLength }
  }
  return result
}

function assertPortableControlPlane(value, fragment) {
  const text = `${canonical(value)}\n${fragment}`
  if (/(?:^|[\s"'])(?:[a-z]:[\\/]|\\\\)/iu.test(text)) throw new Error('OVERLAY_MACHINE_PATH_LEAK')
  if (/\b(?:url|endpoint|headers|token|secret|password|api[_-]?key)\b\s*[:=]/iu.test(text)) {
    throw new Error('OVERLAY_CONNECTION_DATA_LEAK')
  }
}

export async function stageOverlay({ rulepackRoot, output, targetRelease }) {
  const source = resolve(rulepackRoot)
  const target = resolve(output)
  if (await exists(target)) throw new Error(`OUTPUT_EXISTS: ${target}`)
  const baseline = await json(BASELINE)
  if (!targetRelease || targetRelease !== baseline.releaseId) {
    throw new Error(`TARGET_RELEASE_MISMATCH: expected ${baseline.releaseId}`)
  }
  const pack = loadRulepack(source)
  await verifyRulepackFiles(source, pack)
  const releasePatch = assertPatchMatchesBaseline(await json(RELEASE_PATCH), baseline)
  const baselineBytes = await readFile(BASELINE)

  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), `.overlay-${randomUUID()}-`))
  try {
    const providerPayload = join(stage, 'payload', 'packages', 'airules-dsh-provider')
    const rulepackPayload = join(stage, 'payload', 'packages', 'airules-dsh-rulepack')
    const patchPayload = join(stage, 'payload', 'patches', 'project-preset-1c-airules.json')
    await cp(PROVIDER, providerPayload, { recursive: true, force: false, errorOnExist: true })
    await cp(source, rulepackPayload, { recursive: true, force: false, errorOnExist: true })
    await mkdir(dirname(patchPayload), { recursive: true })
    await cp(RELEASE_PATCH, patchPayload, { force: false, errorOnExist: true })
    const copied = loadRulepack(rulepackPayload)
    await verifyRulepackFiles(rulepackPayload, copied)

    const fragment = cordisFragment()
    await writeFile(join(stage, 'cordis.patch.fragment.yml'), fragment, 'utf8')
    const fileRecords = await managedFiles(stage)
    const manifest = {
      schemaVersion: 2,
      overlay: { id: OVERLAY_ID, version: copied.version },
      target: {
        product: baseline.product,
        releaseId: baseline.releaseId,
        hostVersion: baseline.hostVersion,
        bundleVersion: baseline.bundleVersion,
        releaseLockSha256: sha256(baselineBytes),
      },
      install: {
        providerSource: 'payload/packages/airules-dsh-provider',
        providerTarget: PROVIDER_TARGET,
        rulepackSource: 'payload/packages/airules-dsh-rulepack',
        rulepackTarget: RULEPACK_TARGET,
        cordisFragment: 'cordis.patch.fragment.yml',
      },
      releasePatch: {
        required: true,
        engine: 'exact-text-replacements/v1',
        source: 'payload/patches/project-preset-1c-airules.json',
        id: releasePatch.id,
        preset: releasePatch.preset,
        files: releasePatch.files.map(file => ({
          target: file.target,
          sourceSha256: file.sourceSha256,
          resultSha256: file.resultSha256,
        })),
      },
      rulepack: {
        id: copied.manifest.package.id,
        version: copied.version,
        sourceDirty: copied.manifest.source?.dirty === true,
        counts: copied.manifest.counts,
        mcpMode: copied.manifest.mcp.mode,
        logicalMcpRoles: copied.manifest.mcp.logical_roles,
      },
      files: fileRecords,
    }
    assertPortableControlPlane(manifest, fragment)
    await writeFile(join(stage, 'overlay-manifest.json'), canonical(manifest), 'utf8')
    await rename(stage, target)
    return manifest
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

function args(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1]
    if (!['--rulepack', '--output', '--target-release'].includes(key) || value === undefined) {
      throw new Error('Usage: node scripts/stage-overlay.mjs --rulepack <path> --output <fresh-dir> --target-release <id>')
    }
    result[key.slice(2)] = value
  }
  if (!result.rulepack || !result.output || !result['target-release']) {
    throw new Error('Usage: node scripts/stage-overlay.mjs --rulepack <path> --output <fresh-dir> --target-release <id>')
  }
  return result
}

async function main() {
  const input = args(process.argv.slice(2))
  const manifest = await stageOverlay({ rulepackRoot: input.rulepack, output: input.output, targetRelease: input['target-release'] })
  process.stdout.write(`Staged ${manifest.overlay.id} ${manifest.overlay.version}: ${Object.keys(manifest.files).length} files\n`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) main().catch(error => { console.error(error.message); process.exitCode = 1 })

