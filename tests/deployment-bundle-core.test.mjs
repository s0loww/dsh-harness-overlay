import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {readDeploymentBundle,createDeploymentService} from '../src/deployment-bundle/lib/core.mjs'
import {seal} from '../src/deployment-bundle/lib/fs.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex'),put=async(path,bytes)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes)},exists=path=>readFile(path).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e))
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'dsh-deploy-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const bundle=join(root,'Комплект'),state=join(root,'recipient-state'),home=join(root,'home'),install=join(root,'official'),trace=[]
 const paths={engine:'payload/engine',uiArtifact:'payload/engine/dist/airules-ui-overlay-ui1',policyArtifact:'payload/engine/dist/airules-official-policy-policy1',releaseLock:'payload/engine/upstream/official-desktop/0.2.2-rc.1/release.lock.json',node:'runtime/node/node.exe',python:'runtime/python/python.exe',officialInstaller:'payload/official/setup.exe'}
 const files={}
 for(const[path,text]of Object.entries({'payload/engine/package.json':'{"type":"module"}',[paths.uiArtifact+'/ui-overlay-manifest.json']:'{"fixture":"ui"}',[paths.policyArtifact+'/official-policy-manifest.json']:'{"fixture":"policy"}',[paths.releaseLock]:'{"fixture":"host"}',[paths.node]:'PINNED_NODE_FIXTURE',[paths.python]:'PINNED_PYTHON_FIXTURE',[paths.officialInstaller]:'SIGNED_INSTALLER_FIXTURE','components/cognee/image.tar':'COGNEE_IMAGE_FIXTURE','components/mcp/bindings.json':'{"synthetic":true}'})){const bytes=Buffer.from(text);await put(join(bundle,path),bytes);files[path]={bytes:bytes.length,sha256:sha(bytes)}}
 const manifest={schemaVersion:1,kind:'airules-dsh-deployment',version:'0.17.2-test1',platform:'win32-x64',hostVersion:'0.2.2-rc.1',paths,files,components:{cognee:{enabled:true},mcp:{enabled:true},extras:{enabled:true}}}
 await put(join(bundle,'deployment-manifest.json'),JSON.stringify(manifest,null,2))
 let running=false,failComponent=null
 async function config(ctx,name){trace.push(name);if(failComponent===name)throw Object.assign(Error('FIXTURE_COMPONENT_REFUSED'),{notAttempted:true});const path=join(ctx.dshHome,name+'.fixture.json'),before=await readFile(path).catch(e=>{if(e.code==='ENOENT')return null;throw e});const after=Buffer.from(JSON.stringify({version:ctx.manifest.version,synthetic:name}));await put(path,after);return{path,before:before?.toString('base64')??null,after:sha(after)}}
 async function unconfig(ctx,name){trace.push('rollback-'+name);const row=ctx.componentReceipt;assert.equal(sha(await readFile(row.path)),row.after);if(row.before===null)await rm(row.path);else await writeFile(row.path,Buffer.from(row.before,'base64'))}
 const adapters={
  async inspectOfficial(ctx){const present=await exists(join(ctx.installRoot,'host.fixture'));return{installed:present,compatible:present,hostVersion:ctx.manifest.hostVersion}},
  async assertStopped(){if(running)throw Error('DEPLOY_DSH_RUNNING')},
  async installOfficial(ctx){trace.push('official');await put(join(ctx.installRoot,'host.fixture'),ctx.manifest.hostVersion)},
  configureExtras:ctx=>config(ctx,'extras'),rollbackExtras:ctx=>unconfig(ctx,'extras'),
  configureCognee:ctx=>config(ctx,'cognee'),rollbackCognee:ctx=>unconfig(ctx,'cognee'),
  configureMcp:ctx=>config(ctx,'mcp'),rollbackMcp:ctx=>unconfig(ctx,'mcp'),
  async prepareCandidate(ctx){trace.push('candidate');assert.equal(await exists(join(ctx.dshHome,'extras.fixture.json')),true);assert.equal(await exists(join(ctx.bundleRoot,'deployment-manifest.json')),true);const path=join(ctx.engineRoot,'var/candidate',ctx.deploymentId);await mkdir(path,{recursive:true});return path},
  async applyOverlay(ctx){trace.push('overlay');const target=join(ctx.profileRoot,'node_modules/fixture-overlay/index.js'),patch=join(ctx.profileRoot,'cordis.patch.yml'),rows=[];for(const[path,after]of [[target,Buffer.from('overlay '+ctx.manifest.version)],[patch,Buffer.concat([await readFile(patch),Buffer.from('# OWNED OVERLAY\n')])]]){const before=await readFile(path).catch(e=>{if(e.code==='ENOENT')return null;throw e});await put(path,after);rows.push({path,before:before?.toString('base64')??null,after:sha(after)})}const receiptPath=join(ctx.backupRoot,'receipt.json');await put(receiptPath,JSON.stringify({rows}));return{receiptPath}},
  async verifyOverlay(ctx){const{rows}=JSON.parse(await readFile(ctx.receiptPath));return{status:(await Promise.all(rows.map(async row=>sha(await readFile(row.path))===row.after))).every(Boolean)?'PASS':'FAIL',owned:rows.length}},
  async rollbackOverlay(ctx){trace.push('rollback-overlay');const{rows}=JSON.parse(await readFile(ctx.receiptPath));for(const row of [...rows].reverse()){assert.equal(sha(await readFile(row.path)),row.after);if(row.before===null)await rm(row.path);else await writeFile(row.path,Buffer.from(row.before,'base64'))}return{status:'rolled-back'}},
 }
 const service=()=>createDeploymentService({bundleRoot:bundle,stateRoot:state,installRoot:install,dshHome:home,adapters})
 return{root,bundle,state,home,install,manifest,paths,files,trace,adapters,service,setRunning:value=>{running=value},setFailure:value=>{failComponent=value}}
}
test('single deployment caches the verified runtime, installs all components and preserves unrelated recipient state',async t=>{
 const f=await fixture(t);await put(join(f.home,'sessions/chat.json'),'PRIVATE_CHAT_FIXTURE');await put(join(f.home,'.credentials.yaml'),'PRIVATE_CREDENTIAL_FIXTURE');await put(join(f.home,'mcp.existing.json'),'EXISTING_MCP_FIXTURE')
 const svc=f.service(),plan=await svc.plan();assert.equal(plan.status,'ready');assert.equal(plan.requiresOfficialInstall,true);assert.equal(await exists(join(f.state,'current.json')),false)
 const result=await svc.apply({planId:plan.planId,acceptPlan:true});assert.equal(result.status,'installed');assert.deepEqual(f.trace,['official','extras','candidate','overlay','cognee','mcp'])
 assert.equal(await readFile(join(f.home,'sessions/chat.json'),'utf8'),'PRIVATE_CHAT_FIXTURE');assert.equal(await readFile(join(f.home,'.credentials.yaml'),'utf8'),'PRIVATE_CREDENTIAL_FIXTURE');assert.equal(await readFile(join(f.home,'mcp.existing.json'),'utf8'),'EXISTING_MCP_FIXTURE')
 const settings=JSON.parse(await readFile(join(f.home,'git-maintenance/settings.json')));assert.ok(settings.harness.engineRoot.startsWith(f.state));assert.equal(settings.node,join(f.state,'package',f.paths.node));assert.equal(settings.python,join(f.state,'package',f.paths.python));assert.equal(settings.harness.previousReceiptPath,result.overlayReceiptPath)
 assert.equal((await readDeploymentBundle(join(f.state,'package'))).identity,(await readDeploymentBundle(f.bundle)).identity)
 const rolled=await svc.uninstallOverlay();assert.equal(rolled.status,'uninstalled-overlay');assert.equal(rolled.officialDesktopPreserved,true);assert.equal(await exists(join(f.install,'host.fixture')),true);assert.equal(await exists(join(f.home,'sessions/chat.json')),true);assert.equal((await svc.status()).installed,false)
})
test('existing host/profile and machine preferences are backed up and restored exactly on overlay removal',async t=>{
 const f=await fixture(t);await put(join(f.install,'host.fixture'),'0.2.2-rc.1');const profile=join(f.home,'profiles/desktop');await put(join(profile,'package.json'),'{"name":"existing-profile","custom":true}');await put(join(profile,'cordis.patch.yml'),'# USER PATCH\n[]\n');const settings={schemaVersion:1,airules:{repository:'https://github.com/fixture/rules.git',ref:'owner-ref',localPath:''},harness:{repository:'https://github.com/fixture/overlay.git',ref:'owner-ref'},python:'owner-python',node:'owner-node'},original=Buffer.from(JSON.stringify(settings));await put(join(f.home,'git-maintenance/settings.json'),original)
 const svc=f.service(),plan=await svc.plan();assert.equal(plan.requiresOfficialInstall,false);const result=await svc.apply({planId:plan.planId,acceptPlan:true});assert.equal(result.officialInstalled,false);assert.equal(JSON.parse(await readFile(join(f.home,'git-maintenance/settings.json'))).airules.ref,'owner-ref');await svc.rollback({deploymentId:result.deploymentId});assert.deepEqual(await readFile(join(f.home,'git-maintenance/settings.json')),original);assert.equal(await readFile(join(profile,'cordis.patch.yml'),'utf8'),'# USER PATCH\n[]\n');assert.equal(await readFile(join(profile,'package.json'),'utf8'),'{"name":"existing-profile","custom":true}')
})
test('modified package bytes, running Desktop and missing plan acceptance refuse before target writes',async t=>{
 const f=await fixture(t),svc=f.service(),plan=await svc.plan();await assert.rejects(svc.apply({planId:plan.planId}),/DEPLOY_PLAN_ACCEPTANCE_REQUIRED/);f.setRunning(true);await assert.rejects(svc.apply({planId:plan.planId,acceptPlan:true}),/DEPLOY_DSH_RUNNING/);assert.equal(await exists(join(f.install,'host.fixture')),false);f.setRunning(false);await writeFile(join(f.bundle,f.paths.node),'TAMPERED');await assert.rejects(svc.apply({planId:plan.planId,acceptPlan:true}),/DEPLOY_PAYLOAD_HASH_MISMATCH/);assert.equal(await exists(join(f.home,'profiles/desktop/package.json')),false)
})
test('a refused component restores owned overlay/config while leaving the official host and existing data',async t=>{
 const f=await fixture(t);await put(join(f.home,'sessions/chat.json'),'KEEP_CHAT');f.setFailure('mcp');const svc=f.service(),plan=await svc.plan();let failure;try{await svc.apply({planId:plan.planId,acceptPlan:true})}catch(error){failure=error}assert.equal(failure.code,'FIXTURE_COMPONENT_REFUSED');assert.deepEqual(failure.recoveryFailures,[]);assert.equal(await exists(join(f.home,'profiles/desktop/node_modules/fixture-overlay/index.js')),false);assert.equal(await exists(join(f.home,'git-maintenance/settings.json')),false);assert.equal(await readFile(join(f.home,'sessions/chat.json'),'utf8'),'KEEP_CHAT');assert.equal(await exists(join(f.install,'host.fixture')),true);assert.equal(JSON.parse(await readFile(failure.receiptPath)).status,'failed-restored')
})
test('cache conflicts, traversal and links are rejected rather than installing arbitrary files',async t=>{
 const f=await fixture(t);await put(join(f.state,'package',f.paths.node),'UNOWNED_NODE');const plan=await f.service().plan();assert.equal(plan.status,'blocked');assert.ok(plan.conflicts.includes(f.paths.node));f.manifest.files['../outside']={bytes:0,sha256:'0'.repeat(64)};await writeFile(join(f.bundle,'deployment-manifest.json'),JSON.stringify(f.manifest));await assert.rejects(readDeploymentBundle(f.bundle),/DEPLOY_RELATIVE_PATH_INVALID/)
 const g=await fixture(t),target=join(g.root,'outside.exe');await writeFile(target,'PINNED_NODE_FIXTURE');await rm(join(g.bundle,g.paths.node));await symlink(target,join(g.bundle,g.paths.node));await assert.rejects(readDeploymentBundle(g.bundle),/DEPLOY_LINK_REJECTED/)
})
test('unknown component failures remain recovery-required and never claim full compensation',async t=>{
 const f=await fixture(t),partial={owned:true,stateRoot:join(f.root,'cognee-partial'),receiptPath:join(f.root,'cognee-partial.json')};f.adapters.configureCognee=async()=>{throw Object.assign(Error('FIXTURE_TRANSPORT_UNKNOWN'),{componentReceipt:partial})};const svc=f.service(),plan=await svc.plan();let failure;try{await svc.apply({planId:plan.planId,acceptPlan:true})}catch(error){failure=error}assert.equal(failure.code,'FIXTURE_TRANSPORT_UNKNOWN');assert.deepEqual(failure.recoveryFailures,[{component:'cognee',code:'DEPLOY_COMPONENT_OUTCOME_UNKNOWN'}]);const receipt=JSON.parse(await readFile(failure.receiptPath));assert.equal(receipt.status,'recovery-required');assert.deepEqual(receipt.components.cognee,partial)
 await assert.rejects(f.service().plan(),{code:'DEPLOY_RECOVERY_REQUIRED'});const status=await f.service().status();assert.equal(status.pending[0].status,'recovery-required');assert.equal(status.pending[0].receiptPath,failure.receiptPath);assert.ok(!JSON.stringify(status.pending).includes('cognee-partial'))
})
test('an incomplete or invalid transaction blocks both new plans and a previously accepted plan before cache writes',async t=>{
 for(const variant of ['missing','invalid-seal','wrong-owner','preparing']){
  const f=await fixture(t),svc=f.service(),plan=await svc.plan(),id=randomUUID(),transaction=join(f.state,'deployments',id),receiptPath=join(transaction,'receipt.json');await mkdir(transaction,{recursive:true})
  const receipt={schemaVersion:1,kind:'airules-dsh-deployment-receipt',deploymentId:id,status:'preparing',transaction,paths:{stateRoot:f.state,installRoot:variant==='wrong-owner'?join(f.root,'other'):f.install,dshHome:f.home}}
  if(variant!=='missing')await put(receiptPath,JSON.stringify(variant==='invalid-seal'?receipt:seal(receipt)))
  await assert.rejects(svc.plan(),{code:'DEPLOY_RECOVERY_REQUIRED'});await assert.rejects(svc.apply({planId:plan.planId,acceptPlan:true}),{code:'DEPLOY_RECOVERY_REQUIRED'});assert.equal(await exists(join(f.state,'package',f.paths.node)),false);assert.equal(f.trace.length,0);const pending=(await svc.status()).pending;assert.equal(pending.length,1);assert.equal(pending[0].status,variant==='preparing'?'preparing':'invalid-receipt')
 }
})
test('an update keeps historical artifacts and rollback restores the preceding deployment before full overlay uninstall',async t=>{
 const f=await fixture(t),first=f.service(),p1=await first.plan(),v1=await first.apply({planId:p1.planId,acceptPlan:true})
 f.manifest.version='0.17.3-test2'
 for(const[name,path]of [['uiArtifact','payload/engine/dist/airules-ui-overlay-ui2'],['policyArtifact','payload/engine/dist/airules-official-policy-policy2']]){f.manifest.paths[name]=path;const file=path+'/manifest.fixture.json',bytes=Buffer.from(name+' v2');await put(join(f.bundle,file),bytes);f.manifest.files[file]={bytes:bytes.length,sha256:sha(bytes)}}
 await writeFile(join(f.bundle,'deployment-manifest.json'),JSON.stringify(f.manifest,null,2))
 const second=f.service(),p2=await second.plan({mode:'update'});assert.equal(p2.previousDeploymentId,v1.deploymentId);assert.equal(p2.status,'ready');const v2=await second.apply({planId:p2.planId,acceptPlan:true});assert.equal(v2.version,'0.17.3-test2');assert.equal(f.trace.filter(x=>x==='official').length,1)
 await second.rollback({deploymentId:v2.deploymentId});assert.equal((await second.status()).current.deploymentId,v1.deploymentId);assert.equal(await readFile(join(f.home,'profiles/desktop/node_modules/fixture-overlay/index.js'),'utf8'),'overlay 0.17.2-test1');assert.equal(await exists(join(f.state,'package/payload/engine/dist/airules-ui-overlay-ui1/ui-overlay-manifest.json')),true)
 assert.equal((await second.uninstallOverlay()).status,'uninstalled-overlay');assert.equal((await second.status()).installed,false)
})
test('repair restores only an owned cached runtime file and preserves its drifted bytes in the transaction backup',async t=>{
 const f=await fixture(t),svc=f.service(),initial=await svc.plan();await svc.apply({planId:initial.planId,acceptPlan:true});const target=join(f.state,'package',f.paths.node);await writeFile(target,'OWNER_RUNTIME_DRIFT')
 const blocked=await f.service().plan({mode:'update'});assert.equal(blocked.status,'blocked');const repair=f.service(),plan=await repair.plan({mode:'repair'});assert.equal(plan.status,'ready');const result=await repair.apply({planId:plan.planId,acceptPlan:true});assert.equal(await readFile(target,'utf8'),'PINNED_NODE_FIXTURE');assert.equal(await readFile(join(dirname(result.receiptPath),'cache-before',f.paths.node),'utf8'),'OWNER_RUNTIME_DRIFT')
})
test('an interrupted rollback resumes after completed components without repeating their restoration',async t=>{
 const f=await fixture(t),svc=f.service(),plan=await svc.plan(),installed=await svc.apply({planId:plan.planId,acceptPlan:true}),original=f.adapters.rollbackCognee;let calls=0
 f.adapters.rollbackCognee=async ctx=>{calls++;if(calls===1)throw Error('FIXTURE_RECOVERY_INTERRUPTED');return original(ctx)}
 const recovery=f.service();await assert.rejects(recovery.rollback(),/FIXTURE_RECOVERY_INTERRUPTED/);assert.equal(JSON.parse(await readFile(installed.receiptPath)).status,'rollback-interrupted');assert.equal(f.trace.filter(x=>x==='rollback-mcp').length,1)
 await recovery.rollback();assert.equal(calls,2);assert.equal(f.trace.filter(x=>x==='rollback-mcp').length,1);assert.equal((await recovery.status()).installed,false)
})
