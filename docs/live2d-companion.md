# Live2D companion

Optional, local-only companion inside the DSH window. The global settings panel is
always available; rendering is **off by default**. Miara and Hiyori are the original
Live2D Inc. samples copied byte-for-byte from the reviewed donor assets. This is
not a rigged Captain Diesel model. Nicole is deferred by user instruction pending
its separately obtained assets.

## Wiring

- package `airules-dsh-live2d-companion`, entry `lib/index.js`;
- host node `airules-live2d-companion`, native dependencies `webServer`,
  `connection`, `dshHomePath`;
- client id/package `airules-dsh-live2d-companion`, native client dependencies
  `@deepseek-ai/dsh-client-ui-session`, `@deepseek-ai/dsh-client-ui-slots`;
- settings section `airules-live2d-companion`, label «Персонаж Live2D»;
- global configuration in `dshHomePath('live2d-companion')/settings.json`;
- authenticated route prefix `/airules/live2d`, GET/POST `/configuration`,
  GET `/events?sessionId=...`, GET `/assets/{model,vendor}/...`.

Saving requires native connection admission, a one-process CSRF token, JSON,
exact byte revision CAS and a bounded validated config (32 KiB UTF-8 maximum, 64 KiB request). Only bundled model enums
are accepted, never paths or URLs. Settings are global appearance preferences,
not session-owned. The selected chat is only the source of sanitized task-phase
notifications. SSE does not contain prompt text, messages, reasoning, paths,
arguments, results or provider errors; other chats and child agents cannot steal
the selected chat's status. Live2D never submits text, grants approvals or starts
models, MCP, shell, voice or network inference. A completed turn is not a claim
that checks/deploy succeeded.

## Controls and lifecycle

Select Miara/Hiyori, height 160–420 px, default corner, gaze and notifications;
then save. Each model has an independent optional set of phrases for idle, work,
waiting, completion, error and stop. One phrase per line, up to 12 lines of 240
characters per category; clearing the override restores that model's builtin set.
Miara has a gentle fantasy voice; Hiyori is lively. Phrase choice avoids immediate
repetition. Repeated current-chat snapshots do not reconnect SSE or repeat a cached
completion; repeated identical phases do not flood bubbles. Manual buttons can
demonstrate saved phrases without executing tasks.

All PIXI/Cubism/model assets are local and only loaded when enabled.
Drag by the name, minimize/restore, or reset the position. Layout is local to this
installation. Settings buttons demonstrate working/waiting/completion/error
motions without executing a task. Native runtime notifications use only the
currently displayed chat; switching chats closes the old SSE connection.
Disabling/unloading destroys the PIXI renderer, texture resources, event stream,
listeners, bubble timeout and DOM. Server shutdown ends clients and heartbeat timers.
The global diagnostic `window.airulesLive2D.status()` reports ready/model/error;
`demo(phase)` only demonstrates an animation.

## Attribution

Code of the new host/client is separate from the donor's wallet/chat/streaming
implementation. Local asset provenance remains in `src/live2d-companion/PROVENANCE.md`,
`NOTICE.md`, `AUTHORS.md`, `LICENSE`, model `ReadMe.txt` files and vendor headers.
PIXI 6.5.10 and pixi-live2d-display 0.4.0 are MIT. Cubism Core and Live2D Inc.
sample models have their own licensing terms; they are not covered by the MIT
license of plugin code. The required Live2D sample notice is visible in settings.
No sample character design is changed and no assets are downloaded at runtime.

Focused verification: `node --test tests/live2d-companion.test.mjs`. Installation
acceptance must additionally check actual SDK022 mounting and visible WebGL
rendering. Unit/static closure checks alone do not certify renderer display.
