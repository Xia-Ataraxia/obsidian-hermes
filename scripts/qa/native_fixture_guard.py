from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from dataclasses import dataclass
from typing import Final

FIXTURE: Final = Path(__file__).resolve().parents[2] / "tests/fixtures/native-kanban"
SOURCE: Final = FIXTURE / "source"
M1_ROOT: Final = Path("/private/tmp/hermes-control-center-m1-01a161c0")
ROUTER_HASH: Final = "22985675c9402fcefaa84f9cc1ad2530f0d9ec9b68e3a5e6034d8c4e9b8035f5"


@dataclass(frozen=True, slots=True)
class FixtureRefusal(RuntimeError):
    reason: str

    def __str__(self) -> str:
        return self.reason


def owned_root(raw: str) -> Path:
    if not Path(raw).is_absolute() or str(Path(raw)) != raw or ".." in Path(raw).parts:
        raise FixtureRefusal("root must be absolute and canonical")
    path = Path(raw).absolute()
    canonical = path.resolve()
    if path != canonical or any(p.is_symlink() for p in (path, *path.parents)):
        raise FixtureRefusal("root must be canonical without symlink ancestors")
    if platform.system() == "Darwin":
        hardware = subprocess.check_output(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], text=True, timeout=5).strip()
        hostname = subprocess.check_output(["/bin/hostname"], text=True, timeout=5).strip()
        user = subprocess.check_output(["/usr/bin/id", "-un"], text=True, timeout=5).strip()
        if hardware != "Apple M1 Pro" or hostname != "xia.local" or os.getuid() != 501 or user != "beomsu":
            raise FixtureRefusal("verified M1 Pro host required")
        base = M1_ROOT
    elif platform.system() == "Linux" and os.environ.get("CI") == "true":
        base = Path("/tmp/hermes-control-center-ci")
    else:
        raise FixtureRefusal("only verified M1 or isolated Linux CI is supported")
    if not canonical.is_relative_to(base) or canonical == base:
        raise FixtureRefusal("root must be beneath the owned temporary fixture namespace")
    if set(canonical.parts) & {".obsidian", ".hermes", "Obsidian", "Library", "Dropbox", "OneDrive", "iCloud"}:
        raise FixtureRefusal("synced or live runtime root is forbidden")
    return canonical


def verify_source() -> str:
    manifest_path = FIXTURE / "source-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    allowed = {entry["path"] for entry in manifest["files"]}
    if {str(p.relative_to(SOURCE)) for p in SOURCE.rglob("*") if p.is_file()} != allowed:
        raise FixtureRefusal("source tree contains unpinned files")
    for entry in manifest["files"]:
        path = SOURCE / entry["path"]
        if not path.resolve().is_relative_to(SOURCE) or path.is_symlink():
            raise FixtureRefusal("source path escaped pinned root")
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise FixtureRefusal("pinned source hash mismatch: " + entry["path"])
    router = SOURCE / "plugins/kanban/dashboard/plugin_api.py"
    if hashlib.sha256(router.read_bytes()).hexdigest() != ROUTER_HASH:
        raise FixtureRefusal("native router differs from accepted task1 source")
    return hashlib.sha256(manifest_path.read_bytes()).hexdigest()


def isolate(root: Path) -> None:
    token = os.environ.get("HERMES_FIXTURE_TOKEN", "")
    os.environ.clear()
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ.update(HOME=str(home), HERMES_HOME=str(home), HERMES_KANBAN_HOME=str(home),
                      HERMES_PROFILE="default", PATH="/usr/bin:/bin", TMPDIR=str(root),
                      PYTHONDONTWRITEBYTECODE="1", HERMES_SKIP_CHMOD="1", HERMES_FIXTURE_TOKEN=token)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SOURCE))
    readable = (root, SOURCE, Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve(), Path(__file__).parent)

    def audit(event: str, args: tuple[str | bytes | int | None, ...]) -> None:
        if event.startswith(("subprocess.", "os.exec", "os.spawn", "os.fork")) or event in {"os.system", "os.kill", "os.killpg", "socket.connect", "socket.getaddrinfo", "socket.sendto", "socket.sendmsg"}:
            raise FixtureRefusal("fixture blocked effect: " + event)
        if event in {"open", "sqlite3.connect", "os.listdir", "os.scandir"} and args and isinstance(args[0], (str, bytes)):
            path = Path(os.fsdecode(args[0])).resolve()
            if path not in {Path("/dev/null"), Path("/System/Library/CoreServices/SystemVersion.plist")} and not any(path.is_relative_to(p) for p in readable):
                raise FixtureRefusal("fixture blocked path access")
        if event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.rename", "os.symlink", "os.link"}:
            for argument in args[:2]:
                if isinstance(argument, (str, bytes)) and not Path(os.fsdecode(argument)).resolve().is_relative_to(root):
                    raise FixtureRefusal("fixture blocked filesystem mutation")
        if event == "open" and len(args) > 2 and isinstance(args[0], (str, bytes)):
            flags = args[2]
            if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
                if not Path(os.fsdecode(args[0])).resolve().is_relative_to(root):
                    raise FixtureRefusal("fixture blocked write outside synthetic root")

    sys.addaudithook(audit)
