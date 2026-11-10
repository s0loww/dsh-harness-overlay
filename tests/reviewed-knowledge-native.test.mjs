import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNativeKnowledge } from '../src/reviewed-knowledge/lib/native.js'
import { datasetForRoot } from '../src/memory-workspace/lib/core.js'
import { createMemoryRouter } from '../src/memory-workspace/lib/router.js'

const time = '2026-11-11T10:00:00.000Z'
const proposal = { kind: 'fact', title: 'Fixture fact', statement: 'Native fixture behavior is verified.', appliesTo: { scope: 'isolated fixture v1', version: '1' }, evidence: [{ kind: 'test', ref: 'tests/reviewed-knowledge-native.test.mjs', observedAt: time }] }
const reviewArgs = record => ({ action: 'review', id: record.id, expectedRevision: record.revision, findings: 'Checked native fixture.', evidenceVerified: true, applicabilityVerified: true, secretsChecked: true })

for (const [label, location] of [['rc5', 'var/asar-extract-rc5/dsh/node_modules'], ['022', 'var/host-upgrade/rc022/asar/dsh/node_modules']]) test(`real ${label}: mounted native tools require genuine revision-bound user checkpoint; preview only`, async t => {
  const sdk = resolve(location), native = name => import(pathToFileURL(join(sdk, '@deepseek-ai', name, 'lib/index.js')))
  const { Context } = await native('cordis'), { Session } = await native('dsh-session'), { createUserMessage } = await native('dsh-llm'), { SessionQueryEngine } = await native('dsh-session-query'), { default: ToolsService } = await native('dsh-tools')
  const workspace = resolve('var/knowledge-fixture'), session = Session.create(`knowledge-${label}`, undefined, { version: 4, id: `knowledge-${label}`, createdAt: Date.now(), isSeeded: false, cwd: workspace })
  const appendUser = (text, source = { kind: 'user' }, options = { surfaceOp: 'append' }) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), options)
  appendUser('Review this synthetic fixture fact.')
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  ctx.provide('sessions', { get: id => id === session.id ? session : undefined, list: () => [session] })
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const query = new SessionQueryEngine(ctx), tools = new ToolsService(ctx)
  const agent = { id: session.id, session, ctx }, agents = new Map([[session.id, agent]])
  let policy = { mode: 'workspace-write', sessionId: session.id, workspaceRoot: workspace }
  ctx.provide('agents', agents); ctx.provide('agentPresets', { composedPreset: () => '1c-airules' }); ctx.provide('sandboxPolicy', { resolve: () => policy })
  const memoryCalls = []
  ctx.provide('airulesMemory', { configuration: async input => { assert.equal(input.sessionId,session.id);return { config: { enabled: true }, revision: 'fixture-memory-revision' } }, act: async (args, exec) => { memoryCalls.push({ args, exec }); return { state: 'uploaded', indexed: false, needsProcessing: true, dataset: datasetForRoot(workspace), contentHash: 'd'.repeat(64) } } })
  const root = await mkdtemp(join(tmpdir(), 'airules-knowledge-native-'))
  t.after(async () => { const rel = relative(resolve(tmpdir()), root); assert.ok(!isAbsolute(rel) && rel.startsWith('airules-knowledge-native-')); await rm(root, { recursive: true, force: true }) })
  await cp('src/reviewed-knowledge/lib', join(root, 'lib'), { recursive: true }); await writeFile(join(root, 'package.json'), '{"type":"module"}'); await symlink(sdk, join(root, 'node_modules'), 'junction')
  const host = await import(pathToFileURL(join(root, 'lib/index.js'))), scoped = await import(pathToFileURL(join(root, 'lib/agent.js')))
  const hostFiber = ctx.plugin({ ...host }); await hostFiber.await(); assert.equal(hostFiber.state, 2)
  const agentFiber = ctx.plugin({ ...scoped }); await agentFiber.await(); assert.equal(agentFiber.state, 2)
  assert.ok(tools.view().visible.has('airules_knowledge'))
  // Use the mounted host service, including its declared injected dependencies.
  const service = ctx.get('airulesKnowledge'), exec = { agent, token: Symbol('native-fixture'), callId:'knowledge-fixture', signal: new AbortController().signal }
  const draft = (await service.act({ action: 'create', proposal }, exec)).record
  assert.equal(draft.content.appliesTo.project, workspace)
  const reviewed = await service.act(reviewArgs(draft), exec), record = reviewed.record
  const approve = { action: 'approve', id: record.id, expectedRevision: record.revision }
  await assert.rejects(service.act(approve, exec), /USER_CHECKPOINT_REQUIRED/)
  await assert.rejects(service.act({ ...approve, userText: reviewed.approvalRequest }, exec), /ARGUMENTS_INVALID/)
  appendUser(reviewed.approvalRequest, { kind: 'airules-continuity' })
  await assert.rejects(service.act(approve, exec), /USER_CHECKPOINT_REQUIRED/)
  appendUser(reviewed.approvalRequest, { kind: 'user', form: 'recall' })
  await assert.rejects(service.act(approve, exec), /USER_CHECKPOINT_REQUIRED/)
  appendUser(reviewed.approvalRequest, { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })
  await assert.rejects(service.act(approve, exec), /USER_CHECKPOINT_REQUIRED/)
  appendUser(reviewed.approvalRequest)
  const accepted = await service.act(approve, exec)
  assert.equal(accepted.record.state, 'approved'); assert.equal(session.eventAt(accepted.approvalEvidence.eventSeq).data.content[0].text, reviewed.approvalRequest)
  const plan = await service.act({ action: 'plan', id: record.id, expectedRevision: accepted.record.revision, destination: 'cognee' }, exec)
  assert.equal(plan.previewOnly, true); assert.equal(plan.applied, false); assert.equal(plan.durableWriteAvailable, true)
  assert.equal(memoryCalls.length, 0)
  const publishArgs = { action: 'publish', id: record.id, expectedRevision: accepted.record.revision, destination: 'cognee', expectedMemoryRevision: plan.memoryConfigRevision }
  await assert.rejects(service.act({ ...publishArgs, expectedMemoryRevision: 'old-config' }, exec), /MEMORY_REVISION_CHANGED/)
  await assert.rejects(service.act({ ...publishArgs, destination: 'memoria' }, exec), /MEMORIA_UNAVAILABLE/)
  const publication = await service.act(publishArgs, exec)
  assert.equal(publication.publication.state, 'uploaded'); assert.equal(publication.publication.indexed, false)
  assert.equal(memoryCalls.length, 1); assert.equal(memoryCalls[0].args.expectedRevision, plan.memoryConfigRevision)
  assert.equal(memoryCalls[0].args.backend,'cognee')
  assert.equal(memoryCalls[0].args.sessionId, session.id); assert.equal(memoryCalls[0].exec, exec)
  assert.ok(memoryCalls[0].args.text.includes(proposal.statement)); assert.ok(memoryCalls[0].args.text.includes(proposal.evidence[0].ref))
  assert.equal((await service.act(publishArgs, exec)).repeated, true); assert.equal(memoryCalls.length, 1)
  await assert.rejects(service.act(approve, exec), /REVISION_CHANGED/)
  policy = { ...policy, mode: 'read-only' }
  assert.equal((await service.act({ action: 'read', id: record.id }, exec)).record.state, 'approved')
  await assert.rejects(service.act({ action: 'stale', id: record.id, expectedRevision: accepted.record.revision, why: 'v2' }, exec), /LEAD_WRITER/)
  policy = { ...policy, mode: 'workspace-write' }
  const stale = await service.act({ action: 'stale', id: record.id, expectedRevision: accepted.record.revision, why: 'Version changed.' }, exec)
  assert.equal(stale.record.state, 'stale')
  await assert.rejects(service.act({ action: 'plan', id: record.id, expectedRevision: stale.record.revision, destination: 'cognee' }, exec), /APPROVAL_REQUIRED/)
  agents.delete(session.id)
  await assert.rejects(service.act({ action: 'list' }, exec), /NATIVE_SCOPE_REQUIRED/)
})

test('native scope cannot be model supplied; subagents and foreign policies cannot approve', async () => {
  const session = { id: 'subagent', header: { id: 'subagent', cwd: resolve('var/knowledge-fixture'), origin: 'subagent' } }, agent = { session, ctx: {} }
  const policy = { mode: 'workspace-write', sessionId: session.id, workspaceRoot: session.header.cwd }
  const ctx = { agents: new Map([[session.id, agent]]), agentPresets: { composedPreset: () => '1c-airules' }, sandboxPolicy: { resolve: () => policy } }
  const service = createNativeKnowledge(ctx, { now: () => time }), exec = { agent }
  const draft = (await service.act({ action: 'create', proposal }, exec)).record
  await assert.rejects(service.act(reviewArgs(draft), exec), /LEAD_WRITER/)
  await assert.rejects(service.act({ action: 'create', proposal: { ...proposal, appliesTo: { ...proposal.appliesTo, project: 'foreign' } } }, exec), /ARGUMENTS_INVALID/)
  policy.workspaceRoot = resolve('var/foreign')
  await assert.rejects(service.act({ action: 'list' }, exec), /NATIVE_POLICY_REQUIRED/)
})

async function publicationFixture(memoryAct,{kind='fact'}={}) {
  const root = resolve('var/knowledge-publication-fixture'), session = { id: 'knowledge-publication', header: { id: 'knowledge-publication', cwd: root } }, agent = { session, ctx: {} }
  const events = [{ seq: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Review synthetic fact.' }] } }]
  Object.defineProperty(session, 'seq', { get: () => events.length })
  const ctx = { agents: new Map([[session.id, agent]]), agentPresets: { composedPreset: () => '1c-airules' }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', sessionId: session.id, workspaceRoot: root }) },
    sessionQuery: { observeSession: async () => ({ events, inheritedEventCount: 0, [Symbol.dispose]() {} }) },
    airulesMemory: { configuration: async () => ({ config: { enabled: true }, revision: 'revision-a' }), act: memoryAct } }
  const service = createNativeKnowledge(ctx, { now: () => time }), exec = { agent, token:Symbol('native-fixture'),callId:'knowledge-fixture' }
  const draft = (await service.act({ action: 'create', proposal:{...proposal,kind} }, exec)).record, review = await service.act(reviewArgs(draft), exec)
  events.push({ seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: review.approvalRequest }] } })
  const record = (await service.act({ action: 'approve', id: draft.id, expectedRevision: review.record.revision }, exec)).record
  return { service, exec, ctx, events, args: { action: 'publish', id: record.id, expectedRevision: record.revision, destination: 'cognee', expectedMemoryRevision: 'revision-a' } }
}

test('post-upload scope/config/auth failures remain unknown and are never blindly redispatched', async () => {
  for (const code of ['MEMORY_SCOPE_CHANGED', 'MEMORY_CONFIG_STALE', 'MEMORY_AUTH_INVALID', 'MEMORY_WRITE_REQUIRED']) {
    let writes = 0
    const f = await publicationFixture(async () => { writes++; throw new Error(code) })
    assert.equal((await f.service.act(f.args, f.exec)).publication.state, 'outcome-unknown')
    assert.equal((await f.service.act(f.args, f.exec)).repeated, true)
    assert.equal(writes, 1)
  }
})

test('definite native approval refusal permits a fresh approved dispatch; durable bytes survive recreation', async () => {
  let attempts = 0
  const texts = [], titles = []
  const memoryAct = async (args, exec) => {
    attempts++; if (attempts === 1) throw new Error('MEMORY_APPROVAL_REQUIRED')
    texts.push(args.text); titles.push(args.title)
    return { state: 'uploaded', indexed: false, dataset: datasetForRoot(exec.agent.session.header.cwd), contentHash: 'c'.repeat(64) }
  }
  const first = await publicationFixture(memoryAct)
  await assert.rejects(first.service.act(first.args, first.exec), /MEMORY_APPROVAL_REQUIRED/)
  assert.equal((await first.service.act(first.args, first.exec)).publication.state, 'uploaded')
  const recreated = await publicationFixture(memoryAct)
  assert.equal((await recreated.service.act(recreated.args, recreated.exec)).publication.state, 'uploaded')
  assert.equal(attempts, 3); assert.equal(texts[0], texts[1]); assert.equal(titles[0], titles[1])
})

test('successful memory receipt after own native scope revocation or cancellation remains unknown', async () => {
  for (const changed of ['registry', 'policy', 'signal']) {
    const abort = new AbortController(), f = await publicationFixture(async () => { throw new Error('unreplaced fixture') })
    f.exec.signal = abort.signal
    f.ctx.airulesMemory.act = async () => {
      if (changed === 'registry') f.ctx.agents.delete(f.exec.agent.session.id)
      if (changed === 'policy') f.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', sessionId: f.exec.agent.session.id, workspaceRoot: f.exec.agent.session.header.cwd })
      if (changed === 'signal') abort.abort()
      return { state: 'uploaded', indexed: false, dataset: datasetForRoot(f.exec.agent.session.header.cwd), contentHash: 'c'.repeat(64) }
    }
    assert.equal((await f.service.act(f.args, f.exec)).publication.state, 'outcome-unknown')
  }
})

test('new user event after pinned approval observation prevents approving stale consent', async () => {
  const f = await publicationFixture(async () => { throw new Error('must not publish') })
  const draft = (await f.service.act({ action: 'create', proposal: { ...proposal, statement: 'A distinct second synthetic lesson.' } }, f.exec)).record
  const review = await f.service.act(reviewArgs(draft), f.exec)
  f.events.push({ seq: f.events.length, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: review.approvalRequest }] } })
  const priorObserve = f.ctx.sessionQuery.observeSession
  f.ctx.sessionQuery.observeSession = async () => {
    const pinned = structuredClone(f.events)
    return { events: pinned, inheritedEventCount: 0, [Symbol.dispose]() { f.events.push({ seq: f.events.length, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Stop; this approval is withdrawn.' }] } }) } }
  }
  await assert.rejects(f.service.act({ action: 'approve', id: draft.id, expectedRevision: review.record.revision }, f.exec), /USER_CHECKPOINT_CHANGED/)
  f.ctx.sessionQuery.observeSession = priorObserve
  assert.equal((await f.service.act({ action: 'read', id: draft.id }, f.exec)).record.state, 'review')
  await assert.rejects(f.service.act({ action: 'approve', id: draft.id, expectedRevision: review.record.revision }, f.exec), /USER_CHECKPOINT_REQUIRED/)
})

async function routedPublicationFixture({mode='both',kind='fact',memoriaReady=true,cogneeEnabled=true,receipt,approve}={}){
  const f=await publicationFixture(async()=>{throw Error('unreplaced fixture')},{kind}),scope={agent:f.exec.agent,dataset:datasetForRoot(f.exec.agent.session.header.cwd)},calls=[],receipts=new Map()
  let revision='policy-a',policy={mode,writeTarget:'auto',memoria:{namespace:'fixture-project',remember:{tool:'mcp__fixture__remember',scopeArgument:'project',textArgument:'text'}}},approvals=0
  const journal={async claim(id){if(receipts.has(id))return{claimed:false,...receipts.get(id)};receipts.set(id,{state:'outcome-unknown'});return{claimed:true}},async settle(id,result){receipts.set(id,{state:'stored',result})}}
  const backend=name=>async(input,execution)=>{
    assert.equal(execution,f.exec);calls.push({backend:name,...input})
    if(input.action==='status')return{backend:name,namespace:policy.memoria.namespace,availability:'catalog-only',connected:null,operations:{remember:{available:memoriaReady}}}
    if(receipt)return receipt(name,input)
    return name==='memoria'?{backend:name,state:'stored',recordId:'fixture-note-42',namespace:policy.memoria.namespace,indexed:null}:{backend:name,state:'uploaded',indexed:false,dataset:scope.dataset,contentHash:'a'.repeat(64)}
  }
  const router=createMemoryRouter({policyFor:async()=>({effective:structuredClone(policy),revision}),verify:()=>{if(f.ctx.agents.get(f.exec.agent.session.id)!==f.exec.agent)throw Error('MEMORY_SCOPE_CHANGED')},preflight:async backend=>backend+'-fixture-destination',cognee:backend('cognee'),memoria:backend('memoria'),approve:async()=>{approvals++;await approve?.({changePolicy(value){policy=value;revision='policy-b'}})},journal})
  f.ctx.airulesMemory={async configuration(input){assert.equal(input.sessionId,f.exec.agent.session.id);return{config:{enabled:cogneeEnabled,endpoint:'http://127.0.0.1:8000'},revision:'revision-a',policy:{effective:structuredClone(policy),revision,policyRevision:revision},scope:{projectRoot:f.exec.agent.session.header.cwd}}},act(input,execution){assert.equal(input.sessionId,f.exec.agent.session.id);return router.act(input,execution,scope)}}
  return{...f,calls,receipts,get approvals(){return approvals},changePolicy(value){policy=value;revision='policy-b'},async plan(destination='memoria'){return f.service.act({...f.args,action:'plan',destination},f.exec)},async publish(destination='memoria',extra={}){return f.service.act({...f.args,destination,expectedPolicyRevision:revision,...extra},f.exec)}}
}

test('reviewed publisher uses actual unified router with explicit backend under both/auto and destination-bound receipts',async()=>{
  const f=await routedPublicationFixture(),cogneePlan=await f.plan('cognee');assert.equal(cogneePlan.memoryPolicyRevision,'policy-a')
  const cognee=await f.publish('cognee');assert.equal(cognee.publication.destination,'cognee');assert.equal(cognee.publication.state,'uploaded')
  assert.deepEqual(f.calls.filter(row=>row.action==='remember').map(row=>row.backend),['cognee'],'both/auto must not redirect selected Cognee into Memoria')
  const plan=await f.plan();assert.equal(plan.durableWriteAvailable,true);assert.equal(plan.memoryPolicyRevision,'policy-a')
  const memoria=await f.publish();assert.equal(memoria.publication.destination,'memoria');assert.equal(memoria.publication.state,'stored');assert.equal(memoria.publication.recordId,'fixture-note-42');assert.equal(memoria.publication.namespace,'fixture-project');assert.equal(memoria.publication.indexed,null)
  assert.deepEqual(f.calls.filter(row=>row.action==='remember').map(row=>row.backend),['cognee','memoria'])
  assert.equal((await f.publish()).repeated,true);assert.equal((await f.publish('cognee')).repeated,true);assert.equal(f.calls.filter(row=>row.action==='remember').length,2);assert.equal(f.approvals,2)
  assert.equal(f.calls.find(row=>row.backend==='memoria'&&row.action==='remember').expectedPolicyRevision,'policy-a');assert.equal(f.receipts.size,2)
})

test('publisher honors project memory mode, catalog readiness, policy revision and native execution context',async()=>{
  const disabled=await routedPublicationFixture({mode:'memoria'});await assert.rejects(disabled.plan('cognee'),/MEMORY_BACKEND_DISABLED/);assert.equal(disabled.calls.length,0)
  const unavailable=await routedPublicationFixture({memoriaReady:false});assert.equal((await unavailable.plan()).durableWriteAvailable,false);await assert.rejects(unavailable.publish(),/MEMORIA_UNAVAILABLE/);assert.equal(unavailable.approvals,0)
  const f=await routedPublicationFixture();await f.plan()
  await assert.rejects(f.publish('memoria',{expectedPolicyRevision:'stale'}),/MEMORY_POLICY_REVISION_CHANGED/)
  await assert.rejects(f.service.act({...f.args,destination:'memoria'},f.exec),/MEMORY_POLICY_REVISION_CHANGED/)
  const real=f.exec.token;delete f.exec.token;await assert.rejects(f.publish(),/NATIVE_EXECUTION_REQUIRED/);f.exec.token=real
  f.changePolicy({mode:'both',writeTarget:'auto',memoria:{namespace:'fixture-project',remember:{tool:'mcp__fixture__remember',scopeArgument:'project',textArgument:'text'}}})
  await assert.rejects(f.publish('memoria',{expectedPolicyRevision:'policy-a'}),/MEMORY_POLICY_REVISION_CHANGED/);assert.equal(f.calls.filter(row=>row.action==='remember').length,0)
})

test('Memoria unknown, foreign or incomplete receipts stay unknown and are never blindly resent',async()=>{
  for(const receipt of [()=>({backend:'memoria',state:'outcome-unknown',namespace:'fixture-project',indexed:false}),()=>({backend:'memoria',state:'stored',recordId:'note',namespace:'foreign',indexed:null}),()=>({backend:'memoria',state:'stored',recordId:null,namespace:'fixture-project',indexed:null}),()=>({backend:'memoria',state:'stored',recordId:'note',namespace:'fixture-project',indexed:true}),()=>{throw Error('MEMORY_AUTH_INVALID')}]){
    const f=await routedPublicationFixture({receipt});assert.equal((await f.publish()).publication.state,'outcome-unknown');assert.equal((await f.publish()).repeated,true);assert.equal(f.calls.filter(row=>row.action==='remember').length,1)
  }
})

test('a policy change during native approval leaves an uncertain claim but no backend dispatch or blind retry',async()=>{
  const f=await routedPublicationFixture({approve:async({changePolicy})=>changePolicy({mode:'both',writeTarget:'auto',memoria:{namespace:'fixture-project',remember:{tool:'mcp__fixture__remember',scopeArgument:'project',textArgument:'text'}}})})
  assert.equal((await f.publish()).publication.state,'outcome-unknown');assert.equal(f.calls.filter(row=>row.action==='remember').length,0)
  assert.equal((await f.publish()).repeated,true);assert.equal(f.approvals,1)
})

test('Memoria remains independent of disabled Cognee and receipt caches bind the configured namespace',async()=>{
  const f=await routedPublicationFixture({mode:'memoria',cogneeEnabled:false});assert.equal((await f.plan()).durableWriteAvailable,true)
  const first=await f.publish();assert.equal(first.publication.state,'stored');assert.equal(first.publication.namespace,'fixture-project')
  f.changePolicy({mode:'memoria',writeTarget:'auto',memoria:{namespace:'fixture-project-v2',remember:{tool:'mcp__fixture__remember',scopeArgument:'project',textArgument:'text'}}})
  const second=await f.publish();assert.equal(second.publication.state,'stored');assert.equal(second.publication.namespace,'fixture-project-v2');assert.notEqual(second.repeated,true);assert.equal(f.calls.filter(row=>row.action==='remember').length,2)
})

test('policy changes after an accepted Memoria send leave the local claim unknown and prevent blind resend',async()=>{
  const f=await routedPublicationFixture(),original=f.ctx.airulesMemory.act
  f.ctx.airulesMemory.act=async(input,execution)=>{const result=await original(input,execution);if(input.action==='remember')f.changePolicy({mode:'both',writeTarget:'auto',memoria:{namespace:'fixture-project',remember:{tool:'mcp__fixture__remember',scopeArgument:'project',textArgument:'text'}}});return result}
  assert.equal((await f.publish()).publication.state,'outcome-unknown');assert.equal((await f.publish()).repeated,true);assert.equal(f.calls.filter(row=>row.action==='remember').length,1)
})

test('procedures and rules retain airules ownership and cannot publish to either memory backend',async()=>{
  for(const kind of ['procedure','rule']){
    const f=await routedPublicationFixture({kind})
    for(const destination of ['memoria','cognee'])await assert.rejects(f.publish(destination),/RULE_OWNER_REQUIRED/)
    const args={...f.args,destination:'airules',targetPath:'core/rules/example.md',expectedTargetRevision:'a'.repeat(64)}
    assert.equal((await f.service.act({...args,action:'plan'},f.exec)).plan.operation,'review-patch')
    await assert.rejects(f.service.act(args,f.exec),/DESTINATION_PREVIEW_ONLY/);assert.equal(f.calls.length,0)
  }
})
