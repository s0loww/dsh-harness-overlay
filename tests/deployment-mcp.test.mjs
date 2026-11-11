import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,link,lstat} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createPublicMcpCatalog,validateMcpCatalog,planMcpConfiguration,applyMcpConfiguration,rollbackMcpConfiguration,configureMcp} from '../src/deployment-bundle/mcp/index.mjs'
const fixtureKey='fixture-shared-bearer-1234567890'
async function fixture(t,{existing=true}={}){
 const root=await mkdtemp(join(tmpdir(),'airules-deploy-mcp-'));t.after(async()=>{const child=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(child)&&child.startsWith('airules-deploy-mcp-'));await rm(root,{recursive:true,force:true})})
 const dshHome=join(root,'home'),backupRoot=join(root,'backups'),catalogPath=join(root,'catalog.json'),credentialsPath=join(root,'credentials.json');await mkdir(dshHome)
 const catalog=createPublicMcpCatalog({gatewayBaseUrl:'https://gateway.example.invalid:10000',kgBaseUrl:'https://knowledge.example.invalid:8443'})
 const original={version:1,token:'fixture-manager-token-retained',unrelated:{preserve:true},servers:[{serverName:'existing-local',transport:'stdio',command:'fixture-command',args:['keep'],enabled:false,env:{PRIVATE:'fixture-existing-private'}}]},before=Buffer.from('\ufeff'+JSON.stringify(original,null,2)+'\r\n'),target=join(dshHome,'airules-mcp-servers.json')
 if(existing)await writeFile(target,before)
 await writeFile(catalogPath,JSON.stringify(catalog));await writeFile(credentialsPath,JSON.stringify({schemaVersion:1,credentials:{'tail-shared-bearer':fixtureKey}}))
 return{root,dshHome,backupRoot,catalogPath,credentialsPath,catalog,original,before,target,options:{dshHome,backupRoot,catalogPath,credentialsPath}}
}
test('public metadata has no configured infrastructure or credential; all six reviewed servers are enabled and project scope stays metadata',()=>{
 const catalog=createPublicMcpCatalog({gatewayBaseUrl:'https://gateway.example.invalid:10000',kgBaseUrl:'https://knowledge.example.invalid:8443'})
 assert.equal(catalog.servers.length,6);assert.ok(catalog.servers.every(row=>row.enabled===true&&row.transport==='streamable-http'&&row.credentialRef==='tail-shared-bearer'));assert.equal(catalog.servers.at(-1).scope,'knowledge-leasing-project');assert.ok(!JSON.stringify(catalog).includes('Authorization'))
 assert.throws(()=>createPublicMcpCatalog({gatewayBaseUrl:'https://user:secret@gateway.example.invalid',kgBaseUrl:'https://knowledge.example.invalid'}),/ENDPOINT_INVALID/)
 const tampered=structuredClone(catalog);tampered.servers[0].url='https://other.example.invalid:10000/syntaxcheck/mcp';assert.throws(()=>validateMcpCatalog(tampered),/CATALOG_INVALID/)
})
test('actual manager file merge preserves unrelated configuration, writes credentials privately, is idempotent and rolls back exact BOM/CRLF bytes',async t=>{
 const f=await fixture(t),plan=await configureMcp(f.options)
 assert.equal(plan.status,'ready');assert.equal(plan.actions.filter(row=>row.action==='add').length,6);assert.equal(plan.resultingServers,7);assert.ok(!JSON.stringify(plan).includes(fixtureKey));assert.deepEqual(await readFile(f.target),f.before)
 const applied=await configureMcp({...f.options,dryRun:false,expectedPlanDigest:plan.planDigest}),actual=JSON.parse(await readFile(f.target,'utf8'))
 assert.equal(applied.status,'applied');assert.deepEqual(actual.servers[0],f.original.servers[0]);assert.equal(actual.token,f.original.token);assert.deepEqual(actual.unrelated,f.original.unrelated)
 for(const row of actual.servers.slice(1)){assert.equal(row.headers.Authorization,'Bearer '+fixtureKey);assert.equal(row.enabled,true);assert.equal(row.transport,'streamable-http');assert.equal(row.scope,undefined)}
 const receipt=JSON.parse(await readFile(applied.receiptPath,'utf8'));assert.ok(!JSON.stringify(receipt).includes(fixtureKey));assert.ok(!JSON.stringify(receipt).includes(f.original.token));assert.deepEqual(await readFile(receipt.beforePath),f.before)
 const repeat=await planMcpConfiguration(f.options);assert.ok(repeat.actions.every(row=>row.action==='unchanged'));const beforeDirectories=await readdir(f.backupRoot);assert.equal((await applyMcpConfiguration({...f.options,expectedPlanDigest:repeat.planDigest})).status,'unchanged');assert.deepEqual(await readdir(f.backupRoot),beforeDirectories)
 assert.equal((await rollbackMcpConfiguration({receiptPath:applied.receiptPath})).status,'rolled-back');assert.deepEqual(await readFile(f.target),f.before)
})
test('fresh manager provisioning and rollback add and remove only their exact owned file',async t=>{
 const f=await fixture(t,{existing:false}),plan=await planMcpConfiguration(f.options),result=await applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest})
 assert.equal(JSON.parse(await readFile(f.target,'utf8')).servers.length,6);await rollbackMcpConfiguration({receiptPath:result.receiptPath});await assert.rejects(readFile(f.target),error=>error.code==='ENOENT')
})
test('same-name conflict, stale config and changed private provisioning reject without overwriting existing bytes',async t=>{
 const conflict=await fixture(t);await writeFile(conflict.target,JSON.stringify({...conflict.original,servers:[...conflict.original.servers,{serverName:conflict.catalog.servers[0].serverName,transport:'streamable-http',url:'https://user-owned.example.invalid/mcp',enabled:false}]}));const original=await readFile(conflict.target),blocked=await planMcpConfiguration(conflict.options);assert.equal(blocked.status,'blocked');await assert.rejects(applyMcpConfiguration({...conflict.options,expectedPlanDigest:blocked.planDigest}),/DEPLOY_MCP_CONFLICT/);assert.deepEqual(await readFile(conflict.target),original)
 for(const changed of ['configuration','credentials','catalog']){
  const f=await fixture(t),plan=await planMcpConfiguration(f.options)
  if(changed==='configuration')await writeFile(f.target,JSON.stringify({...f.original,userChange:'keep'}))
  if(changed==='credentials')await writeFile(f.credentialsPath,JSON.stringify({schemaVersion:1,credentials:{'tail-shared-bearer':'different-fixture-key-12345'}}))
  if(changed==='catalog')await writeFile(f.catalogPath,JSON.stringify({...f.catalog,servers:[...f.catalog.servers].reverse()}))
  const before=await readFile(f.target);await assert.rejects(applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest}),/DEPLOY_MCP_PLAN_CHANGED/);assert.deepEqual(await readFile(f.target),before)
 }
})
test('rollback refuses edited config and corrupt backups; hardlinks fail closed before provisioning',async t=>{
 const f=await fixture(t),plan=await planMcpConfiguration(f.options),applied=await applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest}),installed=await readFile(f.target)
 await writeFile(f.target,JSON.stringify({version:1,servers:[],userEdit:true}));await assert.rejects(rollbackMcpConfiguration({receiptPath:applied.receiptPath}),/ROLLBACK_CONFLICT/)
 await writeFile(f.target,installed);const receipt=JSON.parse(await readFile(applied.receiptPath,'utf8'));await writeFile(receipt.beforePath,'{}');await assert.rejects(rollbackMcpConfiguration({receiptPath:applied.receiptPath}),/BACKUP_CHANGED/);assert.deepEqual(await readFile(f.target),installed)
 const linked=await fixture(t);await link(linked.credentialsPath,join(linked.root,'credential-alias'));await assert.rejects(planMcpConfiguration(linked.options),/PATH_REJECTED/);assert.deepEqual(await readFile(linked.target),linked.before)
})
test('a revoked installer lease blocks writes and does not connect MCP endpoints',async t=>{
 const f=await fixture(t),plan=await planMcpConfiguration(f.options);let calls=0
 await assert.rejects(applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest,verify:async()=>{calls++;throw Error('FIXTURE_REVOKED')}}),/FIXTURE_REVOKED/)
 assert.equal(calls,1);assert.deepEqual(await readFile(f.target),f.before)
})
test('late lease failure retains a prepared receipt that can recover only exact applied bytes',async t=>{
 const f=await fixture(t),plan=await planMcpConfiguration(f.options);let receiptPath
 await assert.rejects(applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest,verify:async()=>{const current=JSON.parse((await readFile(f.target,'utf8')).replace(/^\uFEFF/u,''));if(current.servers.length===7)throw Error('FIXTURE_LATE_REVOKED')}}),error=>{receiptPath=error.receiptPath;return error.message==='FIXTURE_LATE_REVOKED'&&!!receiptPath})
 assert.equal(JSON.parse(await readFile(receiptPath,'utf8')).status,'prepared');assert.equal((await rollbackMcpConfiguration({receiptPath})).status,'rolled-back');assert.deepEqual(await readFile(f.target),f.before)
})
test('installed credentials and original-config backups have private ACL or POSIX mode',async t=>{
 const f=await fixture(t),plan=await planMcpConfiguration(f.options),result=await applyMcpConfiguration({...f.options,expectedPlanDigest:plan.planDigest}),receipt=JSON.parse(await readFile(result.receiptPath,'utf8'))
 for(const path of [f.target,receipt.beforePath,result.receiptPath]){
  if(process.platform==='win32'){const acl=execFileSync('icacls.exe',[path],{encoding:'utf8',windowsHide:true});assert.ok(!acl.includes('(I)'));assert.equal((acl.match(/:\(F\)/gu)??[]).length,2)}
  else assert.equal((await lstat(path)).mode&0o777,0o600)
 }
})
