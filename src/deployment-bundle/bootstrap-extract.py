"""Extract the pinned engine archive before Node starts; stdlib only."""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid
import zipfile

MAX_JSON = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 ** 3
MAX_FILE = 32 * 1024 ** 3
HEX = re.compile(r"^[a-f0-9]{64}$")
DEVICE = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)


class Refusal(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def native(path):
    path = os.path.abspath(path)
    if os.name != "nt" or path.startswith("\\\\?\\"):
        return path
    return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path


def safe_name(value):
    require(isinstance(value, str) and 0 < len(value) <= 2048, "EXTRACT_PATH_INVALID")
    require(not re.search(r'[\\<>:"|?*\x00-\x1f\x7f]', value), "EXTRACT_PATH_INVALID")
    parts = value.split("/")
    require(all(p and p not in (".", "..") and len(p) <= 255 and not p.endswith((".", " "))
                and not DEVICE.match(p) for p in parts), "EXTRACT_PATH_INVALID")
    return value


def target(root, name):
    return os.path.join(root, *safe_name(name).split("/"))


def guard(path):
    at = os.path.abspath(path)
    chain = []
    while True:
        chain.append(at)
        parent = os.path.dirname(at)
        if at == parent:
            break
        at = parent
    for at in reversed(chain):
        try:
            info = os.lstat(native(at))
        except FileNotFoundError:
            return
        require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
                "EXTRACT_LINK_REJECTED")
        require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, "EXTRACT_LINK_REJECTED")
        if at != os.path.abspath(path):
            require(stat.S_ISDIR(info.st_mode), "EXTRACT_PARENT_INVALID")


def file_hash(path):
    guard(path)
    before = os.stat(native(path))
    require(stat.S_ISREG(before.st_mode), "EXTRACT_FILE_REQUIRED")
    digest = hashlib.sha256()
    with open(native(path), "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    guard(path)
    after = os.stat(native(path))
    require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "EXTRACT_SOURCE_CHANGED")
    return {"bytes": before.st_size, "sha256": digest.hexdigest()}


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "EXTRACT_MANIFEST_INVALID")
        result[key] = value
    return result


def protect(root):
    guard(root)
    # Refuse links before a recursive ACL operation could affect an outside file.
    for base, dirs, files in os.walk(native(root), followlinks=False):
        for name in dirs + files:
            info = os.lstat(os.path.join(base, name))
            require(not stat.S_ISLNK(info.st_mode)
                    and not (getattr(info, "st_file_attributes", 0) & 0x400)
                    and (not stat.S_ISREG(info.st_mode) or info.st_nlink == 1), "EXTRACT_LINK_REJECTED")
    if os.name == "nt":
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW}
        who = subprocess.run(["whoami.exe", "/user", "/fo", "csv", "/nh"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags)
        sid = re.search(rb"S-1-5-[0-9-]+", who.stdout)
        require(sid is not None, "EXTRACT_OWNER_UNAVAILABLE")
        subprocess.run(["icacls.exe", native(root), "/inheritance:r", "/grant:r",
                        "*" + sid.group().decode("ascii") + ":(OI)(CI)(F)",
                        "*S-1-5-18:(OI)(CI)(F)"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
        if os.listdir(native(root)):
            subprocess.run(["icacls.exe", native(os.path.join(root, "*")), "/reset", "/T", "/Q"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
    else:
        os.chmod(root, 0o700)


def read_manifest(root):
    path = os.path.join(root, "deployment-manifest.json")
    guard(path)
    require(os.stat(native(path)).st_size <= MAX_JSON, "EXTRACT_MANIFEST_INVALID")
    with open(native(path), "rb") as stream:
        data = stream.read(MAX_JSON + 1)
    require(len(data) <= MAX_JSON, "EXTRACT_MANIFEST_INVALID")
    manifest = json.loads(data.decode("utf-8-sig"), object_pairs_hook=no_duplicate_keys)
    require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1
            and manifest.get("kind") == "airules-dsh-deployment", "EXTRACT_MANIFEST_INVALID")
    files = manifest.get("files")
    require(isinstance(files, dict) and 0 < len(files) <= 50000, "EXTRACT_MANIFEST_INVALID")
    total = 0
    seen = set()
    for name, row in files.items():
        safe_name(name)
        require(name.lower() not in seen, "EXTRACT_MANIFEST_COLLISION")
        seen.add(name.lower())
        require(isinstance(row, dict) and type(row.get("bytes")) is int
                and 0 <= row["bytes"] <= MAX_FILE and isinstance(row.get("sha256"), str)
                and HEX.fullmatch(row["sha256"]), "EXTRACT_MANIFEST_INVALID")
        total += row["bytes"]
    require(total <= MAX_TOTAL, "EXTRACT_MANIFEST_INVALID")
    envelope = manifest.get("envelope")
    require(isinstance(envelope, dict) and envelope.get("schemaVersion") == 1
            and envelope.get("extractor") == "bootstrap.py", "EXTRACT_ENVELOPE_INVALID")
    prefix = safe_name(envelope.get("engineRoot")) + "/"
    require(manifest.get("paths", {}).get("engine") == prefix[:-1], "EXTRACT_ENVELOPE_INVALID")
    archive = safe_name(envelope.get("engineArchive"))
    require(not archive.startswith(prefix) and archive in files and "bootstrap.py" in files,
            "EXTRACT_ENVELOPE_INVALID")
    expected = {name: row for name, row in files.items() if name.startswith(prefix)}
    require(expected, "EXTRACT_ENGINE_EMPTY")
    return manifest, envelope, expected


def extract(root):
    root = os.path.abspath(root)
    guard(root)
    manifest, envelope, expected = read_manifest(root)
    require(file_hash(os.path.join(root, "bootstrap.py")) == manifest["files"]["bootstrap.py"],
            "EXTRACT_BOOTSTRAP_CHANGED")
    protect(root)  # Covers already extracted private MCP files before engine extraction.
    archive = target(root, envelope["engineArchive"])
    require(file_hash(archive) == manifest["files"][envelope["engineArchive"]], "EXTRACT_ARCHIVE_CHANGED")
    extracted = skipped = 0
    with zipfile.ZipFile(native(archive)) as packed:
        entries = packed.infolist()
        require(len(entries) == len(expected), "EXTRACT_ENTRY_SET_INVALID")
        seen = set()
        for info in entries:
            name = safe_name(info.filename)
            mode = stat.S_IFMT(info.external_attr >> 16)
            require(name.lower() not in seen and name in expected and not info.is_dir()
                    and mode in (0, stat.S_IFREG) and not info.flag_bits & 1
                    and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    and info.file_size == expected[name]["bytes"], "EXTRACT_ENTRY_INVALID")
            seen.add(name.lower())
            path = target(root, name)
            guard(path)
            if os.path.lexists(native(path)):
                require(file_hash(path) == expected[name], "EXTRACT_EXISTING_FILE_CHANGED")
        # Validate every CRC and digest BEFORE any engine file is installed.
        for info in entries:
            digest = hashlib.sha256()
            count = 0
            with packed.open(info) as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    count += len(chunk)
                    require(count <= expected[info.filename]["bytes"], "EXTRACT_SIZE_INVALID")
                    digest.update(chunk)
            require(count == expected[info.filename]["bytes"]
                    and digest.hexdigest() == expected[info.filename]["sha256"], "EXTRACT_CONTENT_CHANGED")
        for info in entries:
            path = target(root, info.filename)
            guard(path)
            if os.path.lexists(native(path)):
                require(file_hash(path) == expected[info.filename], "EXTRACT_EXISTING_FILE_CHANGED")
                skipped += 1
                continue
            parent = os.path.dirname(path)
            guard(parent)
            os.makedirs(native(parent), exist_ok=True)
            guard(parent)
            temp = os.path.join(parent, ".dsh-unpack-" + uuid.uuid4().hex + ".tmp")
            try:
                digest = hashlib.sha256()
                count = 0
                with open(native(temp), "xb") as output, packed.open(info) as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        count += len(chunk)
                        require(count <= expected[info.filename]["bytes"], "EXTRACT_SIZE_INVALID")
                        output.write(chunk)
                        digest.update(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                require(count == expected[info.filename]["bytes"]
                        and digest.hexdigest() == expected[info.filename]["sha256"], "EXTRACT_CONTENT_CHANGED")
                require(file_hash(temp) == expected[info.filename], "EXTRACT_CONTENT_CHANGED")
                guard(path)
                if os.name == "nt":
                    os.rename(native(temp), native(path))  # Refuses overwrite on Windows.
                else:
                    os.link(temp, path)  # Atomic no-overwrite on POSIX test hosts.
                    os.unlink(temp)
                extracted += 1
            finally:
                if os.path.lexists(native(temp)):
                    os.unlink(native(temp))
    return {"status": "ready", "extracted": extracted, "matchingExisting": skipped}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "EXTRACT_ARGUMENT_INVALID")
        print(json.dumps(extract(sys.argv[1])))
    except Exception as error:
        print(json.dumps({"status": "failed", "code": str(error) if isinstance(error, Refusal)
                          else "EXTRACT_OPERATION_FAILED"}))
        sys.exit(1)
