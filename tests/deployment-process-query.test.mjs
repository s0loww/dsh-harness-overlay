import test from 'node:test'
import assert from 'node:assert/strict'
import {queryNativeDesktopProcesses,DESKTOP_PROCESS_COMMAND} from '../installer/official-live/process-query.mjs'
import {assertDesktopStopped} from '../installer/official-live/process-guard.mjs'
import {createOfficialDeploymentAdapters} from '../src/deployment-bundle/lib/official-adapter.mjs'
test('native process query retries execution/empty JSON failures and emits explicit array JSON',async()=>{
 let calls=0;const rows=await queryNativeDesktopProcesses({executeImpl:async()=>{calls++;if(calls===1)throw Error('CIM transient');return{stdout:calls===2?'':'[]'}}});assert.deepEqual(rows,[]);assert.equal(calls,3);assert.match(DESKTOP_PROCESS_COMMAND,/ErrorActionPreference='Stop'/);assert.match(DESKTOP_PROCESS_COMMAND,/ConvertTo-Json -InputObject @\(/)
})
test('empty native output never becomes success after bounded retries',async()=>{let calls=0;await assert.rejects(queryNativeDesktopProcesses({executeImpl:async()=>{calls++;return{stdout:''}}}));assert.equal(calls,3)})
test('injected query refusal is single call and malformed rows fail closed',async()=>{
 let calls=0;await assert.rejects(assertDesktopStopped('C:/Apps',{platform:'win32',query:async()=>{calls++;throw Error('denied')}}),{code:'LIVE_PROCESS_CHECK_UNAVAILABLE'});assert.equal(calls,1)
 for(const row of [null,{ProcessId:0,ExecutablePath:'C:/Apps/a.exe'},{ProcessId:1,ExecutablePath:123},{ProcessId:1,ExecutablePath:''}])await assert.rejects(assertDesktopStopped('C:/Apps',{platform:'win32',query:async()=>[row]}),{code:'LIVE_PROCESS_CHECK_UNAVAILABLE'})
})
test('deployment native adapter denies persistently inaccessible rows after bounded fresh snapshots',async()=>{
 let calls=0;const adapter=createOfficialDeploymentAdapters({platform:'win32',executeImpl:async()=>{calls++;return{stdout:'[{"ProcessId":42,"ExecutablePath":null}]'}}});await assert.rejects(adapter.assertStopped({installRoot:'C:/Apps'}),{code:'DEPLOY_PROCESS_CHECK_UNAVAILABLE'});assert.equal(calls,3)
})
test('transient unknown process snapshot may pass only after a new wholly valid snapshot',async()=>{
 let calls=0;const rows=await queryNativeDesktopProcesses({executeImpl:async()=>({stdout:++calls===1?'[{"ProcessId":42,"ExecutablePath":null}]':'[]'})});assert.equal(calls,2);assert.deepEqual(rows,[])
 calls=0;const adapter=createOfficialDeploymentAdapters({platform:'win32',executeImpl:async()=>({stdout:++calls===1?'[{"ProcessId":42,"ExecutablePath":null}]':JSON.stringify([{ProcessId:42,ExecutablePath:process.cwd()+'/DeepSeek Harness.exe'}])})});await assert.rejects(adapter.assertStopped({installRoot:process.cwd()}),{code:'DEPLOY_DSH_RUNNING'});assert.equal(calls,2)
})
