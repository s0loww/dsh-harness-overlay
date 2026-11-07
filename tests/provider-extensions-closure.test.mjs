import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,readFile,rm,appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { stageProviderExtensionsDependencies,verifyProviderExtensionsImports } from '../scripts/stage-provider-extensions.mjs'

const lockBytes=await readFile(new URL('../upstream/provider-extensions-closure.lock.json',import.meta.url)),lock=JSON.parse(lockBytes)
const sourceBundle=process.env.AIRULES_DSH_SOURCE_BUNDLE
const nativeModulesRoot=process.env.AIRULES_DSH_NATIVE_MODULES??fileURLToPath(new URL('../var/asar-extract-rc5/dsh/node_modules',import.meta.url))

test('provider lock pins library roots and full runtime dependency identities without external accounts or executable runtimes',()=>{
  assert.equal(lock.schemaVersion,1)
  assert.deepEqual(lock.roots,{'@muse-code/sdk':'1.4.14','pi-antigravity-acp-provider':'0.1.17-bundle.5',typebox:'1.3.27'})
  assert.equal(lock.packages.length,117)
  assert.ok(lock.packages.some(row=>row.name==='@agentclientprotocol/sdk'&&row.version==='1.8.0'))
  assert.ok(lock.packages.some(row=>row.name==='@modelcontextprotocol/sdk'&&row.version==='1.32.1'))
  assert.ok(!lock.packages.some(row=>['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@cursor/sdk'].includes(row.name)))
  const licenses=new Set(['MIT','Apache-2.0','ISC','BSD-2-Clause','BSD-3-Clause'])
  for(const row of lock.packages){assert.ok(licenses.has(row.license));assert.match(row.sha256,/^[a-f0-9]{64}$/u);assert.ok(!row.path.includes('..')&&!row.path.includes('\\'))}
  assert.doesNotMatch(lockBytes.toString(),/[A-Z]:[\\/]|\.desktop-local|acp_token|api[_-]?key|access[_-]?token/iu)
})

test('stage helper requires explicit absolute roots and refuses source/target overlap',async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-provider-closure-'))
  try {
    await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:'relative',targetRoot:home}),/ABSOLUTE_ROOT_REQUIRED/)
    await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:home,targetRoot:home}),/SELF_COPY_REJECTED/)
    const target=join(home,'target');await mkdir(target)
    await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:home,targetRoot:target}),/SELF_COPY_REJECTED/)
  }finally{await rm(home,{recursive:true,force:true})}
})

test('missing native peer fails before copying dependencies; an unpinned peer version is refused',async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-provider-peer-'))
  try {
    const source=join(home,'source'),target=join(home,'target'),native=join(home,'native');await mkdir(source);await mkdir(target);await mkdir(join(native,'@earendil-works','pi-ai'),{recursive:true})
    await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:source,targetRoot:target}),/NATIVE_PEER_ROOT_REQUIRED/)
    await writeFile(join(native,'@earendil-works','pi-ai','package.json'),JSON.stringify({name:'@earendil-works/pi-ai',version:'1.4.0'}))
    await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:source,targetRoot:target,nativeModulesRoot:native}),/NATIVE_PEER_MISMATCH/)
  }finally{await rm(home,{recursive:true,force:true})}
})

test('explicit supplied source stages exact closure and cold-imports real SDK APIs with network/subprocess denied',
  {skip:!sourceBundle?'Set AIRULES_DSH_SOURCE_BUNDLE explicitly for private artifact integration':false},async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-provider-closure-real-'))
  try {
    await writeFile(join(home,'package.json'),JSON.stringify({name:'airules-dsh-provider-extensions',version:'fixture'}))
    const result=await stageProviderExtensionsDependencies({modulesRoot:join(resolve(sourceBundle),'node_modules'),targetRoot:home,nativeModulesRoot:resolve(nativeModulesRoot)})
    assert.equal(result.dependencyLockSha256,createHash('sha256').update(lockBytes).digest('hex'))
    assert.equal(result.privateRuntimePackages.length,117)
    assert.deepEqual(result.importProbe,{muse:true,googleRuntime:true,googleConnection:true,googleAuth:true,nativePiAi:'1.1.0',networkUsed:false,runtimeStarted:false})
    assert.equal(result.installScriptsExecuted,false);assert.equal(result.runtimeBinariesCopied,false)
    assert.match(await readFile(join(home,'node_modules','@muse-code','sdk','LICENSE'),'utf8'),/MIT License/u)
    assert.match(await readFile(join(home,'node_modules','pi-antigravity-acp-provider','LICENSE'),'utf8'),/MIT License/u)
    assert.match(await readFile(join(home,'node_modules','pi-antigravity-acp-provider','node_modules','@agentclientprotocol','sdk','LICENSE'),'utf8'),/Apache/u)
    // Deliberately altered temporary fixture attempts a request at import time.
    // The probe must reject it locally; the package source is untouched.
    await appendFile(join(home,'node_modules','@muse-code','sdk','dist','src','index.js'),"\nawait fetch('https://fixture.invalid/forbidden-import-request')\n")
    await assert.rejects(verifyProviderExtensionsImports({targetRoot:home,nativeModulesRoot:resolve(nativeModulesRoot)}),/IMPORT_PROBE_FAILED/)
  }finally{await rm(home,{recursive:true,force:true})}
})
