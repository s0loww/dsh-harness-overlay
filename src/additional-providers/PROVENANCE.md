# Происхождение

Новая самостоятельная реализация интеграции с публичными API установленного DSH. Аудит локальной сборки `dsh-1c-bundle/lib/{cli-subscriptions.js,kimi-subscription.js,cursor-subscription.js,claude-max.js}` использован для определения функций и границ. Файлы поставщика и его приватные зависимости не копируются. OAuth и генерация принадлежат штатным `@earendil-works/pi-ai` и `@deepseek-ai/dsh-llm-pi-ai`. Правила поставщика, ассистент, voice, Jira, support и updater не задействованы.
