#!/usr/bin/env python3
"""Load and resolve airules distribution compositions.

The distribution is assembled along four independent axes:

* a common project layer;
* a stack overlay;
* a user/distribution profile;
* a runtime target.

Declarations are JSON on purpose: the resolver stays dependency-free on
Python 3.9+ and the exact input consumed by CI is unambiguous.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


SCHEMA_VERSION = 1
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class CompositionError(ValueError):
    """A declaration or requested composition is invalid."""


@dataclass(frozen=True)
class Declaration:
    kind: str
    path: Path
    data: Mapping[str, Any]


@dataclass(frozen=True)
class Catalog:
    root: Path
    layers: Mapping[str, Declaration]
    profiles: Mapping[str, Declaration]
    targets: Mapping[str, Declaration]


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            value = json.load(stream)
    except OSError as exc:
        raise CompositionError("cannot read {0}: {1}".format(path, exc)) from exc
    except json.JSONDecodeError as exc:
        raise CompositionError(
            "invalid JSON in {0}:{1}:{2}: {3}".format(
                path, exc.lineno, exc.colno, exc.msg
            )
        ) from exc
    if not isinstance(value, dict):
        raise CompositionError("{0}: top-level JSON value must be an object".format(path))
    return value


def _require_keys(data: Mapping[str, Any], keys: Iterable[str], where: Path) -> None:
    missing = sorted(key for key in keys if key not in data)
    if missing:
        raise CompositionError(
            "{0}: missing required keys: {1}".format(where, ", ".join(missing))
        )


def _require_type(
    data: Mapping[str, Any], key: str, expected: Any, where: Path
) -> Any:
    value = data[key]
    if not isinstance(value, expected):
        names = expected if isinstance(expected, tuple) else (expected,)
        label = " or ".join(item.__name__ for item in names)
        raise CompositionError(
            "{0}: '{1}' must be {2}, got {3}".format(
                where, key, label, type(value).__name__
            )
        )
    return value


def _validate_common(data: Mapping[str, Any], where: Path) -> str:
    _require_keys(data, ("schema_version", "id"), where)
    if data["schema_version"] != SCHEMA_VERSION:
        raise CompositionError(
            "{0}: schema_version must be {1}".format(where, SCHEMA_VERSION)
        )
    identifier = _require_type(data, "id", str, where)
    if not ID_RE.fullmatch(identifier):
        raise CompositionError(
            "{0}: invalid id '{1}'; use lowercase kebab-case".format(where, identifier)
        )
    return identifier


def _validate_string_list(data: Mapping[str, Any], key: str, where: Path) -> List[str]:
    values = _require_type(data, key, list, where)
    if any(not isinstance(value, str) or not value.strip() for value in values):
        raise CompositionError(
            "{0}: '{1}' must contain non-empty strings only".format(where, key)
        )
    return values


def _validate_logical_servers(data: Mapping[str, Any], where: Path) -> None:
    values = _require_type(data, "logical_servers", list, where)
    required = ("role", "selector", "access", "required")
    roles = set()
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            raise CompositionError(
                "{0}: mcp.logical_servers[{1}] must be an object".format(where, index)
            )
        _require_keys(value, required, where)
        for key in ("role", "selector", "access"):
            if not isinstance(value[key], str) or not value[key].strip():
                raise CompositionError(
                    "{0}: mcp.logical_servers[{1}].{2} must be a non-empty string".format(
                        where, index, key
                    )
                )
        if not isinstance(value["required"], bool):
            raise CompositionError(
                "{0}: mcp.logical_servers[{1}].required must be bool".format(
                    where, index
                )
            )
        if value["role"] in roles:
            raise CompositionError(
                "{0}: duplicate mcp.logical_servers role '{1}'".format(
                    where, value["role"]
                )
            )
        roles.add(value["role"])


def _safe_repo_ref(root: Path, raw: str, where: Path, field: str, stack: str) -> Path:
    expanded = raw.replace("{stack}", stack)
    if "{" in expanded or "}" in expanded:
        raise CompositionError(
            "{0}: unsupported placeholder in {1} reference '{2}'".format(
                where, field, raw
            )
        )
    candidate = Path(expanded)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise CompositionError(
            "{0}: {1} reference must stay inside repository: '{2}'".format(
                where, field, raw
            )
        )
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise CompositionError(
            "{0}: {1} reference escapes repository: '{2}'".format(where, field, raw)
        ) from exc
    return resolved


def _validate_refs(
    root: Path, values: Sequence[str], where: Path, field: str, stack: str
) -> None:
    for raw in values:
        path = _safe_repo_ref(root, raw, where, field, stack)
        if not path.exists():
            raise CompositionError(
                "{0}: {1} reference does not exist: '{2}'".format(where, field, raw)
            )


def _validate_layer(root: Path, path: Path, data: Mapping[str, Any], stack: str) -> str:
    identifier = _validate_common(data, path)
    _require_keys(data, ("content_roots", "template_roots", "defaults"), path)
    content = _validate_string_list(data, "content_roots", path)
    templates = _validate_string_list(data, "template_roots", path)
    _require_type(data, "defaults", dict, path)
    expected = path.parent.name
    if identifier != expected:
        raise CompositionError(
            "{0}: layer id '{1}' must match directory '{2}'".format(
                path, identifier, expected
            )
        )
    _validate_refs(root, content, path, "content_roots", stack)
    _validate_refs(root, templates, path, "template_roots", stack)
    return identifier


def _validate_profile(path: Path, data: Mapping[str, Any]) -> str:
    identifier = _validate_common(data, path)
    _require_keys(
        data,
        ("extends", "portable", "capabilities", "mcp"),
        path,
    )
    extends = data["extends"]
    if extends is not None and (not isinstance(extends, str) or not ID_RE.fullmatch(extends)):
        raise CompositionError(
            "{0}: 'extends' must be null or a profile id".format(path)
        )
    _require_type(data, "portable", bool, path)
    capabilities = _require_type(data, "capabilities", dict, path)
    _require_keys(capabilities, ("required", "optional"), path)
    required_capabilities = _validate_string_list(capabilities, "required", path)
    optional_capabilities = _validate_string_list(capabilities, "optional", path)
    overlap = sorted(set(required_capabilities) & set(optional_capabilities))
    if overlap:
        raise CompositionError(
            "{0}: capabilities cannot be both required and optional: {1}".format(
                path, ", ".join(overlap)
            )
        )
    mcp = _require_type(data, "mcp", dict, path)
    _require_keys(mcp, ("selection", "logical_servers"), path)
    _require_type(mcp, "selection", str, path)
    _validate_logical_servers(mcp, path)
    expected = path.parent.name
    if identifier != expected:
        raise CompositionError(
            "{0}: profile id '{1}' must match directory '{2}'".format(
                path, identifier, expected
            )
        )
    return identifier


def _target_id_from_path(root: Path, path: Path) -> str:
    relative = path.parent.relative_to(root / "targets")
    return "-".join(relative.parts)


def _validate_target(root: Path, path: Path, data: Mapping[str, Any], stack: str) -> str:
    identifier = _validate_common(data, path)
    _require_keys(
        data,
        (
            "instruction_files",
            "local_instruction_files",
            "layout",
            "renderer",
            "status",
            "renderer_status",
            "environment",
            "mcp",
        ),
        path,
    )
    _validate_string_list(data, "instruction_files", path)
    _validate_string_list(data, "local_instruction_files", path)
    _require_type(data, "layout", str, path)
    renderer = _require_type(data, "renderer", str, path)
    if not ID_RE.fullmatch(renderer):
        raise CompositionError(
            "{0}: 'renderer' must be a lowercase kebab-case renderer id".format(path)
        )
    status = _require_type(data, "status", str, path)
    if status not in ("stable", "experimental"):
        raise CompositionError(
            "{0}: status must be 'stable' or 'experimental'".format(path)
        )
    renderer_status = _require_type(data, "renderer_status", str, path)
    if renderer_status not in ("implemented", "pending"):
        raise CompositionError(
            "{0}: renderer_status must be 'implemented' or 'pending'".format(path)
        )
    if status == "stable" and renderer_status != "implemented":
        raise CompositionError(
            "{0}: a stable target must have an implemented renderer".format(path)
        )
    environment = _require_type(data, "environment", dict, path)
    if any(not isinstance(key, str) or not key.strip()
           or not isinstance(value, str) or not value.strip()
           for key, value in environment.items()):
        raise CompositionError(
            "{0}: environment keys and values must be non-empty strings".format(path)
        )
    if "limits" in data:
        limits = _require_type(data, "limits", dict, path)
        if any(not isinstance(key, str) or not key.strip()
               or not isinstance(value, int) or isinstance(value, bool) or value <= 0
               for key, value in limits.items()):
            raise CompositionError(
                "{0}: limits must contain positive integer values".format(path)
            )
    if "artifacts" in data:
        artifacts = _require_type(data, "artifacts", dict, path)
        for name, raw in artifacts.items():
            if not isinstance(name, str) or not name.strip() or not isinstance(raw, str) or not raw.strip():
                raise CompositionError(
                    "{0}: artifacts keys and values must be non-empty strings".format(path)
                )
            artifact = Path(raw)
            if artifact.is_absolute() or ".." in artifact.parts:
                raise CompositionError(
                    "{0}: artifact path must stay inside target project: '{1}'".format(path, raw)
                )
    mcp = _require_type(data, "mcp", dict, path)
    _require_keys(mcp, ("import_project_config", "allowlist_required"), path)
    _require_type(mcp, "import_project_config", bool, path)
    _require_type(mcp, "allowlist_required", bool, path)
    expected = _target_id_from_path(root, path)
    if identifier != expected:
        raise CompositionError(
            "{0}: target id '{1}' must match path id '{2}'".format(
                path, identifier, expected
            )
        )
    refs = [data["layout"]]
    if "model_profile" in data:
        if not isinstance(data["model_profile"], str):
            raise CompositionError("{0}: 'model_profile' must be a string".format(path))
        refs.append(data["model_profile"])
    if "environment_template" in data:
        if not isinstance(data["environment_template"], str):
            raise CompositionError("{0}: 'environment_template' must be a string".format(path))
        refs.append(data["environment_template"])
    if "renderer_entry" in data:
        if not isinstance(data["renderer_entry"], str):
            raise CompositionError("{0}: 'renderer_entry' must be a string".format(path))
        refs.append(data["renderer_entry"])
    _validate_refs(root, refs, path, "target", stack)
    return identifier


def _discover(root: Path, pattern: str) -> List[Path]:
    return sorted(path for path in root.glob(pattern) if path.is_file())


def load_catalog(repo_root: Optional[Path] = None, stack: str = "1c") -> Catalog:
    """Load and validate every layer, profile and target declaration."""

    root = Path(repo_root or Path(__file__).resolve().parents[1]).resolve()
    if not ID_RE.fullmatch(stack):
        raise CompositionError("invalid stack id '{0}'".format(stack))

    layers: Dict[str, Declaration] = {}
    profiles: Dict[str, Declaration] = {}
    targets: Dict[str, Declaration] = {}

    def add(registry: Dict[str, Declaration], declaration: Declaration) -> None:
        identifier = declaration.data["id"]
        if identifier in registry:
            raise CompositionError(
                "duplicate {0} id '{1}': {2} and {3}".format(
                    declaration.kind,
                    identifier,
                    registry[identifier].path,
                    declaration.path,
                )
            )
        registry[identifier] = declaration

    for path in _discover(root, "project-layer/*/layer.json"):
        data = _read_json(path)
        identifier = _validate_layer(root, path, data, stack)
        add(layers, Declaration("project-layer", path, data))
        assert identifier in layers

    for path in _discover(root, "profiles/*/profile.json"):
        data = _read_json(path)
        identifier = _validate_profile(path, data)
        add(profiles, Declaration("profile", path, data))
        assert identifier in profiles

    for path in _discover(root, "targets/**/target.json"):
        data = _read_json(path)
        identifier = _validate_target(root, path, data, stack)
        add(targets, Declaration("target", path, data))
        assert identifier in targets

    if not layers:
        raise CompositionError("no project-layer/*/layer.json declarations found")
    if not profiles:
        raise CompositionError("no profiles/*/profile.json declarations found")
    if not targets:
        raise CompositionError("no targets/**/target.json declarations found")

    catalog = Catalog(root=root, layers=layers, profiles=profiles, targets=targets)
    _validate_profile_graph(catalog)
    return catalog


def _validate_profile_graph(catalog: Catalog) -> None:
    states: Dict[str, int] = {}
    trail: List[str] = []

    def visit(identifier: str) -> None:
        state = states.get(identifier, 0)
        if state == 2:
            return
        if state == 1:
            start = trail.index(identifier)
            cycle = trail[start:] + [identifier]
            raise CompositionError(
                "profile inheritance cycle: {0}".format(" -> ".join(cycle))
            )
        states[identifier] = 1
        trail.append(identifier)
        parent = catalog.profiles[identifier].data.get("extends")
        if parent is not None:
            if parent not in catalog.profiles:
                raise CompositionError(
                    "profile '{0}' extends unknown profile '{1}'".format(identifier, parent)
                )
            visit(parent)
        trail.pop()
        states[identifier] = 2

    for identifier in sorted(catalog.profiles):
        visit(identifier)


def _merge(parent: Any, child: Any) -> Any:
    """Deep merge declarations; lists are stable additive sets."""

    if isinstance(parent, dict) and isinstance(child, dict):
        result = copy.deepcopy(parent)
        for key, value in child.items():
            result[key] = _merge(result[key], value) if key in result else copy.deepcopy(value)
        return result
    if isinstance(parent, list) and isinstance(child, list):
        result = copy.deepcopy(parent)
        for value in child:
            if value not in result:
                result.append(copy.deepcopy(value))
        return result
    return copy.deepcopy(child)


def _merge_profiles(parent: Mapping[str, Any], child: Mapping[str, Any]) -> Dict[str, Any]:
    """Merge profile inheritance with capability and MCP semantics.

    Required capabilities promote inherited optional ones. Logical MCP
    servers are keyed by role, so a child replaces a parent's binding instead
    of creating two contradictory entries.
    """

    parent_servers = parent.get("mcp", {}).get("logical_servers", [])
    child_servers = child.get("mcp", {}).get("logical_servers", [])
    result = _merge(dict(parent), dict(child))

    servers: List[Dict[str, Any]] = []
    by_role: Dict[str, int] = {}
    for server in list(parent_servers) + list(child_servers):
        role = server["role"]
        copied = copy.deepcopy(server)
        if role in by_role:
            servers[by_role[role]] = copied
        else:
            by_role[role] = len(servers)
            servers.append(copied)
    result.setdefault("mcp", {})["logical_servers"] = servers

    capabilities = result.setdefault("capabilities", {})
    required = list(dict.fromkeys(capabilities.get("required", [])))
    required_set = set(required)
    optional = [
        value for value in dict.fromkeys(capabilities.get("optional", []))
        if value not in required_set
    ]
    capabilities["required"] = required
    capabilities["optional"] = optional
    return result


def resolve_profile(catalog: Catalog, profile_id: str) -> Tuple[Dict[str, Any], List[str]]:
    if profile_id not in catalog.profiles:
        raise CompositionError("unknown profile '{0}'".format(profile_id))
    chain: List[str] = []

    def resolve(identifier: str) -> Dict[str, Any]:
        declaration = catalog.profiles[identifier]
        parent_id = declaration.data.get("extends")
        value: Dict[str, Any] = {}
        if parent_id is not None:
            value = resolve(parent_id)
        chain.append(identifier)
        return _merge_profiles(value, dict(declaration.data))

    resolved = resolve(profile_id)
    resolved["id"] = profile_id
    resolved["inheritance_chain"] = chain
    return resolved, chain


def _expanded_layer(data: Mapping[str, Any], stack: str) -> Dict[str, Any]:
    result = copy.deepcopy(dict(data))
    for key in ("content_roots", "template_roots"):
        result[key] = [value.replace("{stack}", stack) for value in result[key]]
    return result


def resolve_composition(
    catalog: Catalog,
    target_id: str,
    profile_id: str,
    stack: str = "1c",
    layer_id: str = "common",
) -> Dict[str, Any]:
    """Return a fully resolved, JSON-serialisable composition."""

    if layer_id not in catalog.layers:
        raise CompositionError("unknown project layer '{0}'".format(layer_id))
    if target_id not in catalog.targets:
        raise CompositionError("unknown target '{0}'".format(target_id))
    if not ID_RE.fullmatch(stack):
        raise CompositionError("invalid stack id '{0}'".format(stack))

    profile, chain = resolve_profile(catalog, profile_id)
    layer = _expanded_layer(catalog.layers[layer_id].data, stack)
    target = copy.deepcopy(dict(catalog.targets[target_id].data))
    return {
        "schema_version": SCHEMA_VERSION,
        "stack": stack,
        "project_layer": layer,
        "profile": profile,
        "target": target,
        "sources": {
            "project_layer": str(catalog.layers[layer_id].path.relative_to(catalog.root)).replace("\\", "/"),
            "profiles": [
                str(catalog.profiles[item].path.relative_to(catalog.root)).replace("\\", "/")
                for item in chain
            ],
            "target": str(catalog.targets[target_id].path.relative_to(catalog.root)).replace("\\", "/"),
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="resolve an airules composition")
    parser.add_argument("--root", type=Path, help="repository root")
    parser.add_argument("--target", default="claude")
    parser.add_argument("--profile", default="public")
    parser.add_argument("--stack", default="1c")
    parser.add_argument("--layer", default="common")
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog(args.root, args.stack)
        resolved = resolve_composition(
            catalog, args.target, args.profile, args.stack, args.layer
        )
    except CompositionError as exc:
        print("composition: ERROR: {0}".format(exc), file=sys.stderr)
        return 1
    print(json.dumps(resolved, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
