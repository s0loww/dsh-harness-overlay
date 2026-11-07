'use strict'

const { existsSync } = require('node:fs')
const { delimiter, isAbsolute, join } = require('node:path')
const { homedir } = require('node:os')

const DEFAULT_WINDOWS_BIN = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'Programs', 'bsl-language-server', 'bsl-language-server', 'bsl-language-server.exe',
)

function commandExists(command) {
  if (!command) return false
  if (isAbsolute(command)) return existsSync(command)
  const extensions = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : ['']
  return String(process.env.PATH || '').split(delimiter)
    .some(directory => directory && extensions.some(extension => existsSync(join(directory, command + extension))))
}

function explicitArgs(value = process.env.ONEC_BSL_LS_ARGS) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : []
  } catch { return [] }
}

/**
 * BSL server table for dsh-lsp-actions. Missing server means a clean degraded
 * mode: the preset still loads, but no LSP process or tool is advertised by
 * this package. The 130 MiB Java/JAR runtime from the vendor bundle is not
 * redistributed; users may point to an installed server explicitly.
 */
function lspActionsServers(config = {}) {
  if (String(process.env.ONEC_LSP_TOOLS || '').trim().toLowerCase() === 'off') return {}
  const command = String(config.command || process.env.ONEC_BSL_LS_COMMAND || (process.platform === 'win32' ? DEFAULT_WINDOWS_BIN : '')).trim()
  if (!commandExists(command)) return {}
  const args = Array.isArray(config.args) ? config.args.map(String) : explicitArgs()
  return {
    bsl: {
      command,
      args,
      extensionToLanguage: { '.bsl': 'bsl', '.os': 'bsl' },
      fileGlobs: ['**/*.bsl', '**/*.os'],
      formattingOptions: { tabSize: 4, insertSpaces: false },
      idleTimeoutMs: 900_000,
    },
  }
}

module.exports = { commandExists, lspActionsServers }
