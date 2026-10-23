from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

WORKSPACE = Path(__file__).resolve().parents[2]
BASE = Path(sys.argv[1]).resolve()
INTERPRETER = BASE / "interpreters/cpython-3.11.14-macos-aarch64-none/bin/python3.11"
ROOT = BASE / "runtime-final"
OUT = BASE / "final-evidence"
OUT.mkdir(exist_ok=True)
records = []


def run(name: str, argv: list[str], expected: int = 0, contains: str = "", timeout: int = 240) -> None:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                            env={"PATH": "/usr/bin:/bin", "HOME": str(BASE), "PYTHONDONTWRITEBYTECODE": "1"})
    (OUT / (name + ".log")).write_text(result.stdout + result.stderr)
    passed = (result.returncode == 0 if expected == 0 else result.returncode != 0) and contains in result.stdout + result.stderr
    records.append({"scenario": name, "argv": argv, "exit": result.returncode, "expected": expected,
                    "requiredOutput": contains, "passed": passed, "log": name + ".log"})
    (OUT / "native-commands.json").write_text(json.dumps(records, indent=2)+"\n")
    assert passed, name


bootstrap = WORKSPACE / "scripts/qa/bootstrap-native-fixture.py"
run("clean-bootstrap", [str(INTERPRETER), "-I", str(bootstrap), "--root", str(ROOT / "python")], contains='"event": "bootstrapped"')
python = ROOT / "python/bin/python"
for script in ("native_fixture_acceptance", "native_fixture_guard_probe", "native_fixture_timeout_probe"):
    run(script, [str(python), "-I", str(WORKSPACE / ("scripts/qa/" + script + ".py")), str(ROOT)], contains='"pass": true')
server = WORKSPACE / "scripts/qa/native-kanban-fixture.py"
run("wrong-python", ["/usr/bin/python3", "-I", str(bootstrap), "--root", str(BASE / "wrong-python/python")], 1, "exact Python 3.11.14")
run("real-home", [str(INTERPRETER), "-I", str(bootstrap), "--root", "/Users/beomsu/.hermes/python"], 1, "owned temporary")
run("missing-token", [str(python), "-I", str(server), "--root", str(ROOT)], 1, "in-memory fixture token")
package = ROOT / "python/lib/python3.11/site-packages/fastapi"
hidden = package.with_name("fastapi.hidden")
package.rename(hidden)
try:
    run("missing-dependency", [str(python), "-I", str(server), "--root", str(ROOT), "--smoke"], 1, "No module named 'fastapi'")
finally:
    hidden.rename(package)
receipt = ROOT / "python/fixture-environment.json"
original = receipt.read_bytes()
stale = json.loads(original)
stale["lockSha256"] = "0" * 64
receipt.write_text(json.dumps(stale))
try:
    run("stale-lock", [str(python), "-I", str(server), "--root", str(ROOT), "--smoke"], 1, "dependency lock changed")
finally:
    receipt.write_bytes(original)
copy = BASE / "tamper-workspace"
shutil.copytree(WORKSPACE, copy)
try:
    source = copy / "tests/fixtures/native-kanban/source/plugins/kanban/dashboard/plugin_api.py"
    source.write_bytes(source.read_bytes() + b"\n# synthetic hash tamper probe\n")
    run("source-tamper", [str(python), "-I", str(copy / "scripts/qa/native-kanban-fixture.py"), "--root", str(ROOT), "--smoke"], 1, "pinned source hash mismatch")
    shutil.copyfile(WORKSPACE / "tests/fixtures/native-kanban/source/plugins/kanban/dashboard/plugin_api.py", source)
    lock = copy / "tests/fixtures/native-kanban/requirements.lock"
    lock.write_text(re.sub(r"sha256:[0-9a-f]{64}", "sha256:" + "0" * 64, lock.read_text()))
    run("pip-hash-tamper", [str(INTERPRETER), "-I", str(copy / "scripts/qa/bootstrap-native-fixture.py"), "--root", str(BASE / "hash-failure/python")], 1, "DO NOT MATCH THE HASHES")
finally:
    shutil.rmtree(copy)
    shutil.rmtree(BASE / "hash-failure", ignore_errors=True)
for folder in (ROOT / "evidence", ROOT / "python"):
    for path in folder.glob("*.json"):
        shutil.copyfile(path, OUT / path.name)
manifest = json.loads((WORKSPACE / "tests/fixtures/native-kanban/source-manifest.json").read_text())
source_checks = []
for entry in manifest["files"]:
    live = Path(manifest["sourceRoot"]) / entry["path"]
    fixture = WORKSPACE / "tests/fixtures/native-kanban/source" / entry["path"]
    item = {"path": entry["path"], "pinned": entry["sha256"],
            "transferred": hashlib.sha256(fixture.read_bytes()).hexdigest(),
            "liveAfter": hashlib.sha256(live.read_bytes()).hexdigest()}
    assert item["pinned"] == item["transferred"] == item["liveAfter"], item
    source_checks.append(item)
(OUT / "native-source-verification.json").write_text(json.dumps(source_checks, indent=2)+"\n")
print(json.dumps({"pass": True, "scenarios": len(records), "retainedRoot": str(ROOT), "evidence": str(OUT)}))
