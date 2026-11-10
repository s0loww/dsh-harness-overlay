import test from'node:test'
import assert from'node:assert/strict'
import{readFile,writeFile,access}from'node:fs/promises'
import{resolve,join}from'node:path'
import{verifyHostUpgradeLayers}from'../scripts/upgrade-official-host.mjs'
import{hostFixture}from'./fixtures/host-upgrade.mjs'
import{sha256}from'../installer/fs-state.mjs'
const target=lock=>({kind:'official-desktop',hostVersion:lock.hostVersion,appAsarSha256:lock.files['resources/app.asar'].sha256})
for(const row of[
 {name:'actual old UI23/policy43',ui:'dist/airules-ui-overlay-0.12.0-ui23',policy:'dist/airules-official-policy-0.12.0-dev43',lock:'upstream/official-desktop/release.lock.json'},
 {name:'actual new UI5/policy50',ui:'dist/airules-ui-overlay-0.13.0-host022-ui5',policy:'dist/airules-official-policy-0.13.0-dev50',lock:'upstream/official-desktop/0.2.2-rc.1/release.lock.json'}
])test(`${row.name} validates data-only rulepack identity without a package.json`,{timeout:120000},async()=>{
 const lock=JSON.parse(await readFile(row.lock)),layers=await verifyHostUpgradeLayers(resolve(row.ui),resolve(row.policy),target(lock)),rulepack=layers.packages.find(p=>p.name==='airules-dsh-rulepack')
 assert.ok(rulepack);await assert.rejects(access(join(rulepack.source,'package.json')),{code:'ENOENT'})
 assert.equal(JSON.parse(await readFile(join(rulepack.source,'manifest.json'))).package.id,'airules-dsh-rulepack')
 assert.ok(layers.names.includes('airules-dsh-rulepack'))
})
test('truthful data-only fixture rejects resealed wrong rulepack identity',async t=>{
 const f=await hostFixture(t),root=f.options.oldPolicyArtifactRoot,path='payload/packages/airules-dsh-rulepack/manifest.json'
 await assert.rejects(access(join(root,'payload/packages/airules-dsh-rulepack/package.json')),{code:'ENOENT'})
 const bytes=Buffer.from(JSON.stringify({package:{id:'foreign-rulepack'}}));await writeFile(join(root,path),bytes)
 const manifestPath=join(root,'official-policy-manifest.json'),manifest=JSON.parse(await readFile(manifestPath));manifest.files[path]={bytes:bytes.length,sha256:sha256(bytes)};await writeFile(manifestPath,JSON.stringify(manifest))
 const lock=JSON.parse(await readFile(f.options.oldReleaseLockPath))
 await assert.rejects(verifyHostUpgradeLayers(f.options.oldUiArtifactRoot,root,target(lock)),{code:'HOST_UPGRADE_PACKAGE_IDENTITY_MISMATCH'})
})
