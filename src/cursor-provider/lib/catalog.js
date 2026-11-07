import { createHash } from 'node:crypto'
import { fail } from './runtime.js'
export const PROVIDER = 'airules-cursor'
export function catalogOf(result) {
  const entries = Array.isArray(result)?result:result?.models??result?.data
  if (!Array.isArray(entries) || entries.length>1000) fail('CURSOR_CATALOG_INVALID')
  const rows = new Map()
  for (const item of entries) {
    if (typeof item?.id !== 'string' || !item.id || item.id.length>100) continue
    const presets = (item.variants??[]).filter(v=>Array.isArray(v?.params)&&v.params.every(p=>typeof p.id==='string'&&typeof p.value==='string'))
    const variants = presets.length?presets:(item.parameters??[]).reduce((rows,p)=>{
      if(typeof p.id!=='string'||!Array.isArray(p.values))return rows
      const next=rows.flatMap(row=>p.values.filter(v=>typeof v?.value==='string').map(v=>({params:[...row.params,{id:p.id,value:v.value}]})))
      if(next.length>100)fail('CURSOR_CATALOG_VARIANT_LIMIT')
      return next
    },[{params:[]}]).filter(v=>v.params.length)
    const defaults = variants.find(v=>v.isDefault)?.params ?? (item.parameters??[]).flatMap(p=>typeof p.id==='string'&&typeof p.values?.[0]?.value==='string'?[{id:p.id,value:p.values[0].value}]:[])
    const add = (id,params,label) => {
      // Context is explicit and conservative until Cursor returns a numeric window.
      const context = Number(item.contextWindow??item.contextWindowTokens)
      rows.set(id,{provider:PROVIDER,id,name:String(item.displayName??item.id).slice(0,200)+label,
        inputModalities:['text'],context:{contextWindow:Number.isSafeInteger(context)&&context>0?context:128000},
        contextEstimated:!(Number.isSafeInteger(context)&&context>0),cursorModel:{id:item.id,...(params.length?{params:structuredClone(params)}:{})}})
    }
    add(item.id,defaults,'')
    for(const variant of variants.slice(0,100)) {
      const params=variant.params.map(({id,value})=>({id,value})), digest=createHash('sha256').update(JSON.stringify([...params].sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex').slice(0,20)
      add(item.id.slice(0,85)+'~cursor-'+digest,params,' · '+params.map(p=>`${p.id}=${p.value}`).join(', '))
    }
  }
  if(!rows.size) fail('CURSOR_CATALOG_EMPTY')
  return [...rows.values()]
}
