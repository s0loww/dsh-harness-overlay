# Project evidence links

`airules_links` is a bounded reference ledger for a code file (optionally a line
range) and a note, document/source ID, or another code file. Relation types are
`references`, `implements`, `verifiedBy`, and `related`. It does not build a
second semantic graph, read another backend, fetch links, or copy document or
note bodies. Existing native codegraph and Cognee remain their respective owners.

The agent-only package `airules-dsh-evidence-links/agent` registers in the three
airules presets. `list`/`query` return a project revision, paginated relation
metadata and source freshness. Read it first, then use `expectedRevision` with
`add` or `remove`, and `confirm: true`. Writes require a native executing tool
token, a lead agent with write permission, and an explicit native approval that
shows the exact reference metadata. Subagents and read-only sessions can query.

Example add arguments (after listing the current revision):

```json
{
  "action": "add",
  "from": {"kind": "file", "path": "src/CommonModules/Orders/Module.bsl", "range": {"startLine": 10, "endLine": 25}},
  "to": {"kind": "note", "backend": "memoria", "namespace": "orders", "recordId": "decision-42"},
  "type": "implements",
  "provenance": {"ref": "reviewed design decision decision-42"},
  "expectedRevision": "<revision returned by list>",
  "confirm": true
}
```

`document` and `source` endpoints use `id`; a note additionally specifies its
backend, namespace, and recordId. These are declared references, not proof that
an external record exists or is accessible. Use the owning tool to verify it.
No agent-supplied project root, absolute source path, backend URL, payload, or
source hash is accepted. Paths reject traversal and protected configuration.
Optional labels are short metadata, not a place for notes or credentials.

The project-scoped file `.dsh/evidence-links.json` holds schema v1 metadata.
Project identity derives from the normalized native session path; moving it to
another root requires an explicit migration, not silently accepting a foreign
ledger. Node IDs derive from typed identity; directed relation IDs additionally
bind type and both endpoints. Each relation stores its own exact-byte source
hash, provenance reference/actor/time, and creation/update time. Updating another
relation never silently refreshes earlier evidence.

Files are resolved and read through the selected native filesystem; root and
symlink checks, native sandbox policy, compare-and-swap versions, an expected
byte revision and a runtime project write lock protect updates. Source hashes
are checked again after approval. Removing a relation only removes unused local
reference metadata, never a source file or a backend record.

Results report `fresh`, `stale`, `missing-or-inaccessible`, or
`unverified-budget` for each code source; external verification is `not-fetched`.
Stale references need renewed review. A fresh hash proves byte identity, not the
truth of a design claim or that a test passed. Query pages are limited to 30;
the ledger holds at most 256 relations/512 nodes/512 KiB. Source reads are bounded
to 4 MiB each, 16 files and 16 MiB per page. Cursors bind revision and filters;
changes require starting a fresh query. Reads never rewrite the ledger.

`tests/evidence-links*.test.mjs` exercise original core logic and actual SDK022
tool registration/execution plus SandboxedFileSystem/CAS, using only synthetic
temporary files. They cover stale evidence, native denial/revocation, source
edits during approval, foreign ledgers, junctions, pagination, removal and
concurrent external file edits. No paid model or backend is called. The donor
knowledge/metadata graph architecture was inspected; this ledger is original
code and does not import its cache, graph extraction or remote configuration.
