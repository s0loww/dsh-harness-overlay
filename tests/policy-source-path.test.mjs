import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvePolicySourceBundle } from '../scripts/stage-official-policy.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/stage-official-policy.mjs', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airules-policy-source-'))
  t.after(() => rm(root, {recursive:true,force:true}))
  const bundle = join(root, 'reviewed bundle')
  await mkdir(join(bundle, 'node_modules'), {recursive:true})
  return {root,bundle}
}

test('source selection requires an explicit argument or environment and preserves precedence', async t => {
  const {root,bundle} = await fixture(t)
  await assert.rejects(resolvePolicySourceBundle(undefined, {}), /SOURCE_BUNDLE_REQUIRED/)
  for (const invalid of ['', ' ', null, 1, 'bad\0path']) {
    await assert.rejects(resolvePolicySourceBundle(invalid, {AIRULES_DSH_SOURCE_BUNDLE:bundle}), /SOURCE_BUNDLE_REQUIRED/)
  }
  assert.equal(await resolvePolicySourceBundle(bundle, {AIRULES_DSH_SOURCE_BUNDLE:join(root,'missing')}), bundle)
  assert.equal(await resolvePolicySourceBundle(undefined, {AIRULES_DSH_SOURCE_BUNDLE:bundle}), bundle)
  assert.equal(await resolvePolicySourceBundle(relative(process.cwd(),bundle), {}), resolve(bundle))
})

test('source roots and node_modules must be ordinary existing directories', async t => {
  const {root,bundle} = await fixture(t)
  await assert.rejects(resolvePolicySourceBundle(join(root,'missing'), {}), /SOURCE_BUNDLE_DIRECTORY_REQUIRED/)
  const file = join(root,'file'); await writeFile(file,'not a directory')
  await assert.rejects(resolvePolicySourceBundle(file, {}), /SOURCE_BUNDLE_DIRECTORY_REQUIRED/)
  const incomplete = join(root,'incomplete'); await mkdir(incomplete)
  await assert.rejects(resolvePolicySourceBundle(incomplete, {}), /SOURCE_BUNDLE_NODE_MODULES_REQUIRED/)
  await writeFile(join(incomplete,'node_modules'),'not a directory')
  await assert.rejects(resolvePolicySourceBundle(incomplete, {}), /SOURCE_BUNDLE_NODE_MODULES_REQUIRED/)
  const alias=join(root,'alias')
  try { await symlink(bundle,alias,process.platform==='win32'?'junction':'dir') }
  catch(error) { if(['EPERM','EACCES','ENOTSUP'].includes(error.code)) return; throw error }
  await assert.rejects(resolvePolicySourceBundle(alias, {}), /SOURCE_BUNDLE_DIRECTORY_REQUIRED/)
})

test('CLI accepts --source-bundle and fails before creating staging when input is missing', async t => {
  const {root} = await fixture(t)
  const rulepack = join(root,'rulepack'); await mkdir(rulepack)
  await writeFile(join(rulepack,'manifest.json'),JSON.stringify({package:{id:'airules-dsh-rulepack'},mcp:{mode:'logical-only',logical_roles:[]}}))
  const parent = join(root,'output'), output = join(parent,'airules-official-policy-path.test')
  const env={...process.env}; delete env.AIRULES_DSH_SOURCE_BUNDLE
  const base=[SCRIPT,'--rulepack',rulepack,'--output',output,'--artifact-version','path.test']
  const missing=spawnSync(process.execPath,base,{env,encoding:'utf8',timeout:10000})
  assert.equal(missing.status,1); assert.match(missing.stderr,/SOURCE_BUNDLE_REQUIRED/)
  await assert.rejects(access(parent),{code:'ENOENT'})
  const explicit=spawnSync(process.execPath,[...base,'--source-bundle',join(root,'missing')],{env,encoding:'utf8',timeout:10000})
  assert.equal(explicit.status,1); assert.match(explicit.stderr,/SOURCE_BUNDLE_DIRECTORY_REQUIRED/)
  assert.doesNotMatch(explicit.stderr,/USAGE/)
  await assert.rejects(access(parent),{code:'ENOENT'})
})
