import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {appendCacheJournal,readCacheJournal,restoreCacheRows} from '../src/deployment-bundle/lib/cache-journal.mjs'
import {state} from '../src/deployment-bundle/lib/fs.mjs'
test('append-only cache log reconstructs prepare and commit in linear space',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-cache-log-'));t.after(()=>rm(root,{recursive:true,force:true}));const row={path:'a.txt',before:{type:'missing'},after:{type:'file',bytes:1,sha256:'0'.repeat(64)},backup:null,written:false}
 for(let i=0;i<100;i++){await appendCacheJournal(root,{kind:'prepare',index:i,row:{...row,path:i+'.txt'}});await appendCacheJournal(root,{kind:'commit',index:i})}
 const log=await readFile(join(root,'cache-journal.jsonl'));assert.ok(log.length<100000);const rows=await readCacheJournal(root);assert.equal(rows.length,100);assert.ok(rows.every(r=>r.written))
})
test('rename before commit and torn append recover from exact target bytes, preserving drift',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-cache-recover-'));t.after(()=>rm(root,{recursive:true,force:true}));const cache=join(root,'cache');await mkdir(cache);const target=join(cache,'a.txt');await writeFile(target,'old');const before=await state(target);await mkdir(join(root,'cache-before'));await writeFile(join(root,'cache-before/a.txt'),'old');await writeFile(target,'new');const after=await state(target),row={path:'a.txt',before,after,backup:'cache-before/a.txt',written:false}
 await appendCacheJournal(root,{kind:'prepare',index:0,row});await appendFile(join(root,'cache-journal.jsonl'),'{"kind":"comm');const rows=await readCacheJournal(root);assert.equal(rows[0].written,false);await restoreCacheRows({cacheRoot:cache,transaction:root,rows});assert.equal(await readFile(target,'utf8'),'old');await restoreCacheRows({cacheRoot:cache,transaction:root,rows});await writeFile(target,'colleague edit');await assert.rejects(restoreCacheRows({cacheRoot:cache,transaction:root,rows}),{code:'DEPLOY_CACHE_RECOVERY_CONFLICT'});assert.equal(await readFile(target,'utf8'),'colleague edit')
})
