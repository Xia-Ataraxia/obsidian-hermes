# Isolated regression gate

`tests/test-scope-manifest.json` enumerates every test file. The isolated command selects
both `isolated` and `environment-dependent` entries after checking their prerequisites.
`live-read-only` files require actual SSH/installed-vault state and are never selected in CI.
An added, missing, duplicate, malformed or unclassified test fails the gate.

Use Bun **1.4.2**, a fresh owned Python **3.11.14** virtual environment, and SQLite at
`/usr/bin/sqlite3`. The interpreter has no ambient fallback. The bootstrap installs only
binary wheels from `tests/fixtures/native-kanban/requirements.lock` with required hashes,
checks dependencies and imports the actual pinned native router. Every run rechecks the
lock, source hashes, installed package versions and router import.

On the verified M1 Pro (`beomsu` / `xia.local`), choose a new directory below
`/private/tmp/hermes-control-center-m1-01a161c0` and bootstrap with an exact Python 3.11.14:

```sh
python3.11 -I scripts/qa/bootstrap-native-fixture.py --root "$FIXTURE_ROOT/python"
export HERMES_TEST_PYTHON="$FIXTURE_ROOT/python/bin/python"
export HERMES_TEST_ROOT="$FIXTURE_ROOT/regression"
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test:isolated
```

`FIXTURE_ROOT` must be absolute, canonical, task-owned and outside synced/live data.
The bootstrap requires a new venv path. The retained task 3 interpreter is only a permitted
M1 bootstrap input; the test environment belongs to the new task directory.
On Linux, the same process is permitted only with `CI=true`, under
`/tmp/hermes-control-center-ci`. The workflow sets up exact Python and Bun versions and
runs this same command. Configuration is not evidence of an observed Linux run.

The build writes a digest covering the actual bundle, styles, source tree and build inputs.
Stale output fails before tests. Immutable native source is reference data, excluded from
TypeScript compilation but independently hash-checked; its MIT license is retained at
`tests/fixtures/native-kanban/source/LICENSE`.

The runner uses a unique temporary directory and a closed environment for each invocation.
Each Bun test file runs in its own bounded child process to isolate Obsidian module stubs.
The Python test file runs its existing `unittest.main` entry point explicitly; a zero-case
result or skipped case fails. Native HTTP tests start their own ephemeral loopback server,
wait for authenticated readiness and stop it after use. No GUI, real SSH connection or
user-vault test runs in this command.

Each invocation retains `run-*/evidence/commands.log` and `test-inventory.json` beneath
`HERMES_TEST_ROOT`. The receipt records every actual expanded case count and child exit,
plus completion and cleanup. Cancellation kills the owned process group and reports failure.
The separate `bun run test:live-readonly` command is M1-gated; it does not authorize live
installation or turn historical installed-hash string checks into an equality proof.
