#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Run: python3 hermes-dashboard-preflight.py --local-runtime --out RECEIPTS
from __future__ import annotations

import argparse
import contextlib
import io
import hashlib
import json
import os
import plistlib
import re
import resource
import runpy
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from collections.abc import Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
__package__ = 'scripts.ops'
from .hermes_dashboard_recovery import EXE, PLIST, RECOVERY, ROOT, SERVICE
from .hermes_dashboard_recovery import Refusal, digest, restore, snapshot, validate_restore

REMOTE = '/private/tmp/hermes-control-center-m1-01a161c0/task-5/code/scripts/ops/hermes-dashboard-preflight.py'
Json = str | int | float | bool | None | Sequence['Json'] | Mapping[str, 'Json']


def run(argv: list[str], timeout: float = 15) -> str:
    def limit() -> None:
        resource.setrlimit(resource.RLIMIT_FSIZE, (2_097_152, 2_097_152))
    with tempfile.TemporaryFile() as output:
        with subprocess.Popen(argv, stdout=output, stderr=subprocess.DEVNULL,
                              start_new_session=True, preexec_fn=limit) as process:
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                _ = process.wait()
                raise Refusal('external command deadline exceeded') from None
        if code:
            raise Refusal('external command failed: ' + Path(argv[0]).name)
        if output.tell() >= 2_097_152:
            raise Refusal('external command output limit exceeded')
        _ = output.seek(0)
        return output.read().decode('utf-8').strip()


def identity() -> dict[str, str]:
    return {'hardware': run(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string']),
            'hostname': run(['/bin/hostname']), 'user': run(['/usr/bin/id', '-un']),
            'uid': run(['/usr/bin/id', '-u'])}


def guard(value: dict[str, str], service: str) -> None:
    if value != {'hardware': 'Apple M1 Pro', 'hostname': 'xia.local', 'user': 'beomsu', 'uid': '501'}:
        raise Refusal('wrong runtime identity')
    if service != SERVICE:
        raise Refusal('wrong service owner')


def parser_check(arguments: list[str]) -> dict[str, str | bool | list[str]]:
    namespace = runpy.run_path(str(ROOT / 'hermes_cli/subcommands/dashboard.py'))
    parser = argparse.ArgumentParser(exit_on_error=False)
    namespace['build_dashboard_parser'](parser.add_subparsers(), cmd_dashboard=lambda: None,
                                       cmd_dashboard_register=lambda: None)
    with contextlib.redirect_stderr(io.StringIO()):
        _, unsupported = parser.parse_known_args(arguments[1:])
        fallback = [item for item in arguments if item != '--tui'] if unsupported else list(arguments)
        _, remaining = parser.parse_known_args(fallback[1:])
    if remaining or unsupported not in ([], ['--tui']):
        raise Refusal('unsupported arguments exceed the documented --tui correction')
    for path in (ROOT / 'hermes_cli').glob('web*.py'):
        _ = compile(path.read_bytes(), str(path), 'exec')
    state = ROOT.parent / 'installs' / hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]
    facts = json.loads((state / 'facts.json').read_text())
    environment = Path(facts['packages']['venv']['environment'])
    if not environment.is_relative_to(state / 'environments'):
        raise Refusal('committed dependency generation outside install state')
    sites = list(environment.glob('lib/python*/site-packages'))
    if len(sites) != 1:
        raise Refusal('ambiguous committed dependency site-packages')
    dependencies = run([str(environment / 'bin/python'), '-I', '-S', '-B', '-c',
                        'import sys; sys.path.insert(0, sys.argv[1]); import fastapi, uvicorn, pydantic, yaml; print("imports-ok")',
                        str(sites[0])])
    if dependencies != 'imports-ok':
        raise Refusal('current installation dependencies failed import')
    return {'unsupportedArguments': unsupported, 'fallbackArguments': fallback,
            'parserAcceptsFallback': True, 'sourceCompiles': True,
            'dependencyImports': dependencies, 'dependencyEnvironment': str(environment),
            'parserSource': 'hermes_cli/subcommands/dashboard.py:86-90 (hidden --tui compatibility shim)',
            'validationScope': 'native parser, installed source compilation, committed dependency imports and complete asset backup; no server start'}


def observe() -> dict[str, Json]:
    document = plistlib.loads(PLIST.read_bytes())
    arguments = document.get('ProgramArguments')
    allowed = [str(EXE), 'dashboard', '--host', '127.0.0.1', '--port', '9119', '--no-open']
    if document.get('Label') != SERVICE.split('/')[-1] or arguments not in [allowed, allowed + ['--tui']]:
        raise Refusal('unexpected supervisor label or arguments')
    if PLIST.stat().st_uid != 501 or document.get('WorkingDirectory') != '/Users/beomsu':
        raise Refusal('unexpected supervisor owner or working directory')
    loaded = run(['/bin/launchctl', 'print', SERVICE])
    pid_match = re.search(r'^\s*pid = (\d+)$', loaded, re.M)
    if not pid_match or str(PLIST) not in loaded or 'program = ' + str(EXE) not in loaded:
        raise Refusal('loaded service does not match plist')
    pid = pid_match.group(1)
    if run(['/bin/ps', '-p', pid, '-o', 'uid=']) != '501':
        raise Refusal('wrong live process owner')
    command = run(['/bin/ps', '-ww', '-p', pid, '-o', 'command='])
    if not command.endswith(' '.join(arguments[1:])):
        raise Refusal('live process arguments differ from supervisor')
    parser = parser_check(arguments)
    status = json.loads(run(['/usr/bin/curl', '--silent', '--show-error', '--fail', '--max-time', '5',
                             'http://127.0.0.1:9119/api/status']))
    stamp = json.loads((ROOT / 'install-stamp.json').read_text())
    routes = []
    for path in ['/api/status', '/dashboard-plugins/@default/kanban/dist/index.js',
                 '/dashboard-plugins/kanban/dist/index.js', '/dashboard-plugins/@default/hermes-achievements/dist/index.js',
                 '/dashboard-plugins/hermes-achievements/dist/index.js', '/dashboard-plugins/@default/omh/dist/index.js']:
        result = run(['/usr/bin/curl', '--silent', '--show-error', '--max-time', '5', '-o', '/dev/null',
                      '-w', '%{http_code} %{content_type}', 'http://127.0.0.1:9119' + path])
        routes.append({'path': path, 'statusAndMime': result})
    serve_text = run(['/opt/homebrew/bin/tailscale', 'serve', 'status', '--json'])
    serve = json.loads(serve_text)
    if serve.get('Web', {}).get('m1-pro.tail9eb061.ts.net:443', {}).get('Handlers', {}).get('/', {}).get('Proxy') != 'http://127.0.0.1:9120':
        raise Refusal('private ingress owner or target changed')
    listeners = run(['/usr/sbin/lsof', '-nP', '-iTCP:9119', '-iTCP:9120', '-sTCP:LISTEN'])
    if '127.0.0.1:9119' not in listeners or '127.0.0.1:9120' not in listeners or '*:' in listeners:
        raise Refusal('listener scope differs from private loopback chain')
    proxy = Path('/Users/beomsu/Library/LaunchAgents/com.beomsu.hermes-dashboard-proxy.plist')
    private_routes = {'TCP': {port: {key: value for key, value in config.items() if key in {'HTTPS', 'TCPForward'}}
                              for port, config in serve.get('TCP', {}).items()},
                      'Web': {host: {'Handlers': {path: {key: value for key, value in handler.items() if key in {'Proxy', 'Path'}}
                                                 for path, handler in config.get('Handlers', {}).items()}}
                              for host, config in serve.get('Web', {}).items()}}
    return {'service': SERVICE, 'plist': str(PLIST), 'arguments': arguments, 'parser': parser,
            'process': {'pid': int(pid), 'uid': 501, 'started': run(['/bin/ps', '-p', pid, '-o', 'lstart=']),
                        'executable': command.split()[0], 'argvSha256': hashlib.sha256(command.encode()).hexdigest()},
            'installation': {'version': stamp.get('baseVersion'), 'commit': stamp.get('commit'),
                             'stampSha256': digest(ROOT / 'install-stamp.json'),
                             'dirtyStatus': run(['git', '--no-optional-locks', '-C', str(ROOT), 'status', '--porcelain'])},
            'runningStatus': {key: status.get(key) for key in ['version', 'auth_required', 'auth_providers', 'overall']},
            'routes': routes, 'listeners': listeners.splitlines(),
            'privateRoutes': private_routes, 'privateRoutesSha256': hashlib.sha256(serve_text.encode()).hexdigest(),
            'proxyPlistSha256': digest(proxy),
            'runtimeMatchesInstallation': False,
            'ready': False, 'readyReason': 'preflight is a recovery checkpoint, never UI or ingress readiness',
            'oldMemoryProcessRestorable': False,
            'launcherCaveat': 'launcher/bootstrap may repair or sync runtime; native parser loaded directly without launcher'}


def main() -> int:
    parser = argparse.ArgumentParser(description='Bounded M1 dashboard preflight. No restart or route change.')
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--local-runtime', action='store_true')
    target.add_argument('--host', choices=['m1-pro-file'])
    target.add_argument('--fixture', type=Path)
    parser.add_argument('--service', default=SERVICE)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--restore-check', action='store_true')
    parser.add_argument('--recheck', action='store_true')
    parser.add_argument('--restore', action='store_true')
    parser.add_argument('--expected-current', type=Path)
    args = parser.parse_args()
    try:
        if args.service != SERVICE:
            raise Refusal('wrong service owner')
        if args.fixture:
            fixture = json.loads(args.fixture.read_text())
            guard(fixture['identity'], fixture['service'])
            raise Refusal('fixtures cannot authorize runtime writes')
        if args.host:
            if args.restore or args.restore_check or args.expected_current:
                raise Refusal('recovery must execute explicitly on the verified host')
            ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                       '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
                       '--', args.host]
            remote_out = '/private/tmp/hermes-control-center-m1-01a161c0/task-5/receipts'
            receipt = json.loads(run(ssh + ['python3 ' + REMOTE + ' --local-runtime --service ' + SERVICE +
                                           ' --out ' + remote_out + (' --recheck' if args.recheck else '')], 180))
            if receipt.get('preflight') != 'pass' or args.out is None:
                raise Refusal('remote checkpoint failed or --out missing')
            args.out.mkdir(parents=True, exist_ok=True)
            for name in ['preflight.json', 'rollback-manifest.json']:
                content = run(ssh + ['cat ' + remote_out + '/' + name])
                _ = json.loads(content)
                _ = (args.out / name).write_text(content + '\n')
            print(json.dumps(receipt))
            return 0
        machine = identity()
        guard(machine, args.service)
        if args.restore:
            if args.expected_current is None:
                raise Refusal('restore requires expected-current hashes captured by the change owner')
            print(json.dumps(restore(args.expected_current)))
            return 0
        if args.restore_check:
            checked = validate_restore()
            print(json.dumps({'restoreCheck': 'pass', 'files': len(checked['files']), 'writes': 0}))
            return 0
        if args.out is None:
            raise Refusal('--out required for preflight')
        before = observe()
        manifest = validate_restore() if args.recheck else snapshot()
        _ = validate_restore()
        if args.recheck and any(digest(Path(entry['path'])) != entry['sha256'] for entry in manifest['files']):
            raise Refusal('installed assets changed since checkpoint')
        after = observe()
        if before != after:
            raise Refusal('runtime changed during checkpoint; recovery retained but preflight refused')
        args.out.mkdir(parents=True, exist_ok=True)
        before['identity'] = machine
        (args.out / 'preflight.json').write_text(json.dumps(before, indent=2) + '\n')
        (args.out / 'rollback-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(json.dumps({'preflight': 'pass', 'files': len(manifest['files']), 'recovery': str(RECOVERY), 'ready': False}))
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError, argparse.ArgumentError) as error:
        print(json.dumps({'preflight': 'refused', 'reason': str(error) if isinstance(error, Refusal) else type(error).__name__}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
