# Project_BL: проверки и деплой — read-only аудит для DSH

Дата: 2026-11-04. Область: `D:\AI_Projects\Project_BL`, актуальные инструменты и правила, плюс общий слой `D:\AI_Projects\project_rules`. Скрипты, COM, базы, MCP и сетевые операции не запускались; env-файлы и значения секретов не читались. Наличие файлов и деклараций не означает, что стенд сейчас доступен или прогон проходит. Архивы, backup-копии скриптов и web-приложение не использовались. Отдельный `Project_BL-leasing-contour` не исследовался: проверенный рабочий путь ведёт к `Project_BL/src_lk` и `subprojects/unified-leasing`.

## Вывод для проектирования DSH

Для BL уже существует общий переносимый runner `tools/agent-1c/agent-1c.ps1`, совпадающий побайтово с canonical project_rules, и отдельные более старые/специальные LK-скрипты с другими гарантиями. Нужен проектный binding к конкретной операции и профилю, а не универсальная кнопка «Деплой» поверх произвольной команды.

Общий фасад 1С — навигация и проверки кода. Деплой и исполняемые сценарии BL идут локальным runner, COM либо проектным OneMCP. Их нельзя автоматически считать read-only или переадресовывать общей операции `check`. В текущем этапе требуется сравнение и контракт, без live-enable этих каналов и без новых MCP-подключений.

Предпочтительный базовый adapter — agent-1c для doctor/analyze/deploy/unit/Vanessa, с явным unavailable для ненастроенных возможностей. LK acceptance и BKI bench — отдельные проектные capabilities. Старые `Deploy-LK`/`Build-LK`/`Update-HostCfg` не должны становиться фоновым fallback общего деплоя.

## Источники и ограничения проекта

- [AGENTS.md](D:/AI_Projects/Project_BL/AGENTS.md:26): минимальные обратимые изменения; destructive/production/credential/paid/outward/scope-expanding операции требуют явного разрешения. Production начинается с плана и подтверждения; сбой production останавливает работу.
- [AGENTS.md](D:/AI_Projects/Project_BL/AGENTS.md:230): общая навигация через 1c-facade с выбором слоя, кодовые источники проверяются на диске; фасад не публикует генеративные записи. Отдельная operational memory не является каналом деплоя.
- [openspec/project.md](D:/AI_Projects/Project_BL/openspec/project.md:34): это расширения, а не единая конфигурация. `src` — УЛК, `src_bl` — старый BL, `src_bki` — БКИ, `src_lk` — новый ЛК; `erp_crc` — базовая конфигурация. LK имеет отдельный host/стенд.
- [openspec/project.md](D:/AI_Projects/Project_BL/openspec/project.md:48): БКИ описан как небоевой контур. Это факт предметной области, а не разрешение писать в любую базу с похожим именем.
- [openspec/project.md](D:/AI_Projects/Project_BL/openspec/project.md:82): после COM-изменения результат проверяется OneMCP; COM-чтение уже давало ложные результаты. Здесь это проектное ограничение важнее общей рекомендации «COM read-only» из библиотеки.

В просмотренном дереве найден один корневой AGENTS.md; дополнительных AGENTS для рассматриваемых tools/docs не обнаружено. Перед будущим исполнением нужно повторно проверить локальные инструкции и утверждённый binding, поскольку audit фиксирует состояние файлов на дату чтения.

## Реальные операции и границы

| Capability | Реализация | Что действительно делает / ограничение |
|---|---|---|
| Doctor | [Invoke-Doctor](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:189) | Проверяет наличие инструментов; не является доказательством пользовательского пути или разрешением на запись. |
| Static analyze | [Invoke-Analyze](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:242) | BSL Language Server, собственные артефакты и baseline-политика. Отдельно от исполнения 1С. |
| Deploy preview/apply | [Invoke-Deploy](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:829) | Preview по умолчанию, мутация только с `-Apply`; file/server различаются. |
| Unit | [Invoke-Unit](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:747) | ENTERPRISE `/C` по `unit.launchParameter`, ожидает JUnit. Без настройки возвращает unavailable/3. |
| Vanessa | [Invoke-Test](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:1079) | Только `testTarget.kind=file`; connection file или ibsrv. Это запуск клиента/сценариев, потенциально изменяющий тестовые данные. |
| Hidden UI | [Invoke-TestHidden](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:1051) | Оборачивает внутренний test на скрытом Windows desktop, сохраняет отдельный результат. Не заменяет визуальный канал, когда он необходим. |
| Serve/stop | [Invoke-Serve](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:633), [Invoke-Stop](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:713) | Управляют жизненным циклом ibsrv/публикаций; это эксплуатационные мутации, не «проверка доступности». |
| LK deploy | [Deploy-LK.ps1](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:1) | Отдельный Designer-путь, без DryRun выполняет сразу. Гарантии слабее общего runner. |
| LK acceptance | [Run-Acceptance.ps1](D:/AI_Projects/Project_BL/tools/leasing-stand/Run-Acceptance.ps1:1) | Последовательные BSL-сценарии через OneMCP, машинные проверки в текстовом протоколе. Не read-only по факту канала. |
| BKI bench | [ObjectModule.bsl](D:/AI_Projects/Project_BL/src_bki/DataProcessors/БЛ_Р_СтендТестированияБКИ/Ext/ObjectModule.bsl:109) | Предметный каталог/прогоны со своей синтетикой и зачисткой; отдельная capability, не универсальный unit-engine. |

### Профили, которые действительно лежат в корне

| Профиль | Источник / расширение | Объявленная цель | Существенная настройка |
|---|---|---|---|
| [agent-1c.json](D:/AI_Projects/Project_BL/agent-1c.json:4) | src / УправлениеЛизингом | file, test, env section TEST | versionPrefix 8.3.27; Vanessa ibsrv. |
| [agent-1c.bki.json](D:/AI_Projects/Project_BL/agent-1c.bki.json:4) | src_bki / КонтурБКИ | file, test, TEST | versionPrefix 8.3.27; ibsrv; публикации БЛ_Р_ВебКонсоль и БЛ_Р_MCP. |
| [agent-1c.bki.devtest.json](D:/AI_Projects/Project_BL/agent-1c.bki.devtest.json:4) | src_bki / КонтурБКИ | server, test, ERP_DEVTEST | Designer, versionPrefix 8.3.27.1786; штатный Vanessa test для server запрещён кодом. |
| [agent-1c.lk.json](D:/AI_Projects/Project_BL/agent-1c.lk.json:4) | src_lk / ЛизинговыйКонтур | file, test, ERPSUB_ADMIN | versionPrefix 8.3.27; suite tools/leasing-stand/vanessa; timeout 420 секунд. |

Ни один из этих четырёх профилей не содержит `unit.launchParameter` или `probe.checkModules`. Поэтому нельзя показать «unit настроен» или «последеплойный CheckModules обязателен и выполнен» на основании существования функций runner. Путь/учётная запись из env не разрешались в этом аудите; соответствие действительной базы объявленному test требует отдельного preflight.

Runner и guard совпадают с `project_rules/overlays/1c/tools/agent-1c`: SHA-256 runner `2032504f…cfb9eda3`, guard `19c9b349…32c6e428`. Это общий движок, а не BL-форк. Доменная специфика находится в профилях, LK wrappers, suite и BSL-сценариях.

## Загрузка исходников: конфигурация и расширения

Общий контракт [deploy-and-test.md](D:/AI_Projects/project_rules/overlays/1c/commands/deploy-and-test.md:15) требует определить тип `Configuration.xml` и имя расширения до запуска. Для расширения отсутствие `-Extension`/`--extension` опасно: затрагивается основная конфигурация.

В [Invoke-Deploy](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:837) имя берётся из `profile.extension.name`. При наличии имени Designer строит два запуска: `/LoadConfigFromFiles … -Extension … -Format Hierarchical` ([строка 891](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:891)) и отдельный `/UpdateDBCfg -Extension …` ([строка 901](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:901)). Без имени включается ветка загрузки основной конфигурации ([строка 907](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:907)). Сам runner не доказывает, что отсутствие extension соответствует действительному типу исходников. DSH adapter обязан сравнить binding, XML и запрошенную область, а не доверять пустому полю.

Для file выбирается ibcmd/Designer через [Get-DeployEngine](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:298); [Get-IbcmdDeployRuns](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:507) строит import/apply и extension-параметры. Кластерная база не должна обслуживаться прямым локальным ibcmd-доступом к её хранилищу — это общий запрет контрактов. Профиль devtest явно фиксирует Designer.

Общий runner держит [межпроцессный base lock](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:932) на load+update+probe; управляет только соответствующим ibsrv и перечисленными сервисами, восстанавливая их в finally ([строка 936](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:936)). [1c-guard.ps1](D:/AI_Projects/Project_BL/tools/agent-1c/lib/1c-guard.ps1:96) реализует lock; [Invoke-Guarded1C](D:/AI_Projects/Project_BL/tools/agent-1c/lib/1c-guard.ps1:211) ограничивает процессы по времени/ресурсам. Отдельные скрипты должны использовать тот же механизм, иначе общей взаимной блокировки нет.

### Сигналы успешности

[Invoke-GuardedRun](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:478) проверяет watchdog, exit code и свежий DumpResult. Отсутствующий DumpResult после exit 0 — ошибка. Это значительно надёжнее старого LK wrapper, но сам факт load/update ещё не доказывает нужную метадату в базе.

[Invoke-PostDeployProbe](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:528) работает только при заданном `probe.checkModules`. Проверяет контексты, exit/DumpResult/Out, новые ошибки относительно baseline. Если baseline указан, но файл отсутствует, runner создаёт его из текущих ошибок и выдаёт warning ([строка 577](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:577)). Для DSH первый такой запуск должен быть «baseline требует review», а не молчаливый PASS. После metadata change нужна отдельная проба существования новых объектов/реквизитов: CheckModules этого не заменяет.

## Пирамида проверок и реальная доступность

1. **Статический слой:** facade `lint/check` и локальный analyze решают разные задачи; общий `check` не подтверждает запуск приложения. По [test-model.md](D:/AI_Projects/Project_BL/rules/test-model.md:17) выбирается самый дешёвый слой, наблюдающий поведение.
2. **Чистая логика / unit:** [unit-tests-1c.md](D:/AI_Projects/Project_BL/rules/unit-tests-1c.md:14) разрешает использовать существующий engine, не вводить его случайно. Runner ждёт непустой JUnit и считает errors+failures ([Invoke-Unit](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:808)). Функция есть, но все корневые BL-профили этот канал не связывают. Тестовый BKI processing и LK BSL-сценарии не являются доказательством YaXUnit/headless unit discovery.
3. **Данные и интеграция:** OneMCP запрос исполняется сервером 1С; [Invoke-OneMcpQuery](D:/AI_Projects/Project_BL/tools/mcp-tools/OneMcp.ps1:167) вызывает vcexecutequery. [Invoke-OneMcpCode](D:/AI_Projects/Project_BL/tools/mcp-tools/OneMcp.ps1:193) вызывает vcexecutecode и может писать данные; это принципиально иной риск. COM остаётся проектным каналом мутаций, но не достоверным oracle результата. [OneC-Params.ps1](D:/AI_Projects/Project_BL/tools/com-tools/OneC-Params.ps1:3) поддерживает Apply/DryRun, однако режим общего helper сам по себе не доказывает безопасность каждого доменного скрипта.
4. **Предметная приёмка LK:** [Run-Acceptance.ps1](D:/AI_Projects/Project_BL/tools/leasing-stand/Run-Acceptance.ps1:14) имеет ограниченный набор Base aliases, но это транспортный allowlist, а не проверка класса environment. Скрипт разбирает `ПРОВЕРКА|…` и считает отсутствие проверок неуспехом ([строка 43](D:/AI_Projects/Project_BL/tools/leasing-stand/Run-Acceptance.ps1:43)); сохраняет подробный протокол. Запуски от Administrator не покрывают RLS/целевые роли.
5. **UI / Vanessa:** file-only runner, staged features/settings, junit reports; скрытый desktop — отдельный способ исполнения, не доказательство визуальной корректности. [testing-1c.md](D:/AI_Projects/Project_BL/rules/testing-1c.md:14) требует открыть форму, выполнить первую команду и закрыть. Постинг без явных проверок заполнения и движений не является PASS; роли должны проверяться под целевыми пользователями ([строка 62](D:/AI_Projects/Project_BL/rules/testing-1c.md:62)).
6. **BKI bench:** [spec.md](D:/AI_Projects/Project_BL/openspec/specs/bki-test-bench/spec.md:27) запрещает физическую отправку и требует проверки отправки/фоновых заданий перед прогоном. Реальная предметная реализация имеет [Каталог](D:/AI_Projects/Project_BL/src_bki/DataProcessors/БЛ_Р_СтендТестированияБКИ/Ext/ObjectModule.bsl:109), [ОткатитьПравки](D:/AI_Projects/Project_BL/src_bki/DataProcessors/БЛ_Р_СтендТестированияБКИ/Ext/ObjectModule.bsl:5943), [ЗачиститьПрогон](D:/AI_Projects/Project_BL/src_bki/DataProcessors/БЛ_Р_СтендТестированияБКИ/Ext/ObjectModule.bsl:6116) и [ПротоколПрогона](D:/AI_Projects/Project_BL/src_bki/DataProcessors/БЛ_Р_СтендТестированияБКИ/Ext/ObjectModule.bsl:6352). Это контролируемая мутация с отдельным журналом, а не безопасное чтение.

## Backup, rollback, allowlist и evidence: что есть и чего нет

**Есть в общем runner:** testTarget/extension declarations, DryRun deploy, прямой отказ `environment=production` ([строка 832](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:832)), lock, watchdog, редактирование отображаемой команды через redaction, структурированный result.json ([строка 1308](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:1308)), отдельные логи шагов. Unit/test/serve могут менять состояние и без флага deploy Apply; их нельзя оборачивать общей логикой «нет Apply — всё read-only».

**Не гарантировано кодом:** валидированный allowlist только test/development, полная JSON Schema-проверка и доказательство фактической identity базы. На загрузке profile проверяется только schemaVersion ([строка 1284](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:1284)); `environment != production` не равно `environment ∈ {test, development}`. Поле неизвестного/отсутствующего класса среды нельзя считать разрешением для DSH.

**Нет автоматического backup/rollback в Invoke-Deploy:** [canonical DEPLOYMENT.md](D:/AI_Projects/project_rules/overlays/1c/tools/agent-1c/DEPLOYMENT.md:140) требует резервную копию до первого Apply, но это организационный шаг. Ошибка update или probe не откатывает загруженную конфигурацию. Результат должен различать «не применено», «применено, проверка не пройдена», «восстановление подтверждено».

**Есть отдельный LK backup:** [Backup-ErpSub.ps1](D:/AI_Projects/Project_BL/tools/leasing-stand/Backup-ErpSub.ps1:1) выполняет DumpIB, временно останавливает Apache и возвращает его в finally; [строка 45](D:/AI_Projects/Project_BL/tools/leasing-stand/Backup-ErpSub.ps1:45) проверяет exit и существование файла. Это ещё не тест восстановления. Комментарий предлагает RestoreIB — destructive шаг, не автоматический fallback. [operations-runbook.md](D:/AI_Projects/Project_BL/docs/operations-runbook.md:233) отдельно описывает кодовый откат прежней версии расширения; его следует отличать от отката данных/схемы из backup.

**Evidence требует усиления:** общий run directory имеет timestamp с точностью до секунды и создаётся до lock ([строка 1289](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:1289)); два одинаковых запуска в одну секунду потенциально используют один каталог. DSH нужен уникальный runId и неизменяемый evidence-index с revision/hash исходников, профилем без секретов, шагами/exit, логами, verdict, baseline и причиной skipped/unavailable/interrupted. [Общий test-model](D:/AI_Projects/Project_BL/rules/test-model.md:58) требует уникальные артефакты и сравнение с baseline, а не голый счёт успешных проверок.

## Конфликты и устаревшие рекомендации

| Конфликт | Факт исходников | Решение для binding |
|---|---|---|
| «Деплой всегда preview, мутация только Apply» против старого LK | [Deploy-LK:3](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:3), [Update-HostCfg:5](D:/AI_Projects/Project_BL/tools/leasing-stand/Update-HostCfg.ps1:5): без DryRun исполняют. | Не считать скрипты взаимозаменяемыми; отдельные risky capabilities, выключенные по умолчанию. |
| Exact tool build против newest/prefix | [Deploy-LK:25](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:25) выбирает самый новый 8.3; agent-1c [Get-Platform:127](D:/AI_Projects/Project_BL/tools/agent-1c/agent-1c.ps1:127) поддерживает prefix, три профиля закрепляют только 8.3.27. | Перед Apply разрешить точный build и сравнить с target; не считать prefix полной фиксацией. |
| Проверка Out против exit-only wrapper | [Deploy-LK:41](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:41) печатает Out, но на строке 44 проверяет только exit; DumpResult отсутствует. | Для нового binding использовать общий guarded runner; старый success не принимать за полноценный verdict. |
| Lock общей базы против LK lock-файла | [Deploy-LK:49](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:49) использует собственный deploy.lock и удаляет старый по возрасту. | Не запускать параллельно с общим runner: механизмы не координируются. |
| Секреты должны редактироваться в логах | [Deploy-LK:37](D:/AI_Projects/Project_BL/tools/leasing-stand/Deploy-LK.ps1:37) собирает password-аргумент, а строка 38 выводит весь argv в stdout. Значения в этом аудите не раскрывались. | До любого DSH binding добавить безопасный redaction и проверить логи; существующий wrapper не публиковать как готовый action. |
| Общая COM read-only библиотека против проекта | [com-tools/README:3](D:/AI_Projects/Project_BL/tools/com-tools/README.md:3) предлагает чтение, но [OneMcp.ps1:5](D:/AI_Projects/Project_BL/tools/mcp-tools/OneMcp.ps1:5) описывает ложные COM-вердикты. | Oracle по данным — sanctioned OneMCP/потребительский канал; COM-мутатор отдельный. |
| Apache как универсальный lifecycle | Старые LK wrappers/паспорт говорят Apache; [OneMcp.ps1:15](D:/AI_Projects/Project_BL/tools/mcp-tools/OneMcp.ps1:15) описывает dev ibsrv и замену расширения OneMCP на БЛ_Р_MCP. | Lifecycle привязать к профилю/target, не гасить Apache «на всякий случай» во всех контурах. |
| BKI bench как EPF в spec против extension UI | [bki-test-bench/spec:14](D:/AI_Projects/Project_BL/openspec/specs/bki-test-bench/spec.md:14) описывает внешнюю обработку; исходники также встроены в src_bki. Vanessa rule не умеет открывать external EPF. | Определять конкретный способ запуска bench. Manual EPF и scripted extension form — разные bindings. |
| «Полный pipeline доступен» против конфигов | unit и postdeploy probe не заданы; devtest server не поддержан Vanessa test. | Показывать точный capability status и пробелы, не зелёный общий тест. |
| Порядок общих документов | [testing-contour:7](D:/AI_Projects/project_rules/project-layer/common/templates/testing-contour.md:7) — doctor→analyze→deploy→test; deploy-and-test начинает с deploy и затем static. | Для DSH заранее фиксировать шаги: preflight/static до мутации, postdeploy probe и функциональные проверки после; не смешивать два текста в неявный алгоритм. |

## Предлагаемый единый проектный binding

В canonical common-layer хранить схему и правила маршрутизации; в BL — декларацию фактов. Не вшивать адреса/пароли/локальные базы в пресет DSH.

- `capability`: doctor/static/deploy-preview/deploy-apply/unit/data-check/ui-scenario/acceptance/backup/rollback. У каждой — отдельные read/write/lifecycle признаки, supported target kinds и состояние configured/unavailable.
- `source`: projectId, слой, canonical source root, type configuration/extension, обязательное extensionName для extension, revision/hash. Никаких догадок по активному чату.
- `targetRef`: только утверждённый проектный selector/env section без значений секретов; environment allowlist test/development, проверяемая non-secret identity, disposable/shared, точный build и sanctioned transport. Production не включается автоматически.
- `runner`: repo-relative reviewed script + hash/version, фиксированный argv template/operation. Не принимать произвольную PowerShell-команду из UI и не подставлять неэкранированный пользовательский текст.
- `preconditions`: инструкции/разрешение, инструменты, topology, source-type match, общий base lock, backup receipt/rollback plan, доступность нужной роли, обязательные проверки и запрет физической BKI-отправки.
- `evidence`: runId, source/target identity без секретов, timestamps, результат каждого шага и артефакты, baseline policy, отдельные interrupted/unavailable/failed/not-applied/applied-unverified состояния. Первый auto-created baseline — review-required.
- `mutation`: конкретный подтверждённый plan/argv/target; повторный Apply после изменения профиля или исходников требует пересборки плана. Успешная проверка кода не авторизует deploy, тестовую генерацию данных, service restart или rollback.

Последовательность будущего enable: заполнить BL binding и закрыть обнаруженные пробелы → проверить parse/schema/plan на копии без платформы → отдельно авторизовать опыт на объявленной тестовой копии → получить реальное evidence для каждого канала → только затем показывать кнопку исполнения. Этот аудит не является таким разрешением и не устанавливает состояние PASS ни одному стенду.
