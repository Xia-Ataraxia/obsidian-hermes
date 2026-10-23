# /// script
# requires-python = "==3.11.14"
# dependencies = []
# ///
# How to run: python3.11 scripts/qa/bootstrap-native-fixture.py --root <fixture-root>/python
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

if sys.version_info[:3] != (3, 11, 14):
    raise RuntimeError("exact Python 3.11.14 is required")

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import FIXTURE, FixtureRefusal, owned_root, verify_source
from scripts.qa.native_fixture_process import run_owned


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    if sys.version_info[:3] != (3, 11, 14):
        raise FixtureRefusal("exact Python 3.11.14 is required")
    root = owned_root(args.root)
    if root.name != "python":
        raise FixtureRefusal("owned fixture venv must be named python")
    source_digest = verify_source()
    if root.exists():
        raise FixtureRefusal("bootstrap requires a new empty owned venv path")
    root.parent.mkdir(parents=True, exist_ok=True)
    environment = {"HOME": str(root.parent), "PATH": "/usr/bin:/bin", "TMPDIR": str(root.parent), "PYTHONNOUSERSITE": "1"}
    if sys.platform == "linux" and os.environ.get("CI") == "true":
        environment["CI"] = "true"
    run_owned([sys.executable, "-I", "-m", "venv", "--symlinks", str(root)], environment, 60)
    python = root / "bin/python"
    lock = FIXTURE / "requirements.lock"
    run_owned([str(python), "-I", "-m", "pip", "--isolated", "install", "--require-hashes",
                    "--only-binary=:all:", "--no-cache-dir", "--no-deps", "-r", str(lock)],
                   environment, 180)
    run_owned([str(python), "-I", "-m", "pip", "check"], environment, 30)
    receipt = root / "fixture-environment.json"
    receipt.write_text(json.dumps({"python": "3.11.14", "root": str(root),
                                  "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
                                  "sourceManifestSha256": source_digest}, indent=2)+"\n")
    run_owned([str(python), "-I", str(Path(__file__).with_name("native-kanban-fixture.py")),
               "--root", str(root.parent), "--smoke"], environment, 30)
    print(json.dumps({"event": "bootstrapped", "root": str(root), "receipt": str(receipt)}), flush=True)


if __name__ == "__main__":
    def cancelled(signum: int, frame: object) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, cancelled)
    main()
