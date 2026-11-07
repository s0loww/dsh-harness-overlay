# Точная совместимость LSP actions с native rc.5

Проверено по pinned Desktop `0.2.1-rc.5`: Electron запускает
`dsh-desktop-host`, который использует тот же `dsh/profile-boot.runProfile`,
что и Node probe. Scoped preset admission также вызывает
`dsh-app-boot.prepareProfileEntries`. Автоматического Electron allow-version
нет. Без profile `compatibility.json` пакет `dsh-lsp-actions@0.4.6` с peers
`>=0.1.2-rc.1 <0.2.0` действительно отключается. Успешный старт Web UI этого
не обнаруживает: Electron накапливает stderr отдельно и передаёт stdout.

`src/onec-lsp-compat/patch.mjs` меняет только manifest собственной staged copy:
добавляет `engines.dsh: "0.2.1-rc.5"`. Native admission документированно
применяет собственный engines.dsh вместо peer-проверки версии host. Старые
peer ranges, code и node engine не расширяются. Любая другая версия host
остаётся несовместимой. Profile-wide exemptions не создаются.

Перед адаптацией проверяются точные identity/version, SHA manifest и SHA
`lib/index.js`; entry остаётся неизменным. В artifact metadata записываются
sourceManifestSha256, stagedManifestSha256, sourceEntrySha256, hostVersion и
ограниченный contract. Drift или повторное применение helper останавливают
сборку; staged verifier принимает только точно рассчитанные конечные байты.

Native proof: fresh isolated profile с public config copy и read-only links
к candidate packages; сам LSP package скопирован и адаптирован. В проектном
пресете actual `onec-lsp-actions` enabled, fiberState=2. Зарегистрированы
`lsp_diagnostics`, `lsp_completion`, `lsp_format`, `lsp_code_action`,
`lsp_symbols`, `lsp_signature`, `lsp_inlay_hints`, `lsp_rename`. Standard
пресет их не получает. Это проверяет реальную совместимость регистрации
tool/schema/agent lifecycle с pinned host, а не только строку SemVer.

Probe задаёт `servers:{}` и запрещает каждый subprocess и model request.
Настоящий вызов `lsp_diagnostics` возвращает `LSP_ACTION_UNAVAILABLE`, а не
фиктивные пустые diagnostics. Языковой сервер, BSL LS, MCP и модели не
запускаются. **Семантическая проверка BSL/format/rename с реальным сервером в
этот допуск не входит.** `dsh-composer-history` проверяется отдельной
адаптацией; этот helper не изменяет его и не снимает с него ограничение.

Команды: `node --test tests/onec-lsp-compat.test.mjs`; отдельный probe —
`node scripts/probe-onec-lsp-compat.mjs <explicit-candidate-root>`.
