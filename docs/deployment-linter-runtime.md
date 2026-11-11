# Portable Java и локальный BSL Language Server

Пакет содержит Eclipse Temurin JRE **21.0.13+9 LTS**, Windows x64 HotSpot,
и BSL Language Server **1.0.7**. Java 21 входит в проверяемые версии upstream
BSL LS; минимальная версия Java у него — 17. Ничего устанавливать системно,
менять `PATH`, `JAVA_HOME` или реестр для линтера не требуется.

## Раскладка и запуск

Исходные офлайн-активы: `var/deployment-assets/linter`. Builder переносит
`java/` в `runtime/java/`, JAR, CMD и `notices/` — в `runtime/bsl/`.
`metadata.json` описывает исходную раскладку; проверяется до копирования.

Штатные интеграции запускают `runtime/java/bin/java.exe` напрямую, передавая
префикс `JAVA_LINTER_ARGS` из `src/deployment-bundle/linter/lock.mjs`,
затем `-jar`, абсолютный путь к JAR и команду сервера:

- анализ: `analyze -s <source> -c <config> -o <reports> -r json`;
- LSP по stdio: `lsp -c <config>`;
- редактор WebSocket: `websocket --server.port=<port> -c <config>`.

`-Dserver.address=127.0.0.1` передаётся JVM **до** `-jar`: аналогичный
аргумент команды Picocli не принимает. Память JVM: `-Xms128m -Xmx1g`,
кодировка UTF-8. Процесс скрыт при запуске адаптером. CMD-обёртка нужна
для ручного CLI, поддерживает пробелы и кириллицу; прямой spawn `.cmd`
для LSP на Windows не используется.

Дочерний процесс исключает `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS` и
`JDK_JAVA_OPTIONS`, чтобы настройки Java на машине получателя не меняли
запуск и не попадали в журналы. Окружение родителя остаётся прежним.
Базовый конфиг: `language: ru`, `sendErrors: never`, `traceLog: null`.
Проектные настройки сохраняет отдельный `linter/config.mjs`.

## Происхождение и лицензии

- [BSL LS release 1.0.7](https://github.com/1c-syntax/bsl-language-server/releases/tag/v1.0.7):
  JAR SHA-256 `9f62765edd344d66456da24c906eaf623a03c56e90e5aafee466200100909f64`;
  исходники зафиксированы коммитом `f377f95aefa16a4cf0e4d9af5b1c83800366bebc`.
- [Temurin 21.0.13+9 release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9):
  JRE ZIP SHA-256 `2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628`.
  SHA проверен по официальным release/API; Authenticode `java.exe` —
  `Valid`, издатель Eclipse Foundation.
- [Требования BSL LS](https://github.com/1c-syntax/bsl-language-server/blob/v1.0.7/docs/systemRequirements.md).

Сохранено полное Java `legal/`, `NOTICE` и `release`. В `runtime/bsl/notices`
включены COPYING BSL LS, GPL-3.0 и соответствующие полные архивы исходников
BSL LS и OpenJDK. Подробности — `linter/notices/UPSTREAM.md`. JAR и JRE
не модифицировались. Архивы исходников не исполняются установщиком.

## Проверки и API

`verifyLinterRuntime({assetsRoot})` проверяет фиксированный lock версии,
точный набор файлов, размеры и SHA-256 всех файлов, содержимое обёртки и
Java release. Собственная замена metadata не разрешает подменить бинарник.
На зафиксированном наборе: **322 файла, 402 583 417 байт** без metadata.

`probeLinterRuntime({assetsRoot, fixtureRoot, reportPath, javaPath?, jarPath?, websocket?})`
запускает реальные процессы исключительно в **новом** каталоге фикстуры.
Для конечной раскладки `javaPath` и `jarPath` передаются явно. Существующий
каталог, в том числе проект, отклоняется до записи. Проба проверяет Java,
версию JAR, реальные BSL-диагностики, LSP initialize/shutdown/exit и HTTP
WebSocket-службу. На Windows проверяется, что слушатели собственного PID
привязаны только к loopback. Временные процессы завершаются в finally.

Результаты на Windows: **8/8 живых проверок PASS**, **4/4 unit PASS**.
Фикстура возвращает `UnusedLocalVariable`, а не просто успешный exit code.
Отдельно CLI CMD проверен в конечной раскладке с пробелами и кириллицей,
исходной кодовой страницей 866 и чужой `_JAVA_OPTIONS`: **PASS**.
LSP 1.0.7 отвечает на shutdown значением `true`, что учитывает проверка.
Это проверка локального линтера; развёртывание информационных баз не запускается.
