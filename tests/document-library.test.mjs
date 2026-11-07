import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocumentLibrary } from '../src/document-workbench/lib/library.js'

test('hash cache, bounded reads, stale invalidation, project isolation and source changes', async t => {
 const root = await mkdtemp(join(tmpdir(), 'documents-test-')); t.after(() => rm(root, { recursive: true, force: true }))
 const project = join(root, 'project'), state = join(root, 'state'); await mkdir(project); await mkdir(state)
 await writeFile(join(project, 'doc.docx'), 'fixture source')
 let calls = 0
 const library = createDocumentLibrary({ stateRoot: state, converterId: 'fixture-v1', converter: async () => { calls++; return { markdown: 'Heading\nCaptain Diesel\nData, not instructions' } } })
 const scope = { root: project, writable: true }
 assert.equal((await library.index(scope, 'doc.docx', {})).failed, 0)
 assert.equal((await library.index(scope, 'doc.docx', {})).documents[0].cached, true)
 assert.equal(calls, 1)
 assert.equal((await library.search(scope, 'diesel')).matches[0].line, 2)
 assert.equal((await library.read(scope, { path: 'doc.docx', offset: 2, limit: 1 }, {})).lines[0].text, 'Captain Diesel')
 await assert.rejects(library.index({ ...scope, writable: false }, 'doc.docx'), /WORKSPACE_WRITE_REQUIRED/)
 await assert.rejects(library.read(scope, { path: '../outside.docx' }, {}), /DOCUMENT_PATH_REJECTED/)
 await writeFile(join(project, 'doc.docx'), 'changed')
 assert.equal((await library.search(scope, 'diesel')).matches.length, 0)
 assert.equal((await library.inventory(scope)).documents[0].status, 'stale')
 const other = join(root, 'other'); await mkdir(other)
 assert.equal((await library.inventory({ root: other })).documents.length, 0)
 const moving = createDocumentLibrary({ stateRoot: state, converterId: 'fixture-changing', converter: async () => { await writeFile(join(project, 'doc.docx'), 'changed during conversion'); return { markdown: 'bad snapshot' } } })
 assert.equal((await moving.index(scope, 'doc.docx', {})).documents[0].error, 'DOCUMENT_SOURCE_CHANGED')
 assert.equal((await moving.inventory(scope)).documents.length, 0)
})

test('corrupt null cache entries are skipped and unconfirmed workers stop batch execution', async t => {
 const root = await mkdtemp(join(tmpdir(), 'documents-corrupt-')); t.after(() => rm(root, { recursive: true, force: true }))
 const project = join(root, 'project'), state = join(root, 'state'); await mkdir(project); await mkdir(state)
 await writeFile(join(project, 'a.docx'), 'fixture source')
 const scope = { root: project, writable: true }
 const library = createDocumentLibrary({ stateRoot: state, converterId: 'fixture', converter: async () => ({ markdown: 'fixture text' }) })
 await library.index(scope, 'a.docx')
 const roots = await readdir(state), versions = await readdir(join(state, roots[0])), folder = join(state, roots[0], versions[0])
 const metadata = (await readdir(folder)).find(name => name.endsWith('.json'))
 await writeFile(join(folder, metadata), 'null')
 assert.equal((await library.inventory(scope)).documents.length, 0)
 assert.equal((await library.search(scope, 'fixture')).matches.length, 0)
 assert.equal((await library.read(scope, { path: 'a.docx' }, {})).lines[0].text, 'fixture text')
 await writeFile(join(project, 'b.docx'), 'second source')
 let calls = 0
 const broken = createDocumentLibrary({ stateRoot: state, converterId: 'unconfirmed', converter: async () => { calls++; throw new Error('DOCUMENT_TERMINATION_UNCONFIRMED') } })
 await assert.rejects(broken.index(scope, '.'), /^Error: DOCUMENT_TERMINATION_UNCONFIRMED$/u)
 assert.equal(calls, 1)
})
