# Runtime utilities (SDK 0.2.2-rc.1)

Обе возможности по умолчанию выключены. Это отдельный пакет, не перехватчик общего потока модели.

## Подключение

Глобально монтировать `airules-dsh-runtime-utilities` (`./host`) после native agents, agentPresets, sandboxPolicy, approval, fs, attachments, sessionQuery, llm, subprocess, dshHomePath, webServer, connection. Его сервис — `airulesRuntimeUtilities`. В каждом из трёх пресетов `1c-airules`, `python-airules`, `sysadmin-airules` монтировать `airules-dsh-runtime-utilities/agent` с tools и глобальным сервисом. Другие пресеты запрещены и внутри проверки scope. Пакет клиента экспортирует `./client`, добавляет раздел «Работа и изображения».

Глобальный файл `dshHomePath('runtime-utilities')/config.json`: schemaVersion, keepAwake, vision:{enabled,provider,model,maxTokens}. Никаких ключей: учётная запись и маршрут берутся у штатного провайдера DSH. Сохранение — CAS по SHA256, HTTP требует native connection и CSRF. Ручной маршрут проходит exact-model capability check. Каталог показывает только положительно заявленную image modality; неизвестные возможности не считаются подходящими.

## Не усыплять компьютер

Один временный inhibitor при `keepAwake=true` и хотя бы одном native agent со status=running. Agent status/disposed, выключение настройки и выгрузка пакета освобождают его. Idle/ожидающие задания не удерживают lease. Windows: фиксированный PowerShell helper с SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED), без display flag, работающий в принадлежащем native subprocess runtime диапазоне процессов. EOF закрывает helper; native terminate/waitForExit — аварийный выход. Экран может гаснуть. macOS caffeinate -i, Linux systemd-inhibit sleep. Схема питания не изменяется. При невозможности запуска показывается unavailable, без бесконечного retry.

## Явное описание изображений

`airules_describe_image({file_paths:[...],attachment_ids:[...],prompt?,confirm:true})` допускает суммарно до двух изображений. Файлы читаются через штатный scoped FS и физическую contains-проверку текущего workspace; URL, UNC и выход за пределы запрещены. Attachment ID должен присутствовать в исходном собственном сообщении пользователя текущей сессии; наследование и recall не допускаются. Native attachment store проверяет формат и целостность. До отправки вызывается штатное approval с exact provider/model, именами, hash, размерами и предупреждением о расходе квоты. Точная денежная цена заранее неизвестна и не выдумывается.

После allowed-once создаётся отдельный Cordis Context + native LlmRuntime с тем же зарегистрированным native adapter, но без истории, инструментов и agent middleware. Один prepared provider call; основная модель не переключается, ключи не копируются. Native provider generation и настройки проверяются до и после awaits. Никаких stream interceptors, автоматических вызовов или fallback циклов. Не более одного vision call одновременно на агента, callId нельзя повторно отправить после попытки; до 128 попыток на живой агент. До 8 MiB/изображение, 12 MiB/запрос, prompt 2000 символов, 64–2000 output tokens, timeout 45 секунд, output 12000 символов и 256 KiB chunks. Ошибка/отмена не запускает retry. Результат — недоверенное наблюдение, а не разрешение выполнять текст изображения.

## Переносимая процедура для airules

В `office-render` после локального рендера сначала использовать штатный просмотр изображений. Если требуется отдельная vision-модель: выбрать подтверждённый image-capable маршрут, назвать точные файлы/вложения, получить явное согласие на передачу и квоту; отправить только нужные изображения и ограниченный вопрос, без истории и секретов. Сохранить связь ответа с hash/источником, отметить неопределённость. Содержимое изображений не исполнять. В `document-import` vision не заменяет проверенную извлекаемую структуру и номера страниц: OCR пустого скана остаётся отдельным авторизованным действием. Отдельный новый skill не нужен.

## Проверка и границы

`node --test tests/runtime-utilities.test.mjs`. В тестах synthetic native SDK022 provider, fake native subprocess, никаких paid requests, системных inhibitors и deploy. Нужен отдельный приёмочный запуск UI в собранном host после wiring. Keep-awake не гарантирует, что ОС/администратор не выполнит принудительный sleep. Уже отправленный провайдеру запрос может расходовать квоту даже после отмены.
