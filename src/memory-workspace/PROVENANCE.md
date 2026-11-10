# Project memory workspace

Independent implementation against the public Cognee OpenAPI and pinned native DSH rc.5 services. Donor `lib/memory-workspace.js`, `lib/project-memory-options.js` and `lib/autonomy-core.js` informed the feature audit; their private runtime, account data and storage are not copied.

Local connection configuration is outside the artifact. Defaults are disabled. Existing Memora connections and memories are retained. No automatic indexing, cross-project recall or migration runs at boot.
