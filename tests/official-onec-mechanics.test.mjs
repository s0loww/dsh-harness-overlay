import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findSessionProjectRoot } from '../src/official-onec-mechanics/project-root.js'

const require = createRequire(import.meta.url)
const { lspActionsServers } = require('../src/official-onec-mechanics/lsp-servers.cjs')

test('official 1C root resolver prefers explicit project marker above XML/EDT tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-onec-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const configuration = join(project, 'src', 'Configuration')
  const module = join(configuration, 'Catalogs', 'Items', 'Ext')
  await mkdir(module, { recursive: true })
  await writeFile(join(project, '.dev.env'), 'INFOBASE_NAME=test\n')
  await writeFile(join(configuration, 'Configuration.mdo'), '<Configuration/>')
  assert.equal(findSessionProjectRoot(module), project)
})

test('official 1C root resolver falls back to closest XML/EDT root and rejects relative paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-onec-xml-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configuration = join(root, 'export')
  const module = join(configuration, 'CommonModules', 'Core', 'Ext')
  await mkdir(module, { recursive: true })
  await writeFile(join(configuration, 'Configuration.xml'), '<MetaDataObject/>')
  assert.equal(findSessionProjectRoot(module), configuration)
  assert.throws(() => findSessionProjectRoot('relative/project'), /ABSOLUTE_REQUIRED/u)
})

test('BSL LSP table is fail-clean and activates only for an existing explicit command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'airules-onec-lsp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = join(root, process.platform === 'win32' ? 'bsl-language-server.exe' : 'bsl-language-server')
  await writeFile(command, '')
  assert.deepEqual(lspActionsServers({ command: join(root, 'missing') }), {})
  const table = lspActionsServers({ command, args: ['--stdio'] })
  assert.equal(table.bsl.command, command)
  assert.deepEqual(table.bsl.args, ['--stdio'])
  assert.deepEqual(table.bsl.extensionToLanguage, { '.bsl': 'bsl', '.os': 'bsl' })
  assert.deepEqual(table.bsl.formattingOptions, { tabSize: 4, insertSpaces: false })
})
