import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createMemoryRouter, createRoutingJournal } from '../src/memory-workspace/lib/router.js'

function fixture({ mode='both', writeTarget='both', failRead, failWrite, preflightFailure, lateRevocation=false }={}) {
  let revision='policy-one', revoked=false
  const events=[], receipts=new Map(), scope={dataset:'airules-synthetic',root:resolve('var/memory-router-fixture')}, execution={agent:{},token:Symbol('native-root'),callId:'root-call'}
  const policy={mode,writeTarget,memoria:{namespace:'project-namespace',remember:{tool:'mcp__fixture_memory__save',scopeArgument:'namespace',textArgument:'text'}}}
  const journal={async claim(id){events.push('claim:'+id);if(receipts.has(id))return{claimed:false,...receipts.get(id)};receipts.set(id,{state:'outcome-unknown'});return{claimed:true,state:'outcome-unknown'}},async settle(id,result){events.push('settle:'+id);receipts.set(id,{state:'stored',result:structuredClone(result)})}}
  const invoke=backend=>async(input)=>{
    events.push('send:'+backend)
    if(input.action==='remember') {
      assert.equal(typeof input.operationId,'string','typed backend needs durable operation correlation')
      if(lateRevocation)revoked=true
      return failWrite===backend?{state:'outcome-unknown'}:{state:'stored',recordId:backend+'-record',namespace:'project-namespace'}
    }
    if(failRead===backend)throw Error('BACKEND_OFFLINE')
    return{results:[{text:backend+' fact',score:backend==='cognee'?.99:87,source:{recordId:backend+'-record'}}]}
  }
  const options={policyFor:async()=>({effective:structuredClone(policy),revision}),verify:async()=>{if(revoked)throw Error('MEMORY_SCOPE_CHANGED')},preflight:async backend=>{events.push('preflight:'+backend);if(preflightFailure===backend)throw Error('BACKEND_NOT_CONFIGURED');return backend+'-endpoint-one'},cognee:invoke('cognee'),memoria:invoke('memoria'),approve:async()=>{events.push('approval')},journal}
  return{events,receipts,scope,execution,policy,options,router:createMemoryRouter(options),setRevision(value){revision=value},setRevoked(value){revoked=value}}
}
const remember={action:'remember',text:'Verified source fixture',title:'Fixture',confirm:true}

test('both retrieval retains per-source scores/evidence and reports an unavailable peer without write fallback',async()=>{
  const f=fixture({failRead:'memoria'}),out=await f.router.act({action:'recall',query:'fixture',topK:2},f.execution,f.scope)
  assert.equal(out.status,'partial');assert.equal(out.backends.memoria.status,'unavailable');assert.equal(out.backends.memoria.error,'BACKEND_OFFLINE')
  assert.equal(out.results.length,1);assert.equal(out.results[0].backend,'cognee');assert.equal(out.results[0].score,.99)
  assert.equal(out.results[0].source.recordId,'cognee-record');assert.ok(!f.events.includes('approval'));assert.equal(f.receipts.size,0)
})

test('both writes preflight all targets before approval/send, then retain separate operation-bound receipts',async()=>{
  const f=fixture(),out=await f.router.act(remember,f.execution,f.scope)
  assert.equal(out.status,'complete');assert.deepEqual(f.events.slice(0,3),['preflight:memoria','preflight:cognee','approval'])
  assert.equal(out.backends.memoria.result.recordId,'memoria-record');assert.equal(out.backends.cognee.result.recordId,'cognee-record')
  assert.notEqual(out.backends.memoria.result.operationId,out.backends.cognee.result.operationId);assert.equal(f.receipts.size,2)
  assert.ok(f.events.indexOf('send:memoria')<f.events.indexOf('send:cognee'))
})

test('unknown first write is durable and stops the second destination and every blind retry',async()=>{
  const f=fixture({failWrite:'memoria'}),first=await f.router.act(remember,f.execution,f.scope)
  assert.equal(first.status,'partial');assert.equal(first.backends.memoria.result.state,'outcome-unknown');assert.equal(first.backends.cognee.status,'not-attempted')
  await f.router.act(remember,f.execution,f.scope)
  assert.equal(f.events.filter(x=>x==='send:memoria').length,1);assert.equal(f.events.includes('send:cognee'),false)
})

test('a second-target unknown result does not repeat the successful first target',async()=>{
  const f=fixture({failWrite:'cognee'})
  await f.router.act(remember,f.execution,f.scope)
  const second=await f.router.act(remember,f.execution,f.scope)
  assert.equal(second.backends.memoria.result.repeated,true);assert.equal(second.backends.memoria.result.recordId,'memoria-record')
  assert.equal(f.events.filter(x=>x==='send:memoria').length,1);assert.equal(f.events.filter(x=>x==='send:cognee').length,1)
})

test('a different backend destination cannot replay an old success for the same content and project namespace',async()=>{
  const f=fixture({mode:'memoria',writeTarget:'auto'}),first=await f.router.act(remember,f.execution,f.scope)
  f.options.preflight=async()=> 'a-new-explicit-memory-server';f.router=createMemoryRouter(f.options)
  const second=await f.router.act(remember,f.execution,f.scope)
  assert.notEqual(first.operationId,second.operationId);assert.equal(f.events.filter(x=>x==='send:memoria').length,2)
})

test('changing a destination while approval is pending never sends under an obsolete destination receipt',async()=>{
  const f=fixture({mode:'memoria',writeTarget:'auto'});let destination='endpoint-one'
  f.options.preflight=async()=>destination
  f.options.approve=async()=>{destination='endpoint-two'}
  const router=createMemoryRouter(f.options)
  let out,error
  try { out=await router.act(remember,f.execution,f.scope) } catch(reason){error=reason}
  if(error)assert.match(error.message,/MEMORY_(?:DESTINATION|CONFIG|POLICY)_/)
  else {assert.notEqual(out.state,'stored');assert.notEqual(out.state,'uploaded')}
  assert.equal(f.events.some(row=>row.startsWith('send:')),false)
})

test('preflight failure, stale policy or missing native token refuses before any journal claim or backend call',async()=>{
  const f=fixture({preflightFailure:'cognee'})
  await assert.rejects(f.router.act(remember,f.execution,f.scope),/BACKEND_NOT_CONFIGURED/)
  assert.deepEqual(f.events,['preflight:memoria','preflight:cognee']);assert.equal(f.receipts.size,0)
  const g=fixture();g.options.approve=async()=>{g.setRevision('policy-two')};g.router=createMemoryRouter(g.options)
  await assert.rejects(g.router.act(remember,g.execution,g.scope),/MEMORY_POLICY_STALE/);assert.equal(g.receipts.size,0)
  const h=fixture()
  await assert.rejects(h.router.act(remember,{agent:{},callId:'forged-without-token'},h.scope),/MEMORY_NATIVE_EXECUTION_REQUIRED/)
  assert.equal(h.events.length,0)
})

test('scope revocation after a backend send remains unknown and stops subsequent targets',async()=>{
  const f=fixture({lateRevocation:true}),out=await f.router.act(remember,f.execution,f.scope)
  assert.equal(out.backends.memoria.result.state,'outcome-unknown');assert.equal(out.backends.cognee.status,'not-attempted')
  assert.equal([...f.receipts.values()][0].state,'outcome-unknown');assert.equal(f.events.includes('send:cognee'),false)
})

test('persistent journal keeps scoped record IDs and contains no note bodies; restart prevents duplicate sends',async t=>{
  const root=await mkdtemp(join(tmpdir(),'airules-routing-journal-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-routing-journal-'));await rm(root,{recursive:true,force:true})})
  const path=join(root,'receipts.json'),id='a'.repeat(64),journal=createRoutingJournal(path)
  assert.equal((await journal.claim(id)).claimed,true)
  await journal.settle(id,{backend:'memoria',state:'stored',operationId:id,recordId:'scoped-note',namespace:'project',text:'must-not-persist'})
  const restored=await createRoutingJournal(path).claim(id)
  assert.equal(restored.claimed,false);assert.equal(restored.result.recordId,'scoped-note');assert.equal((await readFile(path,'utf8')).includes('must-not-persist'),false)
})

test('journal rejects invalid identifiers and corrupted stored success evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'airules-routing-corrupt-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-routing-corrupt-'));await rm(root,{recursive:true,force:true})})
  const path=join(root,'receipts.json'),id='b'.repeat(64)
  await assert.rejects(createRoutingJournal(path).claim('not-a-sha256'),/MEMORY_ROUTING_/)
  await writeFile(path,JSON.stringify({schemaVersion:1,entries:{[id]:{state:'stored'}}}))
  await assert.rejects(createRoutingJournal(path).claim(id),/MEMORY_ROUTING_/)
})
test('trusted pre-dispatch guards release only this newly claimed unsent operation; timeout after dispatch stays unknown',async t=>{
  const root=await mkdtemp(join(tmpdir(),'airules-routing-dispatch-'));t.after(()=>rm(root,{recursive:true,force:true}))
  for(const dispatched of [false,true]){
    const f=fixture({mode:'cognee',writeTarget:'auto'}),path=join(root,`${dispatched}.json`)
    f.options.journal=createRoutingJournal(path);f.options.dispatchAware=true
    f.options.cognee=async(_input,_execution,_scope,_policy,mark)=>{if(dispatched)mark();throw Error(dispatched?'BACKEND_TIMEOUT':'MEMORY_SCOPE_CHANGED')}
    const result=await createMemoryRouter(f.options).act(remember,f.execution,f.scope)
    assert.equal(result.state,dispatched?'outcome-unknown':'not-attempted')
    assert.equal(result.retrySafe,dispatched?undefined:true)
    const state=JSON.parse(await readFile(path,'utf8'))
    assert.equal(Object.keys(state.entries).length,dispatched?1:0)
  }
})
