import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

export function writeProtectedFile(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[0-9-]+/u)?.[0]
      if (!sid) throw new Error('ACP_LOCAL_ACL_FAILED')
      execFileSync('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'ignore', windowsHide: true })
    }
    writeFileSync(fd, text, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
