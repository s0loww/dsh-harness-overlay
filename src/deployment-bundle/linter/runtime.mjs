import {readFile,readdir,mkdir,writeFile,stat} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:net'
import {guard,hashFile,safeRelative,same,json,fail} from '../lib/fs.mjs'
import {LINTER_LOCK,JAVA_LINTER_ARGS,renderBslWrapper} from './lock.mjs'
import {LINTER_FILE_LOCK} from './lock-files.mjs'
const execute=promisify(execFile),tick=ms=>new Promise(r=>setTimeout(r,ms))
export function linterChildEnvironment(parent=process.env){const env={...parent};for(const key of Object.keys(env))if(['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS'].includes(key.toUpperCase()))delete env[key];return env}
export {LINTER_LOCK,JAVA_LINTER_ARGS,renderBslWrapper}
export async function verifyLinterRuntime({assetsRoot}){
 const root=resolve(assetsRoot);await guard(root,{allowMissing:false});const manifest=await json(join(root,'metadata.json'))
 if(manifest?.schemaVersion!==1||manifest.kind!=='airules-local-bsl-runtime'||JSON.stringify(manifest.lock)!==JSON.stringify(LINTER_LOCK)||!manifest.files||Object.keys(manifest.files).length>4096)fail('LINTER_RUNTIME_MANIFEST_INVALID')
 if(!same(manifest.files,LINTER_FILE_LOCK))fail('LINTER_RUNTIME_INVENTORY_INVALID')
 const actualNames=[];async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);await guard(path,{allowMissing:false});if(entry.isDirectory())await walk(path);else{const name=path.slice(root.length+1).replaceAll('\\','/');if(name!=='metadata.json')actualNames.push(name)}}}await walk(root)
 if(JSON.stringify(actualNames.sort())!==JSON.stringify(Object.keys(LINTER_FILE_LOCK).sort()))fail('LINTER_RUNTIME_UNLISTED_FILE')
 for(const name of ['java/bin/java.exe','bsl-language-server.jar','bsl-language-server.cmd','java/release'])if(!manifest.files[name])fail('LINTER_RUNTIME_ENTRY_MISSING')
 for(const[name,expected]of Object.entries(manifest.files)){const actual=await hashFile(safeRelative(root,name));if(!same(actual,expected))fail('LINTER_RUNTIME_HASH_MISMATCH')}
 const jar=manifest.files['bsl-language-server.jar'];if(jar.bytes!==LINTER_LOCK.bsl.jarBytes||jar.sha256!==LINTER_LOCK.bsl.jarSha256)fail('LINTER_RUNTIME_PIN_MISMATCH')
 const release=await readFile(join(root,'java/release'),'utf8');if(!release.includes('IMPLEMENTOR="Eclipse Adoptium"')||!release.includes('JAVA_RUNTIME_VERSION="21.0.13+9-LTS"'))fail('LINTER_JAVA_IDENTITY_INVALID')
 if((await readFile(join(root,'bsl-language-server.cmd'),'utf8'))!==renderBslWrapper())fail('LINTER_RUNTIME_WRAPPER_INVALID')
 return{status:'PASS',files:Object.keys(manifest.files).length,bytes:Object.values(manifest.files).reduce((s,v)=>s+v.bytes,0),javaVersion:LINTER_LOCK.java.version,bslVersion:LINTER_LOCK.bsl.version}
}
function startJsonRpc(javaPath,jarPath,cwd,configurationPath){
 const child=spawn(javaPath,[...JAVA_LINTER_ARGS,'-jar',jarPath,'lsp','-c',configurationPath],{cwd,env:linterChildEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']})
 let buffer=Buffer.alloc(0),noise=0;const pending=new Map();let failure
 const rejectAll=error=>{failure=error;for(const p of pending.values())p.reject(error);pending.clear()}
 child.on('error',rejectAll);child.stderr.on('data',chunk=>{noise+=chunk.length;if(noise>1024*1024)child.kill()})
 child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const marker=buffer.indexOf('\r\n\r\n');if(marker<0){if(buffer.length>1024*1024)rejectAll(Error('LINTER_LSP_HEADER_INVALID'));return}const header=buffer.subarray(0,marker).toString('ascii'),match=header.match(/(?:^|\r\n)Content-Length: (\d+)/iu);if(!match)return rejectAll(Error('LINTER_LSP_HEADER_INVALID'));const length=Number(match[1]);if(length>16*1024*1024)return rejectAll(Error('LINTER_LSP_FRAME_TOO_LARGE'));if(buffer.length<marker+4+length)return;const frame=JSON.parse(buffer.subarray(marker+4,marker+4+length).toString('utf8'));buffer=buffer.subarray(marker+4+length);if(frame.id!==undefined&&pending.has(frame.id)){const promise=pending.get(frame.id);pending.delete(frame.id);frame.error?promise.reject(Error('LINTER_LSP_RESPONSE_FAILED')):promise.resolve(frame.result)}}})
 const send=value=>{const body=Buffer.from(JSON.stringify(value));child.stdin.write('Content-Length: '+body.length+'\r\n\r\n');child.stdin.write(body)}
 return{child,send,request:(id,method,params)=>new Promise((resolve,reject)=>{if(failure)return reject(failure);const timer=setTimeout(()=>{pending.delete(id);reject(Error('LINTER_LSP_TIMEOUT'));child.kill()},45000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});send({jsonrpc:'2.0',id,method,params})})}
}
async function availablePort(){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)});const port=server.address().port;await new Promise(r=>server.close(r));return port}
export async function probeLinterRuntime({assetsRoot,javaPath=join(assetsRoot,'java/bin/java.exe'),jarPath=join(assetsRoot,'bsl-language-server.jar'),fixtureRoot,reportPath,websocket=true}){
 const root=resolve(fixtureRoot);await guard(root);try{await stat(root);fail('LINTER_PROBE_FRESH_ROOT_REQUIRED')}catch(error){if(error.code!=='ENOENT')throw error}await mkdir(join(root,'src'),{recursive:true});await mkdir(join(root,'reports'))
 const checks=[],check=(name,value)=>{if(!value)fail('LINTER_PROBE_FAILED',{check:name});checks.push({name,passed:true})},configurationPath=join(root,'.bsl-language-server.json')
 await writeFile(configurationPath,JSON.stringify({language:'ru',sendErrors:'never',traceLog:null})+'\n');await writeFile(join(root,'src/Module.bsl'),'Процедура Проверка()\n    НеиспользуемаяПеременная = 1;\nКонецПроцедуры\n','utf8')
 const base=[...JAVA_LINTER_ARGS,'-jar',resolve(jarPath)],java=resolve(javaPath),options={cwd:root,env:linterChildEnvironment(),windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024}
 const jversion=await execute(java,['-version'],options);check('portable Java 21 starts',jversion.stderr.includes('21.0.13')&&jversion.stderr.includes('Temurin'))
 const version=await execute(java,[...base,'--version'],options);check('pinned BSL Language Server version starts',version.stdout.includes('version: 1.0.7'))
 await execute(java,[...base,'analyze','-s',join(root,'src'),'-c',configurationPath,'-o',join(root,'reports'),'-r','json'],options)
 const diagnostics=JSON.parse(await readFile(join(root,'reports/bsl-json.json'),'utf8'));check('CLI analyze returns actual BSL diagnostics',diagnostics.fileinfos?.some(file=>file.diagnostics?.some(d=>d.code==='UnusedLocalVariable')))
 const rpc=startJsonRpc(java,resolve(jarPath),root,configurationPath)
 try{const result=await rpc.request(1,'initialize',{processId:process.pid,rootUri:pathToFileURL(root).href,capabilities:{},workspaceFolders:[{uri:pathToFileURL(root).href,name:'isolated-linter-fixture'}]});check('stdio LSP initialize returns server capabilities',!!result?.capabilities);rpc.send({jsonrpc:'2.0',method:'initialized',params:{}});const shutdown=await rpc.request(2,'shutdown',null);check('stdio LSP shutdown acknowledged',shutdown===true||shutdown==null||typeof shutdown==='object'&&!Array.isArray(shutdown)&&Object.keys(shutdown).length===0);rpc.send({jsonrpc:'2.0',method:'exit'});rpc.child.stdin.end();await Promise.race([new Promise(r=>rpc.child.once('exit',r)),tick(10000)]);check('stdio LSP exits normally',rpc.child.exitCode===0)}finally{if(rpc.child.exitCode===null)rpc.child.kill()}
 if(websocket){const port=await availablePort(),child=spawn(java,[...base,'websocket','--server.port='+port,'-c',configurationPath],{cwd:root,env:linterChildEnvironment(),windowsHide:true,stdio:['ignore','ignore','ignore']});try{let ready=false;for(let i=0;i<45;i++){if(child.exitCode!==null)fail('LINTER_WEBSOCKET_EXITED');try{const response=await fetch('http://127.0.0.1:'+port+'/lsp',{signal:AbortSignal.timeout(1000)});ready=[400,403,404,405,426].includes(response.status);await response.body?.cancel();if(ready)break}catch{}await tick(500)}check('editor websocket HTTP service starts on explicit loopback',ready);if(process.platform==='win32'){const script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-NetTCPConnection -OwningProcess "+child.pid+" -State Listen -ErrorAction SilentlyContinue|Select-Object LocalAddress,LocalPort)|ConvertTo-Json -Compress";const net=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options);let rows=JSON.parse(net.stdout.trim()||'[]');if(!Array.isArray(rows))rows=[rows];check('owned editor listener is loopback-only',rows.some(r=>r.LocalPort===port)&&rows.every(r=>['127.0.0.1','::1'].includes(r.LocalAddress)))}}finally{child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),tick(10000)])}}
 const report={status:'PASS',checks,javaVersion:LINTER_LOCK.java.version,bslVersion:LINTER_LOCK.bsl.version,configuration:{language:'ru',sendErrors:'never'},projectFilesTouched:false,registryChanged:false,systemJavaHomeChanged:false,sourceFixtureOnly:true};if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');return report
}
