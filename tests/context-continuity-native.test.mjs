import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createNativeContinuity} from '../src/context-continuity/lib/native.js'
const contract=JSON.parse(readFileSync(new URL('../../project_rules/core/tools/continuity/contract.json',import.meta.url)))
function fixture({read,stat,lstat,mode='balanced'}={}){
 const root=resolve('var/continuity-fixture'),events=new Map([[0,{type:'tool/result',data:{message:{source:{callId:'r'}}}}]])
 const session={id:'s',header:{id:'s',cwd:root},surface:{nodes:[0]},eventAt:n=>events.get(n)}
 let policy={sessionId:'s',workspaceRoot:root,mode:'read-only'},reads=0
 const fs={processPath:t=>t.path,resolve:async p=>({path:resolve(p)}),lstat:async (...a)=>lstat?lstat(...a):({type:'file'}),stat:async (...a)=>stat?stat(...a):({type:'file',version:'v1',size:4}),readBytes:async (...a)=>{reads++;return read?read(...a):Buffer.from('DATA')}}
 const agent={id:'s',session,ctx:{get fs(){throw new Error('CORDIS_UNDECLARED_INJECTION')}}},ctx={agents:new Map([['s',agent]]),agentPresets:{composedPreset:()=> '1c-airules',serviceFor:()=>fs},sandboxPolicy:{resolve:()=>policy},fs}
 const service=createNativeContinuity(ctx,{contract,mode,collectGit:false,criticalFiles:['src/a.txt'],createUserMessage:x=>x})
 service.fsObserved({path:join(root,'src/a.txt')},{kind:'present',version:'v1'},{agent,name:'read',callId:'r'})
 service.toolResult({agent,name:'read',callId:'r',arguments:{file_path:'src/a.txt'}},{value:{path:'src/a.txt'}})
 const event=(type,id,seq)=>service.event(session,{type,data:{compactionId:id},seq})
 event('compaction/start','c',1);session.surface.nodes=[];event('compaction/end','c',2)
 return {service,agent,fs,session,ctx,root,get reads(){return reads},setPolicy:p=>{policy={...policy,...p}}}
}
test('minimal never reads file bodies after compact',async()=>{
 const f=fixture({mode:'minimal'}),out=await f.service.restore(f.agent,undefined,{kind:'enter',messages:[]})
 assert.equal(f.reads,0);assert.equal(out.messages.length,1)
})
test('off blocks checkpoint reads and writes even through explicit tool',async()=>{
 const f=fixture({mode:'off'});let writes=0;f.fs.writeText=async()=>{writes++}
 await f.service.act({action:'checkpoint'},{agent:f.agent})
 assert.equal(f.reads,0);assert.equal(writes,0);assert.equal((await f.service.act({action:'status'},{agent:f.agent})).checkpoint,null)
})
test('symlink component blocks fresh body reads',async()=>{
 const f=fixture({lstat:async p=>({type:p.endsWith('src')?'symlink':'file'})}),out=await f.service.restore(f.agent,undefined,{kind:'enter',messages:[]})
 assert.equal(f.reads,0);assert.ok(!out.messages[0].content[0].text.includes('DATA'))
})
test('native source version race omits file',async()=>{
 let stats=0;const f=fixture({stat:async()=>({type:'file',size:4,version:++stats===1?'v1':'v2'})})
 const out=await f.service.restore(f.agent,undefined,{kind:'enter',messages:[]})
 assert.equal(f.reads,1);assert.ok(!out.messages[0].content[0].text.includes('DATA'))
})
test('native scope or policy change across await prevents delivery',async()=>{
 const f=fixture();f.fs.readBytes=async()=>{f.setPolicy({mode:'workspace-write'});return Buffer.from('DATA')}
 const out=await f.service.restore(f.agent,undefined,{kind:'enter',messages:[]});assert.equal(out.messages.length,0)
})
test('abort and rejected step leave successful compact pending',async()=>{
 const f=fixture(),base={kind:'enter',messages:[]}
 assert.equal((await f.service.restore(f.agent,AbortSignal.abort(),base)).messages.length,0)
 await f.service.restore(f.agent,undefined,{kind:'reject'})
 assert.equal((await f.service.restore(f.agent,undefined,base)).messages.length,1)
})
test('returned candidate is not delivered until authoritative native journal receipt',async()=>{
 const f=fixture(),base={kind:'enter',messages:[]}
 const first=await f.service.restore(f.agent,undefined,base)
 assert.equal(first.messages.length,1)
 assert.equal((await f.service.restore(f.agent,AbortSignal.abort(),base)).messages.length,0)
 const retry=await f.service.restore(f.agent,undefined,base);assert.equal(retry.messages.length,1)
 f.service.event(f.session,{type:'user/message',seq:3,data:retry.messages[0]})
 assert.equal((await f.service.restore(f.agent,undefined,base)).messages.length,0)
})
test('FS observation cannot migrate across native roots between observation and result',async()=>{
 const f=fixture();f.service.fsObserved({path:join(f.root,'src/a.txt')},{kind:'present',version:'v1'},{agent:f.agent,name:'read',callId:'other'})
 const foreign=resolve('var/continuity-other-root');f.session.header.cwd=foreign;f.setPolicy({workspaceRoot:foreign})
 f.service.toolResult({agent:f.agent,name:'read',callId:'other',arguments:{file_path:'src/a.txt'}},{value:{path:'src/a.txt'}})
 const result=await f.service.act({action:'status'},{agent:f.agent});assert.equal(result.trackedReads,0)
})
test('subagent cannot receive lead orchestration or map references',async()=>{
 const f=fixture({mode:'minimal'});f.session.header.origin='subagent'
 f.session.surface.nodes=[0]
 f.service.toolResult({agent:f.agent,name:'read',callId:'r',arguments:{file_path:'var/tmp/orchestration.json'}},{value:{path:'var/tmp/orchestration.json'}})
 f.service.event(f.session,{type:'compaction/start',seq:3,data:{compactionId:'child'}});f.session.surface.nodes=[]
 f.service.event(f.session,{type:'compaction/end',seq:4,data:{compactionId:'child'}})
 const out=await f.service.restore(f.agent,undefined,{kind:'enter',messages:[]})
 assert.ok(out.messages[0].content[0].text.includes('Subagent:'));assert.ok(!out.messages[0].content[0].text.includes('var/tmp/orchestration.json'))
})
