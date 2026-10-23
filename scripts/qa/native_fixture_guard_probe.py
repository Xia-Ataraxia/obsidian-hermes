from __future__ import annotations

import importlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import FixtureRefusal, isolate, owned_root, verify_source
from scripts.qa.native_fixture_preflight import install_native_preflight

root = owned_root(sys.argv[1])
results: dict[str, bool] = {}
for raw in ("/Users/beomsu/.hermes", str(root / "Obsidian/fixture")):
    try:
        owned_root(raw)
    except FixtureRefusal:
        results["reject:" + raw] = True
    else:
        raise AssertionError(raw)
with patch("platform.system", return_value="UnsupportedHost"):
    try:
        owned_root(str(root / "wrong-host"))
    except FixtureRefusal:
        results["wrongHostBeforeWrite"] = not (root / "wrong-host").exists()
    else:
        raise AssertionError("wrong host accepted")
link = root / "symlink-root"
link.symlink_to(root, target_is_directory=True)
try:
    owned_root(str(link))
except FixtureRefusal:
    results["symlinkRootRejected"] = True
else:
    raise AssertionError("symlink accepted")
finally:
    link.unlink()
verify_source()
isolate(root)
install_native_preflight(root)
native = importlib.import_module("hermes_state")
writable = root / "home/preflight-probe.db"
writable.write_bytes(b"synthetic")
native.preflight_db_writability(writable)
results["nativeWritableAccepted"] = True
writable.chmod(0o400)
native.preflight_db_writability(writable)
results["nativeReadOnlyWithinHomeRepaired"] = bool(writable.stat().st_mode & 0o200)
outside = root / "outside-home.db"
outside.write_bytes(b"synthetic")
outside.chmod(0o400)
try:
    native.preflight_db_writability(outside)
except sqlite3.OperationalError:
    results["nativeReadOnlyOutsideHomeRefused"] = not bool(outside.stat().st_mode & 0o200)
else:
    raise AssertionError("readonly outside home accepted")
finally:
    outside.chmod(0o600)
    outside.unlink()
    writable.unlink()
marker = root / "spawned-marker"
try:
    subprocess.run(["/usr/bin/touch", str(marker)], check=True)
except FixtureRefusal:
    results["subprocessDeniedBeforeEffect"] = not marker.exists()
else:
    raise AssertionError("spawn accepted")
try:
    Path("/Users/beomsu/.hermes/config.yaml").read_bytes()
except FixtureRefusal:
    results["liveHomeReadDeniedBeforeOpen"] = True
else:
    raise AssertionError("home access accepted")
assert all(results.values())
(root / "evidence/native-guard-probes.json").write_text(json.dumps(results, indent=2)+"\n")
print(json.dumps({"pass": True, "checks": len(results)}))
