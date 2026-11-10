import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoriaAdapter, validateMemoriaBinding } from '../src/memory-workspace/lib/memoria.js'

const namespace = 'project-fixture', agent = { session: { id: 'fixture' } }, parent = Symbol('native parent')
const binding = { namespace, search: { tool: 'mcp__my_memory__search', scopeArgument: 'namespace', queryArgument: 'query' }, remember: { tool: 'mcp__my_memory__save', scopeArgument: 'namespace', textArgument: 'text', titleArgument: 'title' } }
const searchSchema = { type: 'object', properties: { namespace: { type: 'string' }, query: { type: 'string' } }, required: ['namespace', 'query'], additionalProperties: false }
const rememberSchema = { type: 'object', properties: { namespace: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' } }, required: ['namespace', 'text'], additionalProperties: false }
function fixture({ schema = searchSchema, result = { results: [{ id: 'n1', text: '<script>data</script>', namespace }] }, invoke, check = () => {} } = {}) {
  const schemas = new Map([[binding.search.tool, structuredClone(schema)], [binding.remember.tool, structuredClone(rememberSchema)]]), definitions = new Map([...schemas.keys()].map(name => [name, {}])), calls = []
  const ctx = { tools: { get: name => definitions.get(name), schemas: selected => { assert.equal(selected, agent); return [...schemas].map(([name, parameters]) => ({ name, parameters })) } } }
  const execution = { agent, token: parent, callId: 'memory-call', rootCallId: 'native-root', signal: new AbortController().signal }
  const executeTool = async (_ctx, input) => { calls.push(input); return invoke ? invoke(input) : { isError: false, value: result } }
  return { ctx, calls, schemas, definitions, execution, adapter: createMemoriaAdapter(ctx, { binding, execution, verifyScope: check, executeTool }) }
}

test('explicit binding requires declared MCP tools, safe distinct mappings and a namespace',()=>{
  assert.deepEqual(validateMemoriaBinding(binding), binding)
  for (const bad of [{ ...binding, namespace: '' }, { ...binding, endpoint: 'http://foreign' }, { ...binding, search: { ...binding.search, tool: 'shell' } }, { ...binding, search: { ...binding.search, scopeArgument: '__proto__.x' } }, { ...binding, search: { ...binding.search, queryArgument: 'namespace' } }, { ...binding, search: { ...binding.search, queryArgument: 'namespace.x' } }]) assert.throws(()=>validateMemoriaBinding(bad),/MEMORIA_/)
})

test('catalogue is project-agent scoped and makes no connection or network claim',()=>{
  const f=fixture(), status=f.adapter.status()
  assert.equal(status.backend,'memoria');assert.equal(status.namespace,namespace);assert.equal(status.availability,'catalog-only');assert.equal(status.connected,null);assert.equal(f.calls.length,0)
  assert.equal(status.operations.search.available,true)
  f.definitions.delete(binding.search.tool)
  assert.equal(f.adapter.status().operations.search.available,false)
})

test('recall injects namespace and preserves native Agent/parent/root correlation without executing returned content',async()=>{
  const f=fixture(), result=await f.adapter.recall({query:'needle',topK:2}), call=f.calls[0]
  assert.deepEqual(call.arguments,{namespace,query:'needle'});assert.equal(call.agent,agent);assert.equal(call.parent,parent);assert.equal(call.rootCallId,'native-root')
  assert.equal(result.results[0].source.recordId,'n1');assert.equal(result.results[0].text,'<script>data</script>');assert.equal(result.scopeEvidence,'response-and-request-filter')
  assert.equal(call.signal,f.execution.signal)
})

test('explicit dotted scope maps only a declared string-array and rejects missing/unknown required fields',async()=>{
  const schema={type:'object',properties:{filters:{type:'object',properties:{projects:{type:'array',items:{type:'string'}}},required:['projects']},query:{type:'string'}},required:['filters','query']}
  const f=fixture({schema}), dotted={...binding,search:{...binding.search,scopeArgument:'filters.projects'}}
  const adapter=createMemoriaAdapter(f.ctx,{binding:dotted,execution:f.execution,verifyScope(){},executeTool:async(_ctx,input)=>{f.calls.push(input);return{isError:false,value:{results:[]}}}})
  await adapter.recall({query:'needle'});assert.deepEqual(f.calls[0].arguments,{filters:{projects:[namespace]},query:'needle'})
  f.schemas.get(binding.search.tool).required.push('undeclared-required')
  await assert.rejects(adapter.recall({query:'needle'}),/SCHEMA_CHANGED/)
  const missing=fixture({schema:{...searchSchema,required:['namespace','query','other']}})
  await assert.rejects(missing.adapter.recall({query:'needle'}),/REQUIRED_MAPPING_MISSING/);assert.equal(missing.calls.length,0)
  const guessed=fixture({schema:{type:'object',properties:{query:{type:'string'}},additionalProperties:true}})
  await assert.rejects(guessed.adapter.recall({query:'needle'}),/SCHEMA_MAPPING_INVALID/);assert.equal(guessed.calls.length,0)
})

test('foreign namespace in nested or mixed results fails closed; absence is tagged request-filter only',async()=>{
  for(const result of [{namespace:'foreign',results:[]},{results:[{id:'good',text:'ours',namespace},{id:'bad',text:'theirs',namespace:'foreign'}]},{data:{results:[{id:'bad',text:'theirs',namespace:'foreign'}]}}]) await assert.rejects(fixture({result}).adapter.recall({query:'needle'}),/FOREIGN_NAMESPACE/)
  const result=await fixture({result:{memories:[{id:'n1',text:'request scoped only'}]}}).adapter.recall({query:'needle'})
  assert.equal(result.scopeEvidence,'request-filter');assert.equal(result.results[0].namespace,namespace)
})

test('an explicitly bound tag array supports project membership without treating other ordinary tags as foreign projects',async()=>{
  const schema={type:'object',properties:{tags:{type:'array',items:{type:'string'}},query:{type:'string'}},required:['tags','query']}
  const f=fixture({schema}), tagged={...binding,search:{...binding.search,scopeArgument:'tags'}}
  const make=tags=>createMemoriaAdapter(f.ctx,{binding:tagged,execution:f.execution,verifyScope(){},executeTool:async()=>({isError:false,value:{memories:[{id:'note',text:'source',tags}]}})})
  assert.equal((await make([namespace,'decision']).recall({query:'source'})).scopeEvidence,'response-and-request-filter')
  await assert.rejects(make(['foreign','decision']).recall({query:'source'}),/FOREIGN_NAMESPACE/)
})

test('bounded MCP JSON envelopes retain evidence and never leak arbitrary backend/provider metadata',async()=>{
  const result={content:[{type:'text',text:JSON.stringify({results:[{id:'n',text:'x'.repeat(7000),secret:'not-forwarded',score:.2},{id:'m',text:'next'}]})}]}
  const out=await fixture({result}).adapter.recall({query:'needle',topK:1})
  assert.equal(out.results.length,1);assert.equal(out.results[0].text.length,6000);assert.equal(out.truncated,true);assert.equal(out.results[0].score,.2);assert.equal(JSON.stringify(out).includes('not-forwarded'),false)
  await assert.rejects(fixture({result:{content:[{type:'text',text:'not JSON'}]}}).adapter.recall({query:'needle'}),/RESPONSE_SCHEMA_REQUIRED/)
  await assert.rejects(fixture({result:{results:[{text:'x'.repeat(300000)}]}}).adapter.recall({query:'needle'}),/RESPONSE_LIMIT/)
})

test('schema/definition revocation and scope changes after await do not release stale results',async()=>{
  let f
  f=fixture({invoke(){f.schemas.get(binding.search.tool).properties.query.maxLength=4;return{isError:false,value:{results:[]}}}})
  await assert.rejects(f.adapter.recall({query:'needle'}),/SCHEMA_CHANGED/)
  let revoked=false
  const g=fixture({check(){if(revoked)throw Error('MEMORY_SCOPE_CHANGED')},invoke(){revoked=true;return{isError:false,value:{results:[]}}}})
  await assert.rejects(g.adapter.recall({query:'needle'}),/MEMORY_SCOPE_CHANGED/)
})

test('writes are exact mapped data; late errors/revocation and malformed receipts remain unknown',async()=>{
  const f=fixture({result:{id:'stored-one',namespace}}), out=await f.adapter.remember({text:'verified source fixture',title:'Fixture',operationId:'op-1'})
  assert.equal(out.state,'stored');assert.equal(out.recordId,'stored-one');assert.equal(out.retrySafe,false);assert.equal(out.indexed,null)
  assert.deepEqual(f.calls[0].arguments,{namespace,text:'verified source fixture',title:'Fixture'})
  assert.equal(Object.hasOwn(f.calls[0].arguments,'operationId'),false)
  for(const invoke of [()=>{throw Error('provider SECRET')},()=>({isError:true,error:{message:'private'}}),()=>({isError:false,value:{ok:false,error:'private'}}),()=>({isError:false,value:{id:''}}),()=>({isError:false,value:{id:'foreign',namespace:'foreign'}})]) {
    const result=await fixture({invoke}).adapter.remember({text:'literal URL https://example.invalid/source',operationId:'op-2'})
    assert.equal(result.state,'outcome-unknown');assert.equal(result.retrySafe,false);assert.equal(JSON.stringify(result).includes('SECRET'),false)
  }
  let revoked=false
  const g=fixture({check(){if(revoked)throw Error('MEMORY_SCOPE_CHANGED')},invoke(){revoked=true;return{isError:false,value:{ok:true}}}})
  assert.equal((await g.adapter.remember({text:'fixture',operationId:'op-3'})).state,'outcome-unknown')
})

test('HTTP/catalogue identities cannot substitute a real native turn token and cancelled calls never dispatch',async()=>{
  const f=fixture()
  const catalogue=createMemoriaAdapter(f.ctx,{binding,execution:{agent},verifyScope(){},executeTool(){throw Error('must not dispatch')}})
  assert.equal(catalogue.status().connected,null)
  await assert.rejects(catalogue.recall({query:'needle'}),/NATIVE_EXECUTION_REQUIRED/)
  const controller=new AbortController();controller.abort()
  const cancelled=createMemoriaAdapter(f.ctx,{binding,execution:{...f.execution,signal:controller.signal},verifyScope(){},executeTool(){throw Error('must not dispatch')}})
  await assert.rejects(cancelled.recall({query:'needle'}),/abort/i)
})
