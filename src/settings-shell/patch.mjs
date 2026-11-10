import { createHash } from 'node:crypto'
import { GROUPS, UNIFIED_PROVIDERS, PROVIDER_ALIASES, SECTION_META, visibleRows, groupSections, activeSection } from './navigation.mjs'
export const MARKER = 'airules-settings-shell-rc5-v1'
export const TARGET = '@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'
export const BASELINE_SHA256 = 'b6e96324f358448bd962d8b232bf1c21e7819999de69f4951d6fa4f5cc5e6c16'
export const SETTINGS_022_SHA256 = 'd509cc81f418b26404651fdcc7ddd4c6d83a0b10b7fb505cb5ad2691dc438ff2'
const HOSTS = Object.freeze({ '0.2.1-rc.5': { sha256: BASELINE_SHA256, marker: MARKER }, '0.2.2-rc.1': { sha256: SETTINGS_022_SHA256, marker: 'airules-settings-shell-022-v1' } })
const sha256 = source => createHash('sha256').update(source).digest('hex')
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`SETTINGS_SHELL_ANCHOR_CHANGED: ${before.slice(0, 80)}`)
  return source.replace(before, () => after)
}
/** Offline pinned-source adaptation. It registers no runtime hooks or DOM observers. */
export function patchSettingsShell(original, { hostVersion = '0.2.1-rc.5' } = {}) {
  const host = HOSTS[hostVersion]
  if (!host) throw new Error('SETTINGS_SHELL_HOST_MISMATCH')
  if (original.includes(host.marker)) return original
  if (sha256(original) !== host.sha256) throw new Error('SETTINGS_SHELL_BASELINE_CHANGED')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let source = original.replace(/\r\n/gu, '\n')
  const panelStart = '\t\tfunction SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }) {'
  const constants = `const GROUPS=${JSON.stringify(GROUPS)},UNIFIED_PROVIDERS=${JSON.stringify(UNIFIED_PROVIDERS)},PROVIDER_ALIASES=${JSON.stringify(PROVIDER_ALIASES)},SECTION_META=${JSON.stringify(SECTION_META)};`
  source = once(source, panelStart, `// ${host.marker}\n${constants}\n${visibleRows.toString()}\n${groupSections.toString()}\n${activeSection.toString()}\n${panelStart}`)
  source = once(source, 'const active = rows.find((r) => r.id === activeId)?.id ?? rows[0]?.id;', 'const active = activeSection(rows, activeId);')
  const start = source.indexOf('children: rows.map((row) => (0, react_jsx_runtime.jsxs)("button", {')
  const endToken = '}, row.id))'
  const end = source.indexOf(endToken, start)
  if (start < 0 || end < start) throw new Error('SETTINGS_SHELL_NAV_ANCHOR_CHANGED')
  source = source.slice(0, start) + `children: groupSections(rows).map(group => (0, react_jsx_runtime.jsxs)("div", {
    role: "group", "aria-label": group.label,
    children: [(0, react_jsx_runtime.jsx)("div", { style: { fontSize: 11, opacity: .65, padding: "16px 12px 5px", fontWeight: 600, letterSpacing: ".03em" }, "aria-hidden": true, children: group.label }), ...group.rows.map(row => (0, react_jsx_runtime.jsxs)("button", {
      type: "button", className: clsx(SettingsRoot_module_css_default.navCell, row.id === active && SettingsRoot_module_css_default.active),
      style: { width: "100%", flex: "none" }, title: SECTION_META[row.id]?.[1] ?? row.label,
      "aria-current": row.id === active ? "true" : void 0,
      "data-modal-autofocus": row.id === active ? "" : void 0,
      onClick: () => onSelect(row.id),
      children: [navIcon(row.id), (0, react_jsx_runtime.jsx)("span", { className: SettingsRoot_module_css_default.navLabel, children: row.label })]
    }, row.id))]
  }, group.label))` + source.slice(end + endToken.length)
  // Keep the grid track and the navigation in agreement. A fixed nav width
  // over the native 188px track paints its scrollbar over the settings form.
  source = once(source, 'className: SettingsRoot_module_css_default.panel,', 'className: SettingsRoot_module_css_default.panel,\n style: { width: "min(1120px, calc(100vw - 48px))", gridTemplateColumns: "minmax(170px, 22%) minmax(0, 1fr)" },')
  source = once(source, 'className: SettingsRoot_module_css_default.nav,', 'className: SettingsRoot_module_css_default.nav,\n style: { width: "100%", minWidth: 0, overflow: "hidden" },')
  return eol === '\r\n' ? source.replace(/\n/gu, '\r\n') : source
}
