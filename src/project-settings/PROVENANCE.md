# Provenance

Самостоятельная реализация для официального DeepSeek Harness 0.2.1-rc.5.
Имена ключей и интерфейсные категории сверены с `dsh-1c-bundle/lib/project-schema.js`,
`project-settings.js`, `devenv.js` локальной сборки Олега от 2026-11-03.
Supplier policy, wizard, MCP normalization, database operations и клиентский
код сборки не копировались. Проверка native session/sandbox/persistence API
выполнена по pinned официальным пакетам из `var/asar-extract-rc5` и в тестах
с настоящими Cordis, SessionProjectionRegistry и SandboxPolicyService.

Runtime-зависимость — публичный встроенный helper `@deepseek-ai/dsh-home-paths`.
Отдельных сторонних библиотек в пакете нет.

Обнаружение среды реализовано заново через bounded filesystem reads.
Из ibases.v8i используется только структурный список с allowlist File/Srvr/Ref;
чужие credential stores и executable code не загружаются и не выполняются.
