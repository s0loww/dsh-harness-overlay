# Official policy installer

Candidate-only transactional installer for the clean Desktop `1c-airules`
artifact. It verifies the official immutable baseline and all artifact hashes,
copies the seven version-pinned policy packages, merges a separately owned
Cordis fragment and writes
`policy-ready.json`. Apply and rollback never enumerate or copy the live DSH
profile; `loadCandidate()` rejects the live installation and `~/.dsh` paths.

```powershell
node installer/official-policy/plan.mjs --candidate-root <candidate>
node installer/official-policy/apply.mjs --candidate-root <candidate>
node installer/official-policy/rollback.mjs --candidate-root <candidate> --receipt <receipt>
```

Versioned migration from an already installed policy is opt-in:

```powershell
node installer/official-policy/plan.mjs --candidate-root <candidate> --replace-collisions
node installer/official-policy/apply.mjs --candidate-root <candidate> --replace-collisions
```

The flag authorizes only package directories whose `package.json` identity and
policy-ready marker prove policy ownership, plus structurally dedicated Cordis
blocks. Shared or ambiguous Cordis blocks stay blocked. The new version gets a
distinct backup/receipt root, so its guarded rollback restores the complete old
policy state without invoking the old receipt.
