import YAML from '../vendor/yaml/dist/index.js'

const MAX_BYTES=2*1024*1024,JS='tag:yaml.org,2002:js'
const options={customTags:[{tag:JS,resolve:value=>value}],strict:true,uniqueKeys:true}
const fail=()=>{throw Object.assign(new Error('LIVE_CORDIS_PRESERVATION_CONFLICT'),{code:'LIVE_CORDIS_PRESERVATION_CONFLICT'})}
const tags=new Set([JS,'tag:yaml.org,2002:str','tag:yaml.org,2002:null','tag:yaml.org,2002:bool','tag:yaml.org,2002:int','tag:yaml.org,2002:float','tag:yaml.org,2002:map','tag:yaml.org,2002:seq'])
function bytes(value){if(typeof value==='string')value=Buffer.from(value);if(!Buffer.isBuffer(value)||value.length>MAX_BYTES)fail();return value}
function normalize(node,depth=0){
 if(depth>100||YAML.isAlias(node)||node?.tag&&!tags.has(node.tag)||node?.tag===JS&&!YAML.isScalar(node))fail()
 if(node==null)return null
 if(YAML.isScalar(node)){if(typeof node.value==='number'&&!Number.isFinite(node.value)||!['string','number','boolean','undefined'].includes(typeof node.value)&&node.value!==null)fail();return['scalar',node.tag??'',typeof node.value,node.value]}
 if(YAML.isSeq(node))return['sequence',node.items.map(n=>normalize(n,depth+1))]
 if(YAML.isMap(node))return['map',node.items.map(pair=>{if(!YAML.isScalar(pair.key)||typeof pair.key.value!=='string'||pair.key.tag&&pair.key.tag!=='tag:yaml.org,2002:str')fail();return[pair.key.value,normalize(pair.value,depth+1)]}).sort(([a],[b])=>a.localeCompare(b,'en'))]
 fail()
}
const same=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b))
const get=(map,key)=>map.items.find(p=>p.key.value===key)?.value
const scalar=node=>YAML.isScalar(node)?node.value:undefined
function identity(row){
 const id=scalar(get(row,'id'))
 const insert=get(row,'insert');if(!YAML.isSeq(insert))return typeof id==='string'&&id.length?{kind:'id',tokens:[id]}:null
 const ids=insert.items.map(item=>YAML.isMap(item)?scalar(get(item,'id')):undefined)
 const known=ids.filter(id=>typeof id==='string'&&id.length)
 if(new Set(known).size!==known.length)fail()
 if(typeof id==='string'&&id.length)return{kind:'id',tokens:[id]}
 if(!ids.length||known.length!==ids.length)return null
 return{kind:'insert',tokens:ids}
}
const overlaps=(left,right)=>left&&right&&left.kind===right.kind&&left.tokens.some(t=>right.tokens.includes(t))
function mentions(node,tokens){if(YAML.isMap(node))return tokens.includes(scalar(get(node,'id')))||node.items.some(pair=>mentions(pair.value,tokens));return YAML.isSeq(node)&&node.items.some(item=>mentions(item,tokens))}
function parse(buffer){
 let source;try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer)}catch{fail()}
 const offset=source.startsWith('\uFEFF')?1:0,doc=YAML.parseDocument(source.slice(offset),options)
 if(doc.errors.length||doc.warnings.length||doc.contents&&!YAML.isSeq(doc.contents))fail()
 if(doc.contents?.flow&&doc.contents.items.length)fail()
 normalize(doc.contents)
 const rows=doc.contents?.items??[];if(!rows.every(YAML.isMap))fail()
 const identities=rows.map(identity)
 for(let i=0;i<identities.length;i++)for(let j=0;j<i;j++)if(overlaps(identities[i],identities[j]))fail()
 return{source,rows,identities,offset,sequence:YAML.isSeq(doc.contents)}
}
function start(parsed,index){const at=parsed.source.lastIndexOf('\n',parsed.rows[index].range[0]+parsed.offset-1)+1;return at===0&&parsed.offset?1:at}
function end(parsed,index){return parsed.rows[index].range[2]+parsed.offset}
function fragment(parsed,index){return parsed.source.slice(start(parsed,index),end(parsed,index))}
function candidates(parsed,signature){return parsed.identities.map((id,index)=>overlaps(signature,id)?index:-1).filter(index=>index>=0)}

/** Reverse only the installer delta B→A. YAML tags remain data, never code. */
export function reverseCordisChanges({before,installed,current}){
 const b=bytes(before),a=bytes(installed),c=bytes(current),B=parse(b),A=parse(a),C=parse(c)
 if(JSON.stringify(B.rows.map(row=>normalize(row)))===JSON.stringify(A.rows.map(row=>normalize(row))))return{text:Buffer.from(c),preservedUnmanaged:!c.equals(b)}
 const paired=new Map(),claimed=new Set()
 for(let ai=0;ai<A.rows.length;ai++){
  const signature=A.identities[ai],matches=signature?candidates(B,signature):B.rows.map((row,index)=>same(row,A.rows[ai])?index:-1).filter(index=>index>=0)
  if(matches.length>1)fail()
  if(matches.length===1){if(claimed.has(matches[0]))fail();claimed.add(matches[0]);paired.set(ai,matches[0])}
 }
 const changed=[]
 for(let ai=0;ai<A.rows.length;ai++)if(!paired.has(ai)||!same(A.rows[ai],B.rows[paired.get(ai)])){if(!A.identities[ai])fail();changed.push(ai)}
 const deleted=B.rows.map((_,bi)=>claimed.has(bi)?-1:bi).filter(bi=>bi>=0)
 for(const bi of deleted)if(!B.identities[bi])fail()
 // Exact installed bytes retain the original whole-file rollback behavior/BOM.
 if(c.equals(a))return{text:Buffer.from(b),preservedUnmanaged:false}
 if(!changed.length&&!deleted.length)return{text:Buffer.from(c),preservedUnmanaged:!c.equals(b)}
 const edits=[],affected=new Set(),positionByBefore=new Map();let previousOwnedPosition=-1
 for(const[ai,bi]of paired){const signature=A.identities[ai];if(!signature)continue;const found=candidates(C,signature);if(found.length===1)positionByBefore.set(bi,found[0])}
 for(const ai of changed){
  const found=candidates(C,A.identities[ai]);if(found.length!==1)fail();const ci=found[0]
  if(ci<=previousOwnedPosition)fail();previousOwnedPosition=ci
  if(affected.has(ci)||!same(C.rows[ci],A.rows[ai]))fail();affected.add(ci)
  // A new user row must not shadow a managed identity under a different root
  // id or nested insert. Existing cross-references are allowed only as exact,
  // trusted snapshot rows; a new ambiguous owner is never silently retained.
  for(let other=0;other<C.rows.length;other++)if(other!==ci&&mentions(C.rows[other],A.identities[ai].tokens)&&!A.rows.some((row,index)=>index!==ai&&same(row,C.rows[other])))fail()
  const bi=paired.get(ai);let text=bi===undefined?'':fragment(B,bi)
  if(text&&!/\r?\n$/u.test(text)&&end(C,ci)<C.source.length)text+=C.source.includes('\r\n')?'\r\n':'\n'
  edits.push({start:start(C,ci),end:end(C,ci),text,order:bi??-1})
 }
 for(const bi of deleted){
  if(candidates(C,B.identities[bi]).length)fail()
  for(const row of C.rows)if(mentions(row,B.identities[bi].tokens)&&!A.rows.some(known=>same(known,row)))fail()
  let position
  for(let next=bi+1;next<B.rows.length;next++)if(positionByBefore.has(next)){position=start(C,positionByBefore.get(next));break}
  if(position===undefined)for(let previous=bi-1;previous>=0;previous--)if(positionByBefore.has(previous)){position=end(C,positionByBefore.get(previous));break}
  if(position===undefined)position=C.rows.length?start(C,0):C.source.length
  const text=fragment(B,bi),prefix=position>0&&!/[\r\n]$/u.test(C.source.slice(0,position))?'\n':''
  edits.push({start:position,end:position,text:prefix+text+(text&&!/\r?\n$/u.test(text)?'\n':''),order:bi})
 }
 let source=C.source
 // At the same insertion point, reverse application keeps original B order.
 for(const edit of edits.sort((l,r)=>r.start-l.start||r.end-l.end||r.order-l.order))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end)
 const result=parse(Buffer.from(source))
 if(!result.rows.length&&!result.sequence)source+=(source.length&&!/\r?\n$/u.test(source)?'\n':'')+'[]\n'
 parse(Buffer.from(source))
 return{text:Buffer.from(source),preservedUnmanaged:!Buffer.from(source).equals(b)}
}
