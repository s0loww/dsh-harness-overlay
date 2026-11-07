import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyMermaidRuntime } from '../scripts/stage-official-policy.mjs'

test('Mermaid packaging verifies canonical source, npm integrity metadata and exact installed runtime bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mermaid-stager-')), rulepack = join(root, 'rulepack'), pkg = join(root, 'package')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(rulepack, 'skills'), { recursive: true }); await mkdir(join(pkg, 'runtime'), { recursive: true })
  await cp('D:/AI_Projects/project_rules/core/skills/craft-mermaid', join(rulepack, 'skills', 'craft-mermaid'), { recursive: true })
  await cp(new URL('../src/general-tools/runtime/mermaid', import.meta.url), join(pkg, 'runtime', 'mermaid'), { recursive: true })
  const result = await verifyMermaidRuntime(rulepack, pkg)
  assert.equal(result.installedFiles, 317); assert.equal(result.packages.length, 5)
  assert.ok(result.packages.some(pkg => pkg.name === '@resvg/resvg-js-win32-x64-msvc'))
  assert.deepEqual(JSON.parse(await readFile(join(pkg, 'runtime', 'mermaid-provenance.json'), 'utf8')), result)
  const renderer = join(pkg, 'runtime', 'mermaid', 'scripts', 'runtime', 'render.mjs'), original = await readFile(renderer)
  await writeFile(renderer, Buffer.concat([original, Buffer.from('\n// drift')]))
  await assert.rejects(verifyMermaidRuntime(rulepack, pkg), /MERMAID_CANONICAL_SOURCE_DRIFT/)
  await writeFile(renderer, original)
  const moduleFile = join(pkg, 'runtime', 'mermaid', 'scripts', 'runtime', 'node_modules', 'beautiful-mermaid', 'package.json'), bytes = await readFile(moduleFile)
  await writeFile(moduleFile, Buffer.concat([bytes, Buffer.from('\n')]))
  await assert.rejects(verifyMermaidRuntime(rulepack, pkg), /MERMAID_INSTALLED_BYTES_DRIFT/)
  await writeFile(moduleFile, bytes)
  const lock = join(pkg, 'runtime', 'mermaid', 'scripts', 'runtime', 'node_modules', '.package-lock.json'), installed = JSON.parse(await readFile(lock, 'utf8'))
  installed.packages['node_modules/beautiful-mermaid'].integrity = 'sha512-invalid'
  await writeFile(lock, JSON.stringify(installed))
  await assert.rejects(verifyMermaidRuntime(rulepack, pkg), /MERMAID_INSTALLED_PACKAGE_DRIFT/)
})
