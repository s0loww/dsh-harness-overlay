import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
export const TURN_NAV_CLIENT_SHA256='6c3c61df2d6bbeecdb5f78244351224683e21677f90b6680e0b64e89e71dd1eb'
export const TURN_NAV_STAGED_CLIENT_SHA256='9dd9bb662611c2d4562130e1acd728abd2b3d675f2cf89a3bfe256b1682f1b93'
const sha=value=>createHash('sha256').update(value).digest('hex')
export function patchTurnNavigatorClient(source){
 if(sha(source)!==TURN_NAV_CLIENT_SHA256)throw new Error('TURN_NAV_COMPAT_SOURCE_DRIFT')
 const eol=source.includes('\r\n')?'\r\n':'\n';let text=source.replaceAll('\r\n','\n')
 const start=text.indexOf('\t\tfunction SettingsNavModeRow({ t }) {'),end=text.indexOf('\n\t\t//#endregion\n\t\t//#region src/client/locales.ts',start)
 if(start<0||end<start)throw new Error('TURN_NAV_COMPAT_SETTINGS_ANCHOR')
 text=text.slice(0,start)+`\t\tfunction SettingsNavModeRow({ t }) {
            const mode = (0, react.useSyncExternalStore)(subscribeRailMode, getRailMode);
            return (0, react_jsx_runtime.jsxs)("label", {className:"tn-mode-row",children:[
                (0, react_jsx_runtime.jsxs)("div",{className:"tn-mode-row-text",children:[
                    (0, react_jsx_runtime.jsx)("div",{className:"tn-mode-title",children:t("modeRowTitle")}),
                    (0, react_jsx_runtime.jsx)("div",{className:"tn-mode-desc",children:t("modeRowDesc")})
                ]}),
                (0, react_jsx_runtime.jsx)("select",{className:"tn-mode-selector",value:mode,"aria-label":t("modeRowTitle"),onChange:event=>setRailMode(event.target.value),children:OPTIONS.map(option=>(0, react_jsx_runtime.jsx)("option",{value:option.id,children:t(option.label)},option.id))})
            ]});
        }`+text.slice(end)
 for(const [icon,symbol]of[['Up','↑'],['Down','↓']]){
  const before=`_deepseek_ai_dsh_client_ui_primitives.IconChevron${icon}Outline14, { size: 12 }`
  if(text.split(before).length!==2)throw new Error('TURN_NAV_COMPAT_ICON_ANCHOR')
  text=text.replace(before,`"span", { "aria-hidden": true, children: "${symbol}" }`)
 }
 const dependency='\t\tlet _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");\n'
 if(text.split(dependency).length!==2)throw new Error('TURN_NAV_COMPAT_DEPENDENCY_ANCHOR')
 text=text.replace(dependency,'');if(text.includes('_deepseek_ai_dsh_client_ui_primitives.'))throw new Error('TURN_NAV_COMPAT_PRIMITIVE_REMAINS')
 const output=eol==='\r\n'?text.replaceAll('\n','\r\n'):text
 if(sha(output)!==TURN_NAV_STAGED_CLIENT_SHA256)throw new Error('TURN_NAV_COMPAT_OUTPUT_DRIFT')
 return output
}
export async function adaptTurnNavigatorPackage(directory){
 const path=join(directory,'lib/client.js'),source=await readFile(path,'utf8'),output=patchTurnNavigatorClient(source)
 await writeFile(path,output)
 return{hostVersion:'0.2.1-rc.5',sourceClientSha256:TURN_NAV_CLIENT_SHA256,stagedClientSha256:sha(output),contract:'native-html-selector-and-text-icons-no-legacy-primitives'}
}
