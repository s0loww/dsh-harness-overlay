import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {collectEngineFiles,archiveDeploymentPackage,renderLauncher,buildDeploymentPackage} from '../scripts/build-deployment-package.mjs'

test('engine closure includes runtime companions, CommonJS YAML scope and all compatibility patches',async()=>{
 const files=await collectEngineFiles(),root=resolve('.'),names=new Set(files.map(f=>f.slice(root.length+1).replaceAll('\\','/')))
 for(const name of ['src/deployment-bundle/cli.mjs','src/deployment-bundle/cognee/seed-cache.py','installer/vendor/yaml/package.json','installer/vendor/yaml/dist/index.js','src/native-fs-compat/patch.mjs','src/onec-lsp-compat/patch.mjs','src/composer-history-compat/patch.mjs','upstream/native-fs-closure-0.2.2-rc.1.lock.json'])assert.ok(names.has(name),name)
 assert.ok([...names].every(n=>!n.startsWith('var/')&&!n.includes('credentials')&&!n.endsWith('.env')))
})
test('operation launcher puts requested action before options and quotes paths',()=>{
 const ops=renderLauncher('');assert.match(ops,/%\* --bundle-root "%~dp0\."/);assert.match(ops,/Usage: operations.cmd/)
 assert.match(renderLauncher('install'),/install --bundle-root "%~dp0\." %\*/)
 assert.ok(ops.indexOf('runtime\\python\\python.exe')<ops.indexOf('runtime\\node\\node.exe'));assert.match(ops,/if errorlevel 1/)
})
test('private ZIP64 archive round trips binary files and refuses replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-zip64-')),folder=join(root,'package');await mkdir(join(folder,'payload'),{recursive:true});await writeFile(join(folder,'payload/a.bin'),Buffer.from([0,255,13,10]));await writeFile(join(folder,'README.txt'),'тест')
 try{const python=resolve('var/deployment-assets/runtime/python/python.exe'),result=await archiveDeploymentPackage({outputRoot:folder,pythonPath:python});assert.ok(result.bytes>100);assert.match(result.sha256,/^[a-f0-9]{64}$/)
  const check=execFileSync(python,['-I','-c',"import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.read('payload/a.bin')==bytes([0,255,13,10]);assert z.testzip() is None;print(len(z.namelist()))",result.path],{encoding:'utf8',windowsHide:true});assert.equal(check.trim(),'2')
  await assert.rejects(archiveDeploymentPackage({outputRoot:folder,pythonPath:python}),{code:'PACKAGE_ARCHIVE_EXISTS'})
 }finally{await rm(root,{recursive:true,force:true})}
})
test('builder refuses existing output without changing it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-builder-'));try{await writeFile(join(root,'keep'),'preserve');await assert.rejects(buildDeploymentPackage({outputRoot:root}),{code:'PACKAGE_OUTPUT_EXISTS'});assert.equal(await readFile(join(root,'keep'),'utf8'),'preserve')}finally{await rm(root,{recursive:true,force:true})}
})
test('archive cannot include its own growing output through an override',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-zip-loop-'));try{await assert.rejects(archiveDeploymentPackage({outputRoot:root,archivePath:join(root,'nested/archive.zip'),pythonPath:'not-executed'}),{code:'PACKAGE_ARCHIVE_INSIDE_PACKAGE'})}finally{await rm(root,{recursive:true,force:true})}
})
