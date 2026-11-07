import { createHash } from 'node:crypto'
import { cp,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile } from 'node:fs/promises'
import { resolve,join,dirname,relative,isAbsolute,sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectPackageClosure,stagePackageClosure } from './stage-package-closure.mjs'

const LOCK=new URL('../upstream/provider-extensions-closure.lock.json',import.meta.url)
const ROOTS={'@muse-code/sdk':'1.4.14','pi-antigravity-acp-provider':'0.1.17-bundle.5',typebox:'1.3.27'}
const LICENSES=new Set(['MIT','Apache-2.0','ISC','BSD-2-Clause','BSD-3-Clause'])
const execFileAsync=promisify(execFile)
const hash=value=>createHash('sha256').update(value).digest('hex')
const inside=(base,path)=>{const rel=relative(base,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)}

async function directory(path,missing=false){
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('PROVIDER_EXTENSIONS_ABSOLUTE_ROOT_REQUIRED')
  const absolute=resolve(path)
  try {const info=await lstat(absolute);if(!info.isDirectory()||info.isSymbolicLink()||resolve(await realpath(absolute)).toLowerCase()!==absolute.toLowerCase())throw new Error('PROVIDER_EXTENSIONS_DIRECTORY_REJECTED')}
  catch(error){if(!missing||error.code!=='ENOENT')throw error;await directory(dirname(absolute),true)}
  return absolute
}
async function safeFiles(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const path=join(folder,entry.name)
    if(entry.isSymbolicLink())throw new Error('PROVIDER_EXTENSIONS_FILE_LINK_REJECTED')
    if(entry.isDirectory())await safeFiles(path)
    else if(!entry.isFile()||/\.(?:exe|dll|node|par)$/iu.test(entry.name)||/^(?:auth\.json|acp_token\.json|\.env|credentials\.json|oauth_creds\.json)$/iu.test(entry.name))throw new Error('PROVIDER_EXTENSIONS_RUNTIME_FILE_REJECTED')
  }
}
function validateLock(lock){
  if(lock.schemaVersion!==1||JSON.stringify(lock.roots)!==JSON.stringify(ROOTS)||!Array.isArray(lock.packages)||!lock.packages.length)throw new Error('PROVIDER_EXTENSIONS_LOCK_REJECTED')
  if(lock.packages.some(row=>!LICENSES.has(row.license)||['@earendil-works/pi-ai','@earendil-works/pi-coding-agent'].includes(row.name)))throw new Error('PROVIDER_EXTENSIONS_PEER_OR_LICENSE_REJECTED')
}
async function nativePeer(nativeModulesRoot,targetRoot){
  if(nativeModulesRoot!==undefined){const root=await directory(nativeModulesRoot);return join(root,'@earendil-works','pi-ai')}
  let current=resolve(targetRoot)
  while(true){const candidate=join(current,'node_modules','@earendil-works','pi-ai');try{await lstat(join(candidate,'package.json'));return candidate}catch(error){if(error.code!=='ENOENT')throw error}const parent=dirname(current);if(parent===current)break;current=parent}
  throw new Error('PROVIDER_EXTENSIONS_NATIVE_PEER_ROOT_REQUIRED')
}

/** Cold import only; constructors, OAuth, CLI installation and requests are forbidden. */
export async function verifyProviderExtensionsImports({targetRoot,nativeModulesRoot}){
  const target=await directory(targetRoot),peer=await nativePeer(nativeModulesRoot,target)
  await directory(peer)
  const metadata=JSON.parse(await readFile(join(peer,'package.json'),'utf8'))
  if(metadata.name!=='@earendil-works/pi-ai'||metadata.version!=='1.1.0')throw new Error('PROVIDER_EXTENSIONS_NATIVE_PEER_MISMATCH')
  const nativeEntry=join(peer,'dist','index.js'),entryInfo=await lstat(nativeEntry)
  if(!entryInfo.isFile()||entryInfo.isSymbolicLink())throw new Error('PROVIDER_EXTENSIONS_NATIVE_PEER_ENTRY_REJECTED')
  const temporary=await mkdtemp(join(target,'.provider-import-probe-'))
  try {
    await cp(join(target,'node_modules'),join(temporary,'node_modules'),{recursive:true,errorOnExist:true,force:false})
    const peerShim=join(temporary,'node_modules','@earendil-works','pi-ai');await mkdir(peerShim,{recursive:true})
    await writeFile(join(peerShim,'package.json'),JSON.stringify({name:'@earendil-works/pi-ai',version:'1.1.0',type:'module',exports:'./native-peer.mjs'}))
    // This re-export uses the real pinned host SDK and its own resolved dependencies.
    // It neither copies a donor pi-ai nor synthesizes provider behavior.
    await writeFile(join(peerShim,'native-peer.mjs'),`export * from ${JSON.stringify(pathToFileURL(nativeEntry).href)}\n`)
    const probe=join(temporary,'probe.mjs')
    await writeFile(probe,`import {syncBuiltinESMExports} from 'node:module'
import cp from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import dns from 'node:dns'
const deny=()=>{throw new Error('PROVIDER_IMPORT_EFFECT_FORBIDDEN')}
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=deny
for(const key of ['connect','createConnection','createServer'])net[key]=deny
tls.connect=deny;tls.createServer=deny
for(const module of [http,https])for(const key of ['get','request','createServer'])module[key]=deny
dgram.createSocket=deny;dns.lookup=deny;dns.resolve=deny;dns.promises.lookup=deny;dns.promises.resolve=deny
globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny()}};syncBuiltinESMExports()
const [muse,runtime,connection,auth,pi]=await Promise.all([
import('@muse-code/sdk'),import('pi-antigravity-acp-provider/dist/runtime.js'),import('pi-antigravity-acp-provider/dist/acp/connection.js'),import('pi-antigravity-acp-provider/dist/acp/antigravity.js'),import('@earendil-works/pi-ai')])
for(const value of [muse.spawnMspConnection,runtime.AntigravityRuntime,connection.AntigravityAcpConnection,auth.inspectAntigravityAuth,auth.clearAntigravityCredentials,pi.collapseSystemMessages,pi.getCurrentSystemPrompt,pi.getCurrentTools,pi.normalizeContext])if(typeof value!=='function')throw new Error('PROVIDER_IMPORT_API_MISMATCH')
process.stdout.write(JSON.stringify({muse:true,googleRuntime:true,googleConnection:true,googleAuth:true,nativePiAi:'1.1.0',networkUsed:false,runtimeStarted:false}))
`)
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP)$/iu.test(key)))
    env.ELECTRON_RUN_AS_NODE='1'
    let output
    try{output=await execFileAsync(process.execPath,[probe],{cwd:temporary,env,windowsHide:true,timeout:30000,maxBuffer:64*1024})}
    catch{throw new Error('PROVIDER_EXTENSIONS_IMPORT_PROBE_FAILED')}
    try{const result=JSON.parse(output.stdout);if(!result.muse||!result.googleRuntime||result.nativePiAi!=='1.1.0'||result.networkUsed||result.runtimeStarted)throw new Error();return result}
    catch{throw new Error('PROVIDER_EXTENSIONS_IMPORT_PROBE_INVALID')}
  }finally{
    if(!inside(target,resolve(temporary))||resolve(temporary)===target)throw new Error('PROVIDER_EXTENSIONS_TEMP_ESCAPE')
    await rm(temporary,{recursive:true,force:true})
  }
}

/** Copy a pinned library-only closure into an already copied source plugin. */
export async function stageProviderExtensionsDependencies({modulesRoot,targetRoot,nativeModulesRoot}){
  const source=await directory(modulesRoot),target=await directory(targetRoot),targetModules=join(target,'node_modules')
  if(inside(source,target)||inside(target,source))throw new Error('PROVIDER_EXTENSIONS_SELF_COPY_REJECTED')
  const bytes=await readFile(LOCK),lock=JSON.parse(bytes);validateLock(lock)
  // Fail before copy when the required native ABI cannot be supplied to the probe.
  const peer=await nativePeer(nativeModulesRoot,target),peerMeta=JSON.parse(await readFile(join(peer,'package.json'),'utf8'))
  if(peerMeta.name!=='@earendil-works/pi-ai'||peerMeta.version!=='1.1.0')throw new Error('PROVIDER_EXTENSIONS_NATIVE_PEER_MISMATCH')
  const plugin=JSON.parse(await readFile(join(target,'package.json'),'utf8'))
  if(plugin.name!=='airules-dsh-provider-extensions')throw new Error('PROVIDER_EXTENSIONS_TARGET_PACKAGE_REJECTED')
  const actual=await inspectPackageClosure({modulesRoot:source,roots:lock.roots})
  if(JSON.stringify(actual)!==JSON.stringify(lock))throw new Error('PROVIDER_EXTENSIONS_LOCK_MISMATCH')
  for(const row of lock.packages)await safeFiles(join(source,row.path))
  await directory(targetModules,true)
  await stagePackageClosure({modulesRoot:source,targetModulesRoot:targetModules,lock})
  const importProbe=await verifyProviderExtensionsImports({targetRoot:target,nativeModulesRoot})
  return {dependencyLockSha256:hash(bytes),privateRuntimePackages:lock.packages.map(({name,version,license,sha256,path})=>({name,version,license,sha256,path})),
    importProbe,externalPeers:[{name:'@earendil-works/pi-ai',version:'1.1.0',providedBy:'native-host'}],networkUsed:false,installScriptsExecuted:false,runtimeBinariesCopied:false}
}
