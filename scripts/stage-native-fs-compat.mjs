import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePackageClosure } from './stage-package-closure.mjs'
import { applyNativeFsBomPatch, applyNativeFsSandboxImportPatch, NATIVE_FS_VERSION, NATIVE_FS_INPUT_SHA256, NATIVE_FS_OUTPUT_SHA256, NATIVE_FS_SANDBOX_INPUT_SHA256, NATIVE_FS_SANDBOX_OUTPUT_SHA256 } from '../src/native-fs-compat/patch.mjs'

const lockPath = fileURLToPath(new URL('../upstream/native-fs-closure.lock.json', import.meta.url))
export const COMPAT_PACKAGE = 'airules-dsh-native-fs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Materialize reviewed native code and a target-specific, hash-locked closure. */
export async function stageNativeFsCompat({ nativeModules, target }) {
  if (typeof nativeModules !== 'string' || !isAbsolute(nativeModules)) throw new Error('NATIVE_FS_EXPLICIT_MODULES_REQUIRED')
  const localRoot = join(nativeModules, '@deepseek-ai/dsh-fs-local'), sandboxRoot = join(nativeModules, '@deepseek-ai/dsh-fs-sandbox')
  const localManifest = JSON.parse(await readFile(join(localRoot, 'package.json'), 'utf8')), sandboxManifest = JSON.parse(await readFile(join(sandboxRoot, 'package.json'), 'utf8'))
  if (localManifest.name !== '@deepseek-ai/dsh-fs-local' || sandboxManifest.name !== '@deepseek-ai/dsh-fs-sandbox') throw new Error('NATIVE_FS_SOURCE_IDENTITY_MISMATCH')
  const local = applyNativeFsBomPatch(await readFile(join(localRoot, 'lib/index.js')), { packageVersion: localManifest.version })
  const sandbox = applyNativeFsSandboxImportPatch(await readFile(join(sandboxRoot, 'lib/index.js')), { packageVersion: sandboxManifest.version })
  if (hash(local) !== NATIVE_FS_OUTPUT_SHA256 || hash(sandbox) !== NATIVE_FS_SANDBOX_OUTPUT_SHA256) throw new Error('NATIVE_FS_OUTPUT_HASH_MISMATCH')
  const lockBytes = await readFile(lockPath), lock = JSON.parse(lockBytes)
  if (JSON.stringify(lock.optionalDependencySelection) !== JSON.stringify({koffi:['@koromix/koffi-win32-x64']})) throw new Error('NATIVE_FS_PLATFORM_SELECTION_MISMATCH')
  await mkdir(join(target, 'lib'), { recursive: true })
  await writeFile(join(target, 'lib/local.js'), local, { flag: 'wx' })
  await writeFile(join(target, 'lib/index.js'), sandbox, { flag: 'wx' })
  await cp(join(sandboxRoot, 'LICENSE'), join(target, 'LICENSE'), { force: false, errorOnExist: true })
  await cp(join(localRoot, 'LICENSE'), join(target, 'LICENSE-local'), { force: false, errorOnExist: true })
  const manifest = { name: COMPAT_PACKAGE, version: '0.1.0-dev1', private: true, type: 'module', main: 'lib/index.js',
    exports: { '.':'./lib/index.js', './local':'./lib/local.js', './package.json':'./package.json' }, license:'MIT', os:['win32'], cpu:['x64'],
    dependencies: lock.roots, peerDependencies: { '@deepseek-ai/cordis':'~4.0.5', '@deepseek-ai/dsh-fs':NATIVE_FS_VERSION, '@deepseek-ai/dsh-sandbox':NATIVE_FS_VERSION, '@deepseek-ai/dsh-sandbox-policy':NATIVE_FS_VERSION } }
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2)+'\n', { flag:'wx' })
  await writeFile(join(target, 'PROVENANCE.md'), '# Native filesystem compatibility\n\nOfficial MIT DSH 0.2.1-rc.5 sandbox and local filesystem source. Native sandbox code changes only its superclass import to the local copy. The local copy preserves the original UTF-8 BOM inside native atomic edit writeback. Read presentation, write semantics, locks, versions and permission fences remain native. Dependencies are pinned for Windows x64; other optional Koffi targets are deliberately excluded.\n', {flag:'wx'})
  await stagePackageClosure({ modulesRoot:nativeModules, targetModulesRoot:join(target,'node_modules'), lock })
  return { package:COMPAT_PACKAGE, patch:'utf8-bom-edit-v1', hostVersion:NATIVE_FS_VERSION,
    localInputSha256:NATIVE_FS_INPUT_SHA256, localOutputSha256:NATIVE_FS_OUTPUT_SHA256,
    sandboxInputSha256:NATIVE_FS_SANDBOX_INPUT_SHA256, sandboxOutputSha256:NATIVE_FS_SANDBOX_OUTPUT_SHA256,
    dependencyLockSha256:hash(lockBytes), privateRuntimePackages:lock.packages.length, target:'win32-x64' }
}
