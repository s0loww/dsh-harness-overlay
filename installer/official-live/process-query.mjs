import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const execute=promisify(execFile)
export const DESKTOP_PROCESS_COMMAND="$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,ExecutablePath) -Compress"
// Resample a transient failed/incomplete native snapshot; never drop an unknown
// row or infer that its process stopped. Only a wholly valid fresh snapshot may
// authorize progress. Persistent incomplete inventory remains a closed refusal.
export async function queryNativeDesktopProcesses({executeImpl=execute,attempts=3}={}){
 for(let attempt=0;attempt<attempts;attempt++){
  try{const result=await executeImpl('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',DESKTOP_PROCESS_COMMAND],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});const rows=JSON.parse(result.stdout.trim());if(!validDesktopProcessRows(rows))throw Error('DESKTOP_PROCESS_ROWS_UNAVAILABLE');return rows}
  catch(error){if(attempt===attempts-1)throw error}
 }
 throw Error('DESKTOP_PROCESS_QUERY_UNAVAILABLE')
}
export function validDesktopProcessRows(rows){return Array.isArray(rows)&&rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Number.isSafeInteger(row.ProcessId)&&row.ProcessId>0&&typeof row.ExecutablePath==='string'&&row.ExecutablePath.trim().length>0&&!/[\x00-\x1f]/u.test(row.ExecutablePath))}
