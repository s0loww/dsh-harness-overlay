# Происхождение

Новая самостоятельная реализация интеграции с публичными API установленного DSH. Аудит локальной сборки `dsh-1c-bundle/lib/{cli-subscriptions.js,kimi-subscription.js,cursor-subscription.js,claude-max.js}` использован для определения функций и границ. Файлы поставщика и его приватные зависимости не копируются. OAuth и генерация принадлежат штатным `@earendil-works/pi-ai` и `@deepseek-ai/dsh-llm-pi-ai`. Правила поставщика, ассистент, voice, Jira, support и updater не задействованы.

Key-plan routes используют публичные metadata `zai`, `qwen-token-plan`, `opencode-go` из фактически закреплённого `@earendil-works/pi-ai@1.1.0` установленного DSH rc.5. Endpoint, protocol и модельные параметры берутся из этого каталога; новый provider SDK не копируется. Peer version исправлена с ошибочной1.4.0 на проверенную1.1.0.
