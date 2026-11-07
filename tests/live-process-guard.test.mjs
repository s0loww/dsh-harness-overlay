import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { assertDesktopStopped, matchingProcesses } from '../installer/official-live/process-guard.mjs'

test('promotion refuses the exact running executable including background windows', async () => {
  const install = 'C:/Apps/DeepSeek Harness'
  const executable = join(install, 'DeepSeek Harness.exe')
  await assert.rejects(assertDesktopStopped(install, { platform: 'win32', query: async () => [
    { ProcessId: 12, ExecutablePath: executable },
  ] }), { code: 'LIVE_DSH_STILL_RUNNING' })
  await assertDesktopStopped(install, { platform: 'win32', query: async () => [
    { ProcessId: 13, ExecutablePath: 'D:/Candidate/DeepSeek Harness.exe' },
  ] })
  assert.deepEqual(matchingProcesses([{ ProcessId: 12, ExecutablePath: executable.toUpperCase() }], executable), [12])
})

test('failed or incomplete process inventory fails before profile writes', async () => {
  await assert.rejects(assertDesktopStopped('C:/Apps', { platform: 'win32', query: async () => { throw new Error('denied') } }), { code: 'LIVE_PROCESS_CHECK_UNAVAILABLE' })
  await assert.rejects(assertDesktopStopped('C:/Apps', { platform: 'win32', query: async () => [{ ProcessId: 12 }] }), { code: 'LIVE_PROCESS_CHECK_UNAVAILABLE' })
  await assertDesktopStopped('C:/Apps', { platform: 'win32', query: async () => [] })
})
