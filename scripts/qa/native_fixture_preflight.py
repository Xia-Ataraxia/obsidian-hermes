from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import sys
from types import ModuleType

from scripts.qa.native_fixture_guard import SOURCE, FixtureRefusal


def install_native_preflight(root: Path) -> None:
    source = SOURCE / "hermes_state_repair.py"
    tree = ast.parse(source.read_bytes(), filename=str(source))
    functions = {"_rw_or_vanished", "preflight_db_writability"}
    imports = {"contextlib", "logging", "os", "sqlite3", "stat"}
    from_imports = {"__future__", "pathlib", "typing", "hermes_constants"}
    selected: list[ast.stmt] = []
    identities: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in functions:
            selected.append(node)
            identities[node.name] = hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest()
        elif isinstance(node, ast.Import) and all(alias.name in imports for alias in node.names):
            selected.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module in from_imports:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "logger" for target in node.targets):
            selected.append(node)
    if set(identities) != functions:
        raise FixtureRefusal("native preflight definitions missing")
    module = ModuleType("hermes_state")
    module.__file__ = str(source)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), "exec"), module.__dict__)
    sys.modules["hermes_state"] = module
    (root / "python/preflight-provenance.json").write_text(json.dumps({
        "seam": "fixture-only hermes_state facade exposing exact native writability preflight",
        "source": str(source), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "definitionsAstSha256": identities, "nativeBodiesUnmodified": True,
        "omitted": "unrelated session-state and LLM imports; no replacement DB or API"}, indent=2)+"\n")
