import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,open} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {probeDocker,planDockerPrerequisites,ensureDocker,verifyBootstrapAsset,BOOTSTRAP_VENDOR_ASSETS,WINDOWS_HOST_PROBE} from '../src/deployment-bundle/bootstrap/index.mjs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const response=value=>({code:0,stdout:JSON.stringify(value)})
function fixture(overrides={}){
 const host={platform:'win32',arch:'x64',osBuild:26100,productType:1,memoryBytes:16*1024**3,freeDiskBytes:100*1024**3,virtualizationEnabled:true,slat:true,virtualMachinePlatform:'enabled',legacyWslFeature:'enabled',pendingReboot:false,isAdmin:false,wslAvailable:true,dockerExecutable:join(tmpdir(),'Docker','docker.exe'),desktopExecutable:join(tmpdir(),'Docker','Docker Desktop.exe'),...overrides}
 const runs=[],launches=[];let engine='linux',compose='v2.40.0',wsl='WSL version: 2.6.3.0',launchCode=0
 const run=async spec=>{runs.push(spec);if(spec.operation==='host-inventory')return response(host);if(spec.operation==='wsl-version')return{code:0,stdout:wsl};if(spec.operation==='docker-info')return engine?response({OSType:engine,ServerVersion:'fixture'}):{code:1,stdout:''};if(spec.operation==='docker-compose-version')return{code:0,stdout:compose};throw Error('UNEXPECTED_RUN')}
 const launch=async spec=>{launches.push(spec);return{code:launchCode}}
 const manifest={components:{bootstrap:{dockerInstaller:{path:'payload/vendor/DockerDesktopInstaller-amd64.exe',...BOOTSTRAP_VENDOR_ASSETS.dockerInstaller},wslInstaller:{path:'payload/vendor/wsl.3.0.5.0.x64.msi',...BOOTSTRAP_VENDOR_ASSETS.wslInstaller}}}}
 const verified=[];const verifyAsset=async args=>{verified.push(args);return{path:join(tmpdir(),'bundled',args.asset.path.split('/').at(-1)),sha256:args.asset.sha256,bytes:args.asset.bytes,signer:args.kind==='dockerInstaller'?'Docker Inc':'Microsoft Corporation'}}
 return{host,runs,launches,verified,options:{bundleRoot:resolve('fixture-bundle'),manifest,run,launch,verifyAsset,platform:'win32',arch:'x64'},engine:value=>{engine=value},wsl:value=>{wsl=value},compose:value=>{compose=value},launchCode:value=>{launchCode=value}}
}
async function temp(t){const root=await mkdtemp(join(tmpdir(),'airules-bootstrap-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-bootstrap-'));await rm(root,{recursive:true,force:true})});return root}
test('existing Linux Docker and Compose reuse only fixed local read probes with no launcher or global context changes',async()=>{
 const f=fixture(),result=await ensureDocker({...f.options,allowInstall:true});assert.equal(result.status,'ready');assert.equal(result.reuse,true);assert.equal(f.launches.length,0);assert.equal(f.verified.length,0)
 for(const spec of f.runs.filter(row=>row.operation.startsWith('docker-'))){assert.deepEqual(spec.args.slice(0,2),['--host','npipe:////./pipe/docker_engine']);assert.ok(!Object.keys(spec.env).some(key=>key.startsWith('DOCKER_')))}
 assert.ok(f.runs.every(spec=>!spec.args.includes('context')&&!spec.args.includes('--install')))
})
test('missing Docker produces a read-only plan and interactive verified vendor install never auto-accepts terms',async()=>{
 const f=fixture({dockerExecutable:null,desktopExecutable:null});assert.equal((await ensureDocker(f.options)).reason,'DOCKER_DESKTOP_REQUIRED');assert.equal(f.launches.length,0)
 const result=await ensureDocker({...f.options,allowInstall:true});assert.equal(result.status,'waiting-for-user');assert.equal(result.reason,'START_DOCKER_AND_REVIEW_VENDOR_TERMS');assert.equal(f.verified[0].kind,'dockerInstaller');assert.equal(f.launches.length,1)
 assert.deepEqual(f.launches[0].args,['install','--user','--backend=wsl-2']);assert.equal(f.launches[0].interactive,true);assert.equal(f.launches[0].wait,true);assert.ok(!JSON.stringify(f.launches).includes('--accept-license'))
})

test('malformed executable inventory refuses with a bounded error before launching any command',async()=>{
 for(const field of ['dockerExecutable','desktopExecutable'])for(const value of [{},[],42,true]){
  const f=fixture({[field]:value});await assert.rejects(probeDocker(f.options),/^Error: BOOTSTRAP_HOST_PROBE_INVALID$/u);assert.equal(f.runs.length,1);assert.equal(f.launches.length,0)
 }
})

test('Windows PowerShell 5 actual host probe normalizes absent and discovered Docker paths before planning', {skip:process.platform!=='win32'},async t=>{
 const execute=promisify(execFile),systemRoot='C:\\Fixture Programs\\Docker\\Docker',userRoot='C:\\Fixture Профиль\\Programs\\DockerDesktop',docker=p=>p+'\\resources\\bin\\docker.exe',desktop=p=>p+'\\Docker Desktop.exe',literal=s=>"'"+s.replaceAll("'","''")+"'"
 const cases=[
  {name:'no Docker on clean host',paths:[],cli:null,desktop:null},
  {name:'system install',paths:[docker(systemRoot),desktop(systemRoot)],cli:docker(systemRoot),desktop:desktop(systemRoot)},
  {name:'per-user install with spaces and Unicode',paths:[docker(userRoot),desktop(userRoot)],cli:docker(userRoot),desktop:desktop(userRoot)},
  {name:'both locations prefer system install',paths:[docker(systemRoot),desktop(systemRoot),docker(userRoot),desktop(userRoot)],cli:docker(systemRoot),desktop:desktop(systemRoot)},
  {name:'only CLI remains',paths:[docker(systemRoot)],cli:docker(systemRoot),desktop:null},
  {name:'only desktop remains',paths:[desktop(userRoot)],cli:null,desktop:desktop(userRoot)},
 ]
 for(const row of cases)await t.test(row.name,async()=>{
  const mock=String.raw`$ProgressPreference='SilentlyContinue'
$env:ProgramFiles='C:\Fixture Programs'
$env:LOCALAPPDATA='C:\Fixture Профиль'
function Get-CimInstance { param($ClassName,$Filter) switch($ClassName){'Win32_OperatingSystem'{[pscustomobject]@{BuildNumber='26100';ProductType=1}} 'Win32_ComputerSystem'{[pscustomobject]@{TotalPhysicalMemory=17179869184;HypervisorPresent=$true}} 'Win32_Processor'{[pscustomobject]@{VirtualizationFirmwareEnabled=$true;SecondLevelAddressTranslationExtensions=$true}} 'Win32_LogicalDisk'{[pscustomobject]@{FreeSpace=107374182400}} 'Win32_OptionalFeature'{[pscustomobject]@{InstallState=1}} default{throw 'UNEXPECTED_CLASS'}}}
function Get-Command { param($Name,$ErrorAction) if($Name -eq 'wsl.exe'){[pscustomobject]@{Name='wsl.exe'}}else{throw 'UNEXPECTED_COMMAND'} }
$script:present=@(${row.paths.map(literal).join(',')})
function Test-Path { param($LiteralPath,$Path) if($LiteralPath){$script:present -contains [string]$LiteralPath}else{$script:present -contains [string]$Path} }
`
  const script='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n'+mock+WINDOWS_HOST_PROBE
  const ps=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
  const actual=JSON.parse(ps.stdout.trim());assert.equal(actual.dockerExecutable,row.cli);assert.equal(actual.desktopExecutable,row.desktop)
  for(const field of ['dockerExecutable','desktopExecutable'])assert.ok(actual[field]===null||typeof actual[field]==='string')
  const f=fixture(actual);f.engine(null);const result=await ensureDocker({...f.options,allowInstall:true})
  if(!row.cli||!row.desktop){assert.equal(result.operation,'install-docker');assert.equal(f.launches[0].operation,'install-docker');assert.equal(f.verified[0].kind,'dockerInstaller')}
  else{assert.equal(result.operation,'start-docker');assert.equal(f.launches[0].file,row.desktop)}
 })
})
test('WSL feature bootstrap requests native elevation, never restarts Windows and records resumable reboot status',async t=>{
 const f=fixture({dockerExecutable:null,desktopExecutable:null,virtualMachinePlatform:'disabled'}),root=await temp(t),receiptPath=join(root,'receipt.json'),result=await ensureDocker({...f.options,allowInstall:true,receiptPath})
 assert.equal(result.status,'reboot-required');assert.equal(f.launches.length,1);assert.equal(f.launches[0].file,'dism.exe');assert.equal(f.launches[0].elevated,true);assert.ok(f.launches[0].args.includes('/norestart'));assert.ok(!f.launches[0].args.some(arg=>/disable|remove/iu.test(arg)));assert.equal(JSON.parse(await readFile(receiptPath,'utf8')).operation,'enable-virtual-machine-platform')
})
test('old WSL uses bundled Microsoft MSI interactively without downloading a distro or changing the default WSL distribution',async()=>{
 const f=fixture({dockerExecutable:null,desktopExecutable:null});f.wsl('WSL version 1.0.0');const result=await ensureDocker({...f.options,allowInstall:true})
 assert.equal(result.operation,'install-wsl');assert.equal(f.verified[0].kind,'wslInstaller');assert.equal(f.launches[0].file,'msiexec.exe');assert.equal(f.launches[0].args[0],'/i');assert.equal(f.launches[0].args.at(-1),'/norestart');assert.equal(f.launches[0].interactive,true);assert.equal(f.launches[0].elevated,true)
 f.launchCode(3010);assert.equal((await ensureDocker({...f.options,allowInstall:true})).status,'reboot-required')
})
test('hardware, unsupported hosts, pending reboot and a Windows engine do not trigger blind installs or engine switches',async()=>{
 for(const patch of [{arch:'arm64'},{osBuild:22000},{productType:3},{memoryBytes:4*1024**3},{freeDiskBytes:5*1024**3},{virtualizationEnabled:false},{slat:false},{pendingReboot:true},{virtualMachinePlatform:'unknown'}]){
  const f=fixture({dockerExecutable:null,desktopExecutable:null,...patch});if(patch.arch){assert.equal(planDockerPrerequisites({host:f.host,docker:{}}).reason,'WINDOWS_X64_REQUIRED');continue}const result=await ensureDocker({...f.options,allowInstall:true});assert.notEqual(result.status,'ready');assert.equal(f.launches.length,0)
 }
 const f=fixture();f.engine('windows');const result=await ensureDocker({...f.options,allowInstall:true});assert.equal(result.reason,'SWITCH_TO_LINUX_ENGINE');assert.equal(f.launches.length,0)
 const stopped=fixture();stopped.engine(null);assert.equal((await ensureDocker({...stopped.options,allowInstall:true})).operation,'start-docker');assert.equal(stopped.launches[0].file,stopped.host.desktopExecutable);assert.equal(stopped.launches[0].wait,false)
})
test('installer cancellation and aborted authorization never continue into another bootstrap phase',async()=>{
 const f=fixture({dockerExecutable:null,desktopExecutable:null});f.launchCode(1602);await assert.rejects(ensureDocker({...f.options,allowInstall:true}),/INSTALLER_NOT_COMPLETED/);assert.equal(f.launches.length,1)
 const aborted=fixture({dockerExecutable:null,desktopExecutable:null}),cancel=new AbortController();cancel.abort();await assert.rejects(ensureDocker({...aborted.options,allowInstall:true,signal:cancel.signal}));assert.equal(aborted.launches.length,0)
})
test('asset verification rejects a local maintenance stub, changed bytes, bad signer and traversal before any installer launch',async t=>{
 const root=await temp(t),path=join(root,'wsl.msi'),handle=await open(path,'wx');await handle.truncate(50*1024**2);await handle.close();const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);const asset={path:'wsl.msi',bytes:50*1024**2,sha256:hash.digest('hex')};let signatures=0
 const run=async()=>{signatures++;return response({status:'Valid',subject:'CN=Microsoft Corporation, O=Microsoft Corporation'})}
 assert.equal((await verifyBootstrapAsset({bundleRoot:root,asset,kind:'wslInstaller',run})).bytes,asset.bytes);assert.equal(signatures,1)
 await assert.rejects(verifyBootstrapAsset({bundleRoot:root,asset:{...asset,sha256:'0'.repeat(64)},kind:'wslInstaller',run}),/HASH_MISMATCH/);assert.equal(signatures,1)
 await assert.rejects(verifyBootstrapAsset({bundleRoot:root,asset,kind:'wslInstaller',run:async()=>response({status:'Valid',subject:'CN=Other Company, O=Other'})}),/VENDOR_SIGNATURE_INVALID/)
 await assert.rejects(verifyBootstrapAsset({bundleRoot:root,asset:{...asset,path:'../outside.msi'},kind:'wslInstaller',run}),/ASSET_PATH_INVALID/)
 await assert.rejects(verifyBootstrapAsset({bundleRoot:root,asset:{path:'stub.exe',bytes:7*1024**2,sha256:'0'.repeat(64)},kind:'dockerInstaller',run}),/ASSET_INVALID/)
})
