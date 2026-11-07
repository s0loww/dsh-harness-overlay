import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { stageNativeFsCompat } from '../scripts/stage-native-fs-compat.mjs'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { NATIVE_FS_OUTPUT_SHA256, NATIVE_FS_SANDBOX_OUTPUT_SHA256 } from '../src/native-fs-compat/patch.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('native filesystem package keeps sandbox source, the fixed local backend and a Windows x64 closure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-native-stage-'))
  t.after(async () => { const rel=relative(resolve(tmpdir()),resolve(root)); assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-native-stage-')); await rm(root,{recursive:true,force:true}) })
  const target=join(root,'package'), meta=await stageNativeFsCompat({nativeModules:resolve('var/asar-extract-rc5/dsh/node_modules'),target})
  assert.equal(meta.privateRuntimePackages,7)
  assert.equal(meta.target,'win32-x64')
  assert.equal(digest(await readFile(join(target,'lib/local.js'))),NATIVE_FS_OUTPUT_SHA256)
  assert.equal(digest(await readFile(join(target,'lib/index.js'))),NATIVE_FS_SANDBOX_OUTPUT_SHA256)
  const manifest=JSON.parse(await readFile(join(target,'package.json'),'utf8'))
  assert.equal(manifest.name,'airules-dsh-native-fs')
  assert.deepEqual(manifest.os,['win32'])
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-sandbox'],'0.2.1-rc.5')
  const binary=JSON.parse(await readFile(join(target,'node_modules/@koromix/koffi-win32-x64/package.json'),'utf8'))
  assert.equal(binary.version,'3.1.1')
  await assert.rejects(readFile(join(target,'node_modules/@koromix/koffi-darwin-arm64/package.json')),{code:'ENOENT'})
  assert.ok((await readFile(join(target,'LICENSE'),'utf8')).includes('MIT'))
})

test('native filesystem staging requires an explicit native input and a strict opt-in', async () => {
  await assert.rejects(stageNativeFsCompat({nativeModules:'relative',target:resolve('var/unused')}),/NATIVE_FS_EXPLICIT_MODULES_REQUIRED/)
  await assert.rejects(stageOfficialPolicy({includeNativeFsCompat:'true'}),/BOOLEAN_OPTION_REQUIRED/)
  await assert.rejects(stageOfficialPolicy({includeNativeFsCompat:true}),/NATIVE_FS_EXPLICIT_MODULES_REQUIRED/)
})
