# DSH Harness Overlay

Приватный overlay для воспроизводимой адаптации DSH Desktop 1С.

Репозиторий содержит нашу обвязку и адаптированные standalone-компоненты с
доступной provenance; это приватный архив исходников, а не готовая публичная
перепубликация поставки. Полный дистрибутив, установочные бинарники, credentials,
история сессий и machine-local state в Git не включаются. В `upstream/` хранятся
метаданные baseline, версии, хэши и инвентарь компонентов.

У отдельных адаптаций происхождение и полнота лицензий требуют уточнения перед
внешним распространением; см. package-level `PROVENANCE.md`, `NOTICE`, `LICENSE`.
В частности, сохраняется расхождение LICENSE/metadata Telegram. Приватное
хранение не обозначает проверку прав на публичную поставку этих компонентов.

Актуальная установленная версия: UI dev16 / policy dev36. Текущая работа:
пересборка встроенного airules из Git-коммита `243ce44` и проверка на отдельном
стенде. Порядок подготовки исходников описан в
[`docs/BUILD-PREREQUISITES.md`](docs/BUILD-PREREQUISITES.md).

`.gitattributes` сохраняет исходные байты, BOM и окончания строк: exact-text
patches и проверки closure зависят от SHA-256. Не применяйте массовое
переформатирование к закреплённым upstream-компонентам и NOTICE/LICENSE.

## Baseline

```powershell
node scripts/snapshot-installed.mjs "E:\path\to\DSH-Desktop-1C"
node scripts/verify-baseline.mjs "E:\path\to\DSH-Desktop-1C"
npm test
```

Скрипт читает только заранее перечисленные файлы:

- `RELEASE-MANIFEST.json`;
- `dsh-1c-bundle/package.json` и `package-lock.json`;
- `dsh-1c-bundle/diagnostics/plugin-catalog.json`;
- целевые source-файлы release-specific project-preset patch, включая
  `project-presets.js`, API/client/wizard и `scripts/repair-agent-preset.mjs`.

Применение overlay реализовано отдельным этапом с version guard, повторной
проверкой хэшей, staging, полным backup, receipt и rollback. До явного запуска
`installer/apply.mjs` инструменты snapshot/verify/stage/plan ничего в DSH не
изменяют.

## Overlay artifact

Проверенный runtime provider и embedded rulepack собираются в автономный
artifact без изменения установленного DSH:

```powershell
node scripts/stage-overlay.mjs `
  --rulepack "D:\path\to\airules-rulepack" `
  --output "D:\path\to\fresh-output" `
  --target-release 20261103-134539
```

Artifact содержит provider, rulepack, Cordis fragment, pinned exact-text patch
для пресета `1c-airules` и manifest с SHA-256.
Release guard берётся из `upstream/release.lock.json`. В manifest нет исходных
machine paths, MCP endpoints или credentials. Безопасные команды plan, apply и
rollback описаны в `installer/README.md`; apply предназначен сначала для
candidate-копии, а не для работающей установки.

UI artifact для официального Desktop имеет отдельный candidate-only installer:
`installer/official-ui/README.md`. Он блокирует live-пути и создаёт
`ui-ready.json` только после успешной транзакции packages + Cordis.

Installer поддерживает manifest schema v1 и v2. Для schema v2 он применяет
`releasePatch`, packages и Cordis одной guarded stage/quarantine-транзакцией;
точный контракт описан в `patches/README.md`.

## UI porting track

Интерфейсная часть выделена в независимый контракт `src/ui-overlay` и собрана в
immutable artifact `dist/airules-ui-overlay-0.1.0-dev5`. Он содержит только
проверенные UI packages/data, русификацию через официальный locale API и
read-only balance HUD; policy/rulepack, MCP bindings, credentials и runtime
state в UI artifact не входят. План и release evidence находятся в
`docs/ui-porting-plan.md`.

## Isolated official Desktop candidate

Чистый candidate официального Desktop создаётся только в фиксированном новом
каталоге `var/candidate/official-desktop-rc5-01`:

```powershell
npm run candidate:create
node scripts/create-official-candidate.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02"
```

Скрипт проверяет release lock исходной установки, копирует и повторно проверяет
immutable install, создаёт отдельные минимальные `DSH_HOME`/Desktop profile и
Electron user-data, затем записывает manifest и SHA-256. Live `%USERPROFILE%/.dsh`
не читается и не копируется. Существующий candidate не перезаписывается.
Для CLI разрешены только свежие непосредственные дочерние каталоги внутри
`var/candidate` этого репозитория.

GUI не запускается автоматически. Launcher
`scripts/launch-official-candidate.ps1` остаётся заблокированным до появления
проверенных UI/policy artifacts и обоих маркеров `ui-ready.json` и
`policy-ready.json` в candidate root.

## Clean official Desktop preset

Для clean target используется отдельный внешний policy artifact. Он регистрирует
полную композицию `1c-airules` через штатный
`@deepseek-ai/dsh-agent-preset` и загружает airules provider внутри этой
композиции. Поэтому Standard и пользовательские пресеты не получают его
prompts, tools или skills.

```powershell
node scripts/stage-official-policy.mjs `
  --rulepack "D:\path\to\airules-rulepack" `
  --artifact-version "0.12.0-dev7" `
  --output "dist\airules-official-policy-0.12.0-dev7"
```

Artifact содержит preset, проверенный provider, embedded rulepack и отдельный
safe 1C mechanics layer (BSL/XML editor, XML/EDT tree, внешний optional BSL
LSP). Oleg Full canon, MCP bindings, endpoints, credentials, database/deploy
mechanics и runtime state в него не входят. Версия обязательна и связана с
именем fresh output-каталога; переиспользовать версию с другими байтами нельзя.

Policy artifact устанавливается только в изолированный candidate. Инсталлятор
сначала проверяет официальный release lock и все файлы artifact, затем
транзакционно копирует семь package-каталогов и добавляет собственный Cordis-блок,
не изменяя UI-блок. Отдельные receipt, backup root и `policy-ready.json` не
пересекаются с UI-инсталлятором.

```powershell
npm run official:policy:plan -- --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02"
npm run official:policy:apply -- --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02"
npm run official:policy:rollback -- --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02" --receipt "<receipt.json>"
```

Rollback разрешён только при совпадении receipt, owned targets и backup hashes;
после него UI packages, UI Cordis-блок и `ui-ready.json` остаются на месте.
Миграция поверх уже установленной версии требует явного
`--replace-collisions` для `plan` и `apply`. Флаг разрешает замену только
выделенных policy package-каталогов и структурно отдельного policy Cordis-блока;
shared/ambiguous блоки остаются запрещены. Новый versioned receipt хранит полный
pre-migration state и откатывает новую версию обратно в старую без запуска
rollback старого artifact.

## Promotion в локальную official Desktop

После успешного visible smoke на изолированном candidate используется отдельный
`installer/official-live`. Candidate-инсталляторы по-прежнему блокируют live
пути. Promotion проверяет те же immutable UI/policy artifacts и точный official
baseline, затем транзакционно добавляет только allowlisted package-каталоги и
выделенные Cordis-блоки. MCP bindings, endpoints и credentials не переносятся.

Plan read-only; apply/rollback требуют точную acknowledgement-фразу, закрытый
DSH и новый внешний backup-каталог. Полный контракт и команды находятся в
`installer/official-live/README.md`. Автоматический live apply не выполняется.

