import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source=await readFile(new URL('../src/memory-workspace/lib/client.js',import.meta.url),'utf8')
const h=(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})
let client
runInNewContext(source,{window:{__ModuleLoader__:{load(module){client=module.factory(name=>{assert.equal(name,'react');return{createElement:h}})}}}})
const texts=node=>typeof node==='string'?node:Array.isArray(node)?node.map(texts).join(' '):node&&typeof node==='object'?(typeof node.type==='function'?texts(node.type(node.props)):texts(node.children)):''
test('submitted UI operation reports intent rather than upload/index success',()=>{
  const rendered=texts(client.Result({result:{submitted:true,processingStarted:false},action:'remember'}))
  assert.match(rendered,/запись ещё не считается выполненной/u)
  assert.doesNotMatch(rendered,/Загрузка принята|Обработка завершена/u)
})
test('memory chunks keep source IDs and render untrusted markup as text',()=>{
  const malicious='<script>window.evil=true</script>'
  const rendered=client.Result({action:'recall',result:{results:[{text:malicious,document_id:'doc-A'}]}})
  assert.ok(texts(rendered).includes(malicious));assert.ok(texts(rendered).includes('doc-A'))
  function safe(node){if(!node||typeof node!=='object')return;if(Array.isArray(node))return node.forEach(safe);assert.equal(node.props?.dangerouslySetInnerHTML,undefined);node.children?.forEach(safe)}safe(rendered)
})
test('task UI distinguishes latest dataset state from exact receipt tracking',()=>{
  const rendered=texts(client.Result({action:'task',result:{status:'DATASET_PROCESSING_COMPLETED',exactTask:false}}))
  assert.match(rendered,/не подтверждение конкретного ID/u)
})
test('graph limits and dataset documents remain visible without a graph engine in UI',()=>{
  const graph=texts(client.Graph({graph:{nodes:[{id:'x',label:'Fixture'}],edges:[],truncated:true}}))
  assert.match(graph,/Показана часть графа/u)
  const docs=texts(client.Result({action:'documents',result:{documents:[{id:'doc-A',name:'Note'}]}}))
  assert.ok(docs.includes('Note'));assert.ok(docs.includes('doc-A'))
})
