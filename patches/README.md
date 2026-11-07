# Versioned patches

Патчи раскладываются по точному `releaseId`. Неизвестная версия должна
блокировать apply до отдельной проверки совместимости.

`20261103-134539/project-preset-1c-airules.json` — exact-text patch для
закрытого project-preset контракта pinned-релиза. Он оставляет
`1c-lite`, `1c-full` и `1c-only` только для совместимости со
старыми проектами/чатами и делает единственным видимым 1С-пресетом
`1c-airules` с label `1С`.

## Installer v2 contract

Stage manifest имеет schema v2. Текущий installer сохраняет совместимость со
schema v1 и для v2 выполняет следующий контракт:

1. Проверить `releaseId`, release-lock hash и `sourceSha256` всех целевых
   файлов до любых записей.
2. Применить операции по порядку в памяти; каждая `from` должна встретиться
   ровно `count` раз.
3. Проверить полученный `resultSha256` и подготовить все полные
   after-файлы во временном staging-каталоге.
4. Сделать backup всех original-файлов и pending receipt, повторно
   проверить before-хэши, затем атомарно заменить цели.
5. Только после source patch устанавливать provider/rulepack и merge Cordis;
   любая ошибка до final receipt должна откатить весь набор.
6. Receipt хранит для каждой цели before/after SHA-256 и backup path. Rollback
   сначала проверяет after-хэш и только затем восстанавливает backup.

