import {createHash,randomUUID} from 'node:crypto'
import {lstat,realpath,readFile,mkdir,unlink} from 'node:fs/promises'
import {resolve,dirname,join,isAbsolute} from 'node:path'
import {writeProtectedFile} from './protected-file.mjs'

const fail=code=>{throw Error(code)}
const sha=value=>createHash('sha256').update(value).digest('hex')
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
const canonical=value=>JSON.stringify(value)
const key=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path)
const CREDENTIAL_REF='tail-shared-bearer'
const CONFIG_NAME='airules-mcp-servers.json'
const KIND='airules-shared-tail-mcp'
export const MCP_SERVER_DESCRIPTORS=Object.freeze([
 {serverName:'1c-syntax-checker-mcp',route:'/syntaxcheck/mcp',scope:'generic-1c'},
 {serverName:'1C-docs-mcp',route:'/help/mcp',scope:'generic-1c'},
 {serverName:'1c-templates-mcp',route:'/templates/mcp',scope:'generic-1c'},
 {serverName:'1c-code-check-mcp',route:'/code-checker/mcp',scope:'generic-1c'},
 {serverName:'1c-ssl-mcp',route:'/ssl/mcp',scope:'generic-1c'},
 {serverName:'kg-leasing-mcp',route:'/mcp',scope:'knowledge-leasing-project'},
])
const descriptors=new Map(MCP_SERVER_DESCRIPTORS.map(row=>[row.serverName,row]))
function endpoint(value){let url;try{url=new URL(value)}catch{fail('DEPLOY_MCP_ENDPOINT_INVALID')}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname||url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='[::1]')fail('DEPLOY_MCP_ENDPOINT_INVALID');return url}
/** Actual infrastructure addresses are private build inputs, never source defaults. */
export function createPublicMcpCatalog({gatewayBaseUrl,kgBaseUrl}){
 const gateway=endpoint(gatewayBaseUrl),kg=endpoint(kgBaseUrl)
 if(gateway.pathname!=='/'||kg.pathname!=='/')fail('DEPLOY_MCP_ENDPOINT_INVALID')
 return{schemaVersion:1,kind:KIND,servers:MCP_SERVER_DESCRIPTORS.map(row=>({serverName:row.serverName,transport:'streamable-http',url:new URL(row.route,row.serverName==='kg-leasing-mcp'?kg:gateway).toString(),scope:row.scope,credentialRef:CREDENTIAL_REF,enabled:true}))}
}
export function validateMcpCatalog(value){
 if(!plain(value)||Object.keys(value).sort().join(',')!=='kind,schemaVersion,servers'||value.schemaVersion!==1||value.kind!==KIND||!Array.isArray(value.servers)||value.servers.length!==descriptors.size)fail('DEPLOY_MCP_CATALOG_INVALID')
 const seen=new Set();let gatewayOrigin
 for(const row of value.servers){
  const descriptor=descriptors.get(row?.serverName)
  if(!plain(row)||Object.keys(row).sort().join(',')!=='credentialRef,enabled,scope,serverName,transport,url'||!descriptor||seen.has(row.serverName)||row.transport!=='streamable-http'||row.credentialRef!==CREDENTIAL_REF||row.enabled!==true||row.scope!==descriptor.scope)fail('DEPLOY_MCP_CATALOG_INVALID')
  const url=endpoint(row.url);if(url.pathname!==descriptor.route)fail('DEPLOY_MCP_CATALOG_INVALID')
  if(descriptor.scope==='generic-1c'){if(gatewayOrigin&&gatewayOrigin!==url.origin)fail('DEPLOY_MCP_CATALOG_INVALID');gatewayOrigin=url.origin}
  seen.add(row.serverName)
 }
 return value
}
function parse(bytes,code){try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,''));if(!plain(value))fail(code);return value}catch{fail(code)}}
async function guard(path,{missing=true}={}){
 if(!isAbsolute(path??''))fail('DEPLOY_MCP_PATH_REQUIRED')
 const paths=[];let at=resolve(path)
 while(true){paths.unshift(at);const parent=dirname(at);if(parent===at)break;at=parent}
 for(let index=0;index<paths.length;index++)try{const info=await lstat(paths[index]);if(info.isSymbolicLink()||key(await realpath(paths[index]))!==key(paths[index])||index<paths.length-1&&!info.isDirectory()||info.isFile()&&info.nlink!==1)fail('DEPLOY_MCP_PATH_REJECTED')}catch(error){if(error.code==='ENOENT'&&missing)return;throw error}
}
async function read(path,limit=1024*1024,{missing=false}={}){
 await guard(path,{missing});try{const info=await lstat(path);if(!info.isFile()||info.size>limit)fail('DEPLOY_MCP_FILE_INVALID');const bytes=await readFile(path);if(bytes.length>limit)fail('DEPLOY_MCP_FILE_INVALID');await guard(path,{missing:false});return bytes}catch(error){if(error.code==='ENOENT'&&missing)return null;throw error}
}
function credential(value){
 if(!plain(value)||Object.keys(value).sort().join(',')!=='credentials,schemaVersion'||value.schemaVersion!==1||!plain(value.credentials)||Object.keys(value.credentials).join(',')!==CREDENTIAL_REF)fail('DEPLOY_MCP_CREDENTIAL_INVALID')
 const bearer=value.credentials[CREDENTIAL_REF]
 if(typeof bearer!=='string'||bearer.length<16||bearer.length>4096||/[^\x21-\x7e]/u.test(bearer))fail('DEPLOY_MCP_CREDENTIAL_INVALID')
 return bearer
}
function existingConfig(bytes){
 if(!bytes)return{version:1,servers:[]}
 const value=parse(bytes,'DEPLOY_MCP_EXISTING_INVALID')
 if(!Array.isArray(value.servers)||value.servers.length>1000||value.servers.some(row=>!plain(row)||typeof row.serverName!=='string'||!/^[A-Za-z0-9_-]{1,32}$/u.test(row.serverName))||new Set(value.servers.map(row=>row.serverName)).size!==value.servers.length)fail('DEPLOY_MCP_EXISTING_INVALID')
 return value
}
async function prepare({dshHome,catalogPath,credentialsPath}){
 if(!isAbsolute(dshHome??''))fail('DEPLOY_MCP_HOME_REQUIRED')
 const target=join(resolve(dshHome),CONFIG_NAME)
 const [before,catalogBytes,credentialBytes]=await Promise.all([read(target,1024*1024,{missing:true}),read(catalogPath,65536),read(credentialsPath,16384)])
 const catalog=validateMcpCatalog(parse(catalogBytes,'DEPLOY_MCP_CATALOG_INVALID')),bearer=credential(parse(credentialBytes,'DEPLOY_MCP_CREDENTIAL_INVALID')),existing=existingConfig(before),rows=[...existing.servers],actions=[]
 for(const entry of catalog.servers){
  const next={serverName:entry.serverName,transport:entry.transport,url:entry.url,headers:{Authorization:'Bearer '+bearer},enabled:entry.enabled},current=existing.servers.find(row=>row.serverName===entry.serverName)
  const same=current&&Object.entries(next).every(([field,value])=>canonical(current[field])===canonical(value))
  const action=!current?'add':same?'unchanged':'conflict'
  actions.push({serverName:entry.serverName,url:entry.url,scope:entry.scope,enabled:entry.enabled,action})
  if(action==='add')rows.push(next)
 }
 const next={...existing,version:existing.version??1,servers:rows},after=Buffer.from(JSON.stringify(next,null,2)+'\n'),beforeSha256=before?sha(before):'missing'
 const planDigest=sha(canonical([key(target),beforeSha256,sha(catalogBytes),sha(credentialBytes),sha(after),actions]))
 return{before,after,target,catalogBytes,credentialBytes,plan:{schemaVersion:1,kind:'airules-deployment-mcp-plan',status:actions.some(row=>row.action==='conflict')?'blocked':'ready',target,beforeSha256,afterSha256:sha(after),planDigest,existingServers:existing.servers.length,resultingServers:rows.length,credentialRef:CREDENTIAL_REF,actions}}
}
/** Secret-free preview. Existing unrelated servers and manager metadata remain intact. */
export async function planMcpConfiguration(options){return(await prepare(options)).plan}
async function protectedWrite(path,bytes,verify=async()=>{}){
 await verify();await guard(path);await mkdir(dirname(path),{recursive:true});await verify();await guard(path)
 writeProtectedFile(path,bytes.toString('utf8'));await guard(path,{missing:false});if(sha(await read(path))!==sha(bytes))fail('DEPLOY_MCP_WRITE_VERIFY_FAILED')
}
const receiptDigest=receipt=>{const{integritySha256,...value}=receipt;return sha(canonical(value))}
/** Applied only by the reviewed installer; never connects a server or calls tools. */
export async function applyMcpConfiguration(options){
 const{backupRoot,expectedPlanDigest,verify=async()=>{}}=options
 if(!isAbsolute(backupRoot??'')||typeof verify!=='function'||!/^[a-f0-9]{64}$/u.test(expectedPlanDigest??''))fail('DEPLOY_MCP_REVIEWED_PLAN_REQUIRED')
 await verify();const prepared=await prepare(options),{plan,before,after,target}=prepared
 if(plan.planDigest!==expectedPlanDigest)fail('DEPLOY_MCP_PLAN_CHANGED')
 if(plan.status!=='ready')fail('DEPLOY_MCP_CONFLICT')
 if(plan.actions.every(row=>row.action==='unchanged'))return{status:'unchanged',plan,receiptPath:null}
 const own=join(resolve(backupRoot),'mcp-'+randomUUID()),beforePath=join(own,'before.json'),receiptPath=join(own,'receipt.json')
 await guard(own);await mkdir(own,{recursive:true});await verify();await guard(own,{missing:false})
 if(before)await protectedWrite(beforePath,before,verify)
 let receipt={schemaVersion:1,kind:'airules-deployment-mcp-receipt',status:'prepared',target,backupRoot:own,beforePath:before?beforePath:null,beforeSha256:plan.beforeSha256,afterSha256:plan.afterSha256,planDigest:plan.planDigest,actions:plan.actions,createdAt:new Date().toISOString()}
 receipt.integritySha256=receiptDigest(receipt);await protectedWrite(receiptPath,Buffer.from(JSON.stringify(receipt,null,2)+'\n'),verify)
 await verify();if((await prepare(options)).plan.planDigest!==expectedPlanDigest)fail('DEPLOY_MCP_PLAN_CHANGED')
 // A fixed per-target lock prevents overlapping cooperating provisioning jobs.
 const lockPath=target+'.deployment.lock',token=randomUUID();await guard(lockPath)
 const {writeFile}=await import('node:fs/promises');await writeFile(lockPath,token,{flag:'wx',mode:0o600})
 try{
  await verify();const current=await read(target,1024*1024,{missing:true});if((current?sha(current):'missing')!==plan.beforeSha256)fail('DEPLOY_MCP_CONFIG_CHANGED')
  await protectedWrite(target,after,async()=>{await verify();const state=await read(target,1024*1024,{missing:true});if((state?sha(state):'missing')!==plan.beforeSha256)fail('DEPLOY_MCP_CONFIG_CHANGED')})
  receipt={...receipt,status:'applied'};receipt.integritySha256=receiptDigest(receipt);await protectedWrite(receiptPath,Buffer.from(JSON.stringify(receipt,null,2)+'\n'),verify)
  return{status:'applied',plan,receiptPath}
 }catch(error){error.receiptPath=receiptPath;throw error}
 finally{try{if((await readFile(lockPath,'utf8'))===token)await unlink(lockPath)}catch{}}
}
/** Exact rollback preserves unrelated user changes by rejecting any config drift. */
export async function rollbackMcpConfiguration({receiptPath,verify=async()=>{}}){
 await verify();const receipt=parse(await read(receiptPath,65536),'DEPLOY_MCP_RECEIPT_INVALID')
 if(receipt.kind!=='airules-deployment-mcp-receipt'||receipt.schemaVersion!==1||!['prepared','applied'].includes(receipt.status)||receipt.integritySha256!==receiptDigest(receipt)||key(dirname(receiptPath))!==key(receipt.backupRoot)||!isAbsolute(receipt.target??'')||receipt.target.split(/[\\/]/u).at(-1)!==CONFIG_NAME||receipt.beforePath!==null&&key(receipt.beforePath)!==key(join(receipt.backupRoot,'before.json')))fail('DEPLOY_MCP_RECEIPT_INVALID')
 const current=await read(receipt.target);if(sha(current)!==receipt.afterSha256)fail('DEPLOY_MCP_ROLLBACK_CONFLICT')
 const previous=receipt.beforePath?await read(receipt.beforePath):null;if((previous?sha(previous):'missing')!==receipt.beforeSha256)fail('DEPLOY_MCP_BACKUP_CHANGED')
 await verify();if(sha(await read(receipt.target))!==receipt.afterSha256)fail('DEPLOY_MCP_ROLLBACK_CONFLICT')
 if(previous)await protectedWrite(receipt.target,previous,async()=>{await verify();if(sha(await read(receipt.target))!==receipt.afterSha256)fail('DEPLOY_MCP_ROLLBACK_CONFLICT')})
 else{await guard(receipt.target,{missing:false});if(sha(await read(receipt.target))!==receipt.afterSha256)fail('DEPLOY_MCP_ROLLBACK_CONFLICT');await unlink(receipt.target)}
 receipt.status='rolled-back';receipt.integritySha256=receiptDigest(receipt);await protectedWrite(receiptPath,Buffer.from(JSON.stringify(receipt,null,2)+'\n'),verify)
 return{status:'rolled-back',target:receipt.target,restoredSha256:receipt.beforeSha256}
}
/** Installer-friendly wrapper: preview is the default. */
export const configureMcp=options=>options?.dryRun===false?applyMcpConfiguration(options):planMcpConfiguration(options)
export const rollbackMcp=rollbackMcpConfiguration
