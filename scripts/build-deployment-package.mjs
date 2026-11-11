import {readdir,readFile,mkdir,copyFile,writeFile} from 'node:fs/promises'
import {join,resolve,dirname,relative,extname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {guard,kind,below,hashFile,json,same,safeRelative,fail,writeJson} from '../src/deployment-bundle/lib/fs.mjs'
import {readDeploymentBundle} from '../src/deployment-bundle/lib/core.mjs'
import {stageDeploymentExtras} from './stage-deployment-extras.mjs'

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url))),run=promisify(execFile)
export const DEFAULT_PACKAGE_VERSION='0.17.2-test1'
const UI='airules-ui-overlay-0.17.0-host022-ui1',POLICY='airules-official-policy-0.17.2-approval1'
const HOST='0.2.2-rc.1',THUMBPRINT='84032578657219876E273E0D1BD303CFE1B82E6F'
async function tree(root){await guard(root,{allowMissing:false});const result=[];async function visit(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,e.name);await guard(path,{allowMissing:false});if(e.isDirectory())await visit(path);else if(e.isFile())result.push(path);else fail('PACKAGE_SPECIAL_FILE_REJECTED')}}await visit(root);return result}
async function copy(source,target){await guard(source,{allowMissing:false});await guard(target);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
async function copyTree(source,target){for(const file of await tree(source))await copy(file,join(target,relative(source,file)))}
async function protect(path,directory=false){if(process.platform!=='win32')return;const {stdout}=await run('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true});const sid=stdout.match(/S-1-5-[0-9-]+/u)?.[0];if(!sid)fail('PACKAGE_OWNER_SID_REQUIRED');const inherit=directory?'(OI)(CI)':'';await run('icacls.exe',[path,'/inheritance:r','/grant:r',`*${sid}:${inherit}(F)`,`*S-1-5-18:${inherit}(F)`],{windowsHide:true})}

// Preserve module-relative paths. Installer YAML is copied in full because it is
// CommonJS and includes its own package type and dynamically required modules.
export async function collectEngineFiles(sourceRoot=ROOT){
 const selected=new Set(),pending=[]
 const add=file=>{const path=resolve(file);if(!below(sourceRoot,path))fail('PACKAGE_ENGINE_IMPORT_ESCAPE');if(!selected.has(path)){selected.add(path);pending.push(path)}}
 for(const dir of ['installer','src/deployment-bundle'])for(const file of await tree(join(sourceRoot,dir)))add(file)
 for(const name of ['create-official-candidate.mjs','cycle-official-candidate.mjs','smoke-official-candidate.mjs','stage-package-closure.mjs'])add(join(sourceRoot,'scripts',name))
 add(join(sourceRoot,'package.json'))
 for(const name of await readdir(join(sourceRoot,'upstream')))if(name.endsWith('.lock.json'))add(join(sourceRoot,'upstream',name))
 add(join(sourceRoot,'upstream/official-desktop',HOST,'release.lock.json'))
 while(pending.length){const file=pending.pop();if(!['.mjs','.js','.cjs'].includes(extname(file)))continue;const text=await readFile(file,'utf8')
  // Static import/export, literal import(), and CommonJS literal require().
  const pattern=/(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)['"](\.[^'"\r\n]+)['"]/gu
  for(const match of text.matchAll(pattern)){const path=resolve(dirname(file),match[1]);if((await kind(path))!=='file')fail('PACKAGE_ENGINE_IMPORT_MISSING',{path:relative(sourceRoot,path)});add(path)}
 }
 return [...selected].sort()
}
export async function refreshDeploymentEngine({outputRoot,sourceRoot=ROOT}){
 outputRoot=resolve(outputRoot);const manifest=await json(join(outputRoot,'deployment-manifest.json'))
 if(manifest?.kind!=='airules-dsh-deployment')fail('PACKAGE_MANIFEST_REQUIRED')
 for(const file of await collectEngineFiles(sourceRoot)){const target=join(safeRelative(outputRoot,manifest.paths.engine),relative(sourceRoot,file));await copy(file,target);manifest.files[relative(outputRoot,target).replaceAll('\\','/')]=await hashFile(target)}
 const guide=join(sourceRoot,'docs/deployment-colleague-test.md');if(await kind(guide)==='file'){const target=join(outputRoot,'payload/docs/deployment-colleague-test.md');await copy(guide,target);manifest.files['payload/docs/deployment-colleague-test.md']=await hashFile(target)}
 await writeJson(join(outputRoot,'deployment-manifest.json'),manifest)
 return{outputRoot,version:manifest.version,files:Object.keys(manifest.files).length,bytes:Object.values(manifest.files).reduce((sum,f)=>sum+f.bytes,0),manifestSha256:(await hashFile(join(outputRoot,'deployment-manifest.json'))).sha256,engineRefreshed:true,fullVerificationRequiredBeforeArchive:true}
}
export async function finalizePackageInventory(outputRoot){
 outputRoot=resolve(outputRoot);const manifest=await json(join(outputRoot,'deployment-manifest.json'));if(manifest?.kind!=='airules-dsh-deployment')fail('PACKAGE_MANIFEST_REQUIRED')
 const files={};for(const file of await tree(outputRoot)){const name=relative(outputRoot,file).replaceAll('\\','/');if(name==='deployment-manifest.json')continue;files[name]=await hashFile(file)}
 manifest.files=files;await writeJson(join(outputRoot,'deployment-manifest.json'),manifest);const verified=await readDeploymentBundle(outputRoot)
 return{outputRoot,version:manifest.version,files:verified.files.length,bytes:verified.totalBytes,manifestSha256:verified.identity}
}

const README=`Тестовая сборка DSH + airules\r\n\r\nТребования: актуальная Windows 11 x64 с виртуализацией, минимум 8 ГБ RAM\r\nи 20 ГБ свободного диска для пакета, копии runtime и Docker.\r\nDocker Desktop предоставляется по своим лицензионным условиям. Установка\r\nне принимает условия автоматически: ознакомьтесь с ними в окне Docker.\r\nПосле перезагрузки повторите Setup.cmd из той же папки.\r\nЛокальные модели Cognee включены; качество русского текста и терминов 1С\r\nна этой конфигурации пока не подтверждено отдельным корпусом проверок.\r\n\r\nРаспакуйте весь архив в локальную папку. Запустите Setup.cmd обычным пользователем.\r\nУстановщик покажет план и запросит согласие. Docker Desktop/WSL при отсутствии\r\nпотребуют отдельной установки, прав администратора и, возможно, перезагрузки.\r\nПакет содержит официальный DSH, наши дополнения, правила, Cognee и модели,\r\nNode/Python/Git и установщики Docker Desktop/WSL. Существующие чаты, входы\r\nи настройки MCP сохраняются; конфликтующие настройки не перезаписываются.\r\nРеальный деплой проектов не выполняется. operations.cmd: status, repair,\r\nrollback, diagnostics, launch. Удаление overlay сохраняет базовый DSH и память.\r\n\r\nПРИВАТНЫЙ ПАКЕТ: внутри общие учетные данные MCP для согласованной группы\r\nтестирования. Не публикуйте архив, папку payload/private или диагностические\r\nкопии этих файлов. Личные аккаунты, проекты и история автора не включены.\r\n`
export function renderLauncher(command){return '@echo off\r\nsetlocal\r\n'+(!command?'if "%~1"=="" (\r\n  echo Usage: operations.cmd status ^| repair ^| rollback ^| uninstall-overlay ^| diagnostics ^| launch\r\n  exit /b 1\r\n)\r\n':'')+'"%~dp0runtime\\python\\python.exe" -I -B -X utf8 "%~dp0bootstrap.py" "%~dp0."\r\nif errorlevel 1 (\r\n  pause\r\n  exit /b 1\r\n)\r\n"%~dp0runtime\\node\\node.exe" "%~dp0payload\\engine\\src\\deployment-bundle\\cli.mjs" '+(command?command+' --bundle-root "%~dp0." %*':'%* --bundle-root "%~dp0."')+'\r\nset "DSH_EXIT=%ERRORLEVEL%"\r\nif not "%DSH_EXIT%"=="0" pause\r\nexit /b %DSH_EXIT%\r\n'}
export function renderReadme(){return 'Распакуйте в КОРОТКИЙ путь: D:\\DSH или C:\\DSH-Airules. Если корень C:\\ недоступен, выберите свой доступный диск. Не используйте глубокую папку Downloads.\r\n\r\n'+README+'\r\nSetup.cmd сначала проверяет и распаковывает вложенный engine.zip. Подождите окончания; повторный запуск сохраняет совпадающие файлы. Измененные файлы не перезаписываются.\r\nПодробная инструкция: payload\\docs\\deployment-colleague-test.md\r\n'}
export async function archiveDeploymentPackage({outputRoot,pythonPath,archivePath=outputRoot+'.zip'}){
 outputRoot=resolve(outputRoot);archivePath=resolve(archivePath)
 if(archivePath===outputRoot||below(outputRoot,archivePath))fail('PACKAGE_ARCHIVE_INSIDE_PACKAGE')
 const manifest=await json(join(outputRoot,'deployment-manifest.json')),envelope=manifest?.envelope
 let skipPrefix=''
 if(envelope){if(envelope.schemaVersion!==1||envelope.engineRoot!==manifest.paths?.engine||envelope.extractor!=='bootstrap.py'||!manifest.files?.[envelope.engineArchive])fail('PACKAGE_ENVELOPE_INVALID');safeRelative(outputRoot,envelope.engineRoot);safeRelative(outputRoot,envelope.engineArchive);skipPrefix=envelope.engineRoot+'/'}
 return writeZipArchive({outputRoot,pythonPath,archivePath,skipPrefix})
}
async function writeZipArchive({outputRoot,pythonPath,archivePath,includePrefix='',skipPrefix=''}){
 await guard(archivePath);if(await kind(archivePath)!=='missing')fail('PACKAGE_ARCHIVE_EXISTS')
 await writeFile(archivePath,'',{flag:'wx',mode:0o600});await protect(archivePath)
 const program=`import os,sys,zipfile\nroot,out,include,skip=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as z:\n for base,dirs,files in os.walk(root):\n  dirs.sort()\n  for name in sorted(files):\n   p=os.path.join(base,name); rel=os.path.relpath(p,root).replace(os.sep,'/')\n   if (include and not rel.startswith(include)) or (skip and rel.startswith(skip)): continue\n   z.write(p,rel,compress_type=zipfile.ZIP_STORED if name.lower().endswith(('.exe','.msi','.zip','.gz','.7z','.dll','.pyd')) else zipfile.ZIP_DEFLATED)\nwith zipfile.ZipFile(out) as z:\n bad=z.testzip()\n if bad: raise RuntimeError('ARCHIVE_CRC_FAILED')\n`
 await run(pythonPath,['-I','-B','-X','utf8','-c',program,outputRoot,archivePath,includePrefix,skipPrefix],{windowsHide:true,timeout:60*60*1000,maxBuffer:1024*1024})
 return{path:archivePath,...await hashFile(archivePath)}
}
export async function prepareDeploymentEnvelope({outputRoot,pythonPath}){
 outputRoot=resolve(outputRoot);const manifest=await json(join(outputRoot,'deployment-manifest.json'))
 if(manifest?.kind!=='airules-dsh-deployment'||manifest.envelope)fail('PACKAGE_ENVELOPE_STATE_INVALID')
 const engine=manifest.paths.engine;safeRelative(outputRoot,engine)
 const prefix=engine+'/',expected=Object.keys(manifest.files).filter(name=>name.startsWith(prefix)),actual=(await tree(safeRelative(outputRoot,engine))).map(path=>relative(outputRoot,path).replaceAll('\\','/')).sort()
 if(JSON.stringify(actual)!==JSON.stringify(expected.sort()))fail('PACKAGE_ENGINE_SET_CHANGED')
 const bootstrapSource=safeRelative(outputRoot,engine+'/src/deployment-bundle/bootstrap-extract.py')
 if(!manifest.files[engine+'/src/deployment-bundle/bootstrap-extract.py'])fail('PACKAGE_BOOTSTRAP_NOT_STAGED')
 const archive='payload/engine.zip',archivePath=safeRelative(outputRoot,archive)
 const result=await writeZipArchive({outputRoot,pythonPath:pythonPath??safeRelative(outputRoot,manifest.paths.python),archivePath,includePrefix:prefix})
 await copy(bootstrapSource,join(outputRoot,'bootstrap.py'))
 for(const[name,text]of [['Setup.cmd',renderLauncher('install')],['operations.cmd',renderLauncher('')],['README_RU.txt',renderReadme()]]){
  const path=join(outputRoot,name),before=await hashFile(path);if(!same(before,manifest.files[name]))fail('PACKAGE_LAUNCHER_CHANGED');await writeFile(path,text)
 }
 for(const name of [archive,'bootstrap.py','Setup.cmd','operations.cmd','README_RU.txt'])manifest.files[name]=await hashFile(safeRelative(outputRoot,name))
 manifest.envelope={schemaVersion:1,engineArchive:archive,engineRoot:engine,extractor:'bootstrap.py'};await writeJson(join(outputRoot,'deployment-manifest.json'),manifest)
 return{status:'envelope-ready',engineFiles:expected.length,engineArchive:result,fullVerificationRequiredBeforeArchive:true}
}
export async function buildDeploymentPackage(options={}){
 const sourceRoot=resolve(options.sourceRoot??ROOT),assets=resolve(options.assetsRoot??join(sourceRoot,'var/deployment-assets'))
 if(!options.outputRoot)fail('PACKAGE_OUTPUT_ROOT_REQUIRED');const outputRoot=resolve(options.outputRoot)
 await guard(outputRoot);if(await kind(outputRoot)!=='missing')fail('PACKAGE_OUTPUT_EXISTS')
 for(const input of [sourceRoot,assets])if(outputRoot===input||below(outputRoot,input))fail('PACKAGE_OUTPUT_OVERLAP')
 // The output may be a new child of var/, but never inside a copied input tree.
 for(const input of ['installer','src','dist','upstream'].map(p=>join(sourceRoot,p)).concat([assets]))if(below(input,outputRoot))fail('PACKAGE_OUTPUT_OVERLAP')
 const cli=join(sourceRoot,'src/deployment-bundle/cli.mjs');if(await kind(cli)!=='file')fail('PACKAGE_CLI_NOT_READY')
 for(const name of ['node/node.exe','python/python.exe','git/cmd/git.exe'])if(await kind(join(assets,'runtime',name))!=='file')fail('PACKAGE_RUNTIME_NOT_READY')
 const official=resolve(options.officialInstaller??join(sourceRoot,'var/host-upgrade/rc022/deepseek-harness-'+HOST+'-win-x64.exe'))
 if((await hashFile(official)).sha256!=='830947f8996dc05d991ca9133fff4d3400073e47b9cfa6507754867e79482b23')fail('PACKAGE_OFFICIAL_PIN_MISMATCH')
 await mkdir(dirname(outputRoot),{recursive:true});await guard(outputRoot);await mkdir(outputRoot,{recursive:false})
 await protect(outputRoot,true)
 const engine=join(outputRoot,'payload/engine')
 options.onProgress?.({phase:'engine'})
 for(const file of await collectEngineFiles(sourceRoot))await copy(file,join(engine,relative(sourceRoot,file)))
 for(const artifact of [UI,POLICY])await copyTree(join(sourceRoot,'dist',artifact),join(engine,'dist',artifact))
 for(const runtime of ['node','python','git'])await copyTree(join(assets,'runtime',runtime),join(outputRoot,'runtime',runtime))
 for(const [name,pin]of [['assets.json',null],['cognee-image.tar','e19d2941011472277b031067b64575d68a0c29246329bb3a57bc8e55ab1f05a0'],['cognee-models.tar','040152d7c8baa01fd96f603d720c9a01d4300c0f8a895288811a61a580b8a9b3']]){const file=join(assets,'cognee',name);if(pin&&(await hashFile(file)).sha256!==pin)fail('PACKAGE_COGNEE_PIN_MISMATCH');await copy(file,join(outputRoot,'payload/cognee',name))}
 for(const name of ['git-runtime.json','node-runtime.json','python-runtime.json'])if(await kind(join(assets,'runtime',name))==='file')await copy(join(assets,'runtime',name),join(outputRoot,'provenance',name))
 if(await kind(join(assets,'vendor/vendor-assets.json'))==='file')await copy(join(assets,'vendor/vendor-assets.json'),join(outputRoot,'provenance/vendor-assets.json'))
 const vendor=[['DockerDesktopInstaller-amd64.exe','4.99.0.245822','a5e299131c9c53d60f3f752b162078945eb5faf6eedcf0be20a214c6e6cea444',623969712],['wsl.3.0.5.0.x64.msi','3.0.5.0','2313efc5873e3f8552f42e77f950fabd913c0289078fa89d2100f3421a525eaa',367788032]]
 for(const [name,,sha256,bytes]of vendor){const file=join(assets,'vendor',name),actual=await hashFile(file);if(actual.sha256!==sha256||actual.bytes!==bytes)fail('PACKAGE_VENDOR_PIN_MISMATCH');await copy(file,join(outputRoot,'payload/vendor',name))}
 await copy(official,join(outputRoot,'payload/official/setup.exe'))
 if(options.extrasRoot)await copyTree(resolve(options.extrasRoot),join(outputRoot,'payload/extras'))
 else{if(!options.extrasModulesRoot||!options.captainRoot)fail('PACKAGE_EXTRAS_INPUTS_REQUIRED');await mkdir(join(outputRoot,'payload'),{recursive:true});await stageDeploymentExtras({modulesRoot:resolve(options.extrasModulesRoot),captainRoot:resolve(options.captainRoot),output:join(outputRoot,'payload/extras')})}
 for(const [from,to]of [['catalog.private.json','mcp-catalog.json'],['private/credentials.json','mcp-credentials.json']])await copy(join(sourceRoot,'var/deployment-mcp',from),join(outputRoot,'payload/private',to))
 if(await kind(join(sourceRoot,'docs/deployment-colleague-test.md'))==='file')await copy(join(sourceRoot,'docs/deployment-colleague-test.md'),join(outputRoot,'payload/docs/deployment-colleague-test.md'))
 await writeFile(join(outputRoot,'Setup.cmd'),renderLauncher('install'),{flag:'wx'});await writeFile(join(outputRoot,'operations.cmd'),renderLauncher(''),{flag:'wx'});await writeFile(join(outputRoot,'README_RU.txt'),renderReadme(),{flag:'wx'})
 const files={};options.onProgress?.({phase:'inventory'});for(const file of await tree(outputRoot)){const name=relative(outputRoot,file).replaceAll('\\','/');safeRelative(outputRoot,name);files[name]=await hashFile(file)}
 const paths={engine:'payload/engine',uiArtifact:'payload/engine/dist/'+UI,policyArtifact:'payload/engine/dist/'+POLICY,releaseLock:'payload/engine/upstream/official-desktop/'+HOST+'/release.lock.json',node:'runtime/node/node.exe',python:'runtime/python/python.exe',git:'runtime/git/cmd/git.exe',officialInstaller:'payload/official/setup.exe'}
 const manifest={schemaVersion:1,kind:'airules-dsh-deployment',version:options.version??DEFAULT_PACKAGE_VERSION,platform:'win32-x64',hostVersion:HOST,paths,files,components:{extras:{enabled:true,assets:'payload/extras'},cognee:{enabled:true,assets:'payload/cognee',port:18080},mcp:{enabled:true,catalog:'payload/private/mcp-catalog.json',credentials:'payload/private/mcp-credentials.json'},bootstrap:{enabled:true,dockerInstaller:{path:'payload/vendor/'+vendor[0][0],version:vendor[0][1],sha256:vendor[0][2],bytes:vendor[0][3]},wslInstaller:{path:'payload/vendor/'+vendor[1][0],version:vendor[1][1],sha256:vendor[1][2],bytes:vendor[1][3]}}},signatures:{officialInstaller:{thumbprint:THUMBPRINT}},distribution:'private-colleague-test',userDataIncluded:false}
 await writeJson(join(outputRoot,'deployment-manifest.json'),manifest);const verified=await readDeploymentBundle(outputRoot)
 const result={outputRoot,version:manifest.version,files:verified.files.length,bytes:verified.totalBytes,manifestSha256:verified.identity}
 if(options.archive!==false){options.onProgress?.({phase:'envelope'});result.envelope=await prepareDeploymentEnvelope({outputRoot});Object.assign(result,await finalizePackageInventory(outputRoot));options.onProgress?.({phase:'archive'});result.archive=await archiveDeploymentPackage({outputRoot,pythonPath:join(outputRoot,'runtime/python/python.exe'),archivePath:options.archivePath})}
 return result
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){const key=args[i];if(key==='--no-archive'){options.archive=false;continue}const name={'--output-root':'outputRoot','--assets-root':'assetsRoot','--official-installer':'officialInstaller','--extras-modules-root':'extrasModulesRoot','--captain-root':'captainRoot','--extras-root':'extrasRoot','--archive-path':'archivePath','--version':'version'}[key];if(!name||!args[i+1])fail('PACKAGE_ARGUMENT_INVALID');options[name]=args[++i]}
 try{console.log(JSON.stringify(await buildDeploymentPackage({...options,onProgress:e=>console.error('package: '+e.phase)}),null,2))}catch(e){console.error(e.code??e.message);process.exitCode=1}
}
