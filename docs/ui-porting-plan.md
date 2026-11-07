# План переноса интерфейса DSH

Статус: UI payload `airules-ui-overlay-0.1.0-dev5` собран и проверен на
официальном Desktop `0.2.1-rc.5`; candidate apply/rollback/reapply и startup
smoke проходят. Live promotion остаётся отдельным guarded-этапом.

## Границы

Интерфейс переносится отдельным artifact `airules-dsh-ui-overlay`. Он не
содержит policy/rulepack, MCP bindings, credentials, историю сессий или runtime
state. Исходная сборка Олега используется только как pinned source inventory;
целевой clean DSH проверяется отдельным baseline lock.

```text
Oleg release metadata
  -> UI component inventory
  -> license/API/state audit
  -> selected audited components
  -> UI-only staged artifact
  -> candidate clean DSH
  -> health + UI smoke + rollback
  -> release
```

## Приоритет

1. Общие настройки и shell — основа остальных страниц.
2. Баланс/стоимость — видимая пользовательская ценность, но нужен совместимый
   billing/usage backend целевого DSH.
3. Русская локализация — data-only с обязательным provenance каждого словаря.
4. Workspace/sidebar — переносится связкой `dock-base` → `dock-files` →
   `dsh-activity-pane`.
5. Панели plugins/skills/MCP — только UI; конфигурация и секреты остаются у
   target DSH.
6. Расписание и прочие composer extensions.
7. Тема/фон.
8. Компаньон — отдельный последующий инкремент после проверки лицензий модели,
   текстур и runtime; в release `dev5` не входит.

## Контракты

Каждый компонент фиксирует владельца, source package/version/license,
client/backend dependencies, state policy, portability mode, target release,
required/optional, install order и health/smoke checks. `candidate` не означает
готовность: в release допускается только `audited`.

Target compatibility fail-closed: неизвестный release или host version
блокирует staging/apply. UI artifact устанавливается отдельной транзакцией и
имеет собственный receipt; сбой optional-компонента может отключить только его,
сбой required-компонента откатывает весь UI overlay.

## Риски и компромиссы

- Package-copy быстрее reimplementation, но сильнее привязан к API host.
- Vendor patch подходит только для точного release и требует source/result
  hashes; он не является универсальным портом.
- Data overlay локализации проще кода, но требует сохранения attribution и
  разрешения конфликтов ключей.
- Баланс и MCP-панель выглядят автономно, однако зависят от backend services;
  отсутствие сервиса должно давать degraded UI, а не скрытый endpoint.
- Browser-local state не переносится: пользовательские настройки начнутся с
  безопасных defaults.

## Текущее release evidence

- immutable official baseline и artifact hashes зафиксированы;
- 21 package payload + Cordis fragment не содержат MCP bindings, credentials
  или runtime state;
- русификация использует официальный locale API: 216 namespaces / 24 320
  строк, включая адаптацию `dsh-sleep-send` без DOM/host monkeypatch;
- balance HUD работает в read-only degraded-state без backend;
- `rc5-03` прошёл полный rollback до чистого baseline и повторный apply;
- `rc5-04` прошёл preflight и visible startup smoke.

Нативные `Application/Edit` и описания официальных experimental plugins
остаются в signed `app.asar`; release намеренно не патчит host. Следующий шаг —
guarded promotion в рабочий профиль и smoke после установки. Компаньон остаётся
отдельным optional-треком.

