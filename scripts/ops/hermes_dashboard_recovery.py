"""Protected dashboard recovery snapshots; never includes board databases."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from pathlib import Path
from .hermes_dashboard_manifest import Asset, Manifest, Refusal, parse_expected, parse_manifest

ROOT = Path('/Users/beomsu/.hermes/hermes-agent')
HOME = Path('/Users/beomsu/.hermes')
PLIST = Path('/Users/beomsu/Library/LaunchAgents/com.beomsu.hermes-dashboard.plist')
RECOVERY = Path('/private/tmp/hermes-control-center-m1-01a161c0/task-5/recovery')
SERVICE = 'gui/501/com.beomsu.hermes-dashboard'
EXE = Path('/Users/beomsu/.local/bin/hermes')
LEGACY_ROOT = RECOVERY
LEGACY_MANIFEST_SHA256 = '3c2b4c855bca73c2163d419b2c05abf10bff7fdf2d35710c8a8323dc17b58e04'


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_path(path: Path) -> None:
    if path != path.resolve() or path.is_symlink():
        raise Refusal('symlink or noncanonical path refused')


def protected(path: Path) -> None:
    safe_path(path)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise Refusal('recovery ownership or permissions mismatch')


def approved_destination(path: Path) -> bool:
    safe_path(path)
    if path.suffix in {'.db', '.sqlite', '.sqlite3'} or path.name.endswith(('-wal', '-shm')):
        return False
    exact = {PLIST, EXE, HOME / 'config.yaml', ROOT / '.hermes/bin/hermes', ROOT / 'install-stamp.json',
             ROOT / 'pyproject.toml', ROOT / 'uv.lock'}
    trees = [ROOT / part for part in ['hermes_cli/web_dist', 'web/src', 'web/public',
                                      'plugins/kanban/dashboard', 'plugins/hermes-achievements/dashboard']]
    trees.append(HOME / 'plugins/omh/dashboard')
    return (path in exact or path.parent == ROOT / 'web' or
            (path.suffix == '.py' and (path.parent in {ROOT, ROOT / 'hermes_cli', ROOT / 'hermes_cli/subcommands'}
                                      or path.is_relative_to(ROOT / 'hermes_cli/web_routers'))) or
            any(path.is_relative_to(tree) for tree in trees))


def current_state(path: Path) -> str | None:
    safe_path(path)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_uid != os.getuid():
        raise Refusal('restore destination is not an owned regular file')
    return digest(path)


def files() -> list[Path]:
    required = [PLIST, EXE, ROOT / '.hermes/bin/hermes', HOME / 'config.yaml',
                ROOT / 'install-stamp.json', ROOT / 'hermes_cli/web_dist/index.html',
                ROOT / 'hermes_cli/web_server_dashboard.py', ROOT / 'hermes_cli/web_routers/dashboard_ui.py',
                ROOT / 'web/src/plugins/usePlugins.ts', HOME / 'plugins/omh/dashboard/manifest.json',
                HOME / 'plugins/omh/dashboard/plugin_api.py',
                ROOT / 'plugins/kanban/dashboard/dist/index.js',
                ROOT / 'plugins/hermes-achievements/dashboard/dist/index.js']
    for path in required:
        safe_path(path)
        if not path.is_file():
            raise Refusal('required recovery asset missing: ' + str(path))
    selected = set(required)
    selected.update((ROOT / 'hermes_cli').glob('*.py'))
    selected.update((ROOT / 'hermes_cli/web_routers').rglob('*.py'))
    selected.update((ROOT / 'hermes_cli/subcommands').glob('*.py'))
    for directory in ['hermes_cli/web_dist', 'web/src', 'web/public',
                      'plugins/kanban/dashboard', 'plugins/hermes-achievements/dashboard']:
        selected.update(path for path in (ROOT / directory).rglob('*') if path.is_file()
                        and '__pycache__' not in path.parts and 'node_modules' not in path.parts)
    selected.update(path for path in (ROOT / 'web').glob('*') if path.is_file())
    selected.update(path for path in (HOME / 'plugins/omh/dashboard').rglob('*')
                    if path.is_file() and '__pycache__' not in path.parts)
    selected.update(ROOT.glob('*.py'))
    selected.update([ROOT / 'pyproject.toml', ROOT / 'uv.lock'])
    for path in selected:
        safe_path(path)
        if path.suffix in {'.db', '.sqlite', '.sqlite3'} or path.name.endswith(('-wal', '-shm')):
            raise Refusal('database excluded from recovery')
    return sorted(selected)


def snapshot() -> Manifest:
    """Copy a matched set, checking source stability and actual copied bytes."""
    selected = files()
    before = {str(path): digest(path) for path in selected}
    if RECOVERY.exists():
        raise Refusal('recovery already exists; validate it instead of overwriting')
    protected(RECOVERY.parent)
    RECOVERY.mkdir(mode=0o700)
    entries: list[Asset] = []
    for index, path in enumerate(selected):
        dest = RECOVERY / f'asset-{index:04d}'
        _ = shutil.copyfile(path, dest)
        dest.chmod(0o600)
        if digest(dest) != before[str(path)] or digest(path) != before[str(path)]:
            raise Refusal('source changed during backup; incomplete recovery retained')
        entries.append({'path': str(path), 'backup': dest.name, 'sha256': before[str(path)],
                        'bytes': dest.stat().st_size, 'mode': stat.S_IMODE(path.stat().st_mode),
                        'restore': path != HOME / 'config.yaml'})
    (RECOVERY / 'scripts/ops').mkdir(parents=True, mode=0o700)
    for name in ['hermes-dashboard-preflight.py', 'hermes_dashboard_recovery.py', 'hermes_dashboard_manifest.py']:
        _ = shutil.copyfile(Path(__file__).parent / name, RECOVERY / 'scripts/ops' / name)
        (RECOVERY / 'scripts/ops' / name).chmod(0o600)
    result: Manifest = {'schema': 1, 'root': str(RECOVERY), 'service': SERVICE, 'files': entries,
              'boardDatabasesIncluded': False, 'configRestore': 'excluded; protected copy for operator recovery only',
              'oldMemoryProcessRestorable': False}
    _ = (RECOVERY / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    (RECOVERY / 'manifest.json').chmod(0o600)
    _ = (RECOVERY / 'manifest.sha256').write_text(digest(RECOVERY / 'manifest.json') + '\n')
    (RECOVERY / 'manifest.sha256').chmod(0o600)
    return result


def validate_restore() -> Manifest:
    """Validate the entire manifest before any restoration writes."""
    protected(RECOVERY)
    protected(RECOVERY / 'manifest.json')
    if RECOVERY == LEGACY_ROOT:
        anchor = LEGACY_MANIFEST_SHA256
    else:
        protected(RECOVERY / 'manifest.sha256')
        anchor = (RECOVERY / 'manifest.sha256').read_text().strip()
    data = (RECOVERY / 'manifest.json').read_bytes()
    if hashlib.sha256(data).hexdigest() != anchor:
        raise Refusal('checkpoint manifest differs from trusted original membership')
    manifest = parse_manifest(data, str(RECOVERY), SERVICE)
    seen: set[Path] = set()
    backups: set[str] = set()
    for entry in manifest['files']:
        path = Path(entry['path'])
        if not approved_destination(path) or path in seen or entry['backup'] in backups:
            raise Refusal('unapproved or duplicate checkpoint destination')
        seen.add(path)
        backups.add(entry['backup'])
        source = RECOVERY / entry['backup']
        if source.parent != RECOVERY or not source.name.startswith('asset-'):
            raise Refusal('recovery source outside protected root')
        protected(source)
        if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
            raise Refusal('missing or corrupt recovery asset')
        if entry['restore'] != (path != HOME / 'config.yaml'):
            raise Refusal('config restore is outside scope')
    return manifest


def restore(expected_path: Path) -> dict[str, list[str] | bool]:
    manifest = validate_restore()
    expected = parse_expected(expected_path.read_bytes())
    entries = [entry for entry in manifest['files'] if entry['restore']]
    if set(expected) != {entry['path'] for entry in entries}:
        raise Refusal('expected-current must cover every restore destination')
    for entry in entries:
        if current_state(Path(entry['path'])) != expected[entry['path']]:
            raise Refusal('concurrent edit detected; no restoration performed')
    restored: list[str] = []
    for entry in entries:
        path = Path(entry['path'])
        if current_state(path) == entry['sha256']:
            continue
        if current_state(path) != expected[str(path)]:
            raise Refusal('concurrent edit during restore; inspect partial restore')
        path.parent.mkdir(parents=True, exist_ok=True)
        safe_path(path)
        temp = path.with_name(path.name + '.task5-restore')
        with temp.open('xb') as stream:
            _ = stream.write((RECOVERY / entry['backup']).read_bytes())
        temp.chmod(entry['mode'])
        try:
            if expected[str(path)] is None:
                os.link(temp, path)
                temp.unlink()
            else:
                os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        restored.append(str(path))
    return {'restoredPaths': restored, 'serviceRestarted': False, 'configRestored': False}
