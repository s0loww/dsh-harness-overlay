import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { prepareUpdateCandidate } from '../src/git-maintenance/lib/updater-candidate.js'

async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content) }
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-candidate-contract-')); t.after(async () => { const rel = relative(resolve(tmpdir()), base); assert.ok(!isAbsolute(rel) && rel.startsWith('dsh-candidate-contract-')); await rm(base, { recursive: true, force: true }) })
  const engineRoot = join(base, 'engine'), releaseRoot = join(base, 'release'), installRoot = join(base, 'official-install'), log = join(engineRoot, 'calls.jsonl')
  await mkdir(installRoot); await put(join(installRoot, 'untouched'), 'official fixture')
  const preamble = `import {appendFile,mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';const log=${JSON.stringify(log)};async function record(action,value){await appendFile(log,JSON.stringify({action,...value})+'\\n')};\n`
  await put(join(engineRoot, 'scripts/create-official-candidate.mjs'), preamble + `export async function createOfficialCandidate(options){await mkdir(options.candidateRoot,{recursive:true});await record('create',options);await writeFile(join(options.candidateRoot,'source.json'),JSON.stringify(options))}`)
  for (const [directory, name, action] of [['official-ui', 'applyOfficialUi', 'ui'], ['official-policy', 'applyOfficialPolicy', 'policy']]) await put(join(engineRoot, 'installer', directory, 'apply.mjs'), preamble + `export async function ${name}(options){await record('${action}',options);await writeFile(join(options.candidateRoot,'${action}.ready'),'yes')}`)
  await put(join(engineRoot, 'scripts/cycle-official-candidate.mjs'), preamble + `export async function runCandidateLayerCycle(options){await record('cycle',options);return{status:'passed'}}`)
  await put(join(engineRoot, 'scripts/smoke-official-candidate.mjs'), preamble + `export async function preflightCandidate(options){await readFile(join(options.candidateRoot,'ui.ready'));await readFile(join(options.candidateRoot,'policy.ready'));await record('preflight',options);return options};export async function launchCandidateSmoke(options){await preflightCandidate(options);await record('smoke',options);await mkdir(join(options.candidateRoot,'smoke'),{recursive:true});await writeFile(join(options.candidateRoot,'smoke/launch-report.json'),JSON.stringify({schemaVersion:1,status:options.visible?'passed-visible-startup':'passed-hidden-startup',visible:options.visible,startedAt:'fixture-start',stoppedAt:'fixture-end'}));return{status:'passed'}}`)
  const fsUrl = pathToFileURL(resolve(import.meta.dirname, '../installer/fs-state.mjs')).href
  await put(join(engineRoot, 'installer/fs-state.mjs'), `export{directoryState,sameState}from${JSON.stringify(fsUrl)}`)
  const release = { root: releaseRoot, identity: 'a'.repeat(64), uiArtifactRoot: join(releaseRoot, 'ui'), policyArtifactRoot: join(releaseRoot, 'policy'), releaseLockPath: join(releaseRoot, 'host.lock.json') }
  await put(release.releaseLockPath, '{"fixture":true}')
  await put(join(release.uiArtifactRoot, 'ui-overlay-manifest.json'), JSON.stringify({ artifact: { version: 'test-ui.1' } })); await put(join(release.uiArtifactRoot, 'asset.txt'), 'exact UI bytes')
  await put(join(release.policyArtifactRoot, 'official-policy-manifest.json'), JSON.stringify({ artifact: { version: 'test-policy.1' } })); await put(join(release.policyArtifactRoot, 'asset.txt'), 'exact policy bytes')
  return { base, engineRoot, release, installRoot, log, target: { installRoot }, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

test('candidate helper copies immutable artifacts, prepares both layers, cycles and performs genuine visible smoke', async t => {
  const f = await fixture(t), root = await prepareUpdateCandidate({ engineRoot: f.engineRoot, release: f.release, target: f.target })
  const calls = await f.calls(), substantive = calls.filter(row => ['create', 'ui', 'policy', 'cycle', 'smoke'].includes(row.action))
  assert.deepEqual(substantive.map(row => row.action), ['create', 'ui', 'policy', 'cycle', 'smoke'])
  assert.equal(substantive[0].sourceRoot, f.installRoot); assert.equal(substantive[1].artifactRoot, join(f.engineRoot, 'dist/airules-ui-overlay-test-ui.1')); assert.equal(substantive[2].artifactRoot, join(f.engineRoot, 'dist/airules-official-policy-test-policy.1'))
  assert.equal(await readFile(join(f.engineRoot, 'dist/airules-ui-overlay-test-ui.1/asset.txt'), 'utf8'), 'exact UI bytes')
  const report = JSON.parse(await readFile(join(root, 'smoke/launch-report.json'), 'utf8')); assert.equal(report.visible, true); assert.equal(report.status, 'passed-visible-startup')
  assert.equal(JSON.parse(await readFile(join(root, 'maintenance-certified.json'), 'utf8')).releaseIdentity, f.release.identity)
  assert.equal(await readFile(join(f.installRoot, 'untouched'), 'utf8'), 'official fixture')
})

test('a certified candidate is reused without running a second executable or cycle', async t => {
  const f = await fixture(t), input = { engineRoot: f.engineRoot, release: f.release, target: f.target }, first = await prepareUpdateCandidate(input), second = await prepareUpdateCandidate(input), calls = await f.calls()
  assert.equal(first, second); assert.equal(calls.filter(row => row.action === 'create').length, 1); assert.equal(calls.filter(row => row.action === 'smoke').length, 1); assert.equal(calls.filter(row => row.action === 'cycle').length, 1)
})

test('artifact version collisions reject changed bytes instead of replacing the engine artifact store', async t => {
  const f = await fixture(t), input = { engineRoot: f.engineRoot, release: f.release, target: f.target }; await prepareUpdateCandidate(input)
  await writeFile(join(f.release.uiArtifactRoot, 'asset.txt'), 'different'); await assert.rejects(prepareUpdateCandidate(input), /UPDATE_ARTIFACT_VERSION_COLLISION/)
  assert.equal(await readFile(join(f.engineRoot, 'dist/airules-ui-overlay-test-ui.1/asset.txt'), 'utf8'), 'exact UI bytes')
})

test('a partially prepared candidate is never adopted as a certified update', async t => {
  const f = await fixture(t), root = join(f.engineRoot, 'var/candidate/git-release-' + f.release.identity.slice(0, 24)); await mkdir(root, { recursive: true }); await put(join(root, 'foreign.txt'), 'preserve')
  await assert.rejects(prepareUpdateCandidate({ engineRoot: f.engineRoot, release: f.release, target: f.target }), /UPDATE_CANDIDATE_INCOMPLETE/)
  assert.equal(await readFile(join(root, 'foreign.txt'), 'utf8'), 'preserve')
})

test('an already-cancelled operation stops before copying artifacts or creating any candidate', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(Error('fixture-cancelled'))
  await assert.rejects(prepareUpdateCandidate({ engineRoot: f.engineRoot, release: f.release, target: f.target, signal: controller.signal }), /fixture-cancelled/)
  assert.equal(await exists(join(f.engineRoot, 'dist')), false); assert.equal(await exists(join(f.engineRoot, 'var/candidate')), false)
})
