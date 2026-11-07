import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const source=await readFile(new URL('../src/onec-specialized/lib/client.js',import.meta.url),'utf8')
const h=(type,props,...children)=>({type,props:props??{},children:children.flat()})
const nodes=tree=>tree&&typeof tree==='object'?[tree,...tree.children.flatMap(nodes)]:[]
const text=tree=>tree&&typeof tree==='object'?tree.children.map(text).join(' '):tree==null||tree===false?'':String(tree)
const button=(tree,label)=>nodes(tree).find(row=>row.type==='button'&&text(row)===label)
const response=value=>({ok:true,json:async()=>value})
const view=id=>({ok:true,csrfToken:'csrf',binding:{version:id,text:'{"schemaVersion":1}',exists:true},status:{domains:[],activeRuns:[]},workspace:{writable:true},runnerTemplate:{path:'tools/onec-specialized/runner.mjs',exists:false,version:null}})
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve))}
function fixture(fetchImpl){
 let plugin,cursor=0,snapshot={current:'old',byId:{old:{id:'old'},active:{id:'active',retainedBy:{mainView:1}}}}
 const hooks=[],effects=[],calls=[]
 const react={Fragment:'fragment',createElement:h,useState(value){const i=cursor++;hooks[i]??={value};return[hooks[i].value,next=>{hooks[i].value=next}]},useRef(value){const i=cursor++;return hooks[i]??={current:value}},useSyncExternalStore(_sub,get){return get()},useCallback(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((value,j)=>!Object.is(value,hooks[i].deps[j])))hooks[i]={deps,fn};return hooks[i].fn},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||deps.some((value,j)=>!Object.is(value,hooks[i].deps[j]))){const old=hooks[i];hooks[i]={deps};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn()})}}}
 vm.runInNewContext(source,{window:{confirm:()=>true,__ModuleLoader__:{load(row){plugin=row.factory(name=>{assert.equal(name,'react');return react})}}},URLSearchParams,fetch:async(url,options)=>{calls.push({url,options});return fetchImpl?fetchImpl(url,options):response(view(new URL(url,'http://localhost').searchParams.get('sessionId')))}})
 const registrations=[];plugin.apply({get(name){assert.equal(name,'sessions');return{list:{subscribe(){},getSnapshot:()=>snapshot}}},effect(){},slots:{inject(_name,fn){fn()},register(metadata,component){registrations.push({metadata,component})}}})
 return{plugin,calls,registrations,render(){cursor=0;const tree=plugin.Settings();effects.splice(0).forEach(fn=>fn());return tree},switch(id){snapshot={current:id,byId:{[id]:{id,retainedBy:{mainView:1}}}}}}
}
test('specialized page uses actual native sessions service and retained main view, not an invented remote session',async()=>{
 const f=fixture();assert.deepEqual(Array.from(f.plugin.inject),['slots','sessions']);assert.equal(f.registrations[0].metadata.id,'airules-onec-specialized')
 f.render();await flush();assert.equal(new URL(f.calls[0].url,'http://localhost').searchParams.get('sessionId'),'active')
 assert.ok(button(f.render(),'Сформировать план'));assert.equal(f.calls.length,1)
})
test('project switch clears repository object and comment drafts',async()=>{
 const f=fixture();f.render();await flush();let tree=f.render()
 const objects=nodes(tree).find(row=>row.type==='textarea'&&row.props.rows===4),comment=nodes(tree).find(row=>row.type==='input')
 objects.props.onChange({target:{value:'Документ.Заказ'}});comment.props.onChange({target:{value:'old project comment'}})
 f.switch('second');f.render();await flush();tree=f.render()
 assert.equal(nodes(tree).find(row=>row.type==='textarea'&&row.props.rows===4).props.value,'');assert.equal(nodes(tree).find(row=>row.type==='input').props.value,'')
})
test('late POST from previous project cannot replace binding or display a prepared old plan',async()=>{
 let finish
 const f=fixture(async(url,options)=>options?.method==='POST'?new Promise(resolve=>{finish=resolve}):response(view(new URL(url,'http://localhost').searchParams.get('sessionId'))))
 f.render();await flush();button(f.render(),'Сформировать план').props.onClick();await flush()
 f.switch('second');f.render();await flush();finish(response({...view('old-binding'),result:{domain:'repository',operation:'lock',execution:'configured',planDigest:'old-secret-plan',effects:[]}}));await flush()
 const tree=f.render();assert.doesNotMatch(text(tree),/old-secret-plan|Подготовленный план/);assert.equal(nodes(tree).find(row=>row.props['aria-label']==='Настройки специализированных инструментов').props.value,'{"schemaVersion":1}')
 assert.equal(JSON.parse(f.calls.find(row=>row.options?.method==='POST').options.body).sessionId,'active')
})
