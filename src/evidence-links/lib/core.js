import { createHash } from 'node:crypto'
import { isAbsolute, win32, posix } from 'node:path'
const fail=code=>{throw new Error(code)}
export const TYPES=Object.freeze(['references','implements','verifiedBy','related'])
export const LIMITS=Object.freeze({links:256,nodes:512,storeBytes:512*1024,sourceBytes:4*1024*1024,queryBytes:16*1024*1024,queryFiles:16,page:30})
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key))
const secret=/(?:\b(?:bearer|api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+|\bsk-(?:or-v1-)?[A-Za-z0-9_-]{18,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu
function reference(value,max=512){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/u.test(value)||secret.test(value))fail('LINKS_REFERENCE_INVALID');if(/^https?:\/\//iu.test(value)){let url;try{url=new URL(value)}catch{fail('LINKS_REFERENCE_INVALID')}if(url.username||url.password||url.search)fail('LINKS_REFERENCE_INVALID')}return value}
export function projectIdentity(root){
  if(typeof root!=='string'||root.includes('\0')||!isAbsolute(root)&&!win32.isAbsolute(root))fail('LINKS_PROJECT_REQUIRED')
  const windows=win32.isAbsolute(root)&&!posix.isAbsolute(root),normalized=windows?win32.normalize(root).replaceAll('\\','/').replace(/\/+$/u,'').toLowerCase():posix.normalize(root).replace(/\/+$/u,'')||'/'
  return 'project-'+hash(normalized).slice(0,32)
}
export function sourcePath(input){
  if(typeof input!=='string'||!input||input.length>400||/[\u0000-\u001f\u007f]/u.test(input)||secret.test(input)||input.includes(':')||input.includes('\\')||input.startsWith('/')||isAbsolute(input)||win32.isAbsolute(input))fail('LINKS_SOURCE_PATH_REJECTED')
  const parts=input.split('/')
  if(parts.some(part=>!part||['.','..','.git','.ssh','.dsh'].includes(part.toLowerCase())||/^\.env(?:\.|$)/iu.test(part)||/^(?:credentials|auth|secrets)\.json$/iu.test(part)))fail('LINKS_SOURCE_PATH_REJECTED')
  return input
}
export function endpoint(value,projectId){
  if(!keys(value,['kind','path','range','backend','namespace','recordId','id','label']))fail('LINKS_ENDPOINT_INVALID')
  let normalized
  if(value.kind==='file'){
    if(Object.keys(value).some(key=>!['kind','path','range','label'].includes(key)))fail('LINKS_ENDPOINT_INVALID')
    normalized={kind:'file',path:sourcePath(value.path)}
    if(value.range!==undefined){if(!keys(value.range,['startLine','endLine'])||!Number.isSafeInteger(value.range.startLine)||!Number.isSafeInteger(value.range.endLine)||value.range.startLine<1||value.range.endLine<value.range.startLine||value.range.endLine>1_000_000)fail('LINKS_RANGE_INVALID');normalized.range={startLine:value.range.startLine,endLine:value.range.endLine}}
  }else if(value.kind==='note'){
    if(Object.keys(value).some(key=>!['kind','backend','namespace','recordId','label'].includes(key))||!['cognee','memoria','external'].includes(value.backend))fail('LINKS_ENDPOINT_INVALID')
    normalized={kind:'note',backend:value.backend,namespace:reference(value.namespace,300),recordId:reference(value.recordId,300)}
  }else if(['document','source'].includes(value.kind)){
    if(Object.keys(value).some(key=>!['kind','id','label'].includes(key)))fail('LINKS_ENDPOINT_INVALID')
    normalized={kind:value.kind,id:reference(value.id,400)}
  }else fail('LINKS_ENDPOINT_INVALID')
  const identity='node-'+hash(canonical([projectId,normalized])).slice(0,32)
  return {nodeId:identity,...normalized,...(value.label===undefined?{}:{label:reference(value.label,160)})}
}
export function edgeId(projectId,type,from,to){if(!TYPES.includes(type))fail('LINKS_TYPE_INVALID');return'edge-'+hash(canonical([projectId,type,from,to])).slice(0,32)}
export function provenance(input,actor,now){
  if(!keys(input,['ref','observedAt']))fail('LINKS_PROVENANCE_REQUIRED')
  if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)fail('LINKS_PROVENANCE_INVALID')
  const observedAt=input.observedAt??now
  if(typeof observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(observedAt)||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt||Date.parse(observedAt)>Date.parse(now)+300_000)fail('LINKS_PROVENANCE_INVALID')
  return{ref:reference(input.ref),observedAt,recordedAt:now,actor:reference(actor,160)}
}
export function emptyGraph(projectId){return{schemaVersion:1,projectId,nodes:{},links:{}}}
export function validateGraph(input,projectId){
  if(!keys(input,['schemaVersion','projectId','nodes','links'])||input.schemaVersion!==1||input.projectId!==projectId||!plain(input.nodes)||!plain(input.links)||Object.keys(input.nodes).length>LIMITS.nodes||Object.keys(input.links).length>LIMITS.links)fail('LINKS_STORE_INVALID')
  for(const[id,node]of Object.entries(input.nodes)){
    if(!plain(node)||node.nodeId!==id)fail('LINKS_STORE_INVALID')
    const {nodeId,...raw}=node,normalized=endpoint(raw,projectId)
    if(canonical(normalized)!==canonical(node))fail('LINKS_STORE_INVALID')
  }
  for(const[id,link]of Object.entries(input.links)){
    if(!keys(link,['id','type','from','to','sourceHashes','provenance','createdAt','updatedAt'])||link.id!==id||!input.nodes[link.from]||!input.nodes[link.to]||input.nodes[link.from].kind!=='file'||edgeId(projectId,link.type,link.from,link.to)!==id||!plain(link.sourceHashes))fail('LINKS_STORE_INVALID')
    const expected=[link.from,link.to].filter(nodeId=>input.nodes[nodeId].kind==='file')
    if(Object.keys(link.sourceHashes).length!==new Set(expected).size||expected.some(nodeId=>!/^[a-f0-9]{64}$/u.test(link.sourceHashes[nodeId]??'')))fail('LINKS_STORE_INVALID')
    const normalized=provenance({ref:link.provenance?.ref,observedAt:link.provenance?.observedAt},link.provenance?.actor,link.provenance?.recordedAt)
    if(canonical(normalized)!==canonical(link.provenance)||![link.createdAt,link.updatedAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)||link.updatedAt<link.createdAt)fail('LINKS_STORE_INVALID')
  }
  if(Buffer.byteLength(JSON.stringify(input))>LIMITS.storeBytes)fail('LINKS_STORE_LIMIT')
  return structuredClone(input)
}
export function filterEdges(graph,{type,nodeId,query='',limit=20,cursor}={}){
  if(type!==undefined&&!TYPES.includes(type)||nodeId!==undefined&&!/^node-[a-f0-9]{32}$/u.test(nodeId)||typeof query!=='string'||query.length>400||!Number.isSafeInteger(limit)||limit<1||limit>LIMITS.page)fail('LINKS_QUERY_INVALID')
  const needle=query.toLowerCase()
  return Object.values(graph.links).filter(link=>(!type||link.type===type)&&(!nodeId||link.from===nodeId||link.to===nodeId)&&(!needle||[link.id,link.type,...[link.from,link.to].flatMap(id=>Object.values(graph.nodes[id]).filter(value=>typeof value==='string'))].join(' ').toLowerCase().includes(needle))).sort((a,b)=>a.id.localeCompare(b.id))
}
export function queryFingerprint({type,nodeId,query='',limit=20}={}){return hash(canonical({type:type??null,nodeId:nodeId??null,query,limit}))}
