# DSH 0.2.2 и восстановление контекста

Дата: 2026-11-10. Статус: установлено и проверено. Рабочая установка 0.2.2-rc.1.

## Состав кандидата

- Официальный host 0.2.2-rc.1, подпись DeepSeek и SHA512 установщика проверены.
- UI `0.13.0-host022-ui5`; policy `0.13.0-dev50`.
- Канонический airules `0.13.0`, чистый commit `d563128`; 55 правил, 13 ролей, 53 навыка.
- Общий контракт continuity находится в airules. Три JSON-файла копируются побайтно;
  builder сверяет их с вложенной копией rulepack. Правила и тела навыков загружаются
  свежими по ссылкам; кеш текста инструкций не возвращается.
- По умолчанию minimal: до 4096 UTF-8 байт. Balanced включается явно: до 12288 байт,
  не более двух отмеченных файлов задачи по 2048 байта. Тела файлов читаются через
  текущую native FS и проверку версии. После перезапуска checkpoint даёт только ссылки.
- Подтверждённые native события compact start/end и journal user/message управляют
  доставкой. Отменённый шаг не теряет ожидающее восстановление. Subagent получает
  только свой контекст. Standard не получает наши инструменты.
- Механический checkpoint сохраняется на обычных границах шагов со штатными правами.
  Read-only не повышается: используется transient fallback. Git/OpenSpec могут иметь
  partial/unavailable; это видно в receipt. Память и смысловой handoff автоматически
  не записываются. Memoria остаётся основным backend, Cognee — дополнительным.

## Совместимость нового host

Нативные general/models/account и storage-domain взяты из 0.2.2 с точными locks.
Русский каталог DSH сохраняет владение своими переводами; добавлены 151 стороннее
пространство. Проверено отсутствие конфликта `settings.theme` при полном запуске.
Composer/LSP и ACP имеют отдельные точные декларации совместимости, без глобальных
исключений для плагинов. pi-ai 1.3.0 проверен реальным холодным импортом.

Внутренние вызовы инструментов адаптированы к новому batch API. Вложенный вызов
сохраняет native parent token, agent, rootCallId, approval и отзыв разрешений через
публичный pipeline. Это касается workflow/MCP recovery, фоновых инструментов,
документов, Mermaid и источников OpenSpec.

BOM сохраняется штатными edit, patch и move; CAS и sandbox остаются нативными.

## Проверки

- Полный прогон перед установкой: 774/774 PASS, без пропусков. После него
  добавленная реальная проверка PS7 → Windows PowerShell signature и весь
  финализатор прошли 14/14 PASS; два теста legacy RU конфликта также PASS.
- Native continuity: настоящие Session, SandboxedFileSystem, ToolsService и Cordis
  обеих версий; отмена/повтор/смена scope/права/перезапуск.
- Кандидат `official-desktop-022-03`: полный rollback → apply прошёл до пользовательских
  изменений настроек; отчёт в `.airules-cycle-history` этого кандидата.
- Кандидат `official-desktop-022-02`: видимый Desktop запущен; рабочая область,
  русский интерфейс, пресет и панель баланса наблюдались через CUA. Smoke PASS.
- Native host: проверены scoped инструменты, lazy skills, сохранение checkpoint,
  HTTP/CSRF и Cognee с синтетическими данными. Реальные deploy/runners не запускались.

Модельная матрица на UI5/policy49: Flash high без MCP — 14 запросов PASS; с MCP —
16 PASS; Sol medium без MCP — 15 PASS; с MCP — 17 PASS. В каждой строке ровно
два native child developer → tester, точные изменения комментариев, BOM и исходный
проект сохранены. В MCP строках подтверждены успешные обращения родителя и ребёнка
к прямому docs MCP. Всего 62 запроса. Policy50 дополнительно объявляет native jobs
зависимость continuity: отдельно проверены реальные события compact и journal ack
в mounted сервисе для 1С, Python и sysadmin (89 native checks PASS).

## Установленная версия

Официальный NSIS завершился с exit 0; registry DisplayVersion и baseline —
0.2.2-rc.1, подпись нового uninstaller Valid. До первого запуска подтверждены
8289 неизменённых файлов вне управляемых компонентов и точное сохранение
Electron data. Native ownership anchor: 55 операций, integrity PASS и drift 0.

При первом запуске обнаружен legacy community RU bundle
`@ragnoryok1/dsh-client-locale-ru` 0.2.24: он занимал `settings.theme/ru` перед
новым native theme. Убрано только его имя из `dsh.profile.bundles`; dependency,
пакет и остальные 7 bundles сохранены. Исходный package.json и receipt правки
лежат в защищённой транзакции. Cookies, IndexedDB и кэши не сбрасывались.
Старый RU автозапуск необходимо проверять перед такими обновлениями.

Установленный Desktop проверен через CUA: прежние беседы и рабочие области
доступны, оформление и Капитан Дизель сохранены. В панели памяти выполнена
проверка связи: «Cognee доступен. Запрос авторизован». Повторно проверены
55 owned after-states. Реальный deploy 1С не запускался.

Основная завершённая транзакция:
`var/host-upgrade-transactions/release-20261110-host022-retry2`.
Там сохранены `receipt.json`, `host-apply-receipt.json`,
`windows-os-before.json`, `windows-finalization-receipt.json`,
`installed-verification.json`, `installed-ui-verification.json` и
`compatibility-repairs/legacy-ru/receipt.json`.
Новый baseline для последующих overlay updates:
`var/live-promotion-backups/release-20261110-host022-policy50/receipt.json`.

Первая попытка остановилась до запуска NSIS из-за наследованного PS7 module path;
настоящий автоматический host rollback восстановил старые три корня.
Её immutable доказательства сохранены в соседней транзакции без `-retry2`.
Причина исправлена изоляцией PSModulePath и абсолютным импортом штатного
Windows PowerShell Security; реальная проверка подписи и regression PASS.

Откат после запуска приложения — через Windows finalization receipt и
`rollbackOfficialWindowsFinalization`, с явным `allowRuntimeDataChanges`;
текущее состояние предварительно сохраняется. Обычный rollback ownership
anchor является no-op и не откатывает host. При гибели controller внутри NSIS
до final receipt есть intent и полные backups, но автоматический NSIS reconcile
из intent не заявляется. Подробности: [Windows finalization](official-windows-finalization.md).

## Обновление и откат

Переход между host — отдельная транзакция. Старый receipt проверяется против
старого host и не переписывается. Перед изменениями резервируются install,
полный DSH home и Electron userData. Подготовка новой версии идёт в shadow;
проектные MCP, чаты, авторизация и настройки сохраняются. Смена трёх корней
выполняется только при остановленных DSH; откат относится ко всем трём корням.
Обычный обновлятор UI/policy сохраняет запрет работы с receipt другого host.
