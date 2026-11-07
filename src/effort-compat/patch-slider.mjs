import { createHash } from 'node:crypto'

export const SLIDER_CLIENT_SHA256 = 'f266014ab1ece98d9c13d68ad3787e2b3cb19bb23f99797d3419d5934d586474'
function once(source, anchor, replacement, expected = 1) {
  if (source.split(anchor).length !== expected + 1) throw new Error('EFFORT_COMPAT_ANCHOR_MISMATCH')
  return source.split(anchor).join(replacement)
}

export function patchEffortSliderClient(source, { mode = 'native-menu' } = {}) {
  if (createHash('sha256').update(source).digest('hex') !== SLIDER_CLIENT_SHA256) throw new Error('EFFORT_COMPAT_HASH_MISMATCH')
  if (mode === 'native-menu') {
    source = once(source, 'if (typeof document !== "undefined" && document.querySelector(', 'if (false && typeof document !== "undefined" && document.querySelector(')
    source = once(source, 'exports.apply = apply;', 'exports.apply = () => {}; // AIRules: keep the official session-bound reasoning menu; legacy global click capture is disabled.')
    return once(source, 'exports.inject = inject;', 'exports.inject = [];')
  }
  if (mode !== 'shared-directory') throw new Error('EFFORT_COMPAT_MODE_UNSUPPORTED')
  const start = source.indexOf('\t\tfunction useDirectory(connection, sessionId) {')
  const end = source.indexOf('\t\tfunction EffortPanel(props) {', start)
  if (start < 0 || end < 0) throw new Error('EFFORT_COMPAT_DIRECTORY_ANCHOR_MISMATCH')
  source = source.slice(0, start) + `\t\tfunction selectSharedEffort(directory, selection) {
      const state = directory.store.getSnapshot();
      const same = value => value && value.provider === selection.provider && value.model === selection.model && value.reasoningEffort === selection.reasoningEffort;
      if (same(state.pending) || state.status !== "error" && same(state.current)) return Promise.resolve({ ok: true, value: undefined });
      return directory.select(selection);
    }
    function useDirectory(connection, sessionId) {
      const directory = connection.directoryFor(sessionId);
      const snapshot = react.useSyncExternalStore(directory.store.subscribe, directory.store.getSnapshot, directory.store.getSnapshot);
      const [error, setError] = react.useState(undefined);
      react.useEffect(() => {
        let alive = true;
        directory.load().catch(() => { if (alive) setError("Не удалось загрузить каталог моделей"); });
        return () => { alive = false; };
      }, [directory]);
      return { directory: snapshot.status === "idle" || snapshot.status === "loading" && !snapshot.groups.length ? null : snapshot, error: error || snapshot.error || undefined };
    }
` + source.slice(end)
  source = once(source, 'const inject = ["connection", "sessions", "theme"];', 'const inject = ["modelDirectories", "sessions", "theme"];')
  source = once(source, 'connection: ctx.get("connection"),', 'connection: ctx.get("modelDirectories"),', 2)
  source = once(source, 'const { directory, error: directoryError } = useDirectory(connection, sessionId);', 'const { directory, error: directoryError } = useDirectory(connection, sessionId);\n\t\t\tconst [selectionError, setSelectionError] = react.useState(undefined);')
  source = once(source, 'const current = rawCurrent ?? fallback;', 'const current = rawCurrent;')
  source = once(source, 'connection.api.sessions.selectModel({', 'setSelectionError(undefined);\n\t\t\t\tselectSharedEffort(connection.directoryFor(sessionId), {')
  source = once(source, '}).catch(() => {});', '}).then(result => { if (!result.ok) throw new Error("EFFORT_SELECTION_REJECTED"); }).catch(() => { setSelectionError("Не удалось изменить уровень рассуждения. Повторите выбор."); setRawValue(initialRaw); });')
  source = once(source, '!usable && /* @__PURE__ */', '(!usable || selectionError) && /* @__PURE__ */')
  source = once(source, 'children: disabled ? directoryError', 'role: selectionError ? "alert" : "status",\n\t\t\t\t\t\t\tchildren: selectionError || (disabled ? directoryError')
  source = once(source, ': "У текущей модели один уровень рассуждения"', ': "У текущей модели один уровень рассуждения")')
  source = once(source, 'children: labelIndex === 0 ? "OFF" : labelIndex === efforts.length - 1 ? "MAX" : entry.name', 'children: entry.name')
  return once(source, 'exports.apply = apply;', 'exports.airulesEffortCompatibility = { useDirectory, EffortPanel, selectSharedEffort };\n\t\texports.apply = apply;')
}

export function patchEffortSliderPackage(pkg, { mode = 'native-menu' } = {}) {
  if (pkg?.name !== 'dsh-effort-slider' || pkg.version !== '1.1.0') throw new Error('EFFORT_COMPAT_PACKAGE_MISMATCH')
  if (mode === 'native-menu') return pkg
  if (mode !== 'shared-directory') throw new Error('EFFORT_COMPAT_MODE_UNSUPPORTED')
  return { ...pkg, dsh: { ...pkg.dsh, client: { ...pkg.dsh.client, inject: [...new Set([...pkg.dsh.client.inject, '@deepseek-ai/dsh-client-ui-model-selection'])] } } }
}
