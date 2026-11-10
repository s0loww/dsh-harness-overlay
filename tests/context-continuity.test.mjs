import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {renderPacket,createContinuityState,safeRelative,safeSourceText} from '../src/context-continuity/lib/core.js'
const canonical=new URL('../../project_rules/core/tools/continuity/',import.meta.url)
const contract=JSON.parse(readFileSync(new URL('contract.json',canonical)))
const fixtures=JSON.parse(readFileSync(new URL('fixtures.json',canonical)))
for(const row of fixtures.cases)test(`canonical oracle: ${row.id}`,()=>{
 const got=renderPacket(contract,row.input);assert.equal(got.deliver,row.expected.deliver)
 for(const value of row.expected.includes)assert.ok(got.text.includes(value),value)
 for(const value of row.expected.excludes)assert.ok(!got.text.includes(value),value)
 assert.ok(Buffer.byteLength(got.text)<=row.expected.maxBytes)
})
test('UTF8 budget includes all metadata and escaped source text',()=>{
 for(const mode of ['minimal','balanced','expanded']){
 const got=renderPacket(contract,{mode,scope:{projectKey:'я'.repeat(5000),sessionId:'я'.repeat(5000)},compact:{complete:true,id:'я'.repeat(5000)},refs:Array.from({length:50},()=>({path:'я'.repeat(5000)})),files:[{path:'a',critical:true,lost:true,allowed:true,text:'я'.repeat(1024)}]})
 assert.ok(got.bytes<=contract.budgets[mode]);assert.equal(got.bytes,Buffer.byteLength(got.text))
 }
})
test('exact lifecycle, failed/new generation, single delivery and isolated scope',()=>{
 const c=createContinuityState(contract),s={projectKey:'p',sessionId:'s',origin:'lead'}
 c.observe(s,{kind:'file',path:'a',callId:'r',version:'v1'})
 c.start(s,{id:'c',sourceSeq:2,retainedCallIds:new Set(['r'])})
 c.end(s,{id:'wrong',sourceSeq:3});assert.equal(c.ensure(s).pending,null)
 c.end(s,{id:'c',sourceSeq:4});let p=c.ensure(s).pending;assert.equal(p.reads.length,1)
 assert.ok(c.delivered(s,p));assert.equal(c.delivered(s,p),false)
 c.start(s,{id:'c',sourceSeq:5});assert.equal(c.ensure(s).pending,null)
 c.start(s,{id:'d',sourceSeq:6});c.end(s,{id:'d',sourceSeq:7,failed:true});assert.equal(c.ensure(s).pending,null)
 c.start(s,{id:'e',sourceSeq:8});c.end(s,{id:'e',sourceSeq:9});assert.ok(c.ensure(s).pending)
 assert.equal(c.ensure({...s,origin:'subagent'}).pending,null)
})
test('private bodies and secret-like text are excluded',()=>{
 const root=process.cwd()
 for(const name of ['../outside','.env','.env.local','foo/token.key','.claude/settings.json','.git/config','home/auth.json'])assert.equal(safeRelative(root,name),null,name)
 assert.equal(safeSourceText('password=do-not-copy',2048),false)
 assert.equal(safeSourceText('ordinary source',2048),true)
})
