# Provenance

- `dsh-bsl-editor` 0.4.0: MIT, источник `Mempemp/DSH-CodeEditor_BSL`, pinned
  vendor copy из DSH 1C bundle. Копия содержит зафиксированные в её
  `PROVENANCE.md` правки Oleg bundle. При staging заменяется приватный импорт
  project-root, удаляется привязка к приватному `/onec/bsl-intelligence` и
  добавляется fail-closed gate пресета `1c-airules`.
- `dsh-lsp-actions` 0.4.6: Apache-2.0, источник
  `PerryLink/dsh-lsp-actions`, pinned package из DSH 1C bundle.
- `schemastery` 3.18.0, `@standard-schema/spec` 1.1.0, `cosmokit` 1.8.1:
  MIT dependency closure редактора из того же pin дерева. Зависимости
  вкладываются в `schemastery/node_modules`, не занимая общепрофильные имена.
- `@deepseek-ai/schemastery` 3.18.5, `@deepseek-ai/cosmokit` 1.8.6 и
  `@standard-schema/spec` 1.1.0: MIT runtime closure `dsh-lsp-actions`, вложенный
  в сам пакет.
- `fast-xml-parser` 4.5.7 и `strnum` 1.1.2: MIT, сохранены в nested
  `node_modules` vendor editor exactly as installed by its pinned package.

Vendor BSL Language Server JAR/Java, приватные metadata/MCP плагины, Oleg Full
policy, project wizard и database/deploy mechanics в артефакт не входят.
