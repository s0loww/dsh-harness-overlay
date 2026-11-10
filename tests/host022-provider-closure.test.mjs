import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir,appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { stageProviderExtensionsDependencies,verifyProviderExtensionsImports } from '../scripts/stage-provider-extensions.mjs'
import { inspectPackageClosure } from '../scripts/stage-package-closure.mjs'
const source=resolve(process.env.AIRULES_DSH_SOURCE_BUNDLE??'E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle')
const hosts={ '0.2.1-rc.5':{modules:resolve('var/asar-extract-rc5/dsh/node_modules'),pi:'1.1.0'},'0.2.2-rc.1':{modules:resolve(process.env.AIRULES_HOST022_MODULES??'var/host-upgrade/rc022/asar/dsh/node_modules'),pi:'1.3.0'} }
const bytes=await readFile('upstream/provider-extensions-closure.lock.json'),lock=JSON.parse(bytes)

test('unknown host is refused before target inspection, directory creation or copy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'airules-provider-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const untouched=join(root,'untouched');await mkdir(untouched)
 await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:join(root,'absent-source'),targetRoot:untouched,nativeModulesRoot:join(root,'absent-native'),hostVersion:'0.2.2-rc.2'}),/HOST_VERSION_REJECTED/)
 assert.deepEqual(await readdir(untouched),[])
 await assert.rejects(verifyProviderExtensionsImports({targetRoot:untouched,nativeModulesRoot:join(root,'absent-native'),hostVersion:'0.2.2-rc.2'}),/HOST_VERSION_REJECTED/)
 assert.deepEqual(await readdir(untouched),[])
})

for(const[hostVersion,host]of Object.entries(hosts))test(`real ${hostVersion} native pi-ai ${host.pi}: exact117 closure and guarded cold API imports`,{timeout:120000},async t=>{
 const target=await mkdtemp(join(tmpdir(),'airules-provider-'+hostVersion+'-'));t.after(()=>rm(target,{recursive:true,force:true}))
 const native=JSON.parse(await readFile(join(host.modules,'@earendil-works/pi-ai/package.json')));assert.equal(native.version,host.pi)
 await writeFile(join(target,'package.json'),JSON.stringify({name:'airules-dsh-provider-extensions',version:'isolated-test'}))
 // Omitted hostVersion is intentional in the old case: preserve the shipping
 // rc5 default rather than merely testing an explicit compatibility branch.
 const result=await stageProviderExtensionsDependencies({modulesRoot:join(source,'node_modules'),targetRoot:target,nativeModulesRoot:host.modules,...(hostVersion==='0.2.2-rc.1'?{hostVersion}:{})})
 assert.equal(result.dependencyLockSha256,createHash('sha256').update(bytes).digest('hex'))
 assert.equal(result.privateRuntimePackages.length,117)
 const closure=await inspectPackageClosure({modulesRoot:join(target,'node_modules'),roots:lock.roots});assert.deepEqual(closure,lock)
 assert.deepEqual(result.importProbe,{muse:true,googleRuntime:true,googleConnection:true,googleAuth:true,nativePiAi:host.pi,networkUsed:false,runtimeStarted:false})
 assert.deepEqual(result.externalPeers,[{name:'@earendil-works/pi-ai',version:host.pi,providedBy:'native-host'}])
 assert.equal(result.installScriptsExecuted,false);assert.equal(result.runtimeBinariesCopied,false);assert.equal(result.networkUsed,false)
 assert.equal(lock.packages.some(row=>row.name==='@earendil-works/pi-ai'),false)
 if(hostVersion==='0.2.2-rc.1'){
  // Ensure import-time fetch is denied before any external connection. Only the
  // disposable copy is modified; canonical donor and native SDK remain intact.
  await appendFile(join(target,'node_modules/@muse-code/sdk/dist/src/index.js'),"\nawait fetch('https://fixture.invalid/forbidden-import')\n")
  await assert.rejects(verifyProviderExtensionsImports({targetRoot:target,nativeModulesRoot:host.modules,hostVersion}),/IMPORT_PROBE_FAILED/)
 }
})

test('new host refuses old native peer before copying any dependency',async t=>{
 const root=await mkdtemp(join(tmpdir(),'airules-provider-crosshost-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'package.json'),JSON.stringify({name:'airules-dsh-provider-extensions',version:'isolated-test'}))
 await assert.rejects(stageProviderExtensionsDependencies({modulesRoot:join(source,'node_modules'),targetRoot:root,nativeModulesRoot:hosts['0.2.1-rc.5'].modules,hostVersion:'0.2.2-rc.1'}),/NATIVE_PEER_MISMATCH/)
 assert.deepEqual(await readdir(root),['package.json'])
})
