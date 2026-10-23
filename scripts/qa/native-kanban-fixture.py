# /// script
# requires-python = "==3.11.14"
# dependencies = []
# ///
# How to run: <root>/python/bin/python -I scripts/qa/native-kanban-fixture.py --root <root> --port 19129
from __future__ import annotations

import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import FIXTURE, FixtureRefusal, isolate, owned_root, verify_source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=19129)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    root = owned_root(args.root)
    if sys.version_info[:3] != (3, 11, 14) or Path(sys.prefix).resolve() != root / "python" or sys.prefix == sys.base_prefix:
        raise FixtureRefusal("fixture requires its own Python 3.11.14 venv")
    receipt = json.loads((root / "python/fixture-environment.json").read_text())
    if receipt["lockSha256"] != hashlib.sha256((FIXTURE / "requirements.lock").read_bytes()).hexdigest():
        raise FixtureRefusal("dependency lock changed since bootstrap")
    if receipt["sourceManifestSha256"] != verify_source():
        raise FixtureRefusal("source manifest changed since bootstrap")
    packages = {item.metadata["Name"]: item.version for item in metadata.distributions()}
    for line in (FIXTURE / "requirements.lock").read_text().splitlines():
        if "==" in line and not line.startswith("#"):
            name, version = line.split("==", 1)
            expected = version.split()[0].rstrip("\\")
            if metadata.version(name) != expected:
                raise FixtureRefusal("dependency version differs from lock: " + name)
    token = os.environ.get("HERMES_FIXTURE_TOKEN", "")
    if not args.smoke and len(token) < 32:
        raise FixtureRefusal("32+ character in-memory fixture token required")
    if not args.smoke and not (root / "python/import-receipt.json").is_file():
        raise FixtureRefusal("successful bootstrap smoke receipt required")
    isolate(root)
    from fastapi import FastAPI
    import uvicorn
    from plugins.kanban.dashboard import plugin_api
    from scripts.qa.native_fixture_http import FixtureBoundary
    from scripts.qa.native_fixture_seed import seed
    from scripts.qa.native_fixture_preflight import install_native_preflight

    install_native_preflight(root)
    seed(root)

    if args.smoke:
        result = {"event": "smoke", "python": sys.version, "prefix": sys.prefix, "packages": packages,
                  "routerFile": plugin_api.__file__, "routeCount": len(plugin_api.router.routes), "syntheticHome": os.environ["HERMES_HOME"]}
        (root / "python/import-receipt.json").write_text(json.dumps(result, indent=2)+"\n")
        print(json.dumps(result), flush=True)
        return
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(plugin_api.router, prefix="/api/plugins/kanban")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", args.port))
        port = listener.getsockname()[1]

        class FixtureServer(uvicorn.Server):
            async def startup(self, sockets: list[socket.socket] | None = None) -> None:
                await super().startup(sockets)
                if self.started:
                    print(json.dumps({"event": "ready", "host": "127.0.0.1", "port": port, "pid": os.getpid(), "root": str(root)}), flush=True)

        server = FixtureServer(uvicorn.Config(FixtureBoundary(app, token), host="127.0.0.1", port=port,
                                              log_level="warning", access_log=False, ws="websockets", timeout_graceful_shutdown=3))
        server.run(sockets=[listener])


if __name__ == "__main__":
    main()
