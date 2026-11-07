import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, mkdir, writeFile, rename, unlink, open, readdir } from 'node:fs/promises'
import { dirname, resolve, relative, join, isAbsolute, sep } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(code) }
const missing = error => error.code === 'ENOENT'
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const cleanText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0')
const secret = value => /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|(?:password|access_token|api_key)\s*[:=]\s*["']?[^\s"'<${][^\s"']{7,}/iu.test(value)
function text(value, max = 4000) { if (!cleanText(value, max) || secret(value)) fail('INVESTIGATION_TEXT_INVALID'); return value.trim() }
function key(root) { const path = resolve(root); return hash(process.platform === 'win32' ? path.toLowerCase() : path) }

async function safePath(anchor, path) {
  anchor = resolve(anchor); path = resolve(path)
  const rel = relative(anchor, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('INVESTIGATION_PATH_REJECTED')
  let at = anchor
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) at = join(at, part)
    try { const st = await lstat(at); if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) fail('INVESTIGATION_PATH_REJECTED') }
    catch (error) { if (!missing(error)) throw error }
  }
}
async function artifact(root, path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || isAbsolute(path) || /^[A-Za-z]:/u.test(path)
    || path.split(/[\\/]/u).some(part => !part || part === '..' || part === '.') || /(?:^|[\\/])\.env(?:[./\\]|$)/iu.test(path)) fail('INVESTIGATION_PATH_REJECTED')
  const target = resolve(root, path)
  await safePath(root, target)
  const before = await lstat(target)
  if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024) fail('INVESTIGATION_ARTIFACT_INVALID')
  const bytes = await readFile(target)
  await safePath(root, target)
  const after = await lstat(target)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) fail('INVESTIGATION_ARTIFACT_CHANGED')
  return { path: relative(root, target).split(sep).join('/'), sha256: hash(bytes), bytes: bytes.length }
}
async function artifacts(root, paths) {
  if (!Array.isArray(paths) || paths.length > 16 || new Set(paths).size !== paths.length) fail('INVESTIGATION_PATH_REJECTED')
  const result = []
  for (const path of paths) result.push(await artifact(root, path))
  return result
}
function validate(value, projectKey, id) {
  if (!record(value) || value.schemaVersion !== 1 || value.projectKey !== projectKey || value.id !== id || !ID.test(id)
    || !['open', 'closed'].includes(value.status) || !cleanText(value.title, 200) || !Array.isArray(value.hypotheses) || value.hypotheses.length > 8
    || value.hypotheses.some(item => !cleanText(item, 2000)) || !Array.isArray(value.sourceArtifacts) || value.sourceArtifacts.length > 16
    || !Array.isArray(value.evidence) || value.evidence.length > 100 || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) fail('INVESTIGATION_STATE_INVALID')
  for (const row of [...value.sourceArtifacts, ...value.evidence.flatMap(item => Array.isArray(item.artifacts) ? item.artifacts : [])]) {
    if (!record(row) || typeof row.path !== 'string' || row.path.length > 1024 || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) fail('INVESTIGATION_STATE_INVALID')
  }
  for (const item of value.evidence) {
    if (!record(item) || !ID.test(item.id) || !['proposal', 'observation', 'report', 'cleanup'].includes(item.kind) || !cleanText(item.text, 4000) || !Array.isArray(item.artifacts) || item.artifacts.length > 16 || !Number.isSafeInteger(item.timestamp)) fail('INVESTIGATION_STATE_INVALID')
  }
  if (value.status === 'closed' && !['reported-resolved', 'unresolved', 'abandoned'].includes(value.outcome)) fail('INVESTIGATION_STATE_INVALID')
  return value
}

/** A source/evidence notebook, never an instrumentation or deployment engine. */
export function createInvestigationStore(home) {
  const base = join(resolve(home), 'onec-capability-workflows', 'cases')
  const location = (root, id) => { if (!ID.test(id ?? '')) fail('INVESTIGATION_ID_INVALID'); return join(base, key(root), `${id}.json`) }
  async function read(root, id) {
    const path = location(root, id); await safePath(home, path)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) fail('INVESTIGATION_STATE_INVALID')
    const raw = await readFile(path, 'utf8')
    let data; try { data = JSON.parse(raw) } catch { fail('INVESTIGATION_STATE_INVALID') }
    return { path, data: validate(data, key(root), id), revision: hash(raw) }
  }
  async function view(root, data, revision) {
    const freshness = []
    const tracked = [...data.sourceArtifacts.map(row => ({ ...row, origin: 'source' })), ...data.evidence.flatMap(item => item.artifacts.map(row => ({ ...row, origin: item.id })))]
    for (const row of tracked) {
      try { const current = await artifact(root, row.path); freshness.push({ path: row.path, origin: row.origin, state: current.sha256 === row.sha256 ? 'unchanged' : 'changed', currentSha256: current.sha256 }) }
      catch { freshness.push({ path: row.path, origin: row.origin, state: 'unavailable' }) }
    }
    return { ...data, revision, freshness, sourceFresh: freshness.filter(row => row.origin === 'source').every(row => row.state === 'unchanged'), artifactsFresh: freshness.every(row => row.state === 'unchanged'),
      dataOnly: true, certified: false, execution: 'not-performed',
      note: 'This notebook records caller observations and artifact hashes. It does not edit/instrument source, run a database, query logs, deploy, verify assertions or prove cleanup.' }
  }
  async function write(root, data, expectedRevision, creating = false) {
    const path = location(root, data.id), lock = `${path}.lock`, temp = `${path}.${randomUUID()}.tmp`
    const raw = `${JSON.stringify(validate(data, key(root), data.id), null, 2)}\n`
    if (Buffer.byteLength(raw) > 512 * 1024) fail('INVESTIGATION_LIMIT')
    await safePath(home, path); await mkdir(dirname(path), { recursive: true }); await safePath(home, path)
    const handle = await open(lock, 'wx').catch(error => { if (error.code === 'EEXIST') fail('INVESTIGATION_BUSY'); throw error })
    try {
      if (creating) {
        try { await lstat(path); fail('INVESTIGATION_CONFLICT') } catch (error) { if (!missing(error)) throw error }
      } else if ((await read(root, data.id)).revision !== expectedRevision) fail('INVESTIGATION_STALE')
      await writeFile(temp, raw, { flag: 'wx', mode: 0o600 }); await safePath(home, path)
      if (!creating && (await read(root, data.id)).revision !== expectedRevision) fail('INVESTIGATION_STALE')
      await rename(temp, path)
      return view(root, data, hash(raw))
    } finally { await unlink(temp).catch(() => {}); await handle.close(); await unlink(lock).catch(() => {}) }
  }
  return {
    async list(root) {
      const dir = join(base, key(root)); await safePath(home, dir)
      let names; try { names = await readdir(dir) } catch (error) { if (missing(error)) return { cases: [] }; throw error }
      const rows = []
      for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).sort().slice(0, 100)) {
        const { data } = await read(root, name.slice(0, -5))
        rows.push({ id: data.id, title: data.title, status: data.status, outcome: data.outcome ?? null, updatedAt: data.updatedAt })
      }
      return { cases: rows, truncated: names.filter(name => name.endsWith('.json')).length > 100, execution: 'not-performed' }
    },
    async open(root, args) {
      const title = text(args.title, 200), hypotheses = args.hypotheses ?? []
      if (!Array.isArray(hypotheses) || hypotheses.length > 8) fail('INVESTIGATION_TEXT_INVALID')
      const now = Date.now(), data = { schemaVersion: 1, projectKey: key(root), id: randomUUID(), title,
        hypotheses: hypotheses.map(item => text(item, 2000)), sourceArtifacts: await artifacts(root, args.paths ?? []), evidence: [], status: 'open', createdAt: now, updatedAt: now }
      return write(root, data, null, true)
    },
    async status(root, id) { const row = await read(root, id); return view(root, row.data, row.revision) },
    async evidence(root, args) {
      const row = await read(root, args.caseId)
      if (row.data.status !== 'open') fail('INVESTIGATION_CLOSED')
      if (!['proposal', 'observation', 'report', 'cleanup'].includes(args.kind)) fail('INVESTIGATION_EVIDENCE_INVALID')
      const data = { ...row.data, updatedAt: Date.now(), evidence: [...row.data.evidence, { id: randomUUID(), kind: args.kind,
        text: text(args.text), artifacts: await artifacts(root, args.paths ?? []), timestamp: Date.now() }] }
      if (data.evidence.length > 100) fail('INVESTIGATION_LIMIT')
      return write(root, data, args.expectedRevision)
    },
    async close(root, args) {
      const row = await read(root, args.caseId)
      if (row.data.status !== 'open') fail('INVESTIGATION_CLOSED')
      if (!['reported-resolved', 'unresolved', 'abandoned'].includes(args.outcome)) fail('INVESTIGATION_OUTCOME_INVALID')
      if (args.outcome === 'reported-resolved' && !row.data.evidence.some(row => ['observation', 'report'].includes(row.kind))) fail('INVESTIGATION_EVIDENCE_REQUIRED')
      return write(root, { ...row.data, updatedAt: Date.now(), status: 'closed', outcome: args.outcome }, args.expectedRevision)
    },
  }
}
