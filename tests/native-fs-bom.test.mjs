import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyNativeFsBomPatch, applyNativeFsSandboxImportPatch, NATIVE_FS_INPUT_SHA256, NATIVE_FS_OUTPUT_SHA256, NATIVE_FS_SANDBOX_OUTPUT_SHA256 } from '../src/native-fs-compat/patch.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MODULES = join(REPO, 'var/asar-extract-rc5/dsh/node_modules')
const NATIVE = join(MODULES, '@deepseek-ai')
const original = await readFile(join(NATIVE, 'dsh-fs-local/lib/index.js'))
const patched = applyNativeFsBomPatch(original)
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

test('native compatibility patch accepts only exact pinned input and version', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'), NATIVE_FS_INPUT_SHA256)
  assert.throws(() => applyNativeFsBomPatch(Buffer.from('different')), /INPUT_HASH_MISMATCH/)
  assert.throws(() => applyNativeFsBomPatch(original, { packageVersion: 'future' }), /VERSION_MISMATCH/)
  assert.throws(() => applyNativeFsBomPatch(patched), /INPUT_HASH_MISMATCH/)
  assert.equal(createHash('sha256').update(patched).digest('hex'), NATIVE_FS_OUTPUT_SHA256)
})

test('actual patched native filesystem retains BOM, CRLF, CAS and sandbox fences', async t => {
  const root = join(REPO, 'var/native-fs-bom-tests', randomUUID())
  const pkg = join(root, 'package'), workspace = join(root, 'workspace')
  await mkdir(pkg, { recursive: true }); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), '{"type":"module"}\n')
  await symlink(MODULES, join(pkg, 'node_modules'), 'junction')
  await writeFile(join(pkg, 'local.js'), patched)
  // Preserve every native sandbox operation, replacing its superclass import
  // solely inside this isolated fixture package. Never mutate SDK/install.
  const sandboxOriginal = await readFile(join(NATIVE, 'dsh-fs-sandbox/lib/index.js'))
  const sandboxPatched = applyNativeFsSandboxImportPatch(sandboxOriginal)
  assert.equal(createHash('sha256').update(sandboxPatched).digest('hex'), NATIVE_FS_SANDBOX_OUTPUT_SHA256)
  assert.throws(() => applyNativeFsSandboxImportPatch(sandboxPatched), /INPUT_HASH_MISMATCH/)
  assert.throws(() => applyNativeFsSandboxImportPatch(sandboxOriginal, { packageVersion: 'future' }), /VERSION_MISMATCH/)
  await writeFile(join(pkg, 'sandbox.js'), sandboxPatched)
  const { Context } = await import(pathToFileURL(join(NATIVE, 'cordis/lib/index.js')))
  const { SandboxedFileSystem } = await import(pathToFileURL(join(pkg, 'sandbox.js')))
  const { LocalFileSystem } = await import(pathToFileURL(join(pkg, 'local.js')))
  const ctx = new Context()
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) })
  let fs
  const handle = ctx.plugin({ name: 'actual-native-bom-test', apply(scope) {
    fs = new SandboxedFileSystem(scope, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
  } })
  await handle.await()
  try {
    assert.ok(fs instanceof LocalFileSystem)
    assert.equal(fs.sandboxMode, 'workspace-write')
    for (const bom of [false, true]) for (const newline of ['\n', '\r\n']) await t.test(`BOM=${bom}, newline=${JSON.stringify(newline)}`, async () => {
      const file = join(workspace, `${bom}-${newline.length}.bsl`)
      const initial = ['//+ Тест', 'Функция Пример() Экспорт', '\tВозврат 1;', 'КонецФункции', '//-', ''].join(newline)
      const bytes = Buffer.concat([bom ? BOM : Buffer.alloc(0), Buffer.from(initial)])
      await writeFile(file, bytes)
      const target = await fs.resolve(file), originalVersion = (await fs.stat(target)).version
      const before = await fs.readText(target)
      assert.equal(before, initial)
      const first = await fs.editText(target, { oldString: '//+', newString: '// +', replaceAll: false }, { version: originalVersion })
      assert.equal(first.before.charCodeAt(0) === 0xfeff, false)
      assert.equal(first.after.charCodeAt(0) === 0xfeff, false)
      const afterFirst = await readFile(file)
      await assert.rejects(fs.editText(target, { oldString: '//-', newString: '// -', replaceAll: false }, { version: originalVersion }), error => error.code === 'FS_STALE_VERSION')
      assert.deepEqual(await readFile(file), afterFirst)
      await fs.editText(target, { oldString: '//-', newString: '// -', replaceAll: false }, { version: first.version })
      const expected = Buffer.concat([bom ? BOM : Buffer.alloc(0), Buffer.from(initial.replace('//+', '// +').replace('//-', '// -'))])
      assert.deepEqual(await readFile(file), expected)
      const current = (await fs.stat(target)).version
      await assert.rejects(fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }, { version: current }))
      assert.deepEqual(await readFile(file), expected)
      await assert.rejects(fs.editText(target, { oldString: 'Возврат 1', newString: 'Возврат 2', replaceAll: false }, { version: current }, undefined, { mode: 'read-only', workspaceRoot: workspace }), error => error.code === 'FS_SANDBOX_DENIED')
      assert.deepEqual(await readFile(file), expected)
    })
    // Existing write semantics are deliberately unchanged: explicit caller text
    // controls a whole-file write, including an explicitly supplied BOM.
    await t.test('writeText preserves explicit BOM and still honors read-only refusal', async () => {
      const file = join(workspace, 'whole-file.bsl'), target = await fs.resolve(file)
      await fs.writeText(target, '\uFEFF// Создан\r\n')
      assert.deepEqual(await readFile(file), Buffer.from('\uFEFF// Создан\r\n'))
      const version = (await fs.stat(target)).version
      await assert.rejects(fs.writeText(target, 'changed', { kind: 'replaceIfVersion', version }, undefined, { mode: 'read-only', workspaceRoot: workspace }), error => error.code === 'FS_SANDBOX_DENIED')
      assert.deepEqual(await readFile(file), Buffer.from('\uFEFF// Создан\r\n'))
    })
  } finally { await ctx.fiber.dispose() }
})
