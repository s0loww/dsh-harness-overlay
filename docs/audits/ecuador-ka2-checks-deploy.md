# Эквадор и KA2: проверки и deploy перед адаптацией в DSH

Дата: 2026-11-04. **Аудит исходников, не протокол запуска.** Прочитаны root
AGENTS.md, релевантные правила, entrypoints, схемы и профили. В просматриваемых
рабочих деревьях дополнительных AGENTS.md не обнаружено. Проектные скрипты,
1С, COM, ibcmd, тесты и MCP **не запускались**; базы, Docker, службы и env-файлы
не менялись. Проверены имена ключей `.dev.env`, но не выведены их значения.
Архивы, `.rules-backups`, сгенерированные диаграммы и минифицированные файлы
не использованы. Адреса, строки подключения и секреты в отчёт не перенесены.

## Вывод для ADR

Общий DSH deploy нельзя строить как копию одной кнопки из чужой сборки.
Проекты уже имеют разные настоящие контуры, причём установленный generic
`agent-1c` не равен фактически настроенному контуру. Нужен **адаптер существующего
проектного runner с явным binding**, а не универсальная сборка команд 1С по
параметрам `.dev.env`. Проверки кода/документации идут через проектно связанный
фасад; прямые MCP backend-подключения и COM-инструменты в DSH не добавляются.
Применение deploy остаётся отдельной поздней стадией после review плана,
идентификации базы, snapshot/rollback и подтверждения evidence.

| Свойство | Эквадор | KA2 |
|---|---|---|
| Канонические исходники | `src/main`; тестовое расширение `src/test`, дополнительные расширения `ext/<name>` | `src` — расширение сопряжения; `src_dsb` — dashboard; `src_bp` — отдельная бухгалтерская выгрузка |
| Настоящий проектный entrypoint | `scripts/TestEnv.ps1`, `RunUnitTests.ps1`, `RunUITests.ps1`, `RunAllTests.ps1` | `tools/update-ka2-extension.ps1` — основной legacy deploy; `tools/agent-1c/agent-1c.ps1` — тестовая петля и другой deploy |
| Generic agent-1c | Файлы установлены; root `agent-1c.json` на момент аудита отсутствует | Два root профиля: `agent-1c.json`, `agent-1c-dsb.json` |
| Binding базы | Проектные локальные одноразовые базы относительно checkout | Профили привязаны к внешнему INI env-файлу, логический target `KA2_B`, `kind=file`, `environment=development` |
| `.dev.env` | Только параметры разработки/авторства/платформы; не binding фактических runners | То же; не подменяет профиль и внешний INI env |
| Главный backend | Проектная петля: ibcmd + ibsrv + ENTERPRISE; generic: DESIGNER | Generic: auto ibcmd для file, DESIGNER через кластер для server; legacy: DESIGNER |
| Unit | Собственный `TST_TestEngine` и JUnit | Generic `unit` реализован, но в обоих root профилях `unit.launchParameter` отсутствует |
| UI | `RunUITests` — подготовка/публикация базы и ручной браузерный канал; сценариев в этом runner нет | Реальные Vanessa suites; hidden desktop поддержан runner; отдельный dashboard suite |
| Backup/rollback | В изученных entrypoints автоматического backup/restore нет; локальная UI база может пересоздаваться | В изученных deploy entrypoints автоматического snapshot/restore нет; документация требует ручной backup |

Первичные источники: [EC AGENTS.md:12](D:/AI_Projects/Эквадор/AGENTS.md:12),
[EC passport:58](D:/AI_Projects/Эквадор/openspec/project.md:58),
[KA2 AGENTS.md:12](D:/AI_Projects/project_ka2/AGENTS.md:12),
[KA2 passport:82](D:/AI_Projects/project_ka2/openspec/project.md:82),
[KA2 profile:4](D:/AI_Projects/project_ka2/agent-1c.json:4),
[dashboard profile:4](D:/AI_Projects/project_ka2/agent-1c-dsb.json:4).

## Эквадор: фактическая петля

1. `TestEnv.ps1` выбирает `ONEC_BIN` либо новую установленную платформу,
   обязательно содержащую server component/ibcmd; все инструменты берутся из
   того же bin. Фиксирует отдельные unit/UI базы и ServerData под `build`,
   `src/main`, `src/test`, общий JUnit/eventlog/log paths. Это **проектный локальный
   bootstrap**, а не выбор любой базы из DSH ([TestEnv:13](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:13),
   [пути:26](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:26)).
2. `Invoke-Ibcmd` имеет таймаут, убивает свой зависший процесс и пишет лог,
   но один и тот же `build/ibcmd.log` перезаписывается; по неуспешному exit он
   делает `exit`, а по timeout бросает исключение. Следовательно recovery в
   `catch` не охватывает каждый ненулевой код одинаково ([функция:58](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:58)).
3. `Initialize-TestDB` создаёт базу, `Apply-TestConfig` импортирует main и
   `TestingExtension`; дополнительные production/test extensions читают имя
   из XML. Для расширений настраиваются scope и тестовые safe-mode параметры
   ([Import-Extension:238](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:238),
   [создание/main:293](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:293)).
4. `RunUnitTests` **меняет тестовую базу уже обычным запуском**, затем выполняет
   `ENTERPRISE /C RUN_CI_TESTS...`, читает JUnit и failure count. Старый JUnit
   удаляется перед прогоном. Явного отказа на `tests=0` и bounded timeout у
   самого ENTERPRISE в этом entrypoint не видно ([runner:31](D:/AI_Projects/Эквадор/scripts/RunUnitTests.ps1:31),
   [запуск:58](D:/AI_Projects/Эквадор/scripts/RunUnitTests.ps1:58),
   [вердикт:66](D:/AI_Projects/Эквадор/scripts/RunUnitTests.ps1:66)).
   Собственный engine выполняет зарегистрированные тестовые модули и пишет
   JUnit, это не доказательство внедрения YaXUnit ([TST engine:13](D:/AI_Projects/Эквадор/src/test/CommonModules/TST_TestEngine/Ext/Module.bsl:13),
   [startup hook:5](D:/AI_Projects/Эквадор/src/test/Ext/ManagedApplicationModule.bsl:5)).
5. `RunUITests` завершает ibsrv-сессии, останавливает найденные ibcmd-процессы,
   загружает main/выбранные расширения, поднимает ibsrv и ждёт ручного ввода.
   В коде прямо указано отсутствие UI scenarios. Это **не автоматический UI
   gate** и не Vanessa runner ([RunUITests:27](D:/AI_Projects/Эквадор/scripts/RunUITests.ps1:27),
   [ручная стадия:91](D:/AI_Projects/Эквадор/scripts/RunUITests.ps1:91)).
6. При ошибках обновления UI базы recovery очищает ServerData, а затем может
   удалить и пересоздать целиком **локальную disposable UI базу**. Такой код
   нельзя переносить на пользовательский или shared target ([Update-UITestDB:404](D:/AI_Projects/Эквадор/scripts/TestEnv.ps1:404)).
7. CI вызывает `RunAllTests`, который последовательно зовёт unit и ручной UI
   entrypoint. Поэтому наличие workflow не означает unattended зелёную
   UI-регрессию ([RunAllTests:15](D:/AI_Projects/Эквадор/scripts/RunAllTests.ps1:15),
   [CI:10](D:/AI_Projects/Эквадор/.github/workflows/ci.yml:10)).

Дополнительные реальные статические каналы: XML pitfalls checker с JSON отчётом
([параметры:34](D:/AI_Projects/Эквадор/tools/CheckXmlPitfalls.ps1:34)),
Python rules checker с staged/path/diff scope ([README:8](D:/AI_Projects/Эквадор/tools/rules-check/README.md:8)),
Python contract tests отдельного `agent-service` с mock LLM без внешнего ключа
([README:123](D:/AI_Projects/Эквадор/agent-service/README.md:123)). Это разные
слои; их нельзя выдавать за платформенную компиляцию/пользовательский сценарий.

Generic EC `tools/agent-1c` имеет bootstrap/doctor/analyze/deploy/test,
test/deploy production gate, DryRun deploy, -Extension и общий per-base lock;
DESIGNER для extension запускается отдельно на load/update. Но это более
старая копия: в `Invoke-Deploy` нет `/DumpResult`, ibcmd backend, post-deploy
probe или управления публикациями, которые уже есть в KA2. Возвращаемый
exit проверяется, но одного exit=0 для платформы недостаточно
([команды:5](D:/AI_Projects/Эквадор/tools/agent-1c/agent-1c.ps1:5),
[deploy:233](D:/AI_Projects/Эквадор/tools/agent-1c/agent-1c.ps1:233),
[план/apply:293](D:/AI_Projects/Эквадор/tools/agent-1c/agent-1c.ps1:293)).

## KA2: профили, основной deploy и расширенный runner

### Binding и целевая база

Оба root профиля имеют schemaVersion=1, отдельные sourceDir/extension/suite,
общий resultDir, file/development target и внешний INI credential reference.
В них нет inline password/user, unit, post-probe или suspendServices.
Метаданные этих полей проверены чтением JSON; env credential store не открыт.
Нельзя считать тесты dashboard проверками extension сопряжения или наоборот.
См. [profile:7](D:/AI_Projects/project_ka2/agent-1c.json:7),
[dashboard profile:7](D:/AI_Projects/project_ka2/agent-1c-dsb.json:7).

`Resolve-TargetCredentials` читает environment variables/INI и fallback поля
профиля; `.dev.env` в этот resolver не входит ([runner:77](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:77)).
JSON schema описывает environment enum, engine, extension scope/safeMode и
другие поля, **но startup runner проверяет только schemaVersion**, не прогоняет
полную схему ([schema:42](D:/AI_Projects/project_ka2/tools/agent-1c/profile.schema.json:42),
[runtime:1280](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:1280)).
Его `environment -eq production` — не fail-closed allowlist: отсутствующая или
иная метка сама по себе не блокируется. DSH adapter обязан заново требовать
явный test/development и подтверждённую фактическую identity target.

### Legacy `update-ka2-extension`

- Основной проектный deploy по passport. Поддерживает XML либо CFE, отдельные
  LoadAndUpdate/LoadOnly/UpdateOnly, -Extension, Dynamic update и общий guard/lock
  ([параметры:1](D:/AI_Projects/project_ka2/tools/update-ka2-extension.ps1:1),
  [load/update:285](D:/AI_Projects/project_ka2/tools/update-ka2-extension.ps1:285)).
- **Мутация по умолчанию**: dry-run включается отдельным `-DryRun`, в отличие от
  generic agent-1c. Запускать его как «проверку» без флага нельзя.
- Проверяет фактический путь target по allowlist, а не только имя INI section;
  есть явные overrides `-AllowOtherBase`, `-NoLock`, которые DSH автоматически
  передавать не должен ([guard:242](D:/AI_Projects/project_ka2/tools/update-ka2-extension.ps1:242)).
- Сторож контролирует процесс; в изученной реализации нет DumpResult,
  автоматического backup/rollback и post-probe. Отдельный старый
  `check-ka2-modules.ps1` запускает платформенный CheckModules с extension,
  но его финал печатает лог/exit, не формируя строгий независимый gate;
  отсутствующий лог тоже лишь печатается ([проверка:49](D:/AI_Projects/project_ka2/tools/check-ka2-modules.ps1:49)).

### Расширенный `agent-1c`

- Команды bootstrap/doctor/analyze/deploy/test/unit/serve/stop. `platform.engine`
  auto выбирает ibcmd только для file target; server target идёт через
  DESIGNER/кластер. Все утилиты — из bin одной выбранной сборки
  ([backend:288](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:288)).
  EDT importer отсутствует: наличие EDT-исходников в DSH не даёт deploy
  capability. Нужен заранее объявленный экспорт в поддерживаемый XML формат.
- ibcmd plan: import → optional extension scope → apply --force → optional
  safe-mode changes. DESIGNER extension: два запуска с -Extension; main:
  combined load+update. Имя расширения берётся из профиля, поэтому его надо
  сверить с metadata до планирования; пустое имя меняет смысл на main config
  ([ibcmd stages:507](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:507),
  [deploy:829](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:829)).
- Deploy всегда DryRun без -Apply, но DryRun создаёт каталог/отчёты: это
  «не меняет ИБ», а не полное отсутствие файловых побочных эффектов.
  Apply накрывает одним per-base lock все стадии, останавливает связанный
  ibsrv/заданные службы и восстанавливает их в finally. Отсутствующая file DB
  может создаваться через ibcmd — эту capability нельзя включать неявно.
- Guard проверяет exit, а у DESIGNER ещё и обязательный DumpResult=0.
  BOM-gate до DESIGNER load отклоняет BSL без UTF-8 BOM; для ibcmd это warning,
  поскольку поведение там в коде отмечено непроверенным
  ([verdict:478](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:478),
  [BOM/apply/restore:847](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:847)).
- Post-deploy CheckModules умеет baseline и exit=5 на новые ошибки, но
  вызывается только при включённом profile.probe.checkModules. Первое создание
  baseline — отдельная явная стадия, оно не должно молча легализовать ошибки
  релиза ([probe:528](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:528)).
- Analyze считает Error и возвращает 4; сравнение diagnostics baseline,
  обещанное документацией, не реализовано самим Invoke-Analyze. Historical
  counts из документов не являются текущим baseline ([analyze:242](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:242)).
- Unit отличает missing/zero tests от success, но root профили unit не
  настраивают. Не объявлять capability активной только по наличию функции
  ([unit:747](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:747)).

## Пирамида тестов и hidden desktop

| Слой | Эквадор | KA2 / общие ограничения |
|---|---|---|
| Syntax/static | Facade lint/XML validation, XML pitfalls, BSL LS/rules-check | Facade lint, BSL LS, contract-fallback static runner; Error-baseline требует отдельного diff |
| Platform/environment | ibcmd import/apply локального main и test extension | Явный build, source hash, extension identity, backend, DumpResult и optional CheckModules |
| Logic | TST_TestEngine/JUnit | Unit implementation есть, профилями не включена; COM scripts — отдельные data probes |
| Data | Проектные QA/COM и domain-specific runners | Ground-truth через разрешённый проектный канал; факт deploy не доказывает бизнес-инварианты |
| Known UI | Старый RunUITests только ручной канал; generic Vanessa не настроен root профилем | Реальные Vanessa suites; dashboard включает contract/cache/performance и role fixtures |
| Exploration/simulation | Ручной клиент/проектный сценарий | Advisory, не подмена deterministic regression |

KA2 `rules/test-model.md` явно разделяет gating и advisory, требует exact
tool build для shared target, per-environment lock, уникальный артефакт и diff
с baseline ([правило:14](D:/AI_Projects/project_ka2/rules/test-model.md:14)).
Source read-only smoke — **декларация suite**, не enforced read-only sandbox
Vanessa: произвольный feature может выполнять код. Изменяющие сценарии должны
иметь отдельную disposable target policy ([testing-contour:47](D:/AI_Projects/project_ka2/rules/testing-contour.md:47)).
Dashboard suite действительно описывает HTTP contract/performance, но его
README отдельно помечает предположение о client-side execution как ещё не
проверенное живым vrunner; не выдавать наличие feature за результат прогона
([suite:12](D:/AI_Projects/project_ka2/tests/vanessa_dsb/features/README.md:12),
[ограничение:42](D:/AI_Projects/project_ka2/tests/vanessa_dsb/features/README.md:42)).

KA2 `test -Hidden` повторно запускает runner через Win32 desktop и агрегирует
внутренний result. Helper создаёт desktop/процесс и по timeout завершает
процесс-родитель; это не отдельный secret sandbox и не полноценный proof всей
группы descendants ([wrapper:1051](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:1051),
[Win32 helper:57](D:/AI_Projects/project_ka2/tools/agent-1c/lib/hidden-desktop.ps1:57)).

Дополнительный `hodden_test` строже: DryRun по умолчанию, Apply всегда работает
с копией file base, маркер и проверка containment перед cleanup, JUnit/scenario
разбор, nonempty results, fail/skips, client/hidden/visible-window evidence и
cleanup verdict. Парольные аккаунты не поддерживаются; исходную базу runner не
открывает ([вход:1](D:/AI_Projects/hodden_test/Run-VanessaHidden.ps1:1),
[copy:166](D:/AI_Projects/hodden_test/Run-VanessaHidden.ps1:166),
[cleanup/verdict:417](D:/AI_Projects/hodden_test/Run-VanessaHidden.ps1:417)).
Доказательства в `VERIFICATION.ru.md` относятся к историческому generic smoke
на одноразовой копии; **этим аудитом они не повторены**, перенос на KA2 не
подтверждён. Session0/services, client-server bases, OS input/Sikuli и качество
hidden screenshots вне заявленного покрытия ([verification:3](D:/AI_Projects/hodden_test/VERIFICATION.ru.md:3)).
Копирование одного 1CD с проверкой длины не заменяет доказанно консистентный
backup активной/shared базы; нужен отдельный offline/snapshot контракт.

## Backup, evidence, несовпадения документов

1. Автоматический backup/restore в изученных основных deploy runners не найден.
   Рецепты требуют backup перед первым Apply, но это операторская обязанность
   ([EC recipe:140](D:/AI_Projects/Эквадор/tools/agent-1c/DEPLOYMENT.md:140),
   [KA2 recipe:140](D:/AI_Projects/project_ka2/tools/agent-1c/DEPLOYMENT.md:140)).
   Source rollback Git не откатывает схему/данные 1С; load+update не транзакция
   всего release. Нужны backup identity, restore procedure и post-restore probe.
2. Generic runners пишут result.json с шагами/artifacts. Но run directory имеет
   timestamp с точностью до секунды: одновременные одинаковые команды могут
   выбрать один каталог ещё до захвата base lock. Для DSH нужен уникальный
   runId и непрезаписываемый evidence namespace ([EC result:539](D:/AI_Projects/Эквадор/tools/agent-1c/agent-1c.ps1:539),
   [KA2 result:1280](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:1280)).
   EC проектный runner переиспользует JUnit/log paths; consumer должен отдельно
   закреплять артефакты конкретного запуска.
3. Generic Vanessa вердикт строится по vrunner exit; buildstatus читается для
   сообщения, обязательный nonempty JUnit/count не проверяется. Нельзя
   автоматически импортировать такое `ok` как доказанный complete regression
   ([KA2 verdict:1246](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:1246),
   [EC verdict:515](D:/AI_Projects/Эквадор/tools/agent-1c/agent-1c.ps1:515)).
4. KA2 passport ещё перечисляет старый command set и описывает generic deploy
   как дубль legacy; текущий runner уже имеет ibcmd/unit/serve/hidden/probe и
   materially отличается. Testing-contour и passport называют разные старые
   Error-count baseline; ни одно число не использовать как current fact.
   Старые прямые MCP reindex рецепты в passport также не отменяют текущий
   facade-first контракт AGENTS.md.
5. Script-contract запрещает секреты в command-line, но DESIGNER/ibcmd helpers
   фактически собирают credential arguments; redaction отчётов не убирает
   exposure списка процессов. Vanessa дополнительно использует временный
   password-bearing VAParams и удаляет его в finally. DSH не должен сохранять
   эти аргументы/файлы в tool events, журнале или proposal
   ([KA2 credentials:183](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:183),
   [VA cleanup:1263](D:/AI_Projects/project_ka2/tools/agent-1c/agent-1c.ps1:1263)).
6. COM библиотеки в обоих проектах реальны, но это **низкоуровневые live-data
   каналы**, не generic deploy. KA2 repair API имеет Apply, reread и state
   comparison. Для такого сценария нужен проектно разрешённый adapter с
   соответствующим правом; MCP-фасад не является обязательным транспортом COM
   ([COM connector:75](D:/AI_Projects/project_ka2/tools/com-tools/OneC-Connect.ps1:75),
   [repair:71](D:/AI_Projects/project_ka2/com_tools/lib/Ka2-Repair.ps1:71)).

## Предлагаемый контракт DSH-адаптера

Это **предложение ADR**, а не утверждение о существующих MCP методах.

| Операция | Контракт |
|---|---|
| `capabilities/status` | Только чтение. session→projectId→approved binding; объявляет реально настроенные static/unit/scenario/deploy/probe/backup capabilities. Возвращает degraded/notConfigured отдельно от success |
| `checks.plan` | Change set/source revision, выбранный layer/suite, target alias, exact platform build, read/write classification, timeout, lock identity, expected artifacts. Без секретов и shell arguments |
| `checks.run` | Прямой вызов фиксированного allowlisted runner и профиля через локальный execution adapter. Никаких произвольных скриптов/команд/путей из модели; мутация test setup тоже отражена в плане |
| `deployment.plan` | Source format/main-vs-extension/name/source hash, immutable target fingerprint, environment allowlist, backend/exact build, effects on sessions/services, backup/rollback requirements, probe/baseline identities |
| `deployment.apply` | Позднее: plan hash + актуальность source/target + подтверждённый backup + явное подтверждение операции. Нельзя превращать installed-platform picker или `.dev.env` в deploy binding |
| `run.status/evidence` | runId, phase, result semantics passed/failed/skipped/notConfigured/interrupted/degraded, pinned artifact references+hashes, independent JUnit/CheckModules/probe verdict; cancellation и cleanup outcome |
| `rollback.plan/apply` | Отдельные операции с snapshot identity и проверкой target; не Git reset и не автоматический retry destructive stage |

Обязательные границы реализации:

- Уточнение пользователя: deploy/test runners исполняются напрямую локальными
  adapters, без MCP-фасада. MCP-шаги используют явно настроенные подключения
  и проектные правила маршрутизации, включая отдельные ONEMCP/QA.
  Недоступный обязательный шаг не подменяется другим каналом автоматически.
  DSH UI не строит произвольные команды платформы; этим занимается adapter.
- Внешние credential references и target identities остаются host/project
  state. UI видит alias, environment и capability flags, не connection string.
- Unknown environment, несовпавший exact build, неоднозначный extension,
  отсутствие backup/probe, устаревший plan или interrupted channel не дают Apply.
- Per-base lock общий с существующими проектными runners; один lock только
  в DSH не защищает от параллельного legacy скрипта.
- Hidden desktop — optional execution mode для доказанно поддерживаемого
  scenario runner; отдельные readiness/evidence/cleanup gates. Не выдавать
  отсутствие видимых окон за успешность бизнес-сценария.
- Перед переносом Apply сначала выровнять проектные weak points: profile schema
  validation, unique evidence, zero-tests gate, backup/rollback, baseline diff.
  Включать возможности по проектам отдельно: в Эквадоре сначала status/static
  и адаптация disposable unit; в KA2 — status/static/существующие read-only suites.

Ни один описанный runtime результат, действительность индексов/фасада,
доступность тестовых баз или установленного toolchain в этом аудите не проверен.
