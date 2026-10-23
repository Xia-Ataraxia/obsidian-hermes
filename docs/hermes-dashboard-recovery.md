# M1 dashboard recovery checkpoint

This procedure owns only `gui/501/com.beomsu.hermes-dashboard` on `Apple M1 Pro`, `xia.local`, uid 501 / `beomsu`. Task 5 captured the historical recovery assets; task 14 verified the current service; task 15 applied the bounded loader repair described below. Do not restart gateways or the proxy, change Serve routes, run broad dashboard `--stop`, or restore board databases.

**Task 14 fresh verification, 2026-10-22:** the service was already running 0.22.3 as PID 61847, with installed commit `4d04303818b61bf3aa09278af48356315515965b`. Task 14 performed no restart. Scoped Kanban/Achievements assets returned `200 application/javascript`; a headed M1 Chrome session rendered both registered pages and exercised Kanban navigation/filter controls. The dashboard PID, launch arguments, dirty source/index, proxy, private Serve entries and unrelated service identities matched before/after. Evidence is under `.omo/evidence/hermes-control-center/task-14/`.

The original checkpoint below remains preserved historical recovery material. Seventeen checkpoint members had already changed or disappeared at task 14; its `--recheck` correctly refused that changed installation. Do not restore that older set over the current release. Task 15 captured the fresh affected set described next, with expected-current hashes bound before mutation. The task-1 contract pin drift in `web/src/lib/api.ts` moved WhatsApp TypeScript types; its auth/session/JSON/WebSocket runtime code was unchanged. Original accepted pins remain provenance, not silently updated values.

## Task 15 API-only loader repair

Task 15 applied `docs/upstream/omh-api-only-loader.patch` to the observed dirty 0.22.3 installation at commit `4d04303818b61bf3aa09278af48356315515965b`. Explicit manifest `entry: null` now means no browser component; normalized discovery publishes `has_ui: false` while retaining `has_api: true`. An omitted entry preserves the legacy `dist/index.js` default. Hidden UI plugins with a nonnull entry still load and register. Malformed entry values are rejected through discovery's existing error handling, and an explicitly missing browser file retains the useful loader error. `has_ui` is the new compatibility field; no native Kanban API pin was changed.

The patch includes the three Hermes production files, an OMH manifest hunk, and the actual tested hook/normalized-fixture files. Its `omh/manifest.json` path is a staging-layout mapping for `/Users/beomsu/.hermes/plugins/omh/dashboard/manifest.json`, not a new Hermes plugin. Do not apply the patch blindly to the already repaired installation. `patch-binding.json` proves all six patch outputs match the recorded source; the two test files were used in the isolated test source and were not deployed into live build inputs.

Before writing, the owner copied current source and dependencies, preserved unrelated dirty files, captured the complete current/candidate affected union, and checked every expected-current hash. The final build used native PM Node `26.7.0`, all native freshness inputs, and the existing prepared icons path. An earlier staged candidate with different build provenance was never deployed; its safe receipts remain in the evidence. Native source hashes were `da035341472d4e6692b70b244dc51b35a67b86f40468b8b5d53f725345ef4959` before and `3c4d090f0070e581183b7de9c418f2c61389bf0cf1ea0926df24dc1c34651c61` after. The prior and current build receipts match those source hashes, the same PM Node, and the same prepared-icons hash.

The guarded 93-member deployment includes three source files, the existing OMH manifest and the complete affected frontend set, with 14 new asset paths and 14 removed superseded paths. It restarted only the named supervisor, retained `--tui`, and observed PID 61847 become 64812. Native freshness passed before restart and again at final readback. The final readback recorded HTTP status, all 93 members, 20 browser-loaded static assets, 10,368 unchanged other source inputs, unchanged index/private routes/proxy, and unchanged unrelated services. These are observations from 2026-10-22, not future PID assumptions.

The headed M1 browser rendered Kanban and Achievements with screenshots, loaded their existing browser bundles with HTTP 200, and made no OMH browser-entry request. Its JavaScript console interceptor was installed and captured no logs. The first raw OMH probe omitted the native session header and correctly received 401; the corrected read-only `GET /api/plugins/omh/hud` used `X-Hermes-Session-Token` from server-injected HTML in memory and returned HTTP 200, schema `omh_hud/v1`, without an error record. Credentials and business response bodies were not persisted. Served HTML deliberately differs from disk HTML because the native server injects profile/theme/session bootstrap; static asset hashes supply the byte-level binding.

Evidence is under `.omo/evidence/hermes-control-center/task-15/`: `done-claim.json`, `final-readback.json`, `artifact-manifest.json`, `patch-binding.json`, `browser-final.json`, both `*-final.png` screenshots, `omh-api.json`, loader tests, rollback fixture and cleanup receipts. The original four-hour stop is preserved in `boundary/`; work resumed only after the human extended the original checkpoint to eight hours. No redeployment or production restart occurred on resume. Independent acceptance belongs to the coordinator.

### Task 15 protected recovery closure

Retain `/private/tmp/hermes-control-center-m1-01a161c0/task-15` through task 25. Cleanup retains only the protected recovery closure: `recovery-v2/`, `deploy.py`, `task15_matched_set.py`, and `receipts/{before.json,source-inputs.json,predeploy.json}`. The manifest anchor is `8a4c37921921ea9adb866c89f9447eb2298ccffaec817fcb56fd2ef5ce71947d`. Every original/staged recovery member is validated against that anchor. The dependency hashes are recorded in `recovery-v2/dependency-closure.json` and the project cleanup receipt. The driver also depends on the original task5 protected preflight, which remains retained and unchanged. Keeping `recovery-v2` alone would break the current driver's fixed BASE paths.

If a future authorized rollback is necessary, first re-establish the exact M1 identity and current service state, then run the retained BASE driver:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B \
  /private/tmp/hermes-control-center-m1-01a161c0/task-15/deploy.py restore \
  8a4c37921921ea9adb866c89f9447eb2298ccffaec817fcb56fd2ef5ce71947d
```

This is the guarded restore invocation, not a command to run merely for validation. It refuses unrelated source/service drift or current bytes outside each declared before/after state, restores the prior complete matched set including deleted files and original absence of new assets, restarts only the dashboard, and checks readiness and hashes. It performs no business database rollback. Investigate guard refusal; never generate new expected-current hashes from arbitrary later state to bypass it. The operations are sequential guarded file replacements, not a multi-file atomic transaction or filesystem compare-and-swap. A synthetic partial-write failure exercised complete rollback with the same helper; live production rollback was not needed or executed.

## Historical task 5 checkpoint

The captured installation is 0.22.3, commit `5b147ab036d6d19131bff8d20701b5001eab844a`; the running PID 62892 reports 0.22.1. Source is dirty. The snapshot preserves those actual bytes; it does not reconstruct a clean checkout from Git. Runtime and installation identity are independent. HTTP `overall: ok` is not UI readiness: scoped Kanban and Achievements asset routes currently return 404.

**Parser correction:** public help hides `--tui`, but installed `hermes_cli/subcommands/dashboard.py:86-90` accepts it as an ignored compatibility option. Direct `parse_known_args` returns no unsupported arguments. The earlier help-only inference that it was unsupported is superseded. Preserve the original plist arguments unless a fresh native parser check rejects them.

## Invocation and identity

On-host use must be explicit because the M1's `m1-pro-file` self-SSH alias is not established. The CLI checks hardware, hostname, user and UID before any output directory or recovery write. No SSH trust is weakened or user-global SSH configuration changed.

```sh
cd /private/tmp/hermes-control-center-m1-01a161c0/task-5/code
export TMPDIR=/private/tmp/hermes-control-center-m1-01a161c0/task-5/scratch
export PYTHONDONTWRITEBYTECODE=1
python3 scripts/ops/hermes-dashboard-preflight.py --help
python3 scripts/ops/hermes-dashboard-preflight.py --local-runtime \
  --service gui/501/com.beomsu.hermes-dashboard \
  --out /private/tmp/hermes-control-center-m1-01a161c0/task-5/receipts
```

First capture refuses an existing recovery directory. After the initial snapshot, add `--recheck`: it verifies every installed asset still matches the checkpoint, rereads identity/process/parser/routes, and refreshes safe receipts. From an already trusted calling host, the staged CLI also supports `--host m1-pro-file --recheck --out LOCAL_RECEIPTS`; it uses strict SSH and retrieves only the two JSON projections. It does not deploy code automatically. Stage only these scripts and the fixture first through the established trusted connection. Tests and live checks run on M1 only.

Every subprocess has a deadline (15 seconds by default; HTTP 5 seconds; remote transport envelope 180 seconds), a 2 MiB output cap, a separate process group, and discarded stderr. Timeout kills and reaps its process group. Temporary output files use the owned TMPDIR. No health response bodies, process command body, credential-bearing config, session token, or environment dump is persisted.

Git inspection uses `--no-optional-locks` so status cannot refresh the index. The first development probe omitted this flag and left a 2 MiB `index.lock` when its output/file-size bound terminated Git. Its exact size, uid, matching creation time and absence of an open holder identified it; the task removed that temporary lock and recorded unchanged real-index SHA-256 before/after. Lock inode/hash and a second immediate stat were not captured, so cleanup attribution has that explicit evidence limitation. See `git-probe-cleanup.json`.

## Retained protected assets

Recovery root: `/private/tmp/hermes-control-center-m1-01a161c0/task-5/recovery`, owned by uid 501, mode 0700; each numbered asset is mode 0600. The manifest records each original absolute path, actual copied byte count/SHA-256, original mode, and restore eligibility. It includes 1,115 files: dashboard backend/router/parser sources, installed frontend and frontend source/build inputs, Kanban and Achievements bundles, OMH API/manifest, launchers, installation stamp and launch plist. The config is a protected operator reference copy and is excluded from automatic restoration. Board databases/WAL/SHM are excluded. The 9120 proxy and every private Serve mapping are observed and hashed, never changed.

The protected runnable recovery code is retained under `recovery/scripts/ops/`. Project evidence contains safe hashes/projections only. Do not copy numbered backup bodies into the workspace. Do not remove this root until tasks 14/15 have accepted a durable recovery handoff.

Checkpoint membership is independent of the current installed file inventory. This original checkpoint's manifest is pinned to SHA-256 `3c2b4c855bca73c2163d419b2c05abf10bff7fdf2d35710c8a8323dc17b58e04`, independently retained before repair attempt 2 and matched against the protected manifest. New scratch snapshots receive a protected `manifest.sha256` anchor. Validation checks that anchor, parses the complete manifest into typed entries, checks each canonical destination against fixed allowed source/config locations, then verifies every protected asset. It never enumerates live files to decide checkpoint membership.

Deleted checkpoint members can therefore be restored. Newly introduced files, including new content-hashed frontend assets, are left untouched and cannot appear in expected-current unless they were checkpoint members. The change owner must separately account for its additions; this command does not delete unrelated or newly created files. `--recheck` still requires the live checkpoint members to match their original hashes and therefore refuses a damaged installation; `--restore-check` validates recovery independently of missing live files.

## Validated current-installation fallback

The native parser accepts the original command:

```sh
/Users/beomsu/.local/bin/hermes dashboard --host 127.0.0.1 --port 9119 --no-open --tui
```

This is the supervisor's command, **not a command to run alongside the existing service**. Preflight directly loads the parser source, compiles installed dashboard Python sources without writing bytecode, imports FastAPI/Uvicorn/Pydantic/YAML from the committed dependency generation with its own Python, and verifies the complete copied artifact set. It does not claim successful server startup or browser readiness; task 14 must prove that after its authorized restart.

The launcher and `hermes_bootstrap` can repair interrupted updates and synchronize dependency environments. Do not use their nominally read-only entry points for repeated diagnosis. Initial public-help inspection ran once before this caveat was discovered; subsequent checks use the side-effect-free parser and direct dependency imports. Current source hashes and dirty status were independently checked afterward.

No runnable 0.22.1 backend artifact has been captured. The existing in-memory process cannot be resurrected after termination. Recovery uses the protected **current 0.22.3 installation** and existing committed dependencies; it does not roll back to 0.22.1 or roll back board data.

## Restoration, reserved for the change owner

First validate the complete backup without writing live files:

```sh
python3 /private/tmp/hermes-control-center-m1-01a161c0/task-5/recovery/scripts/ops/hermes-dashboard-preflight.py \
  --local-runtime --service gui/501/com.beomsu.hermes-dashboard --restore-check
```

Before mutation, the change owner must retain its exact post-change state for every restore-eligible destination as a JSON object `{absolute_path: sha256_or_null}`. Unchanged destinations keep their checkpoint hash; changed destinations use the exact planned output hash, checked immediately after that owned change. JSON `null` explicitly means the owner deleted this checkpoint member and expects it still to be absent. A hash for a missing file, or null for an existing file, is refused. Do not generate a new expected-current file from arbitrary later state: doing so would bless unrelated concurrent changes. Record it inside the protected recovery root as `expected-current-task14.json` or `expected-current-task15.json`, mode 0600.

```sh
python3 /private/tmp/hermes-control-center-m1-01a161c0/task-5/recovery/scripts/ops/hermes-dashboard-preflight.py \
  --local-runtime --service gui/501/com.beomsu.hermes-dashboard --restore \
  --expected-current /private/tmp/hermes-control-center-m1-01a161c0/task-5/recovery/expected-current-task14.json
```

Restoration rejects wrong hosts/services, altered checkpoint membership, malformed/path-escaping manifests, missing/corrupt assets, unsafe backup ownership/modes, symlink destinations/ancestors, and any current state not matching the owner's expected state before the first write. Files are replaced individually using exclusive temporary files. Absent destinations are installed with an exclusive hard link so a concurrent creator is never overwritten. Existing-file replacement is not a compare-and-swap transaction: coordinate with concurrent editors, and treat a mid-restore failure as partial. Original plist bytes are restored, including the accepted hidden `--tui` option. No service restart is performed by the CLI.

After task 14 verifies the exact service and owns the interruption, its supervisor restart command is `launchctl kickstart -k gui/501/com.beomsu.hermes-dashboard`. Task 14 must compare process identity, loopback routes, private Serve/proxy hashes and real browser registration afterward. If the owner is unloaded, reconcile that specific supervisor separately; this runbook does not authorize a broad service reset.

The fixture tests build a complete scratch layout and use the real `files()` inventory and `snapshot()` behavior. They restore deleted required/optional members, retain a newly introduced frontend asset, and refuse missing/corrupt backup, altered membership, path escape, unsafe permissions, mismatched absence, symlinks and concurrent edits/creation. Live restoration has not been executed. Cancel-state testing is inapplicable: this synchronous CLI exposes no persistent cancellation state; timeout handling is exercised with a hung child.
