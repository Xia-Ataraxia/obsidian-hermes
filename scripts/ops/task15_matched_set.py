# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Run through the identity-guarded task15 deployment driver.
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Callable


class MatchedSetRefusal(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Member:
    path: str
    before: str | None
    after: str | None
    mode: int
    backup: str | None
    staged: str | None


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe(path: Path) -> None:
    if path != path.resolve() or path.is_symlink():
        raise MatchedSetRefusal('noncanonical or symlink path')


def state(path: Path) -> str | None:
    safe(path)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_uid != os.getuid():
        raise MatchedSetRefusal('destination is not an owned regular file')
    return sha(path)


def protected(path: Path) -> None:
    safe(path)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise MatchedSetRefusal('unprotected recovery member')


def capture(root: Path, replacements: dict[Path, Path | None]) -> tuple[Member, ...]:
    safe(root)
    root.mkdir(mode=0o700)
    members = []
    for index, (path, source) in enumerate(sorted(replacements.items())):
        before = state(path)
        after = state(source) if source is not None else None
        if source is not None and after is None:
            raise MatchedSetRefusal('missing staged artifact')
        backup = f'before-{index:04d}' if before is not None else None
        staged = f'after-{index:04d}' if source is not None else None
        if backup is not None:
            (root / backup).write_bytes(path.read_bytes())
            (root / backup).chmod(0o600)
            if sha(root / backup) != before or state(path) != before:
                raise MatchedSetRefusal('concurrent backup change')
        if staged is not None and source is not None:
            (root / staged).write_bytes(source.read_bytes())
            (root / staged).chmod(0o600)
            if sha(root / staged) != after or state(source) != after:
                raise MatchedSetRefusal('concurrent staged change')
        mode = stat.S_IMODE(path.stat().st_mode) if before is not None else 0o644
        members.append(Member(str(path), before, after, mode, backup, staged))
    (root / 'manifest.json').write_text(json.dumps([asdict(member) for member in members], indent=2) + '\n')
    (root / 'manifest.json').chmod(0o600)
    (root / 'manifest.sha256').write_text(sha(root / 'manifest.json') + '\n')
    (root / 'manifest.sha256').chmod(0o600)
    return tuple(members)


def validate(root: Path, members: tuple[Member, ...], anchor: str) -> None:
    protected(root)
    protected(root / 'manifest.json')
    protected(root / 'manifest.sha256')
    if sha(root / 'manifest.json') != anchor or (root / 'manifest.sha256').read_text().strip() != anchor:
        raise MatchedSetRefusal('checkpoint membership changed')
    if json.loads((root / 'manifest.json').read_text()) != [asdict(member) for member in members]:
        raise MatchedSetRefusal('checkpoint membership mismatch')
    if len({member.path for member in members}) != len(members):
        raise MatchedSetRefusal('duplicate destination')
    for member in members:
        safe(Path(member.path))
        for name, expected in ((member.backup, member.before), (member.staged, member.after)):
            if name is None:
                if expected is not None:
                    raise MatchedSetRefusal('missing backup membership')
                continue
            if Path(name).name != name:
                raise MatchedSetRefusal('recovery path escape')
            path = root / name
            protected(path)
            if sha(path) != expected:
                raise MatchedSetRefusal('corrupt protected artifact')


def replace(path: Path, data: bytes, expected: str | None, mode: int) -> None:
    if state(path) != expected:
        raise MatchedSetRefusal('concurrent destination change')
    path.parent.mkdir(parents=True, exist_ok=True)
    safe(path)
    temp = path.with_name(path.name + '.task15-stage')
    with temp.open('xb') as stream:
        stream.write(data)
    temp.chmod(mode)
    try:
        if state(path) != expected:
            raise MatchedSetRefusal('concurrent destination change before replacement')
        if expected is None:
            os.link(temp, path)
        else:
            os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def deploy(root: Path, members: tuple[Member, ...], anchor: str, checkpoint: Callable[[], None]) -> None:
    validate(root, members, anchor)
    if any(state(Path(member.path)) != member.before for member in members):
        raise MatchedSetRefusal('stale expected-current set; no write')
    for member in sorted(members, key=lambda item: item.after is None):
        if member.before != member.after:
            if member.staged is None:
                if state(Path(member.path)) != member.before:
                    raise MatchedSetRefusal('concurrent removed-file change')
                Path(member.path).unlink()
            else:
                replace(Path(member.path), (root / member.staged).read_bytes(), member.before, member.mode)
            checkpoint()
    if any(state(Path(member.path)) != member.after for member in members):
        raise MatchedSetRefusal('post-deploy readback mismatch')


def restore(root: Path, members: tuple[Member, ...], anchor: str) -> None:
    validate(root, members, anchor)
    expected = {member.path: state(Path(member.path)) for member in members}
    if any(expected[member.path] not in (member.before, member.after) for member in members):
        raise MatchedSetRefusal('unowned current bytes; no rollback write')
    for member in reversed(members):
        path = Path(member.path)
        current = expected[member.path]
        if current == member.before:
            continue
        if member.backup is None:
            if state(path) != member.after:
                raise MatchedSetRefusal('concurrent added-file change')
            path.unlink()
        else:
            replace(path, (root / member.backup).read_bytes(), current, member.mode)
    if any(state(Path(member.path)) != member.before for member in members):
        raise MatchedSetRefusal('post-rollback readback mismatch')
