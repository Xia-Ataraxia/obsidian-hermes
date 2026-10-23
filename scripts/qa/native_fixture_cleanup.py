from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import owned_root

base = owned_root(sys.argv[1])
processes = subprocess.check_output(["/bin/ps", "-axo", "pid=,command="], text=True)
survivors = [line.strip() for line in processes.splitlines()
             if str(base) in line and "native-kanban-fixture.py" in line and "ps -axo" not in line]
assert not survivors, survivors
removed = []
for name in ("runtime", "runtime2", "runtime3", "runtime4", "runtime5", "runtime6", "runtime7", "runtime8",
             "runtime-prior-final", "runtime-prior-final2", "uv-cache"):
    path = owned_root(str(base / name))
    if path.exists():
        shutil.rmtree(path)
        removed.append(str(path))
receipt = {"ownedNativeServerProcesses": survivors, "removed": removed,
           "retained": [str(base / name) for name in ("interpreters", "runtime-final", "workspace", "final-evidence")],
           "reason": "Interpreter and native fixture artifacts retained for task3B and later isolated validation; no running server"}
(base / "final-evidence/native-resource-cleanup.json").write_text(json.dumps(receipt, indent=2)+"\n")
print(json.dumps(receipt))
