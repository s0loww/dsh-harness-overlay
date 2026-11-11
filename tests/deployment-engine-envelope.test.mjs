import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,link} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {prepareDeploymentEnvelope,archiveDeploymentPackage} from '../scripts/build-deployment-package.mjs'
import {hashFile} from '../src/deployment-bundle/lib/fs.mjs'
const python=resolve('var/deployment-assets/runtime/python/python.exe'),script=resolve('src/deployment-bundle/bootstrap-extract.py')
const py=(program,args=[])=>execFileSync(python,['-I','-B','-X','utf8','-c',program,...args],{encoding:'utf8',windowsHide:true})
async function fixture(t,{long=false}={}){
 const root=await mkdtemp(join(tmpdir(),'dsh-envelope-'));t.after(()=>rm(root,{recursive:true,force:true}));const engine='payload/engine',bootstrap=engine+'/src/deployment-bundle/bootstrap-extract.py',file=engine+'/'+(long?Array(5).fill('x'.repeat(60)).join('/')+'/':'')+'plain.txt'
 const put=async(name,data)=>{await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),data)}
 await put(file,'ENGINE_PAYLOAD');await mkdir(dirname(join(root,bootstrap)),{recursive:true});await copyFile(script,join(root,bootstrap))
 for(const name of ['Setup.cmd','operations.cmd','README_RU.txt'])await put(name,'FIXTURE')
 const files={};for(const name of [file,bootstrap,'Setup.cmd','operations.cmd','README_RU.txt'])files[name]=await hashFile(join(root,name))
 await put('deployment-manifest.json',JSON.stringify({schemaVersion:1,kind:'airules-dsh-deployment',paths:{engine,python:'runtime/python/python.exe'},files}))
 await prepareDeploymentEnvelope({outputRoot:root,pythonPath:python})
 const invoke=()=>{try{return{code:0,body:JSON.parse(execFileSync(python,['-I','-B','-X','utf8',join(root,'bootstrap.py'),root],{encoding:'utf8',windowsHide:true}))}}catch(e){return{code:e.status,body:JSON.parse(e.stdout)}}}
 async function mutate(program){py(program,[join(root,'payload/engine.zip')]);const path=join(root,'deployment-manifest.json'),manifest=JSON.parse(await readFile(path));manifest.files['payload/engine.zip']=await hashFile(join(root,'payload/engine.zip'));await writeFile(path,JSON.stringify(manifest))}
 return{root,file,engine,invoke,mutate}
}
test('nested envelope extracts long paths, keeps matching files and omits engine paths from outer ZIP',async t=>{
 const f=await fixture(t,{long:true});assert.ok(f.file.length>300);await rm(join(f.root,f.engine),{recursive:true,force:true})
 const first=f.invoke();assert.equal(first.code,0,JSON.stringify(first));assert.equal(first.body.extracted,2);assert.equal(await readFile(join(f.root,f.file),'utf8'),'ENGINE_PAYLOAD');const second=f.invoke();assert.equal(second.code,0);assert.equal(second.body.matchingExisting,2)
 const archive=await archiveDeploymentPackage({outputRoot:f.root,pythonPath:python});const names=JSON.parse(py("import zipfile,json,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",[archive.path]));assert.ok(names.includes('payload/engine.zip'));assert.ok(names.includes('bootstrap.py'));assert.ok(!names.some(n=>n.startsWith('payload/engine/')));assert.ok(Math.max(...names.map(n=>n.length))<100)
 t.after(()=>rm(archive.path,{force:true}))
})
test('bootstrap refuses changed existing engine bytes instead of overwriting them',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,f.file),'COLLEAGUE_EDIT');const result=f.invoke();assert.equal(result.code,1);assert.equal(result.body.code,'EXTRACT_EXISTING_FILE_CHANGED');assert.equal(await readFile(join(f.root,f.file),'utf8'),'COLLEAGUE_EDIT')
})
test('bootstrap rejects extra/traversal, duplicate and symlink ZIP entries before installing files',async t=>{
 for(const variant of ['traversal','duplicate','symlink']){
  const f=await fixture(t);await rm(join(f.root,f.engine),{recursive:true,force:true})
  await f.mutate("import zipfile,sys,os,stat\np=sys.argv[1]\nwith zipfile.ZipFile(p) as z: rows=[(i,z.read(i)) for i in z.infolist()]\nwith zipfile.ZipFile(p+'.tmp','w') as z:\n for j,(i,data) in enumerate(rows):\n  if j==0:\n   if '"+variant+"'=='traversal': i.filename='../escape.txt'\n   if '"+variant+"'=='duplicate': i.filename=rows[1][0].filename\n   if '"+variant+"'=='symlink': i.external_attr=(stat.S_IFLNK|0o777)<<16\n  z.writestr(i,data)\nos.replace(p+'.tmp',p)")
  const result=f.invoke();assert.equal(result.code,1,variant);assert.match(result.body.code,/^EXTRACT_(?:PATH|ENTRY)_INVALID$/);await assert.rejects(readFile(join(f.root,f.file)),{code:'ENOENT'})
 }
})
test('bootstrap checks archive digest and every decompressed entry digest before writing',async t=>{
 const f=await fixture(t);await rm(join(f.root,f.engine),{recursive:true,force:true});await f.mutate("import zipfile,sys,os\np=sys.argv[1]\nwith zipfile.ZipFile(p) as z: rows=[(i,z.read(i)) for i in z.infolist()]\nwith zipfile.ZipFile(p+'.tmp','w') as z:\n for j,(i,data) in enumerate(rows): z.writestr(i,(b'X'+data[1:]) if j==0 else data)\nos.replace(p+'.tmp',p)")
 const result=f.invoke();assert.equal(result.code,1);assert.equal(result.body.code,'EXTRACT_CONTENT_CHANGED');await assert.rejects(readFile(join(f.root,f.file)),{code:'ENOENT'})
 const g=await fixture(t);await writeFile(join(g.root,'payload/engine.zip'),'CORRUPT');assert.equal(g.invoke().body.code,'EXTRACT_ARCHIVE_CHANGED')
})
test('bootstrap refuses hardlinked engine files',async t=>{
 const f=await fixture(t);await link(join(f.root,f.file),join(f.root,'alias.txt'));const result=f.invoke();assert.equal(result.code,1);assert.equal(result.body.code,'EXTRACT_LINK_REJECTED')
})
test('bootstrap rejects a CRC-corrupt entry even when the outer archive digest was updated',async t=>{
 const f=await fixture(t);await rm(join(f.root,f.engine),{recursive:true,force:true});await f.mutate("import zipfile,sys,os\np=sys.argv[1]\nwith zipfile.ZipFile(p) as z: rows=[(i.filename,z.read(i)) for i in z.infolist()]\nwith zipfile.ZipFile(p+'.tmp','w',compression=zipfile.ZIP_STORED) as z:\n for name,data in rows: z.writestr(name,data)\nos.replace(p+'.tmp',p)\nwith zipfile.ZipFile(p) as z: i=z.infolist()[0];offset=i.header_offset+30+len(i.filename.encode('utf8'))+len(i.extra)\nwith open(p,'rb') as stream: data=bytearray(stream.read())\ndata[offset]^=1\nwith open(p,'wb') as stream: stream.write(data)")
 const result=f.invoke();assert.equal(result.code,1);assert.equal(result.body.code,'EXTRACT_OPERATION_FAILED');await assert.rejects(readFile(join(f.root,f.file)),{code:'ENOENT'})
})
