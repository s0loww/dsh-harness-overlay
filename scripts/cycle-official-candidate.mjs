import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOfficialPolicy } from '../installer/official-policy/apply.mjs'
import { rollbackOfficialPolicy } from '../installer/official-policy/rollback.mjs'
import { applyOfficialUi } from '../installer/official-ui/apply.mjs'
import { rollbackOfficialUi } from '../installer/official-ui/rollback.mjs'
import { canonical, pathKind, sameState, sha256, targetState } from '../installer/fs-state.mjs'
import { verifyReceiptIntegrity } from '../installer/receipt.mjs'
import { DEFAULT_RELEASE_LOCK, verifyOfficialDesktop } from '../src/targets/official-desktop/target.mjs'
import { assertCandidatePath, assertNoLiveReferences, preflightCandidate } from './smoke-official-candidate.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST_ROOT = join(REPO_ROOT, 'dist')
const UI_BACKUPS = '.airules-ui-backups'
const POLICY_BACKUPS = '.airules-policy-backups'
const HISTORY_ROOT = '.airules-cycle-history'

export class CandidateCycleError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

async function readJson(path, code) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (error) { throw new CandidateCycleError(code, `${path}: ${error.message}`) }
}

function beneath(root, value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new CandidateCycleError('UNSAFE_PATH', label)
  const result = resolve(root, value)
  const child = relative(resolve(root), result)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new CandidateCycleError('PATH_ESCAPE', label)
  return result
}

function stateKey(state) {
  if (!state || !['missing', 'file', 'directory'].includes(state.type)) throw new CandidateCycleError('RECEIPT_STATE_INVALID')
  return canonical(state)
}

function operationMap(receipt) {
  if (!Array.isArray(receipt.operations) || !receipt.operations.length) throw new CandidateCycleError('RECEIPT_OPERATIONS_INVALID')
  const result = new Map()
  for (const operation of receipt.operations) {
    if (typeof operation.target !== 'string' || result.has(operation.target)) throw new CandidateCycleError('RECEIPT_TARGET_INVALID')
    stateKey(operation.before)
    stateKey(operation.after)
    result.set(operation.target, operation)
  }
  return result
}

export function orderAppliedReceipts(receipts) {
  const nodes = receipts.map((entry, index) => ({ ...entry, index, operationsByTarget: operationMap(entry.receipt) }))
  const edges = new Map(nodes.map(node => [node.index, new Set()]))
  const indegree = new Map(nodes.map(node => [node.index, 0]))
  for (const left of nodes) {
    for (const right of nodes) {
      if (left.index === right.index) continue
      let matches = false
      for (const [target, leftOperation] of left.operationsByTarget) {
        const rightOperation = right.operationsByTarget.get(target)
        if (rightOperation && stateKey(leftOperation.after) === stateKey(rightOperation.before)) {
          matches = true
          break
        }
      }
      if (matches && !edges.get(left.index).has(right.index)) {
        edges.get(left.index).add(right.index)
        indegree.set(right.index, indegree.get(right.index) + 1)
      }
    }
  }
  const ready = nodes.filter(node => indegree.get(node.index) === 0).sort((a, b) => a.receiptPath.localeCompare(b.receiptPath, 'en'))
  const applicationOrder = []
  while (ready.length) {
    const node = ready.shift()
    applicationOrder.push(node)
    for (const next of edges.get(node.index)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) {
        ready.push(nodes.find(candidate => candidate.index === next))
        ready.sort((a, b) => a.receiptPath.localeCompare(b.receiptPath, 'en'))
      }
    }
  }
  if (applicationOrder.length !== nodes.length) throw new CandidateCycleError('RECEIPT_DEPENDENCY_CYCLE')
  return applicationOrder.reverse().map(({ index, operationsByTarget, ...entry }) => entry)
}

async function artifactIndex() {
  const result = new Map()
  for (const entry of await readdir(DIST_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const root = join(DIST_ROOT, entry.name)
    for (const [layer, manifestName] of [['ui', 'ui-overlay-manifest.json'], ['policy', 'official-policy-manifest.json']]) {
      const path = join(root, manifestName)
      if (await pathKind(path) !== 'file') continue
      const manifest = await readJson(path, 'ARTIFACT_MANIFEST_INVALID')
      const digest = sha256(await readFile(path))
      const key = `${layer}:${manifest.artifact?.id}:${manifest.artifact?.version}:${digest}`
      if (result.has(key)) throw new CandidateCycleError('ARTIFACT_IDENTITY_AMBIGUOUS', key)
      result.set(key, root)
    }
  }
  return result
}

async function discoverLayerReceipts(candidateRoot, layer, artifacts) {
  const backupName = layer === 'ui' ? UI_BACKUPS : POLICY_BACKUPS
  const manifestName = layer === 'ui' ? 'ui-overlay-manifest.json' : 'official-policy-manifest.json'
  const parent = join(candidateRoot, backupName)
  if (await pathKind(parent) === 'missing') return []
  if (await pathKind(parent) !== 'directory') throw new CandidateCycleError('BACKUP_ROOT_INVALID', backupName)
  const result = []
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const backupRoot = join(parent, entry.name)
    const receiptPath = join(backupRoot, 'receipt.json')
    if (await pathKind(receiptPath) !== 'file') continue
    const receipt = await readJson(receiptPath, 'RECEIPT_INVALID')
    if (!verifyReceiptIntegrity(receipt)) throw new CandidateCycleError('RECEIPT_INTEGRITY_INVALID', receiptPath)
    if (receipt.status !== 'applied') continue
    const key = `${layer}:${receipt.artifact?.id}:${receipt.artifact?.version}:${receipt.artifactManifestSha256}`
    const artifactRoot = artifacts.get(key)
    if (!artifactRoot) throw new CandidateCycleError('HISTORICAL_ARTIFACT_MISSING', key)
    if (await pathKind(join(artifactRoot, manifestName)) !== 'file') throw new CandidateCycleError('HISTORICAL_ARTIFACT_INVALID', key)
    const expectedBackup = beneath(candidateRoot, receipt.backupRoot, 'receipt backup root')
    if (resolve(expectedBackup) !== resolve(backupRoot)) throw new CandidateCycleError('RECEIPT_LOCATION_MISMATCH', receiptPath)
    result.push({ layer, receiptPath, backupRoot, artifactRoot, receipt })
  }
  return result
}

async function assertOwnsAfterState(candidateRoot, entry) {
  for (const operation of entry.receipt.operations) {
    const target = beneath(candidateRoot, operation.target, 'receipt target')
    if (!sameState(await targetState(target), operation.after)) {
      throw new CandidateCycleError('ROLLBACK_ORDER_OR_OWNERSHIP_MISMATCH', `${entry.layer}:${operation.target}`)
    }
  }
}

async function baselineProfile(candidateRoot, releaseLockPath) {
  const manifest = await readJson(join(candidateRoot, 'candidate-manifest.json'), 'CANDIDATE_MANIFEST_INVALID')
  const installRoot = beneath(candidateRoot, manifest.candidate?.install, 'candidate install')
  const profileRoot = beneath(candidateRoot, manifest.candidate?.profile, 'candidate profile')
  const verified = await verifyOfficialDesktop({ installRoot, releaseLockPath })
  if (verified.lock.hostVersion !== manifest.source?.hostVersion) throw new CandidateCycleError('HOST_VERSION_MISMATCH')
  for (const marker of ['ui-ready.json', 'policy-ready.json']) {
    if (await pathKind(join(candidateRoot, marker)) !== 'missing') throw new CandidateCycleError('OVERLAY_MARKER_REMAINS', marker)
  }
  for (const [name, expected] of Object.entries(manifest.profileFiles ?? {})) {
    if (!sameState(await targetState(join(profileRoot, name)), { type: 'file', ...expected })) {
      throw new CandidateCycleError('PROFILE_BASELINE_MISMATCH', name)
    }
  }
  const modules = await targetState(join(profileRoot, 'node_modules'))
  if (modules.type !== 'directory' || Object.keys(modules.files).length !== 0) throw new CandidateCycleError('PROFILE_MODULES_NOT_EMPTY')
  const evidence = {
    hostVersion: verified.lock.hostVersion,
    profileFiles: manifest.profileFiles,
    nodeModulesDigest: modules.digest,
  }
  assertNoLiveReferences([
    ['candidate manifest', JSON.stringify(manifest)],
    ['baseline evidence', JSON.stringify(evidence)],
  ])
  return evidence
}

async function archiveRolledBackReceipts(candidateRoot, entries, runRoot) {
  const archived = []
  for (const entry of entries) {
    const target = join(runRoot, 'rolled-back', entry.layer, basename(entry.backupRoot))
    await mkdir(dirname(target), { recursive: true })
    if (await pathKind(target) !== 'missing') throw new CandidateCycleError('ARCHIVE_COLLISION', target)
    const before = await targetState(entry.backupRoot)
    if (before.type !== 'directory') throw new CandidateCycleError('BACKUP_ROOT_MISSING', entry.backupRoot)
    await rename(entry.backupRoot, target)
    if (!sameState(await targetState(target), before)) throw new CandidateCycleError('ARCHIVE_VERIFY_FAILED', target)
    archived.push({
      layer: entry.layer,
      artifact: entry.receipt.artifact,
      original: relative(candidateRoot, entry.backupRoot).replaceAll('\\', '/'),
      archived: relative(candidateRoot, target).replaceAll('\\', '/'),
      digest: before.digest,
    })
  }
  return archived
}

export async function planCandidateLayerCycle({ candidateRoot, uiArtifactRoot, policyArtifactRoot, releaseLockPath = DEFAULT_RELEASE_LOCK }) {
  const root = assertCandidatePath(candidateRoot)
  if (!uiArtifactRoot || !policyArtifactRoot) throw new CandidateCycleError('FINAL_ARTIFACTS_REQUIRED')
  await preflightCandidate({ candidateRoot: root, uiArtifactRoot, policyArtifactRoot, releaseLockPath })
  const artifacts = await artifactIndex()
  const receipts = [
    ...await discoverLayerReceipts(root, 'ui', artifacts),
    ...await discoverLayerReceipts(root, 'policy', artifacts),
  ]
  if (!receipts.length) throw new CandidateCycleError('APPLIED_RECEIPTS_MISSING')
  const rollbackOrder = orderAppliedReceipts(receipts)
  return Object.freeze({
    status: 'ready',
    readOnly: true,
    candidateRoot: root,
    uiArtifactRoot: resolve(uiArtifactRoot),
    policyArtifactRoot: resolve(policyArtifactRoot),
    releaseLockPath: resolve(releaseLockPath),
    rollbackOrder: Object.freeze(rollbackOrder),
  })
}

export async function runCandidateLayerCycle(options) {
  const plan = await planCandidateLayerCycle(options)
  const lockPath = join(plan.candidateRoot, '.candidate-layer-cycle.lock')
  let lock
  try { lock = await open(lockPath, 'wx') }
  catch (error) { throw new CandidateCycleError('CYCLE_ALREADY_RUNNING', error.message) }
  const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`
  const runRoot = join(plan.candidateRoot, HISTORY_ROOT, runId)
  const reportPath = join(runRoot, 'cycle-report.json')
  const report = {
    schemaVersion: 1,
    status: 'running',
    runId,
    candidate: relative(REPO_ROOT, plan.candidateRoot).replaceAll('\\', '/'),
    rollbackOrder: plan.rollbackOrder.map(entry => ({ layer: entry.layer, artifact: entry.receipt.artifact, receipt: relative(plan.candidateRoot, entry.receiptPath).replaceAll('\\', '/') })),
  }
  try {
    await mkdir(dirname(runRoot), { recursive: true })
    await mkdir(runRoot, { recursive: false })
    await writeFile(reportPath, canonical(report), 'utf8')
  } catch (error) {
    await lock?.close()
    await rm(lockPath, { force: true })
    throw error
  }
  try {
    for (const entry of plan.rollbackOrder) {
      await assertOwnsAfterState(plan.candidateRoot, entry)
      if (entry.layer === 'policy') await rollbackOfficialPolicy({ candidateRoot: plan.candidateRoot, artifactRoot: entry.artifactRoot, releaseLockPath: plan.releaseLockPath, receiptPath: entry.receiptPath })
      else await rollbackOfficialUi({ candidateRoot: plan.candidateRoot, artifactRoot: entry.artifactRoot, releaseLockPath: plan.releaseLockPath, receiptPath: entry.receiptPath })
    }
    const baseline = await baselineProfile(plan.candidateRoot, plan.releaseLockPath)
    const archived = await archiveRolledBackReceipts(plan.candidateRoot, plan.rollbackOrder, runRoot)
    const ui = await applyOfficialUi({ candidateRoot: plan.candidateRoot, artifactRoot: plan.uiArtifactRoot, releaseLockPath: plan.releaseLockPath })
    const policy = await applyOfficialPolicy({ candidateRoot: plan.candidateRoot, artifactRoot: plan.policyArtifactRoot, releaseLockPath: plan.releaseLockPath })
    const final = await preflightCandidate({ candidateRoot: plan.candidateRoot, uiArtifactRoot: plan.uiArtifactRoot, policyArtifactRoot: plan.policyArtifactRoot, releaseLockPath: plan.releaseLockPath })
    Object.assign(report, {
      status: 'passed',
      completedAt: new Date().toISOString(),
      baseline,
      archived,
      applied: {
        uiReceipt: relative(plan.candidateRoot, ui.receiptPath).replaceAll('\\', '/'),
        policyReceipt: relative(plan.candidateRoot, policy.receiptPath).replaceAll('\\', '/'),
      },
      final: { hostVersion: final.hostVersion, packages: final.packages.length, cordisIds: final.cordisIds.length },
    })
    assertNoLiveReferences([['cycle report', JSON.stringify(report)]])
    await writeFile(reportPath, canonical(report), 'utf8')
    return Object.freeze({ status: 'passed', reportPath, report: Object.freeze(report) })
  } catch (error) {
    Object.assign(report, { status: 'failed', failedAt: new Date().toISOString(), error: { code: error.code ?? 'CYCLE_FAILED', message: error.message } })
    await writeFile(reportPath, canonical(report), 'utf8')
    throw error
  } finally {
    await lock?.close()
    await rm(lockPath, { force: true })
  }
}

function parseArgs(argv) {
  const result = { execute: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--execute') { result.execute = true; continue }
    if (!['--candidate-root', '--ui-artifact', '--policy-artifact', '--release-lock'].includes(key) || argv[index + 1] === undefined) throw new CandidateCycleError('USAGE')
    result[key.slice(2)] = argv[++index]
  }
  if (!result['candidate-root'] || !result['ui-artifact'] || !result['policy-artifact']) throw new CandidateCycleError('USAGE')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const options = {
    candidateRoot: args['candidate-root'],
    uiArtifactRoot: args['ui-artifact'],
    policyArtifactRoot: args['policy-artifact'],
    releaseLockPath: args['release-lock'],
  }
  if (!args.execute) {
    const plan = await planCandidateLayerCycle(options)
    process.stdout.write(`${JSON.stringify({ status: plan.status, readOnly: true, candidateRoot: plan.candidateRoot, rollbackOrder: plan.rollbackOrder.map(entry => ({ layer: entry.layer, artifact: entry.receipt.artifact, receiptPath: entry.receiptPath })) }, null, 2)}\n`)
    return
  }
  const result = await runCandidateLayerCycle(options)
  process.stdout.write(`Candidate layer cycle: PASS; report ${result.reportPath}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
