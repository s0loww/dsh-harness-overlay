# Обновление Windows-установки DSH

Замена дерева `install` — промежуточное состояние. Полным обновлением считается
только успешное завершение проверенного официального NSIS: новый baseline,
подписанный uninstaller, правильные `DisplayVersion` и `InstallLocation`,
сохранённые до первого запуска `DSH_HOME` и Electron user data.

Все функции требуют явных `oldInstallRoot`, `homeRoot`,
`electronUserDataRoot`. Перед изменениями закрываются **все** экземпляры DSH.
Операции выполняются в одном процессе оператора, с защитой общих корней от
параллельных транзакций. Старые receipts не переписываются.

Последовательность:

1. `buildHostUpgradePlan` проверяет старый и новый release locks, receipts,
   ownership пакетов и семантическую миграцию Cordis.
2. `stageHostUpgradeShadow` создаёт полный защищённый `before` для install,
   DSH home и Electron user data и отдельный проверенный shadow. Windows ACL
   допускает текущего пользователя и SYSTEM. Секреты остаются только в backup.
3. `captureOSBefore(shadowReceipt, paths)` сохраняет точные typed values
   фиксированных Uninstall/App Paths keys, включая отсутствующие ключи, и
   существующие/отсутствующие shortcuts. HKLM и общие shortcuts — inventory,
   права на их изменение не предполагаются.
4. `applyHostUpgrade(shadowReceipt, {...paths, acknowledgement: HOST_UPGRADE_ACK})`
   подготавливает **все три** защищённых sibling stages на соответствующих
   томах, затем меняет корни с immutable numbered/fsynced журналом каждого
   rename. Displaced directories сохраняются. Это ещё не полный NSIS update.
5. `runVerifiedOfficialInstallerAndFinalize(hostApplyReceipt, options)` проверяет
   SHA-512 и Authenticode thumbprint, создаёт защищённую проверенную копию setup,
   проверяет зарегистрированный старый uninstaller, его подпись и исходные
   bytes. Запуск: `--updated /S /currentuser /D=<точный install>`, `/D` последний,
   `windowsVerbatimArguments: true`, без `--force-run` и удаления app data.
   `expectedSha512`, `expectedSignerThumbprint`, `installerPath`,
   `osBeforePath`, paths и `HOST_UPGRADE_ACK` передаются явно.
6. Только при exit 0, новом baseline, подписанном uninstaller и правильном
   реестре записывается `windows-finalization-receipt.json` со статусом
   `windows-finalized`. До первого запуска доказаны точные состояния home и
   Electron. Ошибка получает отдельный failed receipt и не считается успехом.
7. До первого запуска создаётся новый ownership anchor:
   `emitHostOwnershipAnchor(hostApplyReceipt, {...paths, ownershipBackupRoot,
   finalizationReceiptPath, acknowledgement: HOST_UPGRADE_ACK})`.
   Новый anchor проходит неизменённый strict reader обычного updater.
   Его `before` копирует **новые** bytes, поэтому rollback самого anchor —
   no-op. `metadata.hostRollbackReceipt` ссылается на Windows finalization;
   старый host receipt остаётся отдельным доказательством.

`ownershipBackupRoot` — новый непосредственный дочерний каталог
`var/live-promotion-backups`. Каталог транзакции — новый непосредственный
дочерний `var/host-upgrade-transactions`. Все пути проверяются на пересечения,
выход за корень и symlink/junction. Volume roots запрещены.

Для отката **после NSIS** используется
`rollbackOfficialWindowsFinalization(finalizationReceipt, {...paths,
acknowledgement: HOST_ROLLBACK_ACK})`. Проверяется актуальность install и OS,
сохраняется защищённый полный снимок текущего состояния. Сначала возвращается
точный bridge из shadow, затем выполняется штатный трёхкорневой host rollback
и восстановление только изменённых owned HKCU/shortcuts. При сбое OS restore
компенсация возвращает всё состояние к началу отката. Immutable intent и
`recoverOfficialWindowsFinalizationRollback(intent, options)` позволяют
проверяемое повторное восстановление. Неизвестные внешние изменения не затираются.

Если приложение уже запускалось и home/Electron изменились, по умолчанию откат
отказывается. Явное `allowRuntimeDataChanges: true` допускает их замену только
с сохранением полного текущего снимка. Строка `"false"` не является разрешением.
После истечения времени installer его исход может быть неизвестен; пока жив
setup/его потомок, откат блокируется.

Если процесс оператора погиб во время NSIS до записи finalization receipt,
останутся installer intent и полные backups. Автоматического reconcile
произвольного NSIS/controller crash из одного intent пока нет: сначала нужен
отдельный осмотр завершения setup и фактического состояния. Проверенная
автоматическая компенсация относится к записанным исходам и откату по
существующему finalization receipt.

Проверки без реального setup и моделей:

```powershell
node --test tests/host-upgrade-shadow.test.mjs tests/finalize-official-windows.test.mjs
```

Fixture adapter доступен только для всех трёх корней внутри выделенного
`var/host-upgrade-fixtures`; implicit OS scope и реальные shortcuts запрещены.
Тесты проверяют ошибки после каждого swap, torn journal, параллельные
транзакции, сохранение auth/chats/MCP, installer failures, удалённый home,
ошибку посередине OS restore, компенсацию и ownership anchor.

Протокол `/D` проверен по [официальной документации NSIS](https://nsis.sourceforge.io/Docs/Chapter3.html).
`--updated` соответствует поставляемому `electron-updater/out/NsisUpdater.js`
официальной версии 0.2.2-rc.1.
