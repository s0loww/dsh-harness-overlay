import {createHash}from'node:crypto'
import{readFile,writeFile}from'node:fs/promises'
import{join}from'node:path'
export const COMPOSER_HOST_VERSION='0.2.1-rc.5'
export const COMPOSER_PACKAGE_VERSION='0.7.2'
export const COMPOSER_MANIFEST_SHA256='4891909f369c769f443c121ec924ef639fef65a1bdfd46ea32854e66f8812fa8'
export const COMPOSER_HOST_SHA256='71d3da278a8533af60e111e2908bf61203844397f473689cf9c0f6034cbf0703'
export const COMPOSER_CLIENT_SHA256='84cc4d9d4208e042505317661ed2d233754ad4a11804d1ac8318833a6537c806'
export const COMPOSER_STAGED_MANIFEST_SHA256='101a16962d82751cd00bde3120f7e5b29b6123a5c1c222b42975cfe985f5fd4c'
export const COMPOSER_STAGED_CLIENT_SHA256='37eee21340f8dd7143b6bf03c46a6d60c4235aeea88a884a0d61b3e841afe385'
export const COMPOSER_HISTORICAL_CLIENT_SHA256='7f1475561f299df0141580f45a371942dfc1670ba1f54515ac58fe1b015ead5d'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const evidence=(clientSha=COMPOSER_STAGED_CLIENT_SHA256)=>({hostVersion:COMPOSER_HOST_VERSION,sourceManifestSha256:COMPOSER_MANIFEST_SHA256,stagedManifestSha256:COMPOSER_STAGED_MANIFEST_SHA256,sourceEntrySha256:COMPOSER_HOST_SHA256,sourceClientSha256:COMPOSER_CLIENT_SHA256,stagedClientSha256:clientSha,contract:'exact-rc5-retained-chat-projection-no-storage-migration'})
export function verifyComposerHistoryCompatibility(manifestBytes,hostBytes,clientBytes,{allowHistorical=false}={}){
  for(const[name,bytes,expected]of[['MANIFEST',manifestBytes,COMPOSER_STAGED_MANIFEST_SHA256],['ENTRY',hostBytes,COMPOSER_HOST_SHA256]])if(!(bytes instanceof Uint8Array)||sha(bytes)!==expected)throw new Error(`COMPOSER_COMPAT_STAGED_${name}_DRIFT`)
  // Historical authenticity permits rollback of immutable UI20/21. It does not
  // certify their failed browser lifecycle or select them for a fresh build.
  if(typeof allowHistorical!=='boolean')throw new Error('COMPOSER_COMPAT_HISTORICAL_OPTION_INVALID')
  if(!(clientBytes instanceof Uint8Array)||![COMPOSER_STAGED_CLIENT_SHA256,...(allowHistorical?[COMPOSER_HISTORICAL_CLIENT_SHA256]:[])].includes(sha(clientBytes)))throw new Error('COMPOSER_COMPAT_STAGED_CLIENT_DRIFT')
  return evidence(sha(clientBytes))
}
/** Only the reviewed public package's already adapted client; no broad peer exemption. */
export function patchComposerHistory(manifestBytes,hostBytes,clientBytes,{hostVersion=COMPOSER_HOST_VERSION}={}){
  if(hostVersion!==COMPOSER_HOST_VERSION)throw new Error('COMPOSER_COMPAT_HOST_MISMATCH')
  for(const[name,bytes,expected]of[['MANIFEST',manifestBytes,COMPOSER_MANIFEST_SHA256],['ENTRY',hostBytes,COMPOSER_HOST_SHA256],['CLIENT',clientBytes,COMPOSER_CLIENT_SHA256]])if(!(bytes instanceof Uint8Array)||sha(bytes)!==expected)throw new Error(`COMPOSER_COMPAT_${name}_DRIFT`)
  const pkg=JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  if(pkg.name!=='dsh-composer-history'||pkg.version!==COMPOSER_PACKAGE_VERSION||Object.hasOwn(pkg.engines??{},'dsh'))throw new Error('COMPOSER_COMPAT_IDENTITY_MISMATCH')
  pkg.engines={...pkg.engines,dsh:hostVersion}
  let client=Buffer.from(clientBytes).toString('utf8')
  const once=(before,after)=>{if(client.split(before).length!==2)throw new Error('COMPOSER_COMPAT_ANCHOR_MISMATCH');client=client.replace(before,after)}
  // A missing optional Cordis service must be read through get(), not a
  // direct property fallback, which throws before the clean-host fallback.
  once('scope.get?.("projectPresetUi") || scope.projectPresetUi ||','scope.get?.("projectPresetUi") ||')
  once('const historyNodes = (id) => historySource(id)?.getSnapshot()?.legacy.nodes ?? emptyNodes;',
    `const historyNodes = (id) => {
                const source = historySource(id);
                if (source === void 0) return emptyNodes;
                // rc.5 Chat targets activate synchronously on subscribe. Read only
                // already retained bindings; no session/network/history migration.
                let snapshot = source.getSnapshot();
                if (snapshot === void 0) {
                    const release = source.subscribe(() => {});
                    try { snapshot = source.getSnapshot(); } finally { release(); }
                }
                return snapshot?.legacy.nodes ?? emptyNodes;
            };`)
  once('parts.push(...extract(binding.session.getSnapshot().nodes, options.maxHistory));','parts.push(...extract(historyNodes(id), options.maxHistory));')
  const outputManifest=Buffer.from(JSON.stringify(pkg,null,2)+'\n'),outputClient=Buffer.from(client)
  if(sha(outputClient)!==COMPOSER_STAGED_CLIENT_SHA256)throw new Error('COMPOSER_COMPAT_CURRENT_OUTPUT_DRIFT')
  return{manifestBytes:outputManifest,clientBytes:outputClient,adaptation:verifyComposerHistoryCompatibility(outputManifest,hostBytes,outputClient)}
}
/** Builder-owned copy only; immutable source/artifacts are never patched in place. */
export async function adaptComposerHistoryPackage(directory,options){
  const paths=[join(directory,'package.json'),join(directory,'lib/index.js'),join(directory,'lib/client.js')]
  const result=patchComposerHistory(...await Promise.all(paths.map(path=>readFile(path))),options)
  await writeFile(paths[0],result.manifestBytes);await writeFile(paths[2],result.clientBytes)
  return result.adaptation
}
