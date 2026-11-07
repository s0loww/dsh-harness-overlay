# Адаптация DSH Desktop 1С, R183

Основа — готовый [IgnatAi401/dsh-telegram](https://github.com/IgnatAi401/dsh-telegram), версия 0.3.0, commit `004640f220374e72507056e88cf8aa90ae9cb737`, BSD-3-Clause. `UPSTREAM.json` сохраняет хеши исходных файлов. Это интеграция готового решения, не порт Pi.

Локально изменены основные русские строки bridge/progress/transcript, форматирующая инструкция канала и добавлены `/status`, `/stop`, `/disconnect`, а также два метода для команды текущей сессии `connectCurrent` / `connectionStatus`. Правки зеркальны в `src` и исполняемом `lib`; декларация bridge дополнена.

Бандл монтирует `lib/telegram.js` основного пакета вместо исходного `apply`. Wrapper и `lib/telegram-control.js` сохраняют настройки в `credentials` scope `onec-telegram/settings`; сам токен — только ciphertext Windows DPAPI CurrentUser. Форма параметров использует защищённый CSRF endpoint `/onec/telegram-control`. Ответ не содержит токен. `configured` учитывает legacy env; `tokenStored` подтверждает сохранённый ciphertext. `active` показывает наличие bridge даже при polling error, `status` — фактическое состояние. Автозапуск сохраняется отдельно от start/stop и по умолчанию выключен.

Добавлены `TelegramClient.getMe`, bridge `verifyBot`, `restoreBinding`, `disconnectCurrent` и callback `onBindingChanged` для Desktop и меню Telegram. Перед polling проверяется бот и восстанавливается точная пара workspace/session. Автовосстановление не создаёт сессию, не переключает чат и не снимает архив. Callback `onConnectionState` сообщает ошибки polling и восстановление соединения. `off` сохраняет привязку, `/disconnect` очищает; исходный `apply` vendor пакета напрямую не монтируется. Legacy env действует лишь при отсутствии сохранённой записи; явное сохранение импортирует токен в DPAPI.

Адресная проверка `test/telegram-r183.test.mjs`: прежние четыре проверки владельца/текстового цикла/подтверждений/redaction и пять проверок Windows DPAPI, восстановления и Telegram menu persistence, недоступной сессии, ошибок polling, env precedence и HTTP/CSRF. Используются синтетические данные; живой Telegram и модели не вызываются.

Транспорт, Session Controller, владельцы agent/session и механизм обычных подтверждений upstream сохранены. Полная совместимость с Pi Telegram не заявляется. Старый citedy sidecar не является этим плагином.

