"""Validate and seed a fresh owned volume from a sealed model-only archive.

No tar extractall: each destination and file type is checked independently.
The helper has no network, keys, project paths or user database mounted.
"""
import hashlib
import json
import pathlib
import sys
import tarfile

root = pathlib.Path('/cognee-storage')
models = json.loads(sys.argv[1])
allowed = ['models/' + m['folder'] + '/snapshots/' + m['revision'] + '/' for m in models]
references = {'models/' + m['folder'] + '/refs/main': m['revision'] for m in models}
inventory = {}
rows = {}
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
    for item in archive:
        name = item.name
        path = pathlib.PurePosixPath(name)
        if not item.isfile() or path.is_absolute() or any(p in ('.', '..', '') for p in path.parts) or '\\' in name or name in seen:
            raise RuntimeError('MODEL_ARCHIVE_ENTRY_REJECTED')
        if name != 'models/model-inventory.json' and name not in references and not any(name.startswith(prefix) for prefix in allowed):
            raise RuntimeError('MODEL_ARCHIVE_PATH_REJECTED')
        seen.add(name)
        if item.size > 2 * 1024**3:
            raise RuntimeError('MODEL_ARCHIVE_ENTRY_LIMIT')
        source = archive.extractfile(item)
        if name == 'models/model-inventory.json':
            if item.size > 256 * 1024:
                raise RuntimeError('MODEL_INVENTORY_LIMIT')
            manifest = json.load(source)
            if manifest.get('schemaVersion') != 1 or manifest.get('models') != models:
                raise RuntimeError('MODEL_LOCK_MISMATCH')
            inventory = {row['path']: row for row in manifest['files']}
            continue
        target = root.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            raise RuntimeError('MODEL_TARGET_ALREADY_EXISTS')
        digest = hashlib.sha256(); size = 0
        with target.open('xb') as destination:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk); destination.write(chunk); size += len(chunk)
        inventory_key = {'size': size, 'sha256': digest.hexdigest()}
        # Temporary verification metadata, never user data.
        rows[name] = inventory_key
        if name in references and target.read_text().strip() != references[name]:
            raise RuntimeError('MODEL_REFERENCE_MISMATCH')
    if not inventory or set(rows) != set(inventory):
        raise RuntimeError('MODEL_INVENTORY_MISMATCH')
    for name, actual in rows.items():
        expected = inventory[name]
        if actual['size'] != expected['size'] or actual['sha256'] != expected['sha256']:
            raise RuntimeError('MODEL_HASH_MISMATCH')
print(json.dumps({'seeded': True, 'files': len(rows), 'modelSnapshots': len(models)}))
