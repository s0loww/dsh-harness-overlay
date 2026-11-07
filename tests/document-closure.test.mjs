import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageDocumentClosure } from '../scripts/stage-document-closure.mjs'
const donor = process.env.AIRULES_DOCUMENT_DONOR_MODULES
// Exact donor fixture is supplied explicitly; never discover a user install or download it.
test('Windows document closure stages offline and detects tampering before destination writes', { skip: !donor }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'document-closure-')); t.after(() => rm(root, { recursive: true, force: true }))
 const reviewed = join(root, 'reviewed'), target = join(root, 'target')
 const result = await stageDocumentClosure({ modulesRoot: donor, targetModulesRoot: reviewed })
 assert.equal(result.packages.length, 4); assert.equal(result.networkUsed, false); assert.equal(result.installScriptsExecuted, false)
 assert.equal((await stageDocumentClosure({ modulesRoot: donor, targetModulesRoot: reviewed })).packages.length, 4)
 await writeFile(join(reviewed, '@firecrawl/anydoc/package.json'), '{}')
 await assert.rejects(stageDocumentClosure({ modulesRoot: reviewed, targetModulesRoot: target }), /DOCUMENT_CLOSURE_HASH_MISMATCH/)
 await assert.rejects(access(target), { code: 'ENOENT' })
})
