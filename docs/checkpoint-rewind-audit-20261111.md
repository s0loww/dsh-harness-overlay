# Checkpoint/rewind: установленный владелец и аудит донора

## Уточнение по настоящему desktop-профилю

Проверено 2026-11-11 только чтением исходников и деклараций. В пользовательском
`C:/Users/S0lo/.dsh/profiles/desktop/package.json` закреплён **dsh-rewind-plugin
0.19.2** (строка 8), он включён в `dsh.profile.bundles` (строка 19).
Пакет действительно установлен. Его `cordis.patch.yml` вставляет одну dual-face
строку `dsh-rewind-plugin`, а browser/client объявлен через `dsh.client`.
Отсутствие отдельной строки в исходном `cordis.yml` не доказывает отсутствие
сервиса: подключение заявлено через bundle. Живое состояние и пользовательские
overrides в этом аудите не проверялись.

Вывод об отсутствии rewind ниже относится исключительно к отдельному candidate,
а не к установленному desktop. **Существующий Rewind — единственный владелец
отката разговора и отслеживаемых файлов. Второй engine не переносим.**
Ни capture/restore, ни Git, ни patch/install, ни изменения настроек не запускались.
Секреты, sidecars и тела разговоров не читались.

| Возможность | Установленный Rewind 0.19.2 | Отличие донора / решение |
|---|---|---|
| Откат разговора | В том же окне, append-only marker + native surface replace; исходный log сохранён | Donor fork/seed replay — другой механизм. Не переносить |
| Откат файлов | Before-write snapshots `write`/`edit`, байтовое восстановление, без Git; внешний drift сканируется только для уже tracked paths | Donor whole-set copy/Git snapshot не нужен вторым владельцем |
| Предпросмотр | RPC `preview`/`candidates`, список реально отличающихся и uncovered файлов | Использовать имеющийся UI; donor timeline/pairwise diff не дублировать |
| Защита перед откатом | Pre-restore rescue и intent journal, reconciliation/continue/rollback | Уже есть; strict fail-closed гарантии имеют ограничения ниже. Второй guard checkpoint не создавать |
| Контроль путей | Symlink/hardlink checks, realpath родителей, per-session inflight | Существующий механизм; дополнительная приёмка SDK022 нужна отдельно |
| Накопление | Checkpointing default on, content dedup, default 100 anchor groups; глобальная cleanup opt-in | Не переносить второй interval/step capture и cleanup |
| Откат настроек | Не выполняется | Donor three-state config rollback целиком не переносить: конфликт owners credentials/memory/rulepack/installer |
| Переносимый комплект | Не функция Rewind | Отдельный sanitized state-backup — полезный кандидат export/preview пользовательских настроек/правил/скиллов, вне rewind |
| Deploy/ИБ/сервисы | Не откатываются | Остаются у project runners и сервисных бэкапов; chat rewind этого не заменяет |

## Реальные границы Rewind 0.19.2

Проверены именно установленные `lib/index.js`, README.en.md и SECURITY.md:

- `TRACKED_TOOLS` — только `write`/`edit` (`index.js:2372`). Новые файлы shell,
  runner и внешних процессов не покрываются, пока путь не стал tracked.
  Большие файлы могут пропускаться. Это частичный checkpoint, не полный snapshot.
- **Subagent edits не отслеживаются** и не восстанавливаются родительским
  rewind; rewind внутри subagent также исключён. Для нашей оркестрации это
  заметный пробел; решение принадлежит существующему Rewind/upstream с native
  parent/root provenance, а не параллельному snapshot engine.
- **Нет исключения `.env` и credentials paths.** Разрешённые модели файлы,
  включая пути вне cwd, могут сохраняться до редактирования. SECURITY:178–188
  относит запрет к model-permissions. Store создаётся с обычными правами
  процесса/umask, без отдельной приватной ACL гарантии (:172–175).
  Каталог rewind-snapshots нельзя включать в переносимый комплект.
- **Journal/rescue не обязательный барьер.** `saveJournal` подавляет ошибки
  записи (`index.js:1249–1269`); `beginRestore` сохраняет `rescueError`, не
  останавливая весь restore (:1284–1309). Наличие журнала не равно успешному
  обязательному guard перед любой мутацией. Strict mode — узкий upstream-кандидат.
- **Нет CAS против внешнего writer.** Между проверкой и in-place raw FS write
  остаётся TOCTOU; это прямо описано в SECURITY. Parent revalidation не делает
  восстановление атомарным с внешними процессами (`index.js:1387–1425`).
- **Chat и files не атомарны вместе.** `executeRewind` сначала добавляет marker,
  затем вызывает `restoreAfter` (:2660 и далее); возможен частичный результат.
  Свёрнутый чат не доказывает успешный restore файлов.
- Restore является явной пользовательской командой `chat`/`both`, а не новым
  grant. В handler нет отдельного `ctx.approval.request` либо повторного
  `sandboxPolicy.resolve`. Не приписываем ему наши per-operation approval/scope
  гарантии без отдельной приёмки.
- История скрывается, не удаляется: telemetry/search/export могут видеть её.
  Rewind не откатывает состояния провайдера, Docker, Cognee/Memoria или ИБ 1С.

## Disposition оставшихся кандидатов

**Не переносить:** donor checkpoint engine, `/rewind`, timeline, автоматический
capture, session replay, whole-config rollback. Они дублируют owner либо меняют
границы ответственности. Donor `reset-hard` и слабые guard/hash defaults ниже
также не принимать.

**Небольшое полезное дополнение:** allowlisted sanitized export пользовательской
настройки для передачи сборки начальнику/сестре. Это отдельный export + dry-run
manifest/preview, без автоматического restore. Donor `lib/state-backup.js`
предлагает полезные идеи: denylist `.env*`/auth/credentials/DPAPI, структурный
scrub JSON/YAML, отказ от текста с найденными секретами, 2 МиБ/файл и 32 МиБ/набор,
manifest SHA-256, запрет links и traversal. Разговоры — только список файлов и
mtime, без тел/заголовков. Санитаризация эвристическая, не доказательство
отсутствия любого секрета. Сам модуль read-only просмотрен; экспорт не запускался.

Для нашего AIRules переносимы **принцип и allowlist**, а не буквальные donor
пути и PowerShell ZIP helper. Экспортировать пользовательские дополнения и явный
список версий/источников; исключать credentials/аккаунты, `.env`, raw profiles,
sessions/snapshots, private paths, endpoints/machine bindings/SID/process env.
Установленные rulepacks и installer receipts остаются у своих владельцев.
Применение будущего архива — через штатный importer, не распаковка поверх DSH.

**Полезное read-only пояснение в UI/правилах:** «Rewind установлен / версия /
что покрывает / subagent и shell limits / внешние действия не откатываются».
Без новой страницы настроек и без изменения capture/cleanup defaults.

**Для владельца Rewind/upstream после fixture acceptance:** strict rescue/journal,
secret path policy, native scope recheck и subagent coverage. Эти усиления сейчас
не реализованы и не оправдывают второго recovery owner.

## Исходный аудит донора (с сохранёнными ограничениями)

Следующие интеграционные решения были предварительными, до проверки настоящего
desktop. Для реализации их заменяет таблица disposition выше: существующий
Rewind остаётся владельцем, «future option» не означает второй перенос.

Reviewed 2026-11-11, without installing the plugin, capturing project snapshots,
restoring files, invoking Git, or changing sessions. This is an implementation
review, not a runtime compatibility acceptance.

Donor: the user's local `dsh-1c-bundle/node_modules/dsh-checkpoint-rewind`, version
0.6.13. The current inspected candidate profile
`var/candidate/official-desktop-022-04/home/profiles/desktop` has no checkpoint/
rewind package or plugin declaration. Owned `src/` has no rewind implementation.
The separate user-installed profile, if different, needs its own version/config
check before applying these conclusions.

| Capability | Donor implementation | Integration decision |
|---|---|---|
| Workspace rollback | Git snapshot objects or bounded copy snapshots; selective file restore and preview | Useful future option; reuse an existing native compatible plugin rather than invent a third recovery owner. Accept only after native rights/scope tests on fixtures. |
| Session rollback | Original session retained; fork/replay through `sessions.create` | Useful; verify the pinned SDK022 public seed/replay API, inherited events, and interrupted fork behavior first. Do not equate it with restoring model provider state. |
| Configuration rollback | Settings snapshot participates in the three-state record | Require an explicit settings allowlist, revision checks and separate approval. Do not roll back credentials, project memory routing, or installed rulepack state implicitly. |
| Preview and approval | Read-only impact preview; `userQuestions` or native approval; missing answerer fails closed | Retain. Command execution between turns cannot use approval without a native open turn; the donor explicitly checks this in `lib/gate.mjs`. |
| Guard checkpoint | `preRewindCheckpoint` supports `warn`, `require`, `off`; default is `warn` | Our restore must require a successfully captured guard before any mutation. Do not adopt the weaker default. |
| Automatic capture | Enabled by default, interval 0 means each step; mutation tool and FS intent hooks | Start opt-in with bounded scope, quotas and exclusions; measure cost. Our continuity checkpoint is recovery metadata, not a workspace backup. |
| Copy verification | `verifyByHash` defaults false | Use exact-byte verification and source/target CAS; fail closed after changed source/target or scope. |
| Backup/export | Donor `lib/state-backup.js` is separate sanitized settings/artifact export | Optional later utility. It excludes secret stores and records only a conversation-file list; it is not a complete restore of chats/accounts. Installer receipts remain a separate owner. |

Two source details change the import decision:

1. `SECURITY.md` states that Git never uses reset-hard; the reviewed implementation
   actually exposes `workspaceRestore: reset-hard` (`lib/constants.mjs:63,69`,
   `lib/providers/git.mjs:393,398`). The safe default is `restore`, but settings
   can select the destructive branch. Do not expose/import reset-hard into our
   approved recovery flow. Review actual code rather than treating this security
   document as an enforced invariant.
2. The default `EXCLUDE_GLOBS` (`lib/constants.mjs:147`) excludes build/tool
   directories and `.dsh`, but does not include `.env*` or credential filenames.
   The copy provider only adds mandatory `.git` exclusion (`copy.mjs:64`), walks
   remaining regular files (`:438,463`) and copies/links their bytes (`:502-508`).
   Thus do not assume its snapshots have the secret-filtering guarantees of the
   separate `state-backup.js`. Verify explicit credential exclusions, denylisted
   paths and storage ACLs before enabling capture in a real project. No actual
   credentials or snapshots were read for this review.

Before enabling a future adapter, fixture acceptance should cover native
read-only and subagent restrictions, cross-project rejection, approval rejection
and scope revocation, modified files during approval, junction/symlink/hardlink
targets, staged/untracked/new files preserved under safe restore, a failed guard,
partial restore, interrupted replay, cancellation, copy/Git path parity, and
credential exclusions. No live rewind, actual deployment, or provider call is
authorized by this document. Existing native jobs, codegraph, installer receipts,
history recall and continuity remain their own owners.
