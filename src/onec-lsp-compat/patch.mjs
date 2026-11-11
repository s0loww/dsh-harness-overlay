import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ONEC_LSP_HOST_VERSION = '0.2.1-rc.5'
export const ONEC_LSP_PACKAGE_VERSION = '0.4.6'
export const ONEC_LSP_MANIFEST_SHA256 = '1dae01aea122a306e75e66b6da59ca575f6391047383cfd77e88ac54ed2cecb3'
export const ONEC_LSP_ENTRY_SHA256 = 'fe97ed31ea6e0e7c409330cd811e0f81413a2b8b310d8e23646a0fed781377bf'
export const ONEC_LSP_STAGED_MANIFEST_SHA256 = 'c11a7e46d5866d462e02fcefcaf100574dba6818b93c8e32dcd994855d325ab9'
export const ONEC_LSP_TOOL_NAMES = Object.freeze(['lsp_diagnostics', 'lsp_completion', 'lsp_format', 'lsp_code_action', 'lsp_symbols', 'lsp_signature', 'lsp_inlay_hints', 'lsp_rename'])
export const ONEC_LSP_022_STAGED_MANIFEST_SHA256 = '743f051aa83885735117a0e51a384c4e59de3fcf4bf12c2b289b58fce36ba10f'
const hosts = {'0.2.1-rc.5': ONEC_LSP_STAGED_MANIFEST_SHA256, '0.2.2-rc.1': ONEC_LSP_022_STAGED_MANIFEST_SHA256}
function hostHash(version) { if (!Object.hasOwn(hosts, version)) throw new Error('ONEC_LSP_COMPAT_HOST_MISMATCH'); return hosts[version] }
const contract = version => version === ONEC_LSP_HOST_VERSION ? 'exact-rc5-native-agent-lsp-admission-no-server-proof' : 'exact-rc022-native-agent-lsp-admission-no-server-proof'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Exact managed compatibility declaration; never grants profile exemptions. */
export function patchOnecLspManifest(manifestBytes, entryBytes, { hostVersion = ONEC_LSP_HOST_VERSION } = {}) {
  const manifestHash = hostHash(hostVersion)
  if (!(manifestBytes instanceof Uint8Array) || sha(manifestBytes) !== ONEC_LSP_MANIFEST_SHA256) throw new Error('ONEC_LSP_COMPAT_MANIFEST_DRIFT')
  if (!(entryBytes instanceof Uint8Array) || sha(entryBytes) !== ONEC_LSP_ENTRY_SHA256) throw new Error('ONEC_LSP_COMPAT_ENTRY_DRIFT')
  const pkg = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  if (pkg.name !== 'dsh-lsp-actions' || pkg.version !== ONEC_LSP_PACKAGE_VERSION || Object.hasOwn(pkg.engines ?? {}, 'dsh')) throw new Error('ONEC_LSP_COMPAT_IDENTITY_MISMATCH')
  pkg.engines = { ...pkg.engines, dsh: hostVersion }
  const output = Buffer.from(JSON.stringify(pkg, null, 2) + '\n')
  if (sha(output) !== manifestHash) throw new Error('ONEC_LSP_COMPAT_OUTPUT_DRIFT')
  return { manifestBytes: output, adaptation: { sourceManifestSha256: ONEC_LSP_MANIFEST_SHA256, stagedManifestSha256: sha(output), sourceEntrySha256: ONEC_LSP_ENTRY_SHA256,
    hostVersion, contract: contract(hostVersion) } }
}

export function verifyOnecLspCompatibility(manifestBytes, entryBytes, { hostVersion = ONEC_LSP_HOST_VERSION } = {}) {
  const manifestHash = hostHash(hostVersion)
  if (sha(manifestBytes) !== manifestHash || sha(entryBytes) !== ONEC_LSP_ENTRY_SHA256) throw new Error('ONEC_LSP_COMPAT_STAGED_DRIFT')
  return { sourceManifestSha256: ONEC_LSP_MANIFEST_SHA256, stagedManifestSha256: manifestHash, sourceEntrySha256: ONEC_LSP_ENTRY_SHA256,
    hostVersion, contract: contract(hostVersion) }
}

/** Called only for the builder's owned package copy before artifact sealing. */
export async function adaptOnecLspPackage(directory, options) {
  const manifestPath = join(directory, 'package.json')
  const [manifest, entry] = await Promise.all([readFile(manifestPath), readFile(join(directory, 'lib/index.js'))])
  const result = patchOnecLspManifest(manifest, entry, options)
  await writeFile(manifestPath, result.manifestBytes)
  return result.adaptation
}

/** Adapt only the builder-owned editor copy before sealing. */
export async function adaptBundledBslEditor(directory) {
  const path=join(directory,'lib/index.js'),clientPath=join(directory,'lib/client.js')
  const original=(await readFile(path,'utf8')).replaceAll('\r\n','\n'),originalClient=(await readFile(clientPath,'utf8')).replaceAll('\r\n','\n')
  const once=(source,needle,replacement,label)=>{const at=source.indexOf(needle);if(at<0||source.indexOf(needle,at+needle.length)>=0)throw Error('EDITOR_LINTER_ANCHOR_'+label);return source.slice(0,at)+replacement+source.slice(at+needle.length)}
  let code=original
  const replace=(a,b,label)=>{code=once(code,a,b,label)}
  replace('appendFileSync, existsSync,','appendFileSync, existsSync, lstatSync, realpathSync,','IMPORT')
  replace('  serverBin: z.string().default(""),',`  serverBin: z.string().default(""),
  serverArgs: z.array(z.string()).default([]),
  serverMode: z.string().default("legacy"),
  bundledRuntime: z.boolean().default(false),`,'SCHEMA')
  replace('const LOG_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-bsl-editor");','const LOG_DIR = process.env.DSH_HOME ? join(process.env.DSH_HOME, "bsl-editor") : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-bsl-editor");','SCOPE')
  replace('const CONFIG_FILE = join(LOG_DIR, "bsl-language-server.json");','const CONFIG_FILE = process.env.DSH_HOME ? join(process.env.DSH_HOME, "bsl-linter", "bsl-language-server.json") : join(LOG_DIR, "bsl-language-server.json");','DEFAULT_CONFIG')
  replace('let childPid = null;',`let childPid = null;
let childRoot = null;`,'ROOT')
  replace('    mkdirSync(LOG_DIR, { recursive: true });\n    if (!existsSync(CONFIG_FILE))',`    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    if (!existsSync(CONFIG_FILE))`,'CONFIG_DIRECTORY')
  replace('  child = spawn(bin, ["-w", "--server.port=" + config.serverPort, "--configuration=" + CONFIG_FILE], {',`  let selectedConfig = CONFIG_FILE;
  const projectConfig = join(root, ".bsl-language-server.json");
  try {
    const info = lstatSync(projectConfig);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || resolve(realpathSync(projectConfig)).toLowerCase() !== resolve(projectConfig).toLowerCase()) throw Error("BSL_PROJECT_CONFIG_UNSAFE");
    selectedConfig = projectConfig;
  } catch (error) {
    if (error.code !== "ENOENT") { setState("missing", "BSL_PROJECT_CONFIG_UNSAFE"); return; }
  }
  const prefix = config.serverArgs ?? [];
  if (!Array.isArray(prefix) || prefix.some(v => typeof v !== "string" || /[\\0\\r\\n]/u.test(v)) || !["legacy", "modern"].includes(config.serverMode ?? "legacy")) { setState("missing", "BSL_SERVER_ARGS_INVALID"); return; }
  const args = config.serverMode === "modern"
    ? [...prefix, "websocket", "--server.port=" + config.serverPort, "-c", selectedConfig, "--app.websocket.lsp-path=/lsp"]
    : [...prefix, "-w", "--server.port=" + config.serverPort, "--configuration=" + selectedConfig];
  const childEnv = { ...process.env };
  if (config.bundledRuntime === true) for (const key of ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"]) delete childEnv[key];
  child = spawn(bin, args, {
    env: childEnv,`,'LAUNCH')
  replace(`  childPid = child.pid ?? null;
  child.on("exit", (code) => {`,`  childPid = child.pid ?? null;
  childRoot = root;
  const startedChild = child;
  child.on("exit", (code) => {
    if (child !== startedChild) return;
    childRoot = null;`,'EXIT')
  replace('      let up = await probePort(config.serverPort);',`      if (config.bundledRuntime && childPid && childRoot !== root) killTree();
      let up = await probePort(config.serverPort);
      if (config.bundledRuntime && up && !childPid) return json(res, 409, { ok: false, state: "port-conflict", reason: "BSL_PORT_OWNED_BY_ANOTHER_PROCESS", port: config.serverPort });`,'PORT')
  replace('      serverBin: config.serverBin,',`      serverBin: config.serverBin,
      serverArgs: config.serverArgs,
      serverMode: config.serverMode,
      bundledRuntime: config.bundledRuntime,`,'GET')
  replace('            serverBin: patch.serverBin ?? config.serverBin,',`            serverBin: patch.serverBin ?? config.serverBin,
            serverArgs: patch.serverArgs ?? (patch.serverBin && patch.serverBin !== config.serverBin ? [] : config.serverArgs),
            serverMode: patch.serverMode ?? (patch.serverBin && patch.serverBin !== config.serverBin ? "legacy" : config.serverMode),
            bundledRuntime: patch.serverBin && patch.serverBin !== config.serverBin ? false : config.bundledRuntime,`,'SAVE')
  const client=originalClient.replaceAll('Путь к bsl-language-server.exe','Путь к Java или bsl-language-server.exe').replaceAll('Укажите полный путь к exe, если сервер установлен не туда, где ожидается.','Укажите полный путь к Java или серверу. Пакетная Java и параметры JAR настроены автоматически.')
  await writeFile(path,code);await writeFile(clientPath,client)
  return {sourceIndexSha256:sha(Buffer.from(original)),sourceClientSha256:sha(Buffer.from(originalClient)),stagedIndexSha256:sha(Buffer.from(code)),stagedClientSha256:sha(Buffer.from(client)),contract:'scoped-home-modern-websocket-project-config-loopback'}
}
