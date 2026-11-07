import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { OfficialUiInstallerError } from '../official-ui/common.mjs'

const execute = promisify(execFile)

export function matchingProcesses(rows, executable) {
  const normalize = value => String(value ?? '').replaceAll('/', '\\').toLowerCase()
  return rows.filter(row => normalize(row.ExecutablePath) === normalize(executable))
    .map(row => row.ProcessId).filter(Number.isSafeInteger)
}

export async function assertDesktopStopped(installRoot, { platform = process.platform, query } = {}) {
  if (platform !== 'win32') return
  let rows
  try {
    rows = query ? await query() : JSON.parse((await execute('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress",
    ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim() || '[]')
  } catch { throw new OfficialUiInstallerError('LIVE_PROCESS_CHECK_UNAVAILABLE') }
  if (!Array.isArray(rows)) rows = [rows]
  if (rows.some(row => !row?.ExecutablePath)) throw new OfficialUiInstallerError('LIVE_PROCESS_CHECK_UNAVAILABLE')
  if (matchingProcesses(rows, join(installRoot, 'DeepSeek Harness.exe')).length) {
    throw new OfficialUiInstallerError('LIVE_DSH_STILL_RUNNING', 'Quit DSH completely, including its tray/background process.')
  }
}
