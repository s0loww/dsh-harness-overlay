import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,link,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {EXTRA_PLUGINS,configureExtras,rollbackExtras,extrasState} from '../src/deployment-bundle/extras/index.mjs'
import {stageDeploymentExtras} from '../scripts/stage-deployment-extras.mjs'
import {seal} from '../src/deployment-bundle/lib/fs.mjs'
import {createRequire} from 'node:module'
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'airules-extras-'));t.after(async()=>{const child=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(child)&&child.startsWith('airules-extras-'));await rm(root,{recursive:true,force:true})})
 const modulesRoot=join(root,'source-modules'),captainRoot=join(root,'captain'),assetsRoot=join(root,'assets'),profileRoot=join(root,'home','profiles','desktop'),dshHome=join(root,'home'),backupRoot=join(root,'receipt')
 await mkdir(modulesRoot);await mkdir(captainRoot);await mkdir(profileRoot,{recursive:true})
 const names=Object.entries(EXTRA_PLUGINS)
 for(const[name,version]of [...names,['fixture-extra-dependency','1.0.0']]){const at=join(modulesRoot,name);await mkdir(join(at,'lib'),{recursive:true});await writeFile(join(at,'package.json'),JSON.stringify({name,version,license:'MIT',...(name===names[0][0]?{dependencies:{'fixture-extra-dependency':'1.0.0'}}:{})}));await writeFile(join(at,'lib/index.js'),'export const fixture=true\n');await writeFile(join(at,'LICENSE'),'Fixture MIT\n')}
 await writeFile(join(captainRoot,'pet.json'),JSON.stringify({name:'Fixture Captain',spriteVersionNumber:2,spritesheetPath:'spritesheet.png'}));await writeFile(join(captainRoot,'spritesheet.png'),Buffer.from('fixture-spritesheet'))
 await stageDeploymentExtras({modulesRoot,captainRoot,output:assetsRoot})
 const profile={name:'fixture-profile',dependencies:{'user-existing-plugin':'1.0.0'},dsh:{profile:{bundles:['user-existing-plugin']}}},profileBytes=Buffer.from('\ufeff'+JSON.stringify(profile,null,2)+'\r\n')
 await writeFile(join(profileRoot,'package.json'),profileBytes);await mkdir(join(profileRoot,'node_modules/user-existing-plugin'),{recursive:true});await writeFile(join(profileRoot,'node_modules/user-existing-plugin/user.txt'),'Preserve existing plugin')
 const petConfig=Buffer.from('{"selected":"custom:user-own-pet","visible":false,"phrases":{"idle":["personal-fixture"]}}\r\n');await mkdir(join(dshHome,'codex-pet'));await writeFile(join(dshHome,'codex-pet/config.json'),petConfig)
 return{root,modulesRoot,captainRoot,assetsRoot,profileRoot,dshHome,backupRoot,profileBytes,petConfig,options:{assetsRoot,profileRoot,dshHome,backupRoot}}
}
async function editReceipt(path,change){const value=JSON.parse(await readFile(path,'utf8'));change(value);await writeFile(path,JSON.stringify(seal(value),null,2)+'\n');return value}
test('actual extras staging pins dependency content; configure preserves user profile/pet settings and exact rollback restores original BOM bytes',async t=>{
 const f=await fixture(t),manifest=JSON.parse(await readFile(join(f.assetsRoot,'extras.json'),'utf8'));assert.equal(manifest.packages.length,5);assert.equal(manifest.dependencyLayout,'private-per-plugin');assert.ok(manifest.packages.every(row=>row.state.type==='directory'&&row.state.digest&&Object.keys(row.state.files).length>=3))
 const installed=await configureExtras(f.options);assert.equal(installed.plugins,5);assert.equal(installed.personalStateImported,false)
 const profile=JSON.parse(await readFile(join(f.profileRoot,'package.json'),'utf8'));assert.equal(profile.dependencies['user-existing-plugin'],'1.0.0');assert.ok(profile.dsh.profile.bundles.includes('user-existing-plugin'));for(const name of Object.keys(EXTRA_PLUGINS))assert.equal(profile.dependencies[name],EXTRA_PLUGINS[name])
 assert.deepEqual(await readFile(join(f.dshHome,'codex-pet/config.json')),f.petConfig);assert.equal(await readFile(join(f.profileRoot,'node_modules/user-existing-plugin/user.txt'),'utf8'),'Preserve existing plugin')
 assert.equal((await rollbackExtras({receiptPath:installed.receiptPath})).status,'rolled-back');assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes);assert.deepEqual(await readFile(join(f.dshHome,'codex-pet/config.json')),f.petConfig);assert.deepEqual(await readdir(join(f.profileRoot,'node_modules')),['user-existing-plugin'])
})
test('changed staged dependency bytes are rejected before any recipient mutation',async t=>{
 const f=await fixture(t);await writeFile(join(f.assetsRoot,'modules/@michengai/dsh-btw/node_modules/fixture-extra-dependency/lib/index.js'),'tampered dependency\n')
 await assert.rejects(configureExtras(f.options),/EXTRAS_ASSET_CHANGED/);assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes);assert.deepEqual(await readdir(join(f.profileRoot,'node_modules')),['user-existing-plugin'])
})
test('a same-type existing package directory with different content is a conflict instead of a false hash match',async t=>{
 const f=await fixture(t),path=join(f.profileRoot,'node_modules/dsh-usage-panel');await mkdir(path);await writeFile(join(path,'user.txt'),'different user dependency')
 await assert.rejects(configureExtras(f.options),/EXTRAS_PACKAGE_CONFLICT/);assert.equal(await readFile(join(path,'user.txt'),'utf8'),'different user dependency');assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes)
})
test('rollback infers the package.json commit when interruption happened before its written journal update',async t=>{
 const f=await fixture(t),result=await configureExtras(f.options)
 await editReceipt(result.receiptPath,value=>{value.status='interrupted';const row=value.rows.find(row=>row.path==='package.json');assert.ok(row);row.written=false;row.started=true})
 await rollbackExtras({receiptPath:result.receiptPath});assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes)
})
test('started partial package copy rolls back its exact owned subset, and interrupted rollback resumes from restored bytes',async t=>{
 const f=await fixture(t),result=await configureExtras(f.options),receipt=await editReceipt(result.receiptPath,value=>{value.status='interrupted';const row=value.rows.find(row=>row.kind==='package');row.written=false;row.started=true})
 const row=receipt.rows.find(row=>row.kind==='package');await unlink(join(f.profileRoot,row.path,'lib/index.js'))
 const pkg=receipt.rows.find(row=>row.path==='package.json'),saved=join(f.backupRoot,'before/profile/package.json');assert.ok(pkg);await writeFile(join(f.profileRoot,'package.json'),await readFile(saved))
 await rollbackExtras({receiptPath:result.receiptPath});assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes);assert.deepEqual(await readdir(join(f.profileRoot,'node_modules')),['user-existing-plugin'])
})
test('foreign edits in an interrupted package block the whole rollback without erasing user files',async t=>{
 const f=await fixture(t),result=await configureExtras(f.options),receipt=await editReceipt(result.receiptPath,value=>{value.status='interrupted';value.rows.find(row=>row.kind==='package').written=false})
 const row=receipt.rows.find(row=>row.kind==='package');await writeFile(join(f.profileRoot,row.path,'foreign.txt'),'user data');const before=await readFile(join(f.profileRoot,'package.json'))
 await assert.rejects(rollbackExtras({receiptPath:result.receiptPath}),/EXTRAS_ROLLBACK_CONFLICT/);assert.equal(await readFile(join(f.profileRoot,row.path,'foreign.txt'),'utf8'),'user data');assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),before)
})
test('reentry does not duplicate bundle registration or overwrite user defaults, and dependency hardlinks fail closed',async t=>{
 const f=await fixture(t);await configureExtras(f.options);const before=await readFile(join(f.profileRoot,'package.json')),again=await configureExtras({...f.options,backupRoot:join(f.root,'second-receipt')});assert.equal(again.files,0);assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),before);assert.deepEqual(await readFile(join(f.dshHome,'codex-pet/config.json')),f.petConfig)
 const file=join(f.assetsRoot,'modules/@michengai/dsh-btw/node_modules/fixture-extra-dependency/lib/index.js');await link(file,join(f.root,'dependency-alias'));await assert.rejects(extrasState(join(f.assetsRoot,'modules/@michengai/dsh-btw/node_modules/fixture-extra-dependency')),/DEPLOY_LINK_REJECTED/)
})


test('per-plugin private zod keeps the host zod and stripped shared packages unchanged and resolves its exact source version',async t=>{
 const f=await fixture(t)
 const zodSource=join(f.modulesRoot,'zod');await mkdir(zodSource);await writeFile(join(zodSource,'package.json'),JSON.stringify({name:'zod',version:'4.6.7',license:'MIT',main:'index.cjs'}));await writeFile(join(zodSource,'index.cjs'),"module.exports={fixtureVersion:'4.6.7'}\n")
 const usagePath=join(f.modulesRoot,'dsh-usage-panel/package.json'),usage=JSON.parse(await readFile(usagePath,'utf8'));usage.dependencies={zod:'^4.4.3'};await writeFile(usagePath,JSON.stringify(usage))
 const richer=join(f.root,'private-assets');await stageDeploymentExtras({modulesRoot:f.modulesRoot,captainRoot:f.captainRoot,output:richer})
 const hostZod=join(f.profileRoot,'node_modules/zod');await mkdir(hostZod);await writeFile(join(hostZod,'package.json'),JSON.stringify({name:'zod',version:'4.4.3',main:'index.cjs'}));await writeFile(join(hostZod,'index.cjs'),"module.exports={fixtureVersion:'4.4.3'}\n")
 const hostSpec=join(f.profileRoot,'node_modules/@standard-schema/spec');await mkdir(hostSpec,{recursive:true});await writeFile(join(hostSpec,'package.json'),JSON.stringify({name:'@standard-schema/spec',version:'1.1.0'}));await writeFile(join(hostSpec,'index.js'),'stripped host package\n')
 const beforeZod=await extrasState(hostZod),beforeSpec=await extrasState(hostSpec),installed=await configureExtras({...f.options,assetsRoot:richer})
 assert.deepEqual(await extrasState(hostZod),beforeZod);assert.deepEqual(await extrasState(hostSpec),beforeSpec)
 const pluginRequire=createRequire(join(f.profileRoot,'node_modules/dsh-usage-panel/package.json'))
 assert.equal(pluginRequire('zod').fixtureVersion,'4.6.7');assert.ok(pluginRequire.resolve('zod').includes(join('dsh-usage-panel','node_modules','zod')))
 assert.equal(createRequire(join(f.profileRoot,'package.json'))('zod').fixtureVersion,'4.4.3')
 await rollbackExtras({receiptPath:installed.receiptPath});assert.deepEqual(await extrasState(hostZod),beforeZod);assert.deepEqual(await extrasState(hostSpec),beforeSpec);assert.deepEqual(await readFile(join(f.profileRoot,'package.json')),f.profileBytes)
})
