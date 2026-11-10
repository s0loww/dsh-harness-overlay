import test from'node:test'
import assert from'node:assert/strict'
import{readFile,mkdtemp,mkdir,writeFile,rm,readdir}from'node:fs/promises'
import{join,dirname}from'node:path'
import{tmpdir}from'node:os'
import{fileURLToPath}from'node:url'
import{createHash}from'node:crypto'
import{policyPackageNames,verifyPolicyArtifact}from'../installer/official-policy/common.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex')
const evidence={sourceManifestSha256:'940e499d84127eb1634ebd684e5d722150f7b54b05c675d28644717269927736',stagedManifestSha256:'7cf400f2cd2b713a7bf44086948467035994df0d7766acfd8174ac1e2bc376ac',fromEngine:'0.2.1-rc.3 || 0.2.1-rc.5',toEngine:'0.2.2-rc.1'}
const acp=()=>({package:'airules-dsh-acp',defaultEnabled:false,inbound:'local-named-pipe',outbound:'native-external-agent',adapterVersion:'0.2.1-rc.3.1',sdkVersion:'1.5.1',dependencyLockSha256:'a'.repeat(64),privateRuntimePackages:4,adaptation:{sourceSha256:'b'.repeat(64),stagedSha256:'c'.repeat(64)},engineAdaptation:{...evidence}})

test('022 ACP metadata pins exact engine transition and keeps rc5 historical shape unchanged',()=>{
 const source={target:{hostVersion:'0.2.2-rc.1'},integrations:{acp:acp()}};assert.ok(policyPackageNames(source).includes('@zaimokuza/dsh-acp-adapter'))
 for(const mutate of [m=>delete m.integrations.acp.engineAdaptation,m=>m.integrations.acp.engineAdaptation.toEngine='*',m=>m.integrations.acp.engineAdaptation.fromEngine='0.2.1-rc.5',m=>m.integrations.acp.engineAdaptation.stagedManifestSha256='d'.repeat(64),m=>m.integrations.acp.engineAdaptation.extra=true,m=>m.target.hostVersion='0.2.1-rc.5']){const bad=structuredClone(source);mutate(bad);assert.throws(()=>policyPackageNames(bad),/ACP_ENGINE/)}
 const old=structuredClone(source);old.target.hostVersion='0.2.1-rc.5';delete old.integrations.acp.engineAdaptation;assert.ok(policyPackageNames(old).includes('@zaimokuza/dsh-acp-adapter'))
})

test('ACP source lock metadata hashes match exact staged format and artifact verification refuses resealed engine payload drift',async t=>{
 const source=await readFile('E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules/@zaimokuza/dsh-acp-adapter/package.json')
 assert.equal(sha(source),evidence.sourceManifestSha256)
 const pkg=JSON.parse(source);assert.equal(pkg.engines.dsh,evidence.fromEngine);pkg.engines.dsh=evidence.toEngine
 const staged=Buffer.from(JSON.stringify(pkg,null,2)+'\n');assert.equal(sha(staged),evidence.stagedManifestSha256)
 const root=await mkdtemp(join(tmpdir(),'airules-acp-engine-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const manifest={schemaVersion:1,artifact:{id:'airules-official-policy-overlay',version:'engine-test'},target:{kind:'official-desktop',hostVersion:'0.2.2-rc.1'},preset:{id:'1c-airules',extensionPoint:'@deepseek-ai/dsh-agent-preset'},separation:{credentials:'excluded'},integrations:{acp:acp()},files:{},operations:[]}
 for(const name of policyPackageNames(manifest)){
  const path=`payload/packages/${name}/package.json`,bytes=name==='@zaimokuza/dsh-acp-adapter'?staged:Buffer.from(JSON.stringify({name,version:'fixture'}))
  await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);manifest.files[path]={bytes:bytes.length,sha256:sha(bytes)}
  manifest.operations.push({kind:'package-copy',source:`payload/packages/${name}`,target:`node_modules/${name}`})
 }
 const fragment=Buffer.from('[]\n');await writeFile(join(root,'cordis.policy.fragment.yml'),fragment);manifest.files['cordis.policy.fragment.yml']={bytes:fragment.length,sha256:sha(fragment)};manifest.operations.push({kind:'cordis-merge',source:'cordis.policy.fragment.yml',target:'cordis.patch.yml'})
 await writeFile(join(root,'official-policy-manifest.json'),JSON.stringify(manifest));assert.ok(await verifyPolicyArtifact(root))
 const path='payload/packages/@zaimokuza/dsh-acp-adapter/package.json',bad=Buffer.from(staged.toString().replace('"dsh": "0.2.2-rc.1"','"dsh": "*"'))
 assert.notDeepEqual(bad,staged);await writeFile(join(root,path),bad);manifest.files[path]={bytes:bad.length,sha256:sha(bad)};await writeFile(join(root,'official-policy-manifest.json'),JSON.stringify(manifest))
 await assert.rejects(verifyPolicyArtifact(root),/ACP_ENGINE_PAYLOAD_MISMATCH/)
})

test('real stageOfficialPolicy ACP022 emits engine provenance and produces a verifier-accepted artifact', {timeout:120000}, async t=>{
 const {stageOfficialPolicy}=await import('../scripts/stage-official-policy.mjs')
 const root=await mkdtemp(join(tmpdir(),'airules-acp-real-stage-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const output=join(root,'airules-official-policy-acp022-integration')
 const manifest=await stageOfficialPolicy({
   artifactVersion:'acp022-integration',output,
   rulepack:process.env.AIRULES_HOST022_RULEPACK??'D:/AI_Projects/project_rules/var/rulepack/airules-0.13.0-d563128',
   sourceBundle:process.env.AIRULES_DSH_SOURCE_BUNDLE??'E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle',
   targetLock:new URL('../upstream/official-desktop/0.2.2-rc.1/release.lock.json',import.meta.url),
   nativeModules:process.env.AIRULES_HOST022_MODULES??fileURLToPath(new URL('../var/host-upgrade/rc022/asar/dsh/node_modules',import.meta.url)),
   includeOpenSpec:false,includeAcp:true,includeOnecPanels:true
 })
 assert.deepEqual(manifest.integrations.acp.engineAdaptation,evidence)
 assert.deepEqual(await readFile(join(output,'payload/packages/airules-dsh-onec-panels/lib/native-tools.js')),await readFile('src/native-tools-compat/rc022.js'))
 const path='payload/packages/@zaimokuza/dsh-acp-adapter/package.json',actual=await readFile(join(output,path))
 assert.equal(sha(actual),evidence.stagedManifestSha256)
 assert.equal(manifest.files[path].sha256,evidence.stagedManifestSha256)
 assert.equal(JSON.parse(actual).engines.dsh,'0.2.2-rc.1')
 const result=await verifyPolicyArtifact(output)
 assert.deepEqual(result.manifest.integrations.acp.engineAdaptation,evidence)
 assert.ok(result.packageNames.includes('@zaimokuza/dsh-acp-adapter'))
})
