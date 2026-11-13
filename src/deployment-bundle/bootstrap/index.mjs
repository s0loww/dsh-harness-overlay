import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat,realpath,mkdir,writeFile,rename,unlink} from 'node:fs/promises'
import {resolve,dirname,join,isAbsolute,relative,parse} from 'node:path'

const fail=code=>{throw Error(code)}
const PIPE='npipe:////./pipe/docker_engine'
const key=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path)
export const BOOTSTRAP_VENDOR_ASSETS=Object.freeze({
 dockerInstaller:{filename:'DockerDesktopInstaller-amd64.exe',version:'4.99.0.245822',bytes:623969712,sha256:'a5e299131c9c53d60f3f752b162078945eb5faf6eedcf0be20a214c6e6cea444',signer:'Docker Inc',sourceUrl:'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'},
 wslInstaller:{filename:'wsl.3.0.5.0.x64.msi',version:'3.0.5.0',bytes:367788032,sha256:'2313efc5873e3f8552f42e77f950fabd913c0289078fa89d2100f3421a525eaa',signer:'Microsoft Corporation',sourceUrl:'https://github.com/microsoft/WSL/releases/download/3.0.5/wsl.3.0.5.0.x64.msi'},
})
export const WINDOWS_HOST_PROBE=String.raw`$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$system=Get-CimInstance Win32_ComputerSystem
$cpu=@(Get-CimInstance Win32_Processor)[0]
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
function FeatureState($name){try{$item=Get-CimInstance Win32_OptionalFeature -Filter "Name='$name'";if($item.InstallState -eq 1){'enabled'}elseif($item.InstallState -eq 2){'disabled'}else{'unknown'}}catch{'unknown'}}
$programRoots=@((Join-Path $env:ProgramFiles 'Docker\Docker'),(Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop'))
$docker=@($programRoots|ForEach-Object{Join-Path $_ 'resources\bin\docker.exe'}|Where-Object{Test-Path -LiteralPath $_})[0]
$docker=if($docker){[string]$docker}else{$null}
$desktop=@($programRoots|ForEach-Object{Join-Path $_ 'Docker Desktop.exe'}|Where-Object{Test-Path -LiteralPath $_})[0]
$desktop=if($desktop){[string]$desktop}else{$null}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[pscustomobject]@{platform='win32';arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLower();osBuild=[int]$os.BuildNumber;productType=[int]$os.ProductType;memoryBytes=[double]$system.TotalPhysicalMemory;freeDiskBytes=[double]$disk.FreeSpace;virtualizationEnabled=([bool]$cpu.VirtualizationFirmwareEnabled -or [bool]$system.HypervisorPresent);slat=([bool]$cpu.SecondLevelAddressTranslationExtensions -or [bool]$system.HypervisorPresent);virtualMachinePlatform=(FeatureState 'VirtualMachinePlatform');legacyWslFeature=(FeatureState 'Microsoft-Windows-Subsystem-Linux');pendingReboot=((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'));isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);dockerExecutable=$docker;desktopExecutable=$desktop;wslAvailable=[bool](Get-Command wsl.exe -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress`
const encoded=script=>Buffer.from(script,'utf16le').toString('base64')
const powershell=(operation,script,signal)=>({operation,file:'powershell.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n'+script)],signal,timeoutMs:30000})
const resultCode=value=>value?.code??value?.exitCode
function output(value){if(!value||typeof value.stdout!=='string'||Buffer.byteLength(value.stdout)>1024*1024)fail('BOOTSTRAP_PROBE_OUTPUT_INVALID');return value.stdout.replace(/\0/gu,'').replace(/^\uFEFF/u,'').trim()}
function json(value){try{return JSON.parse(output(value))}catch{fail('BOOTSTRAP_PROBE_OUTPUT_INVALID')}}
const version=value=>typeof value==='string'?value.match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:\.\d+)?)/u)?.[1]??null:null
function atLeast(actual,required){if(!actual)return false;const a=actual.split('.').map(Number),b=required.split('.').map(Number);for(let index=0;index<Math.max(a.length,b.length);index++){if((a[index]??0)!==(b[index]??0))return(a[index]??0)>(b[index]??0)}return true}
function scrubDockerEnv(){const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('DOCKER_'))delete env[name];return env}
/** Read probes only: fixed local Docker pipe, no context/network/service changes. */
export async function probeDocker({run,signal,platform=process.platform,arch=process.arch}={}){
 if(typeof run!=='function')fail('BOOTSTRAP_RUNNER_REQUIRED')
 if(platform!=='win32'||arch!=='x64')return{host:{platform,arch},docker:{ready:false},wslVersion:null}
 signal?.throwIfAborted();const hostResult=await run(powershell('host-inventory',WINDOWS_HOST_PROBE,signal))
 if(resultCode(hostResult)!==0)fail('BOOTSTRAP_HOST_PROBE_FAILED')
 const host=json(hostResult)
 if(host.platform!=='win32'||host.arch!=='x64'||!Number.isSafeInteger(host.osBuild)||!Number.isFinite(host.memoryBytes)||!Number.isFinite(host.freeDiskBytes)||![1,2,3].includes(host.productType)||!['enabled','disabled','unknown'].includes(host.virtualMachinePlatform))fail('BOOTSTRAP_HOST_PROBE_INVALID')
 for(const field of ['dockerExecutable','desktopExecutable'])if(host[field]!==null&&host[field]!==undefined&&(typeof host[field]!=='string'||!isAbsolute(host[field])||!host[field].toLowerCase().endsWith('.exe')))fail('BOOTSTRAP_HOST_PROBE_INVALID')
 let wslVersion=null
 if(host.wslAvailable){const row=await run({operation:'wsl-version',file:'wsl.exe',args:['--version'],signal,timeoutMs:15000});if(resultCode(row)===0)wslVersion=version(output(row))}
 const docker={installed:!!host.dockerExecutable&&!!host.desktopExecutable,ready:false,engine:'unavailable',composeVersion:null,endpoint:PIPE}
 if(host.dockerExecutable){
  const info=await run({operation:'docker-info',file:host.dockerExecutable,args:['--host',PIPE,'info','--format','{{json .}}'],env:scrubDockerEnv(),signal,timeoutMs:20000})
  if(resultCode(info)===0){const value=json(info);docker.engine=value.OSType==='linux'?'linux':value.OSType==='windows'?'windows':'unknown';docker.serverVersion=typeof value.ServerVersion==='string'?value.ServerVersion.slice(0,80):null}
  if(docker.engine==='linux'){const compose=await run({operation:'docker-compose-version',file:host.dockerExecutable,args:['--host',PIPE,'compose','version','--short'],env:scrubDockerEnv(),signal,timeoutMs:15000});if(resultCode(compose)===0)docker.composeVersion=version(output(compose));docker.ready=atLeast(docker.composeVersion,'2.0.0')}
 }
 signal?.throwIfAborted();return{host,docker,wslVersion}
}
/** New installation is restricted to supported Windows 11 x64 workstation hosts. */
export function planDockerPrerequisites(snapshot){
 const{host,docker,wslVersion}=snapshot??{}
 if(host?.platform!=='win32'||host?.arch!=='x64')return{status:'blocked',reason:'WINDOWS_X64_REQUIRED',actions:[]}
 if(docker?.ready)return{status:'ready',reason:'EXISTING_LINUX_ENGINE',reuse:true,actions:[]}
 if(docker?.engine==='windows')return{status:'waiting-for-user',reason:'SWITCH_TO_LINUX_ENGINE',actions:[]}
 if(docker?.engine==='linux')return{status:'waiting-for-user',reason:'COMPOSE_V2_REQUIRED',actions:[]}
 if(host.productType!==1||host.osBuild<22631)return{status:'blocked',reason:'WINDOWS_11_23H2_REQUIRED',actions:[]}
 if(host.memoryBytes<8*1024**3)return{status:'blocked',reason:'MEMORY_8_GIB_REQUIRED',actions:[]}
 if(host.freeDiskBytes<20*1024**3)return{status:'blocked',reason:'FREE_DISK_20_GIB_REQUIRED',actions:[]}
 if(host.virtualizationEnabled!==true||host.slat!==true)return{status:'waiting-for-user',reason:'FIRMWARE_VIRTUALIZATION_REQUIRED',actions:[]}
 if(host.pendingReboot)return{status:'reboot-required',reason:'WINDOWS_REBOOT_PENDING',actions:[]}
 if(host.virtualMachinePlatform==='unknown')return{status:'waiting-for-user',reason:'FEATURE_STATE_UNVERIFIED',actions:[]}
 if(host.virtualMachinePlatform!=='enabled')return{status:'bootstrap-required',reason:'VIRTUAL_MACHINE_PLATFORM_REQUIRED',actions:['enable-virtual-machine-platform']}
 if(!atLeast(wslVersion,'2.1.5'))return{status:'bootstrap-required',reason:'WSL_UPDATE_REQUIRED',actions:['install-wsl']}
 if(!docker.installed)return{status:'bootstrap-required',reason:'DOCKER_DESKTOP_REQUIRED',actions:['install-docker']}
 return{status:'waiting-for-user',reason:'DOCKER_DESKTOP_NOT_RUNNING',actions:['start-docker']}
}
async function guard(path){
 if(!isAbsolute(path??''))fail('BOOTSTRAP_PATH_REQUIRED')
 const paths=[];let at=resolve(path);while(true){paths.unshift(at);const parent=dirname(at);if(parent===at)break;at=parent}
 for(let index=0;index<paths.length;index++)try{const info=await lstat(paths[index]);if(info.isSymbolicLink()||key(await realpath(paths[index]))!==key(paths[index])||index<paths.length-1&&!info.isDirectory()||info.isFile()&&info.nlink!==1)fail('BOOTSTRAP_PATH_REJECTED')}catch(error){if(error.code==='ENOENT')return;throw error}
}
function assetPath(root,value){if(!isAbsolute(root??'')||typeof value!=='string'||value.includes('\\')||value.includes(':')||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('BOOTSTRAP_ASSET_PATH_INVALID');const result=resolve(root,...value.split('/'));if(relative(resolve(root),result).startsWith('..'))fail('BOOTSTRAP_ASSET_PATH_INVALID');return result}
/** Recheck full payload bytes and vendor Authenticode on the recipient. */
export async function verifyBootstrapAsset({bundleRoot,asset,kind,run,signal}){
 if(!['dockerInstaller','wslInstaller'].includes(kind)||!asset||!/^[a-f0-9]{64}$/u.test(asset.sha256??'')||!Number.isSafeInteger(asset.bytes)||asset.bytes<(kind==='dockerInstaller'?100:50)*1024**2)fail('BOOTSTRAP_ASSET_INVALID')
 const path=assetPath(bundleRoot,asset.path);await guard(path);const info=await lstat(path)
 if(!info.isFile()||info.size!==asset.bytes||!path.toLowerCase().endsWith(kind==='dockerInstaller'?'.exe':'.msi'))fail('BOOTSTRAP_ASSET_INVALID')
 const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk)}if(hash.digest('hex')!==asset.sha256)fail('BOOTSTRAP_ASSET_HASH_MISMATCH')
 const path64=Buffer.from(path,'utf8').toString('base64'),script=`$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path64}'));$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $p;[pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`
 const signature=await run(powershell('verify-vendor-signature',script,signal));if(resultCode(signature)!==0)fail('BOOTSTRAP_VENDOR_SIGNATURE_INVALID');const signed=json(signature),expected=kind==='dockerInstaller'?'Docker Inc':'Microsoft Corporation'
 if(signed.status!=='Valid'||typeof signed.subject!=='string'||!signed.subject.includes('CN='+expected+','))fail('BOOTSTRAP_VENDOR_SIGNATURE_INVALID')
 await guard(path);signal?.throwIfAborted();return{path,sha256:asset.sha256,bytes:asset.bytes,signer:expected}
}
async function receipt(path,value){if(!path)return;await guard(path);await mkdir(dirname(path),{recursive:true});await guard(path);const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,path)}finally{await unlink(temp).catch(()=>{})}}
/** One resumable setup step. No silent legal acceptance, reboot or uninstallation. */
export async function ensureDocker({bundleRoot,manifest,run,launch,signal,allowInstall=false,receiptPath,platform=process.platform,arch=process.arch,verifyAsset=verifyBootstrapAsset}={}){
 const snapshot=await probeDocker({run,signal,platform,arch}),plan=planDockerPrerequisites(snapshot),result={schemaVersion:1,kind:'airules-docker-bootstrap',...plan,checkedAt:new Date().toISOString(),snapshot,changed:false}
 if(plan.status==='ready'||plan.status==='blocked'||plan.status==='reboot-required'||!allowInstall){await receipt(receiptPath,result);return result}
 if(typeof launch!=='function')fail('BOOTSTRAP_INTERACTIVE_LAUNCH_REQUIRED')
 const operation=plan.actions[0]
 if(!operation){await receipt(receiptPath,result);return result}
 const component=manifest?.components?.bootstrap??manifest?.bootstrap??manifest
 let spec
 if(operation==='enable-virtual-machine-platform')spec={operation,file:'dism.exe',args:['/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart'],elevated:true,interactive:false,wait:true}
 else if(operation==='start-docker')spec={operation,file:snapshot.host.desktopExecutable,args:[],elevated:false,interactive:true,wait:false}
 else{
  const kind=operation==='install-wsl'?'wslInstaller':'dockerInstaller',asset=component?.[kind]
  const verified=await verifyAsset({bundleRoot,asset,kind,run,signal})
  spec=kind==='wslInstaller'?{operation,file:'msiexec.exe',args:['/i',verified.path,'/norestart'],elevated:true,interactive:true,wait:true}:{operation,file:verified.path,args:['install','--user','--backend=wsl-2'],elevated:false,interactive:true,wait:true}
  result.vendorAsset={kind,sha256:verified.sha256,bytes:verified.bytes,signer:verified.signer}
 }
 signal?.throwIfAborted();await receipt(receiptPath,{...result,status:'launching',operation})
 const launched=await launch({...spec,signal,timeoutMs:operation==='start-docker'?30000:30*60*1000}),code=resultCode(launched)
 if(code!==0&&code!==3010&&code!==1641)fail('BOOTSTRAP_INSTALLER_NOT_COMPLETED')
 result.changed=operation!=='start-docker';result.operation=operation;result.installerExitCode=code
 if(operation==='enable-virtual-machine-platform'||code===3010||code===1641){result.status='reboot-required';result.reason='REBOOT_THEN_RERUN_SAME_SETUP';result.resume='Rerun the same Setup after restarting Windows; existing prerequisites are detected again.'}
 else{result.status='waiting-for-user';result.reason=operation==='start-docker'||operation==='install-docker'?'START_DOCKER_AND_REVIEW_VENDOR_TERMS':'RERUN_PREREQUISITE_CHECK';result.resume='Continue the same setup after the vendor UI completes. Docker terms are accepted manually by the recipient.'}
 await receipt(receiptPath,result);return result
}
