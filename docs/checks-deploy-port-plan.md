# Проверки и deploy: результат проработки

Исполняемый инкремент 1: [core, CLI и adapters](workflow-core-increment1.md)
реализованы отдельно от live DSH. Текст ниже фиксирует исходное сравнение/план.

2026-11-04. Статус: аудит завершён, архитектура и контракт **предложены**.
Это не выпуск нового runtime. Установленные UI dev13 / policy dev15 сохранены;
`airules_verification` остаётся declarative-only. Базы, 1С, COM, проектные runners,
службы и MCP в ходе аудита не запускались и не менялись.

## Решение по переносу

Уточнение: строим универсальное workflow core с доменными пакетами,
переиспользуемыми adapters и validators; 1С/DSH — первая интеграция.
Новый типовой проект подключается binding-данными, без отдельной ветки ядра.
Эквадор/КА2/БЛ проверяют применимость архитектуры, не ограничивают её.

У Олега берём организацию работы: состояние готовности, наглядный план,
контроль scope, учёт проверенных файлов, отдельные результаты стадий и журнал.
Исполнение адаптируем к нашим проектам прямыми вызовами проектных runners
через локальный execution host. Отдельный сервис или MCP-фасад для этого
не требуются; MCP остаётся необязательным каналом конкретных проверок.
Подключения получателя могут состоять только из нескольких прямых MCP одного
проекта. Фасад не является зависимостью сборки или её MCP-интеграции; workflow
использует capabilities, связанные настройками с локальным либо MCP provider.
Глобальная настройка содержит правила/контракты; конкретные подключения,
базы, платформы и credentials остаются проектными/машинными.

| Блок Олега | Что делаем | Существенное отличие |
|---|---|---|
| Readiness / preflight | Переносим UX, перерабатываем capabilities | «Настроено», «доступно» и «проверено» отдельно; открытие настроек не запускает 1С |
| Prewrite BSL check | Переносим проверку prospective content и digest | Через выбранный syntax provider: локальный или MCP, напрямую либо через фасад; покрытие write/edit явно ограничено |
| Postwrite BSL LS | Подключаем к нашему LS и evidence | Недоступность LS не означает отсутствие ошибок |
| Plan / scope / drift | Переносим концепцию, нормализуем проектным adapter | XML kind + имя extension, hash фактических исходников, missing baseline виден |
| Load + platform checks | Отдельная мутирующая операция | У Олега action=check загружает конфигурацию; в нашем UI это «Загрузить и проверить» |
| UpdateDBCfg | Отдельная стадия deploy | Не включён по умолчанию; отражаем уже применённое состояние при падении дальнейших проверок |
| Batch main/extensions | Последовательные операции с per-target receipts | Не транзакция: предыдущие цели могли успешно измениться |
| Timeout / cancel | Переносим ownership и single-flight | Отмена ожидания не равна остановке процесса или откату базы |
| Backup / recovery | Проектный provider + receipt | Backup DSH, ConfigDumpInfo baseline и копия расширения не заменяют backup ИБ |
| Unit / business / UI | Единый формат evidence, существующие suite | Skills поставщика не считаем готовыми тестами наших проектов |
| QA / hidden desktop | Явный project binding и disposable copy | Один владелец клиента, отдельные business assertions и visual proof |
| .cfl cleanup, default dynamic, Git commit | Не переносим в общий автоматический путь | Только отдельные обоснованные проектные операции при необходимости |

## Сравнение проектов

| Слой | Эквадор | КА2 | БЛ |
|---|---|---|---|
| Источник | Основная конфигурация + TestingExtension, отдельные ext | Разные расширения src/src_dsb | Разные расширения src/src_bki/src_lk |
| Основной adapter | TestEnv + собственный unit runner | agent-1c с выбранным профилем | agent-1c + отдельные предметные adapters |
| Unit | Реальная реализация, усилить timeout/zero-test/evidence | В профилях не настроен | В профилях не настроен |
| UI | Ручной launcher без автоматических сценариев | Vanessa suites, hidden mode | Vanessa file-only; server-профиль отдельно |
| Postdeploy probe | Нужен явный контракт | Функция есть, профили не связывают | Функция есть, профили не связывают |
| Backup/restore | Нет автоматического общего контура в проверенных entrypoints | Нет автоматического общего контура | Есть отдельный LK backup; не общий обязательный stage, restore не подтверждён |
| Главный риск адаптации | Нельзя заменить TestEnv старым generic runner или запустить ручной UI в CI | Не использовать legacy update как fallback; разные suite/расширения | Старый Deploy-LK: мутация по умолчанию, другой lock, слабее verdict, вывод секретного argv |

Для всех трёх: `.dev.env` не становится источником истины для target.
Наличие `environment != production` недостаточно: нужен strict allowlist,
разрешённая фактическая identity и точный build. Broad versionPrefix не равен
фиксации версии. Zero/stale/missing tests и ненастроенные обязательные gates
не дают общий PASS. Безусловное принятие первой baseline запрещается.

## План реализации

| Этап | Результат | Условие перехода |
|---|---|---|
| 1. Контракт и fixtures | Binding/plan/result, операции и эффекты, fixtures всех трёх проектов | Plan строится без процессов/базы и не содержит секретов |
| 2. Runners/adapters | Guards, schema/target validation, exact build, source kind, UUID evidence, fresh verdict, baseline/backup policy | Негативные contract tests; TestEnv и предметная логика сохранены |
| 3. Локальный execution host | Прямой вызов adapters; registry операций, plan/run/status/result/cancel, locks/ownership | Fake executor проверяет stale plan, partial apply, отмену, redaction, retry/restart |
| 4. DSH UI | Проверки/деплой/прогоны, preview плана, точный capability status и evidence | Проверка native permissions и отключённых ненастроенных действий |
| 5. Изолированные контуры | Реальное evidence по отдельно выбранным проектным targets | Сначала backup/recovery/identity, затем разрешённый прогон; никаких автоматических production действий |

Пункты 1–5 — будущая реализация; в этом изменении подготовлены сравнительные
аудиты и документы, без включения исполнителя. Исключённые блоки поставщика
не возвращаются. Project_bki не запускается как рабочий сценарий.

## Канонические документы и доказательства

- [Предложение архитектуры и порядок работ](D:/AI_Projects/project_rules/docs/DSH-CHECKS-DEPLOY-ADR.md).
- [Черновик binding/plan/result и критериев PASS](D:/AI_Projects/project_rules/docs/DSH-CHECKS-DEPLOY-CONTRACT.md).
- [Подробный аудит сборки Олега](audits/oleg-checks-deploy.md).
- [Подробный аудит Эквадора и КА2](audits/ecuador-ka2-checks-deploy.md).
- [Подробный аудит БЛ и canonical runner](audits/bl-checks-deploy.md).

Аудиты содержат ссылки на конкретные исходники и строки. Они подтверждают
поведение прочитанного кода, не доступность стендов или успешность прогонов.
