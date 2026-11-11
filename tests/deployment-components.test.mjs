import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createComponentAdapters} from '../src/deployment-bundle/components.mjs'
import {parseArgs,runtimeEnvironment,windowsArgumentLine} from '../src/deployment-bundle/cli.mjs'

test('recipient launcher rejects unknown arguments and keeps portable runtimes local to the child environment',()=>{
 assert.deepEqual(parseArgs(['repair','--yes','--bundle-root','C:/package']),{action:'repair',options:{yes:true,'bundle-root':'C:/package'}})
 assert.throws(()=>parseArgs(['install','--purge-data']),/DEPLOY_OPTION_UNKNOWN/)
 assert.throws(()=>parseArgs(['install','--dsh-home']),/DEPLOY_OPTION_VALUE_REQUIRED/)
 const env=runtimeEnvironment(join(tmpdir(),'package'),{paths:{node:'runtime/node/node.exe',python:'runtime/python/python.exe'}},'recipient-home')
 assert.equal(env.DSH_HOME,'recipient-home');assert.ok(env.PATH.includes('runtime'));assert.ok(env.PATH.includes('git'))
 assert.equal(windowsArgumentLine(['/i','C:\\User Name\\Downloads\\wsl.msi','/norestart']),'"/i" "C:\\User Name\\Downloads\\wsl.msi" "/norestart"')
 assert.equal(windowsArgumentLine(['C:\\trailing\\']),'"C:\\trailing\\\\"')
})
test('Cognee binding installs private fresh profile files, rolls back only owned settings and retains memory data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-component-')),home=join(root,'home'),stateRoot=join(root,'state');await mkdir(home)
 let stopped=0
 const fake={async install({stateRoot}){const memoryHome=join(stateRoot,'memory-workspace');await mkdir(memoryHome,{recursive:true});for(const name of ['config.json','auth.json','processing-binding.json','processing.json'])await writeFile(join(memoryHome,name),JSON.stringify({fixture:name}));return{memoryHome}},async health(){return{available:true}},async stop(){stopped++;return{stopped:true}}}
 const adapter=createComponentAdapters({cognee:fake}),ctx={stateRoot,dshHome:home,deploymentId:'fixture',bundleRoot:root,manifest:{components:{cognee:{assets:'payload/cognee'}}}}
 const installed=await adapter.configureCognee(ctx);assert.equal(installed.status,'installed');assert.ok((await readFile(join(home,'memory-workspace/auth.json'),'utf8')).includes('auth.json'))
 await adapter.rollbackCognee({...ctx,componentReceipt:installed});assert.equal(stopped,1)
 await assert.rejects(readFile(join(home,'memory-workspace/auth.json')),e=>e.code==='ENOENT')
 assert.ok((await readFile(join(stateRoot,'components/cognee/fixture/memory-workspace/auth.json'),'utf8')).includes('auth.json'))
})
test('edited memory settings block rollback before stopping the server or deleting any credential',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-component-conflict-')),home=join(root,'home');await mkdir(home);let stopped=0
 const fake={async install({stateRoot}){const memoryHome=join(stateRoot,'memory-workspace');await mkdir(memoryHome,{recursive:true});for(const name of ['config.json','auth.json','processing-binding.json','processing.json'])await writeFile(join(memoryHome,name),'{}');return{memoryHome}},async health(){return{available:true}},async stop(){stopped++}}
 const adapter=createComponentAdapters({cognee:fake}),ctx={stateRoot:join(root,'state'),dshHome:home,deploymentId:'fixture',bundleRoot:root,manifest:{components:{cognee:{assets:'payload/cognee'}}}},installed=await adapter.configureCognee(ctx)
 await writeFile(join(home,'memory-workspace/config.json'),'{"enabled":false}')
 await assert.rejects(adapter.rollbackCognee({...ctx,componentReceipt:installed}),/DEPLOY_MEMORY_ROLLBACK_CONFLICT/)
 assert.equal(stopped,0);assert.equal(await readFile(join(home,'memory-workspace/auth.json'),'utf8'),'{}')
})
