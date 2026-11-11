#!/usr/bin/env python3
"""Stage and verify an airules DSH/DeepSeek project candidate.

This renderer deliberately does not mutate the target project. It builds a
candidate tree, an instruction-budget report and a secret-free MCP plan. Apply
and rollback are separate milestones because existing project instructions
and MCP files are user-owned until an explicit migration is accepted.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


KINDS = ("invariant", "case", "recipe", "process", "router")
TEXT_SKILL_EXTENSIONS = {".md", ".txt", ".json", ".yaml", ".yml", ".toml"}
REQUIRED_PLACEHOLDERS = {
    "PROJECT_ID", "PROJECT_NAME", "STACK", "SOURCE_OF_TRUTH",
    "PRIMARY_CODE_DIR", "PREFIX", "LANGUAGE_POLICY", "MCP_ORDER",
    "DISABLED_MCP", "BACKUP_DIR",
}


class RenderError(ValueError):
    pass


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".airules-tmp")
    temporary.write_bytes(content)
    os.replace(str(temporary), str(path))


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(read_text(path))
    except (OSError, json.JSONDecodeError) as exc:
        raise RenderError("cannot read JSON {0}: {1}".format(path, exc)) from exc
    if not isinstance(value, dict):
        raise RenderError("{0}: top-level JSON value must be an object".format(path))
    return value


def safe_relative(root: Path, raw: str, label: str) -> Path:
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        raise RenderError("{0} must be a project-relative path: {1}".format(label, raw))
    result = (root / relative).resolve()
    try:
        result.relative_to(root.resolve())
    except ValueError as exc:
        raise RenderError("{0} escapes project: {1}".format(label, raw)) from exc
    return result


def load_composition(source: Path, profile: str) -> Dict[str, Any]:
    sys.path.insert(0, str(source / "ci"))
    try:
        from composition import load_catalog, resolve_composition
        return resolve_composition(
            load_catalog(source, "1c"), "dsh-deepseek", profile, "1c", "common"
        )
    finally:
        sys.path.pop(0)


def parse_rule_meta(text: str, path: Path, kind_override: Optional[str] = None) -> Tuple[str, str]:
    kind = re.search(r"^kind:\s*([^\s]+)", text, re.M)
    description = re.search(r"^description:\s*(.+)$", text, re.M)
    if description is None:
        raise RenderError("rule lacks description: {0}".format(path))
    if kind is None and kind_override is None:
        raise RenderError("rule lacks kind and binding supplies none: {0}".format(path))
    kind_value = kind_override or kind.group(1).strip("\"'")
    if kind_value not in KINDS:
        raise RenderError("unsupported rule kind {0}: {1}".format(kind_value, path))
    return kind_value, description.group(1).strip().strip('"')


def transform_paths(text: str) -> str:
    text = text.replace(".claude/skills/", ".dsh/skills/")
    text = text.replace(".codex/rules/", ".dsh/rules-1c/")
    text = re.sub(r"\.cursor/rules/([A-Za-z0-9_-]+)\.mdc", r".dsh/rules-1c/\1.md", text)
    text = re.sub(r"(?<![A-Za-z0-9_.-])rules/([A-Za-z0-9_-]+\.md)",
                  r".dsh/rules-1c/\1", text)
    return text


def collect_rules(source: Path, project: Path, bindings: Mapping[str, Any]) -> Tuple[Dict[str, str], Dict[str, Tuple[str, str]], List[str]]:
    bodies: Dict[str, str] = {}
    meta: Dict[str, Tuple[str, str]] = {}
    overrides: List[str] = []
    for base in (source / "core" / "rules", source / "overlays" / "1c" / "rules"):
        for path in sorted(base.glob("*.md")):
            text = read_text(path)
            bodies[path.stem] = transform_paths(text)
            meta[path.stem] = parse_rule_meta(text, path)

    project_rules = bindings.get("project_rules", [])
    if not isinstance(project_rules, list):
        raise RenderError("project_rules must be a list")
    for item in project_rules:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("path"), str):
            raise RenderError("each project_rules item needs string name and path")
        path = safe_relative(project, item["path"], "project rule")
        if not path.is_file():
            raise RenderError("project rule does not exist: {0}".format(path))
        text = read_text(path)
        if item["name"] in bodies:
            overrides.append(item["name"])
        bodies[item["name"]] = transform_paths(text)
        kind_override = item.get("kind")
        if kind_override is not None and not isinstance(kind_override, str):
            raise RenderError("project rule kind must be a string: {0}".format(item["name"]))
        meta[item["name"]] = parse_rule_meta(text, path, kind_override)
    return bodies, meta, sorted(overrides)


def render_index(meta: Mapping[str, Tuple[str, str]]) -> str:
    grouped = {kind: [] for kind in KINDS}
    for name, (kind, description) in sorted(meta.items()):
        grouped[kind].append((name, description))
    lines: List[str] = []
    for kind in KINDS:
        if not grouped[kind]:
            continue
        lines.extend(["", "**{0}**".format(kind), ""])
        lines.extend(
            "- `.dsh/rules-1c/{0}.md` — {1}".format(name, description)
            for name, description in grouped[kind]
        )
    return "\n".join(lines).strip()


def parse_roles(source: Path) -> List[Dict[str, str]]:
    roles = []
    row = re.compile(r"^\| ([a-z][a-z-]+) \| (\w+)(\*?) \| (\w+) \| (\w+) \| (\S+) \| (.+?) \|$")
    for line in read_text(source / "core" / "agents" / "ROLES.md").splitlines():
        match = row.match(line)
        if not match or match.group(1) == "role":
            continue
        roles.append({
            "role": match.group(1),
            "tier": match.group(2),
            "effort": match.group(4),
            "purpose": match.group(7),
        })
    if not roles:
        raise RenderError("no roles parsed from core/agents/ROLES.md")
    return roles


def render_role_rows(roles: Iterable[Mapping[str, str]]) -> str:
    return "\n".join(
        "| {role} | {tier} | {effort} | DSH runtime-selected; native role renderer pending |".format(**role)
        for role in roles
    )


def model_profile_block(source: Path) -> str:
    text = read_text(source / "targets" / "dsh" / "deepseek" / "model-profile.md")
    match = re.search(r"```text\s*\n(.*?)\n```", text, re.S)
    if match is None:
        raise RenderError("model profile rendered block not found")
    return match.group(1).strip()


def render_agents(source: Path, values: Mapping[str, str], index: str, roles: List[Dict[str, str]]) -> str:
    text = read_text(source / "core" / "templates" / "AGENTS.md")
    replacements = dict(values)
    replacements["RULE_INDEX"] = index
    replacements["AGENTS_TABLE"] = render_role_rows(roles)
    for key, value in replacements.items():
        text = text.replace("{{" + key + "}}", value)
    text = text.replace(
        "Project-owned access and verification bindings live in\n  `.airules/project-context.md` and `.airules/testing-contour.md`.",
        "Project-owned facts, access policy and verification bindings live in `USER-RULES.md`.",
    )
    text = transform_paths(text)
    unresolved = sorted(set(re.findall(r"\{\{([A-Za-z0-9_]+)\}\}", text)))
    if unresolved:
        raise RenderError("unresolved AGENTS placeholders: {0}".format(", ".join(unresolved)))
    return text.rstrip() + "\n\n" + model_profile_block(source) + "\n"


def validate_skill(skill: Path) -> None:
    entry = skill / "SKILL.md"
    if not entry.is_file():
        raise RenderError("skill lacks SKILL.md: {0}".format(skill))
    text = read_text(entry)
    frontmatter = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
    if frontmatter is None:
        raise RenderError("skill lacks YAML frontmatter: {0}".format(entry))
    metadata = frontmatter.group(1)
    name = re.search(r"^name:[ \t]*([a-z0-9]+(?:-[a-z0-9]+)*|'[a-z0-9]+(?:-[a-z0-9]+)*'|\"[a-z0-9]+(?:-[a-z0-9]+)*\")[ \t]*$", metadata, re.M)
    if name is None or not re.search(r"^description:[ \t]*\S[^\r\n]*$", metadata, re.M):
        raise RenderError("skill lacks name/description frontmatter: {0}".format(entry))
    if name.group(1).strip("\"'") != skill.name:
        raise RenderError("skill name does not match directory: {0}".format(entry))


def copy_skills(source: Path, output: Path) -> Tuple[List[str], int]:
    names: List[str] = []
    count = 0
    destination = output / ".dsh" / "skills"
    target_skills = source / "targets" / "dsh" / "skills"
    for base in (source / "core" / "skills", source / "overlays" / "1c" / "skills", target_skills):
        if not base.is_dir():
            continue
        for skill in sorted(path for path in base.iterdir() if path.is_dir()):
            validate_skill(skill)
            if base == target_skills and skill.name in names:
                raise RenderError("DSH target skill conflicts with portable skill: {0}".format(skill.name))
            names.append(skill.name)
            for path in skill.rglob("*"):
                if not path.is_file() or "node_modules" in path.parts:
                    continue
                relative = path.relative_to(skill)
                target = destination / skill.name / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if path.suffix.lower() in TEXT_SKILL_EXTENSIONS:
                    write_text(target, transform_paths(read_text(path)))
                else:
                    shutil.copyfile(path, target)
                count += 1
    return sorted(set(names)), count


def existing_skill_names(project: Path) -> set:
    result = set()
    for base in (project / ".agents" / "skills", project / ".dsh" / "skills"):
        if base.is_dir():
            result.update(path.name for path in base.iterdir() if path.is_dir())
    return result


def mcp_inventory(project: Path, composition: Mapping[str, Any], bindings: Mapping[str, Any], skip: bool) -> Dict[str, Any]:
    path = project / ".mcp.json"
    servers: Dict[str, Any] = {}
    if path.is_file():
        data = read_json(path)
        raw_servers = data.get("mcpServers", {})
        if not isinstance(raw_servers, dict):
            raise RenderError(".mcp.json mcpServers must be an object")
        servers = raw_servers
    mapping = bindings.get("mcp_bindings", {})
    if not isinstance(mapping, dict):
        raise RenderError("mcp_bindings must be an object")
    logical = composition["profile"]["mcp"]["logical_servers"]
    allowed = set()
    missing_required = []
    unbound_required = []
    for item in logical:
        server_name = mapping.get(item["role"])
        if not server_name:
            if item["required"]:
                unbound_required.append(item["role"])
            continue
        allowed.add(server_name)
        if item["required"] and server_name not in servers:
            missing_required.append(server_name)
    rows = []
    for name, server in sorted(servers.items()):
        if not isinstance(server, dict):
            continue
        old_enabled = server.get("enabled") is not False and server.get("disabled") is not True
        rows.append({
            "name": name,
            "transport": server.get("type") or ("stdio" if "command" in server else "unknown"),
            "old_enabled": old_enabled,
            "planned_enabled": name in allowed,
        })
    blockers = [] if skip else [
        *("required logical MCP role is unbound: " + role for role in unbound_required),
        *("required MCP server is absent: " + name for name in missing_required),
    ]
    return {
        "status": "skipped" if skip else ("blocked" if blockers else "ready"),
        "allowlist": sorted(allowed),
        "servers": rows,
        "blockers": blockers,
    }


def git_state(source: Path) -> Dict[str, Any]:
    def run(*args: str) -> str:
        proc = subprocess.run(["git", *args], cwd=source, capture_output=True, text=True, encoding="utf-8")
        return proc.stdout.strip() if proc.returncode == 0 else ""
    return {
        "revision": run("rev-parse", "HEAD"),
        "dirty": bool(run("status", "--porcelain")),
    }


def instruction_probe(output: Path, project: Path, bundle: Optional[Path], limit: int) -> Dict[str, Any]:
    files = [("AGENTS.md", output / "AGENTS.md")]
    for name in ("USER-RULES.md", "LLM-RULES.md", "AGENTS.local.md"):
        path = output / name if (output / name).is_file() else project / name
        if path.is_file():
            files.append((name, path))
    if bundle is None:
        raw_bytes = sum(len(path.read_bytes()) for _, path in files)
        return {
            "status": "approximate",
            "source_bytes": raw_bytes,
            "max_bytes": limit,
            "warning": raw_bytes > 57344,
            "omitted": [],
            "truncated": [],
        }
    module = bundle / "node_modules" / "@deepseek-ai" / "dsh-agent-instructions" / "lib" / "index.js"
    if not module.is_file():
        raise RenderError("DSH instruction module not found: {0}".format(module))
    script = Path(__file__).with_name("dsh_probe.mjs")
    command = [
        "node", str(script), "--module", str(module), "--max-bytes", str(limit),
        "--warning-bytes", "57344",
    ]
    for display, path in files:
        command.extend(["--file", display + "=" + str(path)])
    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if not proc.stdout.strip():
        raise RenderError("DSH instruction probe failed: {0}".format(proc.stderr.strip()))
    report = json.loads(proc.stdout)
    report["status"] = "pass" if proc.returncode == 0 else "fail"
    if proc.returncode not in (0, 2):
        raise RenderError("DSH instruction probe failed: {0}".format(proc.stderr.strip()))
    return report


def verify_output(output: Path, expected_rules: int) -> List[str]:
    failures = []
    agents = read_text(output / "AGENTS.md")
    rule_dir = output / ".dsh" / "rules-1c"
    rules = sorted(rule_dir.glob("*.md"))
    if len(rules) != expected_rules:
        failures.append("expected {0} rules, found {1}".format(expected_rules, len(rules)))
    refs = set(re.findall(r"`\.dsh/rules-1c/([A-Za-z0-9_-]+)\.md`", agents))
    missing = sorted(name for name in refs if not (rule_dir / (name + ".md")).is_file())
    if missing:
        failures.append("Rule Index references missing files: " + ", ".join(missing))
    if re.search(r"\{\{[A-Za-z0-9_]+\}\}", agents):
        failures.append("AGENTS.md contains unresolved placeholders")
    all_markdown = [output / "AGENTS.md", *rules]
    leftovers = []
    for path in all_markdown:
        text = read_text(path)
        if re.search(r"(?<![A-Za-z0-9_.-])rules/[A-Za-z0-9_-]+\.md", text) or ".claude/skills/" in text:
            leftovers.append(str(path.relative_to(output)).replace("\\", "/"))
    if leftovers:
        failures.append("target-dependent paths remain in: " + ", ".join(leftovers[:10]))
    return failures


def render(args: argparse.Namespace) -> int:
    source = args.source.resolve()
    project = args.project.resolve()
    output = args.output.resolve()
    if output.exists():
        raise RenderError("output already exists; use a fresh staging directory: {0}".format(output))
    output.mkdir(parents=True)

    bindings = read_json(args.bindings.resolve())
    values = bindings.get("placeholders")
    if not isinstance(values, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in values.items()):
        raise RenderError("bindings.placeholders must be a string map")
    missing_values = sorted(REQUIRED_PLACEHOLDERS - set(values))
    if missing_values:
        raise RenderError("missing bindings placeholders: " + ", ".join(missing_values))

    composition = load_composition(source, args.profile)
    rules, meta, overrides = collect_rules(source, project, bindings)
    for name, body in rules.items():
        write_text(output / ".dsh" / "rules-1c" / (name + ".md"), body)
    agents = render_agents(source, values, render_index(meta), parse_roles(source))
    write_text(output / "AGENTS.md", agents)

    user_rules = project / "USER-RULES.md"
    if user_rules.is_file():
        user_target = "USER-RULES.md" if args.replace_user_rules else "USER-RULES.proposed.md"
        write_text(output / user_target, transform_paths(read_text(user_rules)))

    if args.skip_skills:
        skill_names, skill_files, collisions = [], 0, []
    else:
        skill_names, skill_files = copy_skills(source, output)
        collisions = sorted(set(skill_names) & existing_skill_names(project))
    mcp = mcp_inventory(project, composition, bindings, args.skip_mcp)
    failures = verify_output(output, len(rules))
    probe = instruction_probe(output, project, args.dsh_bundle.resolve() if args.dsh_bundle else None,
                              int(composition["target"]["limits"]["instruction_bytes"]))
    if probe.get("status") == "fail":
        failures.append("DSH instruction probe omitted or truncated files")

    managed = [output / "AGENTS.md"]
    if args.replace_user_rules and (output / "USER-RULES.md").is_file():
        managed.append(output / "USER-RULES.md")
    managed.extend(sorted((output / ".dsh" / "rules-1c").glob("*.md")))
    managed.extend(sorted(path for path in (output / ".dsh" / "skills").rglob("*") if path.is_file()))
    state = git_state(source)
    manifest = {
        "schema_version": 1,
        "source_version": read_text(source / "VERSION").strip(),
        "source_revision": state["revision"],
        "source_dirty": state["dirty"],
        "composition": {
            "stack": "1c", "project_layer": "common",
            "profile": args.profile, "target": "dsh-deepseek",
        },
        "files": {
            str(path.relative_to(output)).replace("\\", "/"): sha256(path)
            for path in managed
        },
    }
    write_text(output / ".airules-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    write_text(output / ".airules-mcp-plan.json", json.dumps(mcp, ensure_ascii=False, indent=2) + "\n")
    collision_blocked = bool(collisions) and not args.accept_skill_collisions
    plan = {
        "status": "failed" if failures else ("blocked-for-apply" if collision_blocked or mcp["blockers"] else "ready-for-review"),
        "project": str(project),
        "output": str(output),
        "rules": len(rules),
        "project_rule_overrides": overrides,
        "skills": len(skill_names),
        "skills_status": "skipped" if args.skip_skills else "staged",
        "skill_files": skill_files,
        "skill_collisions": collisions,
        "skill_collision_action": (
            "backup-and-disable-higher-priority" if collisions and args.accept_skill_collisions
            else "blocked" if collisions else "none"
        ),
        "instruction_probe": probe,
        "mcp_status": mcp["status"],
        "mcp_blockers": mcp["blockers"],
        "verification_failures": failures,
        "apply_implemented": False,
    }
    write_text(output / ".airules-render-plan.json", json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 1 if failures else 0


def verify(args: argparse.Namespace) -> int:
    output = args.output.resolve()
    manifest = read_json(output / ".airules-manifest.json")
    rules = list((output / ".dsh" / "rules-1c").glob("*.md"))
    failures = verify_output(output, len(rules))
    for relative, expected in manifest.get("files", {}).items():
        path = safe_relative(output, relative, "manifest file")
        if not path.is_file() or sha256(path) != expected:
            failures.append("manifest hash mismatch: " + relative)
    for failure in failures:
        print("FAIL " + failure)
    if not failures:
        print("PASS DSH candidate: {0} rules, manifest hashes match".format(len(rules)))
    return 1 if failures else 0


def apply_candidate(args: argparse.Namespace) -> int:
    project = args.project.resolve()
    candidate = args.candidate.resolve()
    if args.confirm != project.name:
        raise RenderError("--confirm must equal target directory name '{0}'".format(project.name))
    plan = read_json(candidate / ".airules-render-plan.json")
    if plan.get("status") != "ready-for-review":
        raise RenderError("candidate is not ready-for-review: {0}".format(plan.get("status")))
    manifest = read_json(candidate / ".airules-manifest.json")
    if manifest.get("source_dirty") and not args.allow_dirty_source:
        raise RenderError("candidate source is dirty; pass --allow-dirty-source explicitly")
    managed = manifest.get("files")
    if not isinstance(managed, dict) or not managed:
        raise RenderError("candidate manifest has no managed files")

    old_manifest_path = project / ".airules-manifest.json"
    old_manifest = read_json(old_manifest_path) if old_manifest_path.is_file() else None
    old_files = old_manifest.get("files", {}) if isinstance(old_manifest, dict) else {}
    conflicts = []
    for relative, expected in managed.items():
        source = safe_relative(candidate, relative, "candidate file")
        target = safe_relative(project, relative, "target file")
        if not source.is_file() or sha256(source) != expected:
            raise RenderError("candidate hash mismatch: {0}".format(relative))
        if not target.exists():
            continue
        previous_hash = old_files.get(relative)
        if previous_hash is not None:
            if sha256(target) != previous_hash:
                conflicts.append(relative + " (changed since previous airules apply)")
        elif relative in ("AGENTS.md", "USER-RULES.md") and args.adopt_existing_instructions:
            continue
        else:
            conflicts.append(relative + " (existing unmanaged file)")
    if conflicts:
        raise RenderError("apply conflicts: " + "; ".join(conflicts[:12]))

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = args.backup_root.resolve() / project.name / stamp
    if backup.exists():
        raise RenderError("backup directory already exists: {0}".format(backup))
    backup.mkdir(parents=True)
    records: Dict[str, Any] = {}
    for relative, applied_hash in managed.items():
        target = safe_relative(project, relative, "target file")
        record = {"existed": target.is_file(), "applied_hash": applied_hash}
        if target.is_file():
            backup_file = safe_relative(backup, "files/" + relative, "backup file")
            backup_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup_file)
            record["original_hash"] = sha256(target)
            record["backup"] = str(backup_file.relative_to(backup)).replace("\\", "/")
        records[relative] = record

    manifest_record: Dict[str, Any] = {"existed": old_manifest_path.is_file()}
    if old_manifest_path.is_file():
        saved_manifest = backup / "previous-airules-manifest.json"
        shutil.copy2(old_manifest_path, saved_manifest)
        manifest_record.update({
            "original_hash": sha256(old_manifest_path),
            "backup": saved_manifest.name,
        })

    shadowed_skills: Dict[str, Any] = {}
    if plan.get("skill_collision_action") == "backup-and-disable-higher-priority":
        for name in plan.get("skill_collisions", []):
            skill = safe_relative(project, ".agents/skills/" + name, "shadowed skill")
            if not skill.is_dir():
                continue
            saved = safe_relative(backup, "shadowed-skills/.agents/skills/" + name, "skill backup")
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(skill, saved)
            shadowed_skills[name] = {
                "source": str(skill.relative_to(project)).replace("\\", "/"),
                "backup": str(saved.relative_to(backup)).replace("\\", "/"),
            }
            shutil.rmtree(skill)

    for relative in sorted(managed):
        source = safe_relative(candidate, relative, "candidate file")
        target = safe_relative(project, relative, "target file")
        atomic_write_bytes(target, source.read_bytes())

    applied_manifest = dict(manifest)
    applied_manifest["applied_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    applied_manifest["backup"] = str(backup)
    atomic_write_bytes(
        old_manifest_path,
        (json.dumps(applied_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    manifest_record["applied_hash"] = sha256(old_manifest_path)
    backup_manifest = {
        "schema_version": 1,
        "project": str(project),
        "candidate": str(candidate),
        "files": records,
        "airules_manifest": manifest_record,
        "shadowed_skills": shadowed_skills,
    }
    write_text(backup / "backup-manifest.json", json.dumps(backup_manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "status": "applied",
        "project": str(project),
        "files": len(managed),
        "backup": str(backup),
    }, ensure_ascii=False, indent=2))
    return 0


def rollback(args: argparse.Namespace) -> int:
    project = args.project.resolve()
    backup = args.backup.resolve()
    if args.confirm != project.name:
        raise RenderError("--confirm must equal target directory name '{0}'".format(project.name))
    data = read_json(backup / "backup-manifest.json")
    if Path(data.get("project", "")).resolve() != project:
        raise RenderError("backup belongs to another project")
    files = data.get("files", {})
    conflicts = []
    for relative, record in files.items():
        target = safe_relative(project, relative, "target file")
        if not target.is_file() or sha256(target) != record.get("applied_hash"):
            conflicts.append(relative)
    manifest_path = project / ".airules-manifest.json"
    manifest_record = data.get("airules_manifest", {})
    if not manifest_path.is_file() or sha256(manifest_path) != manifest_record.get("applied_hash"):
        conflicts.append(".airules-manifest.json")
    for name, record in data.get("shadowed_skills", {}).items():
        target = safe_relative(project, record["source"], "shadowed skill")
        if target.exists():
            conflicts.append(record["source"] + " (shadowed skill path recreated)")
    if conflicts:
        raise RenderError("rollback refused; applied files changed: " + ", ".join(conflicts[:12]))

    for relative, record in files.items():
        target = safe_relative(project, relative, "target file")
        if record.get("existed"):
            saved = safe_relative(backup, record["backup"], "backup file")
            atomic_write_bytes(target, saved.read_bytes())
        else:
            target.unlink()
    if manifest_record.get("existed"):
        saved_manifest = safe_relative(backup, manifest_record["backup"], "manifest backup")
        atomic_write_bytes(manifest_path, saved_manifest.read_bytes())
    else:
        manifest_path.unlink()
    for name, record in data.get("shadowed_skills", {}).items():
        target = safe_relative(project, record["source"], "shadowed skill")
        saved = safe_relative(backup, record["backup"], "skill backup")
        shutil.copytree(saved, target)
    print(json.dumps({
        "status": "rolled-back",
        "project": str(project),
        "backup": str(backup),
    }, ensure_ascii=False, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="stage an airules DSH target")
    commands = result.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("render")
    stage.add_argument("--source", type=Path, required=True)
    stage.add_argument("--project", type=Path, required=True)
    stage.add_argument("--profile", default="s0lo")
    stage.add_argument("--bindings", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)
    stage.add_argument("--dsh-bundle", type=Path)
    stage.add_argument("--skip-mcp", action="store_true")
    stage.add_argument("--skip-skills", action="store_true")
    stage.add_argument("--accept-skill-collisions", action="store_true")
    stage.add_argument("--replace-user-rules", action="store_true")
    check = commands.add_parser("verify")
    check.add_argument("--output", type=Path, required=True)
    apply_parser = commands.add_parser("apply")
    apply_parser.add_argument("--project", type=Path, required=True)
    apply_parser.add_argument("--candidate", type=Path, required=True)
    apply_parser.add_argument("--backup-root", type=Path, required=True)
    apply_parser.add_argument("--confirm", required=True)
    apply_parser.add_argument("--allow-dirty-source", action="store_true")
    apply_parser.add_argument("--adopt-existing-instructions", action="store_true")
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--project", type=Path, required=True)
    rollback_parser.add_argument("--backup", type=Path, required=True)
    rollback_parser.add_argument("--confirm", required=True)
    return result


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "render":
            return render(args)
        if args.command == "verify":
            return verify(args)
        if args.command == "apply":
            return apply_candidate(args)
        return rollback(args)
    except RenderError as exc:
        print("renderer: ERROR: {0}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
