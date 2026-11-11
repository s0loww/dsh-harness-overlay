import { join } from 'node:path'
import { OfficialUiInstallerError } from '../official-ui/common.mjs'
import {queryNativeDesktopProcesses,validDesktopProcessRows} from './process-query.mjs'

export function matchingProcesses(rows, executable) {
  const normalize = value => String(value ?? '').replaceAll('/', '\\').toLowerCase()
  return rows.filter(row => normalize(row.ExecutablePath) === normalize(executable))
    .map(row => row.ProcessId).filter(Number.isSafeInteger)
}

export async function assertDesktopStopped(installRoot, { platform = process.platform, query } = {}) {
  if (platform !== 'win32') return
  let rows
  try {
    rows = query ? await query() : await queryNativeDesktopProcesses()
  } catch { throw new OfficialUiInstallerError('LIVE_PROCESS_CHECK_UNAVAILABLE') }
  if (!Array.isArray(rows)) rows = [rows]
  if (!validDesktopProcessRows(rows)) throw new OfficialUiInstallerError('LIVE_PROCESS_CHECK_UNAVAILABLE')
  if (matchingProcesses(rows, join(installRoot, 'DeepSeek Harness.exe')).length) {
    throw new OfficialUiInstallerError('LIVE_DSH_STILL_RUNNING', 'Quit DSH completely, including its tray/background process.')
  }
}
