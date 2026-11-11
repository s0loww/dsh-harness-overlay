import {appendFile,readFile,lstat,copyFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {guard,seal,validSeal,fail,safeRelative,state,same} from './fs.mjs'
const LIMIT=64*1024*1024
export async function appendCacheJournal(transaction,record){
 const path=join(transaction,'cache-journal.jsonl');await guard(path);await appendFile(path,JSON.stringify(seal(record))+'\n',{encoding:'utf8',mode:0o600})
}
export async function readCacheJournal(transaction){
 const path=join(transaction,'cache-journal.jsonl');await guard(path);let bytes
 try{if((await lstat(path)).size>LIMIT)fail('DEPLOY_CACHE_JOURNAL_INVALID');bytes=await readFile(path)}catch(e){if(e.code==='ENOENT')return[];throw e}
 if(bytes.length>LIMIT)fail('DEPLOY_CACHE_JOURNAL_INVALID')
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytes.lastIndexOf(10)+1)),lines=text.split('\n');lines.pop() // A torn final append has not completed; infer the prepared row from target bytes.
 const rows=[]
 for(const line of lines){let entry;try{entry=JSON.parse(line)}catch{fail('DEPLOY_CACHE_JOURNAL_INVALID')}
  if(!validSeal(entry)||!Number.isSafeInteger(entry.index)||entry.index<0)fail('DEPLOY_CACHE_JOURNAL_INVALID')
  if(entry.kind==='prepare'){
   if(entry.index!==rows.length||rows.length>=50001||!entry.row||entry.row.written!==false)fail('DEPLOY_CACHE_JOURNAL_INVALID')
   safeRelative(transaction,entry.row.path);if(entry.row.backup!==null&&entry.row.backup!=='cache-before/'+entry.row.path)fail('DEPLOY_CACHE_JOURNAL_INVALID');rows.push(entry.row)
  }else if(entry.kind==='commit'){
   if(entry.index!==rows.length-1||!rows[entry.index]||rows[entry.index].written)fail('DEPLOY_CACHE_JOURNAL_INVALID');rows[entry.index].written=true
  }else fail('DEPLOY_CACHE_JOURNAL_INVALID')
 }
 return rows
}
export async function restoreCacheRows({cacheRoot,transaction,rows}){
 for(const row of [...rows].reverse()){
  const target=safeRelative(cacheRoot,row.path),actual=await state(target)
  // Rename can succeed just before the commit append fails or is interrupted.
  if(same(actual,row.before))continue
  if(!same(actual,row.after))fail('DEPLOY_CACHE_RECOVERY_CONFLICT')
  if(row.backup){if(row.backup!=='cache-before/'+row.path)fail('DEPLOY_CACHE_JOURNAL_INVALID');const backup=safeRelative(transaction,row.backup);if(!same(await state(backup),row.before))fail('DEPLOY_CACHE_BACKUP_INVALID');await copyFile(backup,target)}
  else await unlink(target)
 }
}
