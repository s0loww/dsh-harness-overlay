"""Export only pinned public model snapshots, never a Cognee database or user file.

Executed read-only in the existing source container. stdout is a tar stream.
Symlinks in HF snapshots are resolved ONLY inside /cognee-storage/models and
materialized as plain files; no source permissions, owners or host paths leak.
"""
import hashlib
import io
import json
import pathlib
import sys
import tarfile

root = pathlib.Path('/cognee-storage/models').resolve()
models = json.loads(sys.argv[1])
inventory = []
files_by_model = {
    'fastino/gliner2.5-base-v1': ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'],
    'BAAI/bge-small-en-v1.5': ['tokenizer.json', 'tokenizer_config.json'],
    'Qdrant/bge-small-en-v1.5-onnx-Q': ['config.json', 'model_optimized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json'],
}

with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    for model in models:
        folder = root / model['folder']
        snapshot = folder / 'snapshots' / model['revision']
        if not snapshot.is_dir():
            raise RuntimeError('PINNED_MODEL_SNAPSHOT_MISSING')
        files = [snapshot / name for name in files_by_model[model['name']]]
        if not files or any(not p.is_file() for p in files):
            raise RuntimeError('MODEL_FILE_COUNT_INVALID')
        for path in files:
            source = path.resolve(strict=True)
            if not source.is_relative_to(root):
                raise RuntimeError('MODEL_SOURCE_NOT_ALLOWLISTED')
            relative = pathlib.PurePosixPath('models') / path.relative_to(root).as_posix()
            if any(part in ('..', '.', '') for part in relative.parts):
                raise RuntimeError('MODEL_PATH_INVALID')
            size = source.stat().st_size
            if size > 2 * 1024**3:
                raise RuntimeError('MODEL_FILE_TOO_LARGE')
            digest = hashlib.sha256()
            with source.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            info = tarfile.TarInfo(str(relative)); info.size = size
            info.mode = 0o644; info.uid = info.gid = 1000; info.mtime = 0
            with source.open('rb') as stream:
                archive.addfile(info, stream)
            inventory.append({'path': str(relative), 'size': size, 'sha256': digest.hexdigest()})
        # HF offline lookup resolves refs/main before reading a cached snapshot.
        reference = model['revision'].encode()
        name = 'models/' + model['folder'] + '/refs/main'
        info = tarfile.TarInfo(name); info.size = len(reference)
        info.mode = 0o644; info.uid = info.gid = 1000; info.mtime = 0
        archive.addfile(info, io.BytesIO(reference))
        inventory.append({'path': name, 'size': len(reference), 'sha256': hashlib.sha256(reference).hexdigest()})
    manifest = json.dumps({'schemaVersion': 1, 'models': models, 'files': inventory}, sort_keys=True).encode()
    info = tarfile.TarInfo('models/model-inventory.json'); info.size = len(manifest)
    info.mode = 0o644; info.uid = info.gid = 1000; info.mtime = 0
    archive.addfile(info, io.BytesIO(manifest))

