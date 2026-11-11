# Обновление сборки: release, план, отдельный исполнитель

Модуль `src/git-maintenance/lib/updater.js` не исполняет код из полученного Git
checkout. Репозиторий по умолчанию — `https://github.com/s0loww/dsh-harness-overlay.git`.
GitHub Releases и локально подготовленный release используют один контракт.
Отсутствие готового release возвращает `UPDATE_RELEASE_NOT_PUBLISHED` либо
`UPDATE_RELEASE_ASSETS_REQUIRED`; исходники сами по себе не считаются обновлением.

## Формат release

Файл `.dsh-release.json` внутри корня распакованного пакета:

```json
{
  "schemaVersion": 1,
  "kind": "airules-dsh-release",
  "repository": "https://github.com/s0loww/dsh-harness-overlay.git",
  "version": "0.16.0-example",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "hostVersion": "0.2.2-rc.1",
  "paths": {
    "uiArtifactRoot": "dist/airules-ui-overlay-example",
    "policyArtifactRoot": "dist/airules-official-policy-example",
    "releaseLockPath": "upstream/official-desktop/0.2.2-rc.1/release.lock.json"
  },
  "manifests": {
    "ui": "<SHA-256 ui-overlay-manifest.json>",
    "policy": "<SHA-256 official-policy-manifest.json>",
    "releaseLock": "<SHA-256 release.lock.json>"
  }
}
```

`candidateRoot` — необязательный относительный путь в `paths`. Если его нет,
доверенный локальный `updater-candidate.js` строит настоящий изолированный
кандидат и получает штатную сертификацию. Существующий live-installer повторно
проверяет manifest, все файлы, baseline официальной установки, receipts кандидата
и visible-startup evidence. Запись статуса PASS из удалённого JSON эту проверку
не заменяет. Сертифицированный путь закрепляется в плане; повторный просмотр
не создаёт ещё один кандидат.

Для GitHub Releases нужны assets `airules-dsh-release.json` и
`airules-dsh-release.zip`. Внешний JSON содержит те же поля плюс:

```json
"asset": {
  "name": "airules-dsh-release.zip",
  "url": "https://github.com/s0loww/dsh-harness-overlay/releases/download/TAG/airules-dsh-release.zip",
  "sha256": "<SHA-256 всего ZIP>",
  "bytes": 123456
}
```

Ссылки принимаются только из release настроенного GitHub-репозитория. Обращение
публичное: токены и Git credentials не читаются. Хэши защищают целостность;
доверие источнику задаётся явно выбранным репозиторием и HTTPS. Это не заявление
о подписи отдельным release signing key.

Архив проверяется до распаковки: SHA-256 и размер, CRC каждого файла, store/deflate,
лимиты, строгие относительные имена, отсутствие symlink/device/ADS/zip-slip и
коллизий путей для Windows. ZIP64, шифрование и необычные методы не принимаются.
Лимиты: ZIP 512 МиБ, распакованные данные 1 ГиБ, один файл 128 МиБ, 25 000 entries.
Распаковка идёт в новый управляемый каталог; частичный собственный staging можно
удалить только после проверки его канонического пути. Никаких install hooks.

## Контракт сервиса

`createUpdaterService({root, installer, verifyScope, waitStopped, restart, onArmed})`:

- `prepare({releaseRoot, repository?, expectedCommit?, target}, execution)`:
  проверяет источник и native authority, строит проверяемый план. Target содержит
  `installRoot`, `profileRoot`, необязательный `previousReceiptPath`. Путь backup и
  сам вариант обновления определяет доверенный installer adapter.
- `queue({planId, authorization:{planId,execute:true}}, execution)`:
  повторно сверяет exact plan и создаёт одноразовую HMAC-sealed транзакцию.
  Возвращаемые `token` и job не предназначены для отправки клиенту или в чат.
- `queueRollback({transactionId, authorization:{transactionId,rollback:true}}, execution)`:
  отдельная транзакция отката на выходе, с новым token и закреплённым хэшем receipt.
- `executePending({transactionId,token}, workerExecution)`:
  допускает только правильную sealed транзакцию, захватывает межпроцессную
  блокировку, выдаёт ready proof, ждёт закрытия точного Desktop, повторяет проверки,
  применяет update/rollback, проверяет файлы и запускает Desktop.
- `status()` возвращает ограниченную историю без token/HMAC и тел файлов.
- `rollback(...)` — прямой вариант для уже закрытого Desktop; HTTP UI использует
  `queueRollback`, иначе сервер запроса исчезнет при закрытии приложения.

План действует 30 минут. После перезапуска host подготовленный, но не поставленный
в очередь план нужно заново просмотреть; файл плана нельзя подменить и затем
выполнить по старому ID. Worker ждёт закрытия максимум 15 минут и не убивает
процессы. Отзыв прав до постановки, изменение исходника/target, замена job,
неверный token, повтор и второй worker прекращают выполнение. Задание, которое
не дошло до применения, получает `not-applied`/`rollback-not-applied`.

## Отдельный worker

`createWorkerJob` записывает приватный JSON и возвращает путь + хэш. Фиксированный
`update-worker.mjs` запускается только с `--job PATH --sha256 HASH`. Он проверяет
job, затем sealed транзакцию. После захвата её lock создаётся
`root/jobs/<transactionId>.ready.json`; pid сам по себе не является proof готовности.
В ready-файле только ID, операция, pid и время. Native launcher сохраняет связь
с точным одобренным планом и не превращается в произвольный detached runner.

Worker runtime содержит `updater.js`, `update-worker.mjs`, доверенный локальный
`updater-candidate.js` и `package.json` с `type:module`. Эти файлы копируются из
уже установленного пакета, не из release ZIP. Путь к локальному installer engine
задаётся машинной настройкой. Engine сохраняет собственный artifact store и
цепочку previous receipts; их нельзя незаметно переносить в другой root, потому
что существующий installer проверяет расположение backup и старых артефактов.

Состояние `restarted-startup-unverified` означает проверенные установленные
байты и выполненный запуск. Оно не объявляет живой UI проверенным. Откат имеет
аналогичное `rollback-restarted-startup-unverified`. Если применение могло
завершиться, но вернуло ошибку, receipt ищется через доверенный adapter; при
неопределённом результате повторное применение автоматически не запускается.

## Проверка

`node --test tests/git-maintenance-updater.test.mjs`: 17 предметных тестов.
Проверены реальные файловые изменения только в temp fixtures: preview/queue без
применения, закрытие перед apply, одноразовый worker, смена файлов/прав, HMAC,
сохранённый receipt при отказе проверки, queued rollback и точное восстановление
байтов, ready proof и межпроцессный lock, безопасный архив и GitHub asset contract.
Реальный installer adapter импортируется, а отсутствие настоящей сертификации
отклоняется. Это не новый живой update рабочего DSH; установку и UI проверяет
общая приёмка release.

Отмена ожидающей транзакции проверяет token/HMAC и остаётся доступна после
отзыва прав. Worker повторно читает состояние непосредственно перед изменением
файлов; начавшееся применение отменой не перезаписывается.
