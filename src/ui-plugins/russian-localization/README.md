# Russian localization provider

Client-only DSH plugin for host `0.2.1-rc.5`. It uses the official
`@deepseek-ai/dsh-client-locale` API:

- `addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })`;
- `register(namespace, 'ru', dictionary)`.

It does not replace `locale.register`, inspect `locale.dicts`, force a locale
preference or write settings. The user selects Russian through the official
language setting. Unknown APIs and an existing `ru` owner fail closed.

The generated payload contains 216 namespaces / 24,320 strings: 215 namespaces
from the pinned `ru-extra.json` plus the locally owned 39-string
`dsh-sleep-send` dictionary in `data/overrides.ru.json`. The source SHA-256,
override SHA-256 and both MIT license hashes are recorded by `build.mjs`;
`zhRu` string-replacement data is deliberately excluded because the official
API accepts keyed dictionaries, not global text monkeypatches.

Hardcoded text is not intercepted. The staging pipeline instead adapts the
MIT-licensed, SRI-pinned `dsh-sleep-send` client to become the owner of a real
locale namespace (`register` + `bind`). Its Russian strings then come from
this provider like every other keyed dictionary.

The Electron native `Application` / `Edit` menu and English descriptions of
some official experimental plugins live in the signed host `app.asar`, outside
the client locale extension API. They remain upstream gaps: the overlay does
not patch host code or replace DOM text at runtime.

Rebuild from a verified pinned source directory with:

```powershell
node build.mjs --source "<DSH-1C-bundle>\locales"
```

The source path is an input only and is not written to the package.
