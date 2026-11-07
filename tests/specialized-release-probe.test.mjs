import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises'
import { join,resolve,dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArguments,loopbackHost,seedComparison,persistPreviewFixture,inspectProviderCards,composerProvenanceProof,SPECIALIZED_SKILLS } from '../scripts/probe-specialized-release.mjs'

test('native release probe requires explicit isolated inputs and bounds preview lifetime',()=>{
  const args=['--candidate-root',resolve('candidate'), '--ui-artifact',resolve('ui'), '--policy-artifact',resolve('policy')]
  assert.equal(parseArguments(args).servePreview,false)
  assert.equal(parseArguments([...args,'--serve-preview','--preview-timeout-ms','1000']).previewTimeoutMs,1000)
  for(const input of [[],['--candidate-root','relative'],[...args,'--unknown','x'],[...args,'--preview-timeout-ms','1200001']])assert.throws(()=>parseArguments(input))
  assert.deepEqual(SPECIALIZED_SKILLS,['1c-repository-manage','1c-ai-merge','v8unpack-cf','1c-element'])
})
test('only loopback hostnames qualify for native probe HTTP',()=>{
  for(const value of ['127.0.0.1','localhost','::1','[::1]'])assert.equal(loopbackHost(value),true)
  for(const value of ['api.openai.com','127.0.0.2','0.0.0.0','localhost.example','169.254.169.254'])assert.equal(loopbackHost(value),false)
})
test('local comparison fixtures contain two XML exports and no precreated settings or runner',async()=>{
  const root=await mkdtemp(join(tmpdir(),'release-probe-seed-'))
  try{await seedComparison(root);assert.notEqual(await readFile(join(root,'current/Documents/Probe.xml'),'utf8'),await readFile(join(root,'vendor/Documents/Probe.xml'),'utf8'));await assert.rejects(readFile(join(root,'.dsh/onec-specialized.json')),/ENOENT/);await assert.rejects(readFile(join(root,'tools/onec-specialized/runner.mjs')),/ENOENT/)}finally{await rm(root,{recursive:true,force:true})}
})
test('installed client inspection validates twelve cold cards without mounting provider auth controls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'release-probe-clients-'))
  try{
    for(const name of ['additional-providers','provider-extensions','cursor-provider','providers-settings']){
      const source=resolve('src',name),pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8')),target=join(root,pkg.name),entry=pkg.exports['./client']
      await mkdir(dirname(join(target,entry)),{recursive:true});await writeFile(join(target,'package.json'),JSON.stringify(pkg));await writeFile(join(target,entry),await readFile(join(source,entry)))
    }
    const result=await inspectProviderCards(root)
    assert.equal(result.cards.length,12);assert.equal(result.browserMounted,false);assert.equal(result.metadataOnly,true)
    assert.ok(Object.values(result.components).every(Boolean));assert.ok(result.cards.every(row=>!row.hasKnownCount))
  }finally{await rm(root,{recursive:true,force:true})}
})
test('native release probe uses installed profile and guards model requests without source plugin overlays',async()=>{
  const source=await readFile(new URL('../scripts/probe-specialized-release.mjs',import.meta.url),'utf8')
  assert.match(source,/runProfile\(\{profile:'desktop'/u);assert.doesNotMatch(source,/ctx\.plugin\(/u)
  assert.match(source,/RELEASE_PROBE_MODEL_REQUEST_FORBIDDEN/u);assert.match(source,/RELEASE_PROBE_RUNNER_FORBIDDEN/u)
  assert.match(source,/writeProtectedFile\(privatePreviewPath/u)
  assert.match(source,/welcomeNoticeVersion: 2026-09-28\.1/u)
})
test('preview sidebar fixture uses native session flush and workspace membership without creating a turn',async()=>{
  const calls=[],agent={session:{id:'fixture'}},workspace={id:'workspace-fixture',sessionIds:[],async attachSession(id){calls.push('attach');this.sessionIds.push(id)}}
  const ctx={get:()=>({rename(session,title){assert.equal(session,agent.session);assert.ok(title);calls.push('rename')}}),sessions:{async flush(session){assert.equal(session,agent.session);calls.push('flush')}},workspaceRegistry:{async create(root,title){assert.equal(root,'fixture-root');assert.ok(title);calls.push('workspace');return workspace}},sessionPersistence:{async list(){return[{header:{id:'fixture'}}]}}}
  const result=await persistPreviewFixture(ctx,{root:'fixture-root',agent,id:'fixture'})
  assert.deepEqual(calls,['rename','flush','workspace','attach']);assert.equal(result.persisted,true);assert.equal(result.attached,true)
})
test('composer release proof requires exact reviewed sources and staged projection provenance',()=>{
  const proof={hostVersion:'0.2.1-rc.5',sourceManifestSha256:'4891909f369c769f443c121ec924ef639fef65a1bdfd46ea32854e66f8812fa8',sourceEntrySha256:'71d3da278a8533af60e111e2908bf61203844397f473689cf9c0f6034cbf0703',sourceClientSha256:'84cc4d9d4208e042505317661ed2d233754ad4a11804d1ac8318833a6537c806',stagedManifestSha256:'a'.repeat(64),stagedClientSha256:'b'.repeat(64),contract:'exact-rc5-retained-chat-projection-no-storage-migration'}
  assert.equal(composerProvenanceProof({compatibility:proof}),proof)
  assert.throws(()=>composerProvenanceProof({compatibility:{...proof,sourceClientSha256:'f'.repeat(64)}}))
  assert.throws(()=>composerProvenanceProof({compatibility:{...proof,hostVersion:'0.2.1-rc.6'}}))
  assert.throws(()=>composerProvenanceProof({first:proof,second:proof}))
})
