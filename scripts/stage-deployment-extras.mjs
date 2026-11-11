import {mkdir,readFile,writeFile,copyFile,cp,mkdtemp,lstat,rename,rm} from 'node:fs/promises'
import {join,dirname,resolve,isAbsolute,relative,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {inspectPackageClosure,stagePackageClosure} from './stage-package-closure.mjs'
import {guard} from '../src/deployment-bundle/lib/fs.mjs'
import {EXTRA_PLUGINS,extrasState as state} from '../src/deployment-bundle/extras/index.mjs'

const slash=path=>path.split(sep).join('/')
async function resolveDependency(modulesRoot,from,name){
 let at=join(modulesRoot,from)
 while(true){
  const candidate=at===modulesRoot?join(modulesRoot,name):join(at,'node_modules',name)
  try{await guard(candidate);const info=await lstat(join(candidate,'package.json'));if(info.isFile())return slash(relative(modulesRoot,candidate))}catch(error){if(error.code!=='ENOENT')throw error}
  if(at===modulesRoot)break
  const parent=dirname(at),rel=relative(modulesRoot,parent);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))break;at=parent
 }
 throw Error('EXTRAS_PRIVATE_DEPENDENCY_UNRESOLVED')
}
async function stagePrivatePlugin({modulesRoot,targetModulesRoot,name,version}){
 const temporary=await mkdtemp(join(tmpdir(),'airules-private-extra-')),scratch=join(temporary,'modules')
 try{
  await mkdir(scratch)
  const source=await inspectPackageClosure({modulesRoot,roots:{[name]:version}})
  await stagePackageClosure({modulesRoot,targetModulesRoot:scratch,lock:source})
  const edges=[]
  for(const row of source.packages){
   const manifest=JSON.parse(await readFile(join(scratch,row.path,'package.json'),'utf8'))
   for(const dependency of Object.keys({...manifest.dependencies,...manifest.optionalDependencies}).sort())edges.push({from:row.path,name:dependency,resolved:await resolveDependency(scratch,row.path,dependency)})
  }
  const relocate=path=>path===name||path.startsWith(name+'/node_modules/')?path:name+'/node_modules/'+path
  if(new Set(source.packages.map(row=>relocate(row.path))).size!==source.packages.length)throw Error('EXTRAS_PRIVATE_DEPENDENCY_COLLISION')
  for(const row of source.packages.filter(row=>row.path!==name&&!row.path.includes('/node_modules/'))){
   const destination=join(scratch,relocate(row.path));await mkdir(dirname(destination),{recursive:true});await guard(destination)
   try{await lstat(destination);throw Error('EXTRAS_PRIVATE_DEPENDENCY_COLLISION')}catch(error){if(error.code!=='ENOENT')throw error}
   await rename(join(scratch,row.path),destination)
  }
  const target=join(targetModulesRoot,name);await mkdir(dirname(target),{recursive:true});await guard(target);try{await rename(join(scratch,name),target)}catch(error){if(error.code!=='EXDEV')throw error;await cp(join(scratch,name),target,{recursive:true,force:false,errorOnExist:true})}
  const staged=await inspectPackageClosure({modulesRoot:targetModulesRoot,roots:{[name]:version}})
  const expected=source.packages.map(row=>({...row,path:relocate(row.path)})).sort((a,b)=>a.path.localeCompare(b.path,'en'))
  if(JSON.stringify(staged.packages)!==JSON.stringify(expected))throw Error('EXTRAS_PRIVATE_CLOSURE_CHANGED')
  for(const edge of edges)if(await resolveDependency(targetModulesRoot,relocate(edge.from),edge.name)!==relocate(edge.resolved))throw Error('EXTRAS_PRIVATE_RESOLUTION_CHANGED')
  return{plugin:name,source,staged,edges:edges.map(row=>({from:relocate(row.from),name:row.name,resolved:relocate(row.resolved)}))}
 }finally{
  const rel=relative(resolve(tmpdir()),resolve(temporary))
  if(!isAbsolute(rel)&&rel.startsWith('airules-private-extra-')&&!rel.includes(sep))await rm(temporary,{recursive:true,force:true})
 }
}
export async function stageDeploymentExtras({modulesRoot,captainRoot,output}){
 if(![modulesRoot,captainRoot,output].every(isAbsolute))throw Error('EXTRAS_ABSOLUTE_INPUTS_REQUIRED')
 await guard(output);await mkdir(output,{recursive:false})
 const modules=join(output,'modules');await mkdir(modules)
 const closures=[]
 for(const[name,version]of Object.entries(EXTRA_PLUGINS))closures.push(await stagePrivatePlugin({modulesRoot,targetModulesRoot:modules,name,version}))
 const lock={schemaVersion:2,dependencyLayout:'private-per-plugin',roots:EXTRA_PLUGINS,closures}
 const packages=[]
 for(const[name,version]of Object.entries(EXTRA_PLUGINS)){const manifest=JSON.parse(await readFile(join(modules,name,'package.json'),'utf8'));packages.push({path:name,name,version,license:manifest.license??null,state:await state(join(modules,name))})}
 const captain={};await mkdir(join(output,'captain-diesel'))
 for(const name of ['pet.json','spritesheet.png']){const source=join(captainRoot,name);await guard(source);await copyFile(source,join(output,'captain-diesel',name));captain[name]=await state(join(output,'captain-diesel',name))}
 const metadata=JSON.parse(await readFile(join(output,'captain-diesel/pet.json'),'utf8'));if(metadata.spriteVersionNumber!==2||metadata.spritesheetPath!=='spritesheet.png')throw Error('EXTRAS_CAPTAIN_DESCRIPTOR_INVALID')
 await writeFile(join(output,'extras.json'),JSON.stringify({schemaVersion:1,dependencyLayout:'private-per-plugin',roots:EXTRA_PLUGINS,packages,captain},null,2)+'\n',{flag:'wx'});await writeFile(join(output,'dependency-lock.json'),JSON.stringify(lock,null,2)+'\n',{flag:'wx'})
 return{plugins:Object.keys(EXTRA_PLUGINS).length,packages:packages.length,privateDependencyCopies:closures.reduce((sum,row)=>sum+row.source.packages.length-1,0),sourcePackages:new Set(closures.flatMap(row=>row.source.packages.map(pkg=>pkg.path))).size,personalConfigCopied:false}
}
