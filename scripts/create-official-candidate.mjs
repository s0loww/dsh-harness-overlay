import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, readFile, rename, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_RELEASE_LOCK, verifyOfficialDesktop } from '../src/targets/official-desktop/target.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const CANDIDATE_PARENT = join(REPO_ROOT, 'var', 'candidate')
export const DEFAULT_SOURCE_ROOT = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
export const DEFAULT_CANDIDATE_ROOT = join(CANDIDATE_PARENT, 'official-desktop-rc5-01')

const PROFILE_PACKAGE = Object.freeze({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
})
const PROFILE_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')
const PROFILE_WORKSPACE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n')

export class CandidateError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

async function pathKind(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'link'
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeExclusive(path, content) {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(content, 'utf8'); await handle.sync() }
  finally { await handle.close() }
}

async function scanTree(root, { hashes = false } = {}) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const rel = relative(root, path).split(sep).join('/')
      if (entry.isSymbolicLink()) throw new CandidateError('SOURCE_LINK_UNSUPPORTED', rel)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const info = await lstat(path)
        files.push({ path: rel, bytes: info.size, ...(hashes ? { sha256: await sha256File(path) } : {}) })
      } else throw new CandidateError('SOURCE_ENTRY_UNSUPPORTED', rel)
    }
  }
  await visit(root)
  const bytes = files.reduce((total, file) => total + file.bytes, 0)
  if (!hashes) return { fileCount: files.length, bytes }
  const digest = createHash('sha256')
  for (const file of files) digest.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`)
  return { fileCount: files.length, bytes, sha256: digest.digest('hex') }
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function resolveCliCandidateRoot(value) {
  const candidate = resolve(String(value ?? DEFAULT_CANDIDATE_ROOT))
  if (dirname(candidate) !== resolve(CANDIDATE_PARENT)) {
    throw new CandidateError('CANDIDATE_ROOT_OUTSIDE_REPOSITORY', candidate)
  }
  return candidate
}

export async function createOfficialCandidate({
  sourceRoot,
  candidateRoot,
  releaseLockPath = DEFAULT_RELEASE_LOCK,
  minimumFreeMultiplier = 1.2,
} = {}) {
  const source = resolve(String(sourceRoot ?? DEFAULT_SOURCE_ROOT))
  const candidate = resolve(String(candidateRoot ?? DEFAULT_CANDIDATE_ROOT))
  if (source === candidate || inside(source, candidate) || inside(candidate, source)) throw new CandidateError('SOURCE_CANDIDATE_OVERLAP')
  if (await pathKind(source) !== 'directory') throw new CandidateError('SOURCE_ROOT_INVALID')
  if (await pathKind(candidate) !== 'missing') throw new CandidateError('CANDIDATE_ALREADY_EXISTS', candidate)

  const verifiedSource = await verifyOfficialDesktop({ installRoot: source, releaseLockPath })
  const sourceTree = await scanTree(source, { hashes: true })
  const parent = dirname(candidate)
  await mkdir(parent, { recursive: true })
  const disk = await statfs(parent)
  const freeBytes = Number(disk.bavail) * Number(disk.bsize)
  if (freeBytes < sourceTree.bytes * minimumFreeMultiplier) throw new CandidateError('INSUFFICIENT_DISK_SPACE')

  const stage = join(parent, `.${candidate.split(sep).at(-1)}.staging-${randomUUID()}`)
  await mkdir(stage, { recursive: false })
  const install = join(stage, 'install')
  await cp(source, install, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
  const verifiedCopy = await verifyOfficialDesktop({ installRoot: install, releaseLockPath })

  const home = join(stage, 'home')
  const profile = join(home, 'profiles', 'desktop')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(join(stage, 'electron-user-data'), { recursive: true })
  const profileFiles = {
    'package.json': `${JSON.stringify(PROFILE_PACKAGE, null, 2)}\n`,
    'cordis.patch.yml': PROFILE_PATCH,
    'pnpm-workspace.yaml': PROFILE_WORKSPACE,
  }
  for (const [name, content] of Object.entries(profileFiles)) await writeExclusive(join(profile, name), content)

  const copiedTree = await scanTree(install, { hashes: true })
  if (copiedTree.fileCount !== sourceTree.fileCount || copiedTree.bytes !== sourceTree.bytes || copiedTree.sha256 !== sourceTree.sha256) {
    throw new CandidateError('COPIED_TREE_MISMATCH')
  }
  const profileHashes = {}
  for (const name of Object.keys(profileFiles).sort()) profileHashes[name] = {
    bytes: Buffer.byteLength(profileFiles[name]),
    sha256: await sha256File(join(profile, name)),
  }
  const lockBytes = await readFile(releaseLockPath)
  const manifest = {
    schemaVersion: 1,
    status: 'created-not-launched',
    source: {
      product: verifiedSource.lock.product,
      hostVersion: verifiedSource.lock.hostVersion,
      buildCommit: verifiedSource.lock.buildCommit,
      releaseLockSha256: createHash('sha256').update(lockBytes).digest('hex'),
      installationTreeSha256: sourceTree.sha256,
    },
    candidate: {
      install: 'install',
      dshHome: 'home',
      profile: 'home/profiles/desktop',
      electronUserData: 'electron-user-data',
      uiReadyMarker: 'ui-ready.json',
      launchAllowed: false,
    },
    installationTree: copiedTree,
    baselineFiles: verifiedCopy.snapshot.files,
    profileFiles: profileHashes,
    isolation: {
      copiesLiveProfile: false,
      dshHomeEnvironment: 'candidate/home',
      electronUserDataArgument: 'candidate/electron-user-data',
      telemetry: 'off',
    },
  }
  await writeExclusive(join(stage, 'candidate-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(stage, candidate)
  return Object.freeze({ candidateRoot: candidate, manifest: Object.freeze(manifest) })
}

async function main() {
  const options = {}
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--source', '--candidate-root', '--release-lock'].includes(flag) || !value || value.startsWith('--') || options[flag] !== undefined) {
      throw new CandidateError('USAGE', 'node scripts/create-official-candidate.mjs [--source <official install>] [--candidate-root <fresh path under repo/var/candidate>]')
    }
    options[flag] = value
  }
  const result = await createOfficialCandidate({
    sourceRoot: options['--source'],
    releaseLockPath: options['--release-lock'],
    candidateRoot: resolveCliCandidateRoot(options['--candidate-root']),
  })
  process.stdout.write(`Candidate created, not launched: ${result.candidateRoot}\n`)
  process.stdout.write(`Copied tree: ${result.manifest.installationTree.fileCount} files, ${result.manifest.installationTree.bytes} bytes\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
