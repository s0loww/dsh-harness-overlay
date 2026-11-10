import test from'node:test'
import assert from'node:assert/strict'
import{mkdir,cp,readFile,writeFile,access}from'node:fs/promises'
import{join,dirname,resolve}from'node:path'
import{randomUUID}from'node:crypto'
import{pathToFileURL}from'node:url'
import{hostFixture}from'./fixtures/host-upgrade.mjs'
import{buildHostUpgradePlan,HOST_UPGRADE_ROOT}from'../scripts/upgrade-official-host.mjs'
import{targetState,sha256}from'../installer/fs-state.mjs'
import{sealReceipt}from'../installer/receipt.mjs'
import{directoryStateWithNested}from'../installer/official-live/common.mjs'
const NAME='@deepseek-ai/cosmokit'
const put=async(path,bytes)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes)}
async function fixture(t){
 const f=await hostFixture(t)
 for(const side of['old','new']){
  const root=f.options[side+'UiArtifactRoot'],source=join(root,'payload/packages',NAME)
  await put(join(source,'package.json'),JSON.stringify({name:NAME,version:side==='old'?'1.8.6':'1.9.0'}));await put(join(source,'index.js'),side+' core')
  const cpPath=join(root,'official-ui-manifest.json'),contract=JSON.parse(await readFile(cpPath));contract.packages.push({name:NAME,source:'payload/packages/'+NAME});await writeFile(cpPath,JSON.stringify(contract))
  const path=join(root,'ui-overlay-manifest.json'),manifest=JSON.parse(await readFile(path));manifest.operations.push({type:'package-copy',target:'node_modules/'+NAME});manifest.packageProvenance=[{name:NAME,origin:'official-native-runtime',hostVersion:'test-'+side,sourceDirectorySha256:(await targetState(source)).digest}]
  const state=await targetState(root);delete state.files['ui-overlay-manifest.json'];manifest.files=state.files;await writeFile(path,JSON.stringify(manifest))
 }
 const oldSource=join(f.options.oldUiArtifactRoot,'payload/packages',NAME),installed=join(f.profile,'node_modules',NAME)
 await cp(oldSource,installed,{recursive:true});await put(join(installed,'index.d.ts'),'safe declaration')
 const path=f.options.previousReceiptPath,receipt=JSON.parse(await readFile(path));receipt.artifactPackageNames.push(NAME);receipt.artifacts.ui.manifestSha256=sha256(await readFile(join(f.options.oldUiArtifactRoot,'ui-overlay-manifest.json')))
 receipt.dependencyResolution={verifiedNoops:[{package:NAME,version:'1.8.6',sourceDigest:(await targetState(oldSource)).digest,installedDigest:(await targetState(installed)).digest,mode:'same-version-subset'}]}
 await writeFile(path,JSON.stringify(sealReceipt(receipt)));return{...f,installed,receipt,oldSource}
}
async function reseal(f,mutate){const receipt=JSON.parse(await readFile(f.options.previousReceiptPath));mutate(receipt);await writeFile(f.options.previousReceiptPath,JSON.stringify(sealReceipt(receipt)))}

test('only prior attested safe subset dependency upgrades become owned operations with bound migration proof',async t=>{
 const f=await fixture(t),oldReceipt=await readFile(f.options.previousReceiptPath),plan=await buildHostUpgradePlan(f.options),row=plan.operations.find(row=>row.package===NAME)
 assert.ok(row);assert.deepEqual(row.dependencyMigration,{previousReceiptSha256:sha256(oldReceipt),oldSourceDigest:(await targetState(f.oldSource)).digest,installedDigest:(await targetState(f.installed)).digest,newSourceDigest:row.after.digest});assert.ok(plan.newOwnership.packageNames.includes(NAME));assert.deepEqual(await readFile(f.options.previousReceiptPath),oldReceipt)
})
for(const[description,mutate]of[
 ['false installed digest',r=>r.dependencyResolution.verifiedNoops[0].installedDigest='a'.repeat(64)],
 ['false old source digest',r=>r.dependencyResolution.verifiedNoops[0].sourceDigest='b'.repeat(64)],
 ['false old version',r=>r.dependencyResolution.verifiedNoops[0].version='1.9.0'],
 ['duplicate noop',r=>r.dependencyResolution.verifiedNoops.push({...r.dependencyResolution.verifiedNoops[0]})],
 ['non-whitelisted noop',r=>r.dependencyResolution.verifiedNoops[0].package='user-plugin']
])test('resealed receipt refuses '+description,async t=>{const f=await fixture(t);await reseal(f,mutate);await assert.rejects(buildHostUpgradePlan(f.options),/DEPENDENCY_MIGRATION_INVALID|PREVIOUS_NOOPS_INVALID|UNOWNED_PACKAGE_COLLISION/)})
test('resealed current digest cannot legitimize an unsafe extra executable file',async t=>{
 const f=await fixture(t);await put(join(f.installed,'unexpected.js'),'executable extra')
 const current=await targetState(f.installed);await reseal(f,r=>r.dependencyResolution.verifiedNoops[0].installedDigest=current.digest)
 await assert.rejects(buildHostUpgradePlan(f.options),/DEPENDENCY_MIGRATION_INVALID/)
})
test('unattested changes to a formerly verified dependency remain blocked',async t=>{
 const f=await fixture(t);await put(join(f.installed,'index.js'),'changed existing runtime');await assert.rejects(buildHostUpgradePlan(f.options),/DEPENDENCY_MIGRATION_INVALID/)
})
test('actual certified old/new artifacts and unchanged live installation produce read-only upgrade plan', {skip:process.env.AIRULES_RUN_LIVE_READONLY_PLAN!=='1',timeout:120000},async()=>{
 const modulePath=resolve(process.env.AIRULES_LIVE_OPTIONS_MODULE??'var/host-upgrade/rc022/live-options.mjs')
 const {options}=await import(pathToFileURL(modulePath))
 const transactionRoot=join(HOST_UPGRADE_ROOT,'readonly-'+randomUUID())
 await assert.rejects(access(transactionRoot),{code:'ENOENT'})
 const outcome=await buildHostUpgradePlan({...options,transactionRoot})
 assert.equal(outcome.status,'ready-shadow-only');assert.equal(outcome.oldTarget.hostVersion,'0.2.1-rc.5');assert.equal(outcome.newTarget.hostVersion,'0.2.2-rc.1');assert.ok(outcome.operations.length>40)
 await assert.rejects(access(transactionRoot),{code:'ENOENT'})
})

test('new artifact source must retain reviewed official native runtime provenance',async t=>{
 const f=await fixture(t),path=join(f.options.newUiArtifactRoot,'ui-overlay-manifest.json'),manifest=JSON.parse(await readFile(path));manifest.packageProvenance[0].origin='source-bundle';await writeFile(path,JSON.stringify(manifest))
 await assert.rejects(buildHostUpgradePlan(f.options),/DEPENDENCY_MIGRATION_INVALID/)
})
test('previous storage-domain composite subset binds old nested zod and installs new composite as owned',async t=>{
 const f=await hostFixture(t,{nativeDeps:true}),name='@deepseek-ai/dsh-storage-domain',oldRoot=f.options.oldUiArtifactRoot,newRoot=f.options.newUiArtifactRoot
 const oldSource=await targetState(join(oldRoot,'payload/packages',name)),oldZod=await targetState(join(oldRoot,'payload/packages/zod')),installed=await targetState(join(f.profile,'node_modules',name)),source=directoryStateWithNested(oldSource,'zod',oldZod)
 const receipt=JSON.parse(await readFile(f.options.previousReceiptPath));receipt.packageNames=receipt.packageNames.filter(row=>row!==name);receipt.operations=receipt.operations.filter(row=>row.package!==name);receipt.dependencyResolution={verifiedNoops:[{package:name,version:'1.0.0',sourceDigest:source.digest,installedDigest:installed.digest,mode:'composite-subset'}]};await writeFile(f.options.previousReceiptPath,JSON.stringify(sealReceipt(receipt)))
 const path=join(newRoot,'ui-overlay-manifest.json'),manifest=JSON.parse(await readFile(path));manifest.packageProvenance=[{name,origin:'official-native-runtime',hostVersion:'test-new',sourceDirectorySha256:(await targetState(join(newRoot,'payload/packages',name))).digest}];await writeFile(path,JSON.stringify(manifest))
 const plan=await buildHostUpgradePlan(f.options),operation=plan.operations.find(row=>row.package===name)
 assert.equal(operation.dependencyMigration.oldSourceDigest,source.digest);assert.equal(operation.type,'copy-directory-with-nested-dependency');assert.equal(operation.nestedDependency.name,'zod');assert.ok(plan.newOwnership.packageNames.includes(name))
})
