# /// script
# requires-python = "==3.11.14"
# dependencies = []
# ///
# How to run: <fixture-root>/python/bin/python -I scripts/qa/verify-native-environment.py --root <fixture-root>/python
from __future__ import annotations

import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import signal
import sys
from types import FrameType

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import FIXTURE, FixtureRefusal, owned_root, verify_source
from scripts.qa.native_fixture_process import run_owned


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = owned_root(args.root)
    if sys.version_info[:3] != (3, 11, 14) or sys.prefix == sys.base_prefix:
        raise FixtureRefusal("fixture requires its own Python 3.11.14 venv")
    if root.name != "python" or Path(sys.prefix).resolve() != root or not sys.flags.isolated:
        raise FixtureRefusal("invoke the owned python venv with -I")
    receipt = json.loads((root / "fixture-environment.json").read_text())
    lock_digest = hashlib.sha256((FIXTURE / "requirements.lock").read_bytes()).hexdigest()
    source_digest = verify_source()
    if receipt.get("root") != str(root) or receipt.get("python") != "3.11.14":
        raise FixtureRefusal("environment receipt does not identify this owned interpreter")
    if receipt.get("lockSha256") != lock_digest:
        raise FixtureRefusal("dependency lock changed since bootstrap")
    if receipt.get("sourceManifestSha256") != source_digest:
        raise FixtureRefusal("source manifest changed since bootstrap")
    environment = {"HOME": str(root.parent), "PATH": "/usr/bin:/bin", "TMPDIR": str(root.parent), "PYTHONNOUSERSITE": "1"}
    if sys.platform == "linux" and os.environ.get("CI") == "true":
        environment["CI"] = "true"
    run_owned([sys.executable, "-I", "-m", "pip", "check"], environment, 30)
    run_owned([sys.executable, "-I", str(Path(__file__).with_name("native-kanban-fixture.py")),
               "--root", str(root.parent), "--smoke"], environment, 30)
    print(json.dumps({"event": "environment-verified", "python": sys.version,
                      "executable": sys.executable, "root": str(root),
                      "lockSha256": lock_digest, "sourceManifestSha256": source_digest,
                      "packages": {item.metadata["Name"]: item.version for item in metadata.distributions()},
                      "importReceipt": str(root / "import-receipt.json")}), flush=True)


if __name__ == "__main__":
    def cancelled(signum: int, frame: FrameType | None) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, cancelled)
    main()
