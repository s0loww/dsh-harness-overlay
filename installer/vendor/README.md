# Installer parser

`yaml/` is the unmodified ISC-licensed yaml 2.9.1 runtime copied from the
pinned supplier dependency tree. `upstream/installer-yaml-closure.lock.json`
records its package identity and complete file digest. No dependencies are
installed or executed at update time. Cordis migration treats native `!!js`
tags as opaque scalar data, never evaluates expressions, and rejects aliases
and unrecognized tags.
