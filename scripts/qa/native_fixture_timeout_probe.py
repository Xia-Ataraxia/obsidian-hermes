from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import owned_root
from scripts.qa.native_fixture_process import run_owned

root = owned_root(sys.argv[1])
marker = root / "hung-provisioner.pid"
program = "import os,pathlib,threading; pathlib.Path(" + repr(str(marker)) + ").write_text(str(os.getpid())); threading.Event().wait()"
started = time.monotonic()
try:
    run_owned([sys.executable, "-I", "-c", program], {"PATH": "/usr/bin:/bin"}, 2)
except subprocess.TimeoutExpired:
    elapsed = time.monotonic() - started
else:
    raise AssertionError("hung provisioner did not time out")
pid = int(marker.read_text())
try:
    os.kill(pid, 0)
except ProcessLookupError:
    dead = True
else:
    raise AssertionError("hung provisioner survived timeout")
marker.unlink()
assert elapsed < 6
(root / "evidence/native-timeout.json").write_text(json.dumps({"timeoutSeconds": 2, "elapsedSeconds": elapsed,
                                                            "startedPid": pid, "processGone": dead}, indent=2)+"\n")
print(json.dumps({"pass": True}))
