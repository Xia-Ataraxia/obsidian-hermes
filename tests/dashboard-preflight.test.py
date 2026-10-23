# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Run with the verified owned fixture interpreter: $HERMES_TEST_PYTHON -I tests/dashboard-preflight.test.py -v
from __future__ import annotations

import importlib.util
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager
from unittest.mock import patch

CODE = Path(__file__).resolve().parents[1] / 'scripts/ops'
sys.path.insert(0, str(CODE.parents[1]))
recovery = importlib.import_module('scripts.ops.hermes_dashboard_recovery')

spec = importlib.util.spec_from_file_location('preflight', CODE / 'hermes-dashboard-preflight.py')
if spec is None or spec.loader is None:
    raise RuntimeError('preflight module missing')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    @contextmanager
    def checkpoint(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            base = Path(directory).resolve()
            home = base / 'home'
            root = home / 'hermes-agent'
            backup = base / 'recovery'
            for name, value in {'ROOT': root, 'HOME': home, 'PLIST': base / 'launch.plist',
                                'EXE': base / 'hermes', 'RECOVERY': backup}.items():
                stack.enter_context(patch.object(recovery, name, value))
            required = [recovery.PLIST, recovery.EXE, home / 'config.yaml',
                        root / '.hermes/bin/hermes', root / 'install-stamp.json', root / 'pyproject.toml', root / 'uv.lock',
                        root / 'hermes_cli/web_dist/index.html', root / 'hermes_cli/web_dist/assets/old.js',
                        root / 'hermes_cli/web_server_dashboard.py', root / 'hermes_cli/web_routers/dashboard_ui.py',
                        root / 'web/src/plugins/usePlugins.ts', home / 'plugins/omh/dashboard/manifest.json',
                        home / 'plugins/omh/dashboard/plugin_api.py', root / 'plugins/kanban/dashboard/dist/index.js',
                        root / 'plugins/hermes-achievements/dashboard/dist/index.js']
            for path in required:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('checkpoint bytes for ' + path.name)
            manifest = recovery.snapshot()
            expected = base / 'expected.json'
            expected.write_text(json.dumps({item['path']: item['sha256'] for item in manifest['files'] if item['restore']}))
            yield root, backup, expected

    def test_removed_required_checkpoint_member_restores(self) -> None:
        with self.checkpoint() as (root, _, expected):
            target = root / 'hermes_cli/web_dist/index.html'
            original = target.read_bytes()
            target.unlink()
            state = json.loads(expected.read_text())
            state[str(target)] = None
            expected.write_text(json.dumps(state))
            recovery.restore(expected)
            self.assertEqual(target.read_bytes(), original)

    def test_removed_optional_checkpoint_member_restores(self) -> None:
        with self.checkpoint() as (root, _, expected):
            target = root / 'hermes_cli/web_dist/assets/old.js'
            original = target.read_bytes()
            target.unlink()
            state = json.loads(expected.read_text())
            state[str(target)] = None
            expected.write_text(json.dumps(state))
            recovery.restore(expected)
            self.assertEqual(target.read_bytes(), original)

    def test_new_frontend_asset_is_untouched(self) -> None:
        with self.checkpoint() as (root, _, expected):
            new = root / 'hermes_cli/web_dist/assets/new.js'
            new.write_text('new asset belongs to the change owner')
            recovery.restore(expected)
            self.assertEqual(new.read_text(), 'new asset belongs to the change owner')

    def test_native_hidden_tui_compatibility(self) -> None:
        arguments = [str(recovery.EXE), 'dashboard', '--host', '127.0.0.1', '--port', '9119', '--no-open', '--tui']
        result = preflight.parser_check(arguments)
        self.assertEqual(result['unsupportedArguments'], [])
        self.assertEqual(result['fallbackArguments'], arguments)

    def test_wrong_owner_and_malformed_leave_output_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for text in ['{', '{}', json.dumps({'identity': {}, 'service': recovery.SERVICE}),
                         json.dumps({'identity': {'hardware': 'Apple M3 Pro'}, 'service': recovery.SERVICE})]:
                fixture = root / 'fixture.json'
                fixture.write_text(text)
                out = root / 'never-created'
                result = subprocess.run([sys.executable, str(CODE / 'hermes-dashboard-preflight.py'),
                                         '--fixture', str(fixture), '--out', str(out)], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(out.exists())
            fixture = Path(__file__).parent / 'fixtures/dashboard-wrong-owner.json'
            result = subprocess.run([sys.executable, str(CODE / 'hermes-dashboard-preflight.py'),
                                     '--fixture', str(fixture), '--out', str(root / 'wrong')], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((root / 'wrong').exists())

    def test_hung_child_is_killed_within_deadline(self) -> None:
        start = time.monotonic()
        with self.assertRaises(recovery.Refusal):
            preflight.run([sys.executable, '-c', 'import time; time.sleep(60)'], 0.15)
        self.assertLess(time.monotonic() - start, 2)

    def test_excess_output_is_bounded(self) -> None:
        with self.assertRaises(recovery.Refusal):
            preflight.run([sys.executable, '-c', 'print("x" * 3000000)'])

    def test_restore_guards_and_matched_fixture_restore(self) -> None:
        with self.checkpoint() as (root, backup, expected):
            source = root / 'hermes_cli/web_dist/index.html'
            original = source.read_bytes()
            manifest_path = backup / 'manifest.json'
            manifest = recovery.validate_restore()
            entry = next(item for item in manifest['files'] if item['path'] == str(source))
            asset = backup / entry['backup']
            asset.rename(backup / 'missing')
            with self.assertRaises(FileNotFoundError):
                recovery.validate_restore()
            self.assertEqual(source.read_bytes(), original)
            (backup / 'missing').rename(asset)
            asset.write_text('corrupt backup')
            with self.assertRaises(recovery.Refusal):
                recovery.validate_restore()
            asset.write_bytes(original)
            asset.chmod(0o644)
            with self.assertRaises(recovery.Refusal):
                recovery.validate_restore()
            asset.chmod(0o600)
            source.write_text('concurrent user edit\n')
            with self.assertRaises(recovery.Refusal):
                recovery.restore(expected)
            self.assertEqual(source.read_text(), 'concurrent user edit\n')
            state = json.loads(expected.read_text())
            state[str(source)] = recovery.digest(source)
            expected.write_text(json.dumps(state))
            result = recovery.restore(expected)
            self.assertEqual(result['restoredPaths'], [str(source)])
            self.assertEqual(source.read_bytes(), original)
            entry['path'] = str(root / '../outside')
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(recovery.Refusal):
                recovery.validate_restore()
            (backup / 'manifest.sha256').write_text(recovery.digest(manifest_path))
            with self.assertRaises(recovery.Refusal):
                recovery.validate_restore()

    def test_absence_requires_explicit_expected_state(self) -> None:
        with self.checkpoint() as (root, _, expected):
            target = root / 'hermes_cli/web_dist/index.html'
            target.unlink()
            with self.assertRaises(recovery.Refusal):
                recovery.restore(expected)
            self.assertFalse(target.exists())
            target.write_text('concurrent replacement')
            state = json.loads(expected.read_text())
            state[str(target)] = None
            expected.write_text(json.dumps(state))
            with self.assertRaises(recovery.Refusal):
                recovery.restore(expected)
            self.assertEqual(target.read_text(), 'concurrent replacement')

    def test_absent_destination_symlink_is_rejected(self) -> None:
        with self.checkpoint() as (root, _, expected):
            target = root / 'hermes_cli/web_dist/index.html'
            target.unlink()
            victim = root.parent / 'outside.txt'
            victim.write_text('unrelated bytes')
            target.symlink_to(victim)
            state = json.loads(expected.read_text())
            state[str(target)] = None
            expected.write_text(json.dumps(state))
            with self.assertRaises(recovery.Refusal):
                recovery.restore(expected)
            self.assertEqual(victim.read_text(), 'unrelated bytes')

    def test_concurrent_creation_during_absent_restore_is_preserved(self) -> None:
        with self.checkpoint() as (root, _, expected):
            target = root / 'hermes_cli/web_dist/index.html'
            target.unlink()
            state = json.loads(expected.read_text())
            state[str(target)] = None
            expected.write_text(json.dumps(state))
            link = os.link
            def concurrent_link(source, destination):
                Path(destination).write_text('concurrent creator')
                link(source, destination)
            with patch.object(recovery.os, 'link', side_effect=concurrent_link):
                with self.assertRaises(FileExistsError):
                    recovery.restore(expected)
            self.assertEqual(target.read_text(), 'concurrent creator')
            self.assertFalse(target.with_name(target.name + '.task5-restore').exists())

    def test_malformed_expected_state_and_membership_tampering(self) -> None:
        with self.checkpoint() as (root, backup, expected):
            source = root / 'hermes_cli/web_dist/index.html'
            original = source.read_bytes()
            state = json.loads(expected.read_text())
            for malformed in [False, 123, '', {'state': 'absent'}]:
                state[str(source)] = malformed
                expected.write_text(json.dumps(state))
                with self.assertRaises(recovery.Refusal):
                    recovery.restore(expected)
                self.assertEqual(source.read_bytes(), original)
            manifest = json.loads((backup / 'manifest.json').read_text())
            manifest['files'].pop()
            (backup / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(recovery.Refusal):
                recovery.validate_restore()


if __name__ == '__main__':
    from scripts.qa.native_fixture_guard import owned_root
    owned_root(os.environ["HERMES_TEST_ROOT"])
    unittest.main(verbosity=2)
