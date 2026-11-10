# Источники и native overlap

Исследована локальная сборка Oleg `E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/lib/keep-awake.js` и `vision-fallback.js`, включая vendor/dsh-easyvision. Keep-awake содержит MIT provenance @narumitw/pi-caffeinate 0.49.11; vision donor ссылается на MIT dsh-easyvision 0.4.0. Текущий пакет реализован заново через штатные возможности DSH, donor служил источником функциональных требований и идеи временного system-only inhibitor. Код vendor не копируется. Donor ограничения конкретных провайдеров и включение по умолчанию не перенесены.

Проверен extracted native SDK022 (`var/host-upgrade/rc022/asar`): desktop main/lib/main.js использует powerMonitor только для resume/update и shutdown; powerSaveBlocker/keepawake/inhibitor owner отсутствует. Повторный отдельный inhibitor поверх native owner не создаётся: при появлении штатного механизма пакет следует переключить на него. Native LLM и attachment API уже имеют image modality, prepareCall, admission/immutable refs; ими пользуется новый явный инструмент. Отдельного describe_image fallback native не найдено. Native image offload не заменяется.

Assistant DSH, голос, Jira, поддержка автора, updater, Live2D, PII interception не включены. Rewind остаётся штатным host behavior и этим пакетом не изменяется.
