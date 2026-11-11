import {execFile,spawn,execFileSync} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createInterface} from 'node:readline/promises'
import {createDeploymentService,readDeploymentBundle,createOfficialDeploymentAdapters} from './lib/core.mjs'
import {safeRelative,json,writeJson,guard,boundedCode,fail} from './lib/fs.mjs'
import {createComponentAdapters} from './components.mjs'
import {ensureDocker} from './bootstrap/index.mjs'

const execute=promisify(execFile),quote=value=>"'"+String(value).replaceAll("'","''")+"'"
export function parseArgs(args){
 const action=args[0]&&!args[0].startsWith('--')?args.shift():'install',options={}
 for(let i=0;i<args.length;i++){const key=args[i];if(!/^--(?:bundle-root|state-root|install-root|dsh-home|isolated-root|stock-source|cognee-port|yes|offline|check-only)$/u.test(key))fail('DEPLOY_OPTION_UNKNOWN');if(['--yes','--offline','--check-only'].includes(key))options[key.slice(2)]=true;else{const value=args[++i];if(!value||value.startsWith('--'))fail('DEPLOY_OPTION_VALUE_REQUIRED');options[key.slice(2)]=value}}
 if(!['install','update','repair','plan','status','rollback','uninstall-overlay','diagnostics','launch'].includes(action))fail('DEPLOY_ACTION_UNKNOWN')
 return{action,options}
}
export function runtimeEnvironment(bundleRoot,manifest,home,extra={}){
 return{...process.env,...extra,PATH:[dirname(safeRelative(bundleRoot,manifest.paths.node)),dirname(safeRelative(bundleRoot,manifest.paths.python)),join(bundleRoot,'runtime/git/cmd'),join(bundleRoot,'runtime/git/mingw64/bin'),process.env.PATH??''].join(';'),DSH_HOME:home}
}
// Start-Process joins an ArgumentList array without preserving argument bounds.
// Build the single Windows command line explicitly for MSI paths with spaces.
export function windowsArgumentLine(args){return args.map(value=>'"'+String(value).replace(/(\\*)"/gu,'$1$1\\"').replace(/(\\+)$/u,'$1$1')+'"').join(' ')}
async function run(spec){try{const r=await execute(spec.file,spec.args,{windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024,timeout:spec.timeoutMs??30000,signal:spec.signal,env:spec.env??process.env,cwd:spec.cwd});return{code:0,stdout:r.stdout}}catch(error){return{code:typeof error.code==='number'?error.code:1,stdout:error.stdout??''}}}
async function launch(spec){
 if(spec.elevated){const script=`$p=Start-Process -FilePath ${quote(spec.file)} -ArgumentList ${quote(windowsArgumentLine(spec.args))} -Verb RunAs -PassThru -Wait;exit $p.ExitCode`;return run({file:'powershell.exe',args:['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],timeoutMs:spec.timeoutMs,signal:spec.signal})}
 return new Promise((resolve,reject)=>{const p=spawn(spec.file,spec.args,{stdio:spec.interactive?'inherit':'ignore',windowsHide:!spec.interactive,detached:!spec.wait,signal:spec.signal});p.once('error',reject);if(!spec.wait){p.unref();resolve({code:0})}else p.once('exit',code=>resolve({code:code??1}))})
}
async function privateDirectory(path){await guard(path);await mkdir(path,{recursive:true});if(process.platform==='win32'){const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/u)?.[0];if(!sid)fail('DEPLOY_OWNER_SID_UNAVAILABLE');execFileSync('icacls.exe',[path,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)(F)`,'*S-1-5-18:(OI)(CI)(F)'],{stdio:'ignore',windowsHide:true})}}
async function ask(text){if(!process.stdin.isTTY)return false;const rl=createInterface({input:process.stdin,output:process.stdout});try{return /^(?:y|yes|д|да)$/iu.test((await rl.question(text+' [да/нет]: ')).trim())}finally{rl.close()}}
export async function main(args=process.argv.slice(2)){
 const{action,options}=parseArgs([...args]),bundleRoot=resolve(options['bundle-root']??fileURLToPath(new URL('../../../..',import.meta.url))),isolated=options['isolated-root']?resolve(options['isolated-root']):null
 const stateRoot=resolve(options['state-root']??(isolated?join(isolated,'state'):join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'AirulesDSH'))),installRoot=resolve(options['install-root']??(isolated?join(isolated,'install'):join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'Programs/DeepSeek Harness'))),dshHome=resolve(options['dsh-home']??(isolated?join(isolated,'home'):join(homedir(),'.dsh')))
 // The mutation plan performs a complete hash pass before prerequisites or
 // target writes, and apply rechecks it. Avoid a third full initial pass.
 console.log('DSH Airules: '+action)
 const bundle=await readDeploymentBundle(bundleRoot,{verifyFiles:false})
 const env=runtimeEnvironment(bundleRoot,bundle.manifest,dshHome);process.env.PATH=env.PATH
 const native=createOfficialDeploymentAdapters(),components=createComponentAdapters({cogneePort:options['cognee-port']?Number(options['cognee-port']):undefined,offline:options.offline===true}),adapters={...native,...components}
 if(isolated&&options['stock-source'])adapters.installOfficial=async ctx=>{await guard(ctx.installRoot);await cp(resolve(options['stock-source']),ctx.installRoot,{recursive:true,force:false,errorOnExist:true});return{status:'isolated-stock-copy'}}
 const service=createDeploymentService({bundleRoot,stateRoot,installRoot,dshHome,adapters,onProgress:({phase})=>console.log('  '+phase)})
 if(action==='status')return service.status()
 if(action==='diagnostics'){const status=await service.status(),diagnostics={schemaVersion:1,version:bundle.manifest.version,hostVersion:bundle.manifest.hostVersion,installed:status.installed,installRoot,dshHome,stateRoot,deploymentId:status.current?.deploymentId??null,pending:status.pending,credentialsIncluded:false};const path=join(stateRoot,'diagnostics','summary.json');await writeJson(path,diagnostics);return{status:'written',path}}
 if(action==='launch'){
  const installed=await service.status();if(!installed.installed)fail('DEPLOY_CURRENT_REQUIRED')
  const liveBundle=installed.current.engineRoot?resolve(installed.current.engineRoot,'../..'):bundleRoot
  const child=spawn(join(installRoot,'DeepSeek Harness.exe'),isolated?['--user-data-dir='+join(isolated,'electron-user-data')]:[],{env:runtimeEnvironment(liveBundle,bundle.manifest,dshHome),stdio:'ignore',detached:true,windowsHide:false});await new Promise((res,rej)=>{child.once('spawn',res);child.once('error',rej)});child.unref();return{status:'launched'}
 }
 if(['rollback','uninstall-overlay'].includes(action))return action==='rollback'?service.rollback():service.uninstallOverlay()
 const mode=action==='plan'?'install':action,plan=await service.plan({mode});console.log(JSON.stringify(plan,null,2));if(action==='plan'||options['check-only'])return plan
 if(plan.status!=='ready')fail('DEPLOY_PLAN_BLOCKED')
 if(!options.yes&&!await ask('Установить DSH со всеми дополнениями, Cognee и шестью MCP по этому плану?'))return{status:'cancelled'}
 await privateDirectory(stateRoot)
 for(let n=0;n<8;n++){
  const prerequisite=await ensureDocker({bundleRoot,manifest:bundle.manifest,run,launch,allowInstall:true,receiptPath:join(stateRoot,'docker-bootstrap.json')});console.log('Docker: '+prerequisite.status+' / '+prerequisite.reason)
  if(prerequisite.status==='ready'){if(prerequisite.snapshot?.host?.dockerExecutable)process.env.PATH=dirname(prerequisite.snapshot.host.dockerExecutable)+';'+process.env.PATH;break}
  if(prerequisite.status==='reboot-required'){console.log('Перезагрузите Windows и повторно запустите Setup.cmd. Данные сохранятся.');return{status:prerequisite.status}}
  if(prerequisite.status==='blocked'||options.yes||!await ask('Завершите настройку в окне Docker. Проверить готовность ещё раз?'))return{status:prerequisite.status}
  if(n===7)fail('DEPLOY_DOCKER_NOT_READY')
 }
 const result=await service.apply({planId:plan.planId,acceptPlan:true})
 // Launchers live in our stable, private installation cache. No PATH/registry mutation.
 const cache=join(stateRoot,'package'),launcher=join(stateRoot,'LaunchDSH.cmd')
 const literal=value=>String(value).replaceAll('%','%%')
 await writeFile(launcher,'@echo off\r\nsetlocal disableDelayedExpansion\r\n"'+literal(join(cache,...bundle.manifest.paths.node.split('/')))+'" "'+literal(join(cache,...bundle.manifest.paths.engine.split('/'),'src/deployment-bundle/cli.mjs'))+'" launch --bundle-root "'+literal(cache)+'" --state-root "'+literal(stateRoot)+'" --install-root "'+literal(installRoot)+'" --dsh-home "'+literal(dshHome)+'"'+(isolated?' --isolated-root "'+literal(isolated)+'"':'')+'\r\n')
 result.launcher=launcher
 if(!isolated&&process.platform==='win32'){
  const script=`$p=Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Airules (тест).lnk';if(Test-Path -LiteralPath $p){exit 0};$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);$s.TargetPath=${quote(launcher)};$s.WorkingDirectory=${quote(stateRoot)};$s.IconLocation=${quote(join(installRoot,'DeepSeek Harness.exe')+',0')};$s.Description='DSH Airules — тестовая сборка';$s.Save()`
  const link=await run({file:'powershell.exe',args:['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]});result.desktopShortcut=link.code===0?'created-or-preserved':'unavailable-use-launcher'
 }
 return result
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(result=>{console.log(JSON.stringify(result,null,2));if(['blocked','waiting-for-user','reboot-required'].includes(result?.status))process.exitCode=2}).catch(error=>{console.error(JSON.stringify({status:'failed',code:boundedCode(error),receiptPath:error.receiptPath??null,recoveryFailures:error.recoveryFailures??[]},null,2));process.exitCode=1})
