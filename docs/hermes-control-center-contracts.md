# Hermes control center native contracts

This capture describes installed source on the verified M1 Pro (`m1-pro-file`, `xia.local`, user `beomsu`), collected 2026-10-22. It does **not** attest the currently running dashboard process, network readiness, UI fidelity, or successful native mutations. Task 1 only records contracts and validates sanitized captures.

The machine-readable authority is [hermes-contracts.json](../tests/fixtures/hermes-contracts.json). It contains all 48 router decorators, exact parameter annotations/default expressions, all 18 request models, Task/Run/Comment/Event/Attachment fields, source-return expressions, explicit handler errors, 130 UI control/local-behavior dispositions, auth/workflow/skill/cron policies, and synthetic examples. Each route and control names its source path and line. Every source file has its observed SHA-256 and dirty flag. The separate apiOnlyFields section distinguishes native API capacity from rendered UI: InlineCreate has no body/tenant input; ModelEditor has no reasoning input; StatusActions has no todo/review/scheduled button; RunHistorySection has no run-state filter. These are not parity requirements.

## Provenance and drift

Installation stamp: **0.22.3**, commit `5b147ab036d6d19131bff8d20701b5001eab844a`. The stamp SHA-256 is `95449e91cdf061cd0bbf52a38cc2cd8cf17a24b1c819d92723ea48a7456ee0f6`. The repository HEAD matches, but relevant files are dirty: `cron/jobs.py`, `cron/scheduler.py`, `hermes_cli/kanban_db.py`, and `tools/skills_tool.py`. Therefore the file hashes, not HEAD alone, identify the contract. `pyproject.toml` contains the packaging placeholder 0.0.0; it is not the installation version.

| Source | SHA-256 |
| --- | --- |
| `plugins/kanban/dashboard/plugin_api.py` | `22985675c9402fcefaa84f9cc1ad2530f0d9ec9b68e3a5e6034d8c4e9b8035f5` |
| `plugins/kanban/dashboard/dist/index.js` | `c316f2e7155b288de8dd709fd8975e9dbc3af6d59a255c74039ce401fd121a3a` |
| `plugins/kanban/dashboard/dist/style.css` | `4fec2b7a06c80dedacce78a63b05dffaaa44afe20e4288693d0d13f06a1977a4` |
| `web/src/lib/api.ts` | `45e51e69b7e2edb530334979011f50927ea01ed3d8109f3479199cb2b9e486e3` |
| `web/src/plugins/sdk.d.ts` | `092b483dc1000d2de504b46d93faba88b2ea45d87a75a74265b41846a99c7417` |
| `hermes_cli/web_routers/dashboard_ui.py` | `ad5012fd8d3286b6ec481afaa4b0522f2e961fe832984778855a3f866b334c14` |
| `hermes_cli/web_server_dashboard.py` | `d01f29e78f9f2ab993df4cc2d375e667786b9830f61188242376b686360c28c6` |
| `hermes_cli/kanban_db.py` (dirty) | `0169ec83b9edcb86d5af93896278381fc61e5a9f42f972101d1422e072c940f5` |
| `hermes_cli/profiles.py` | `bf02f8442a80ce0daad0ddde130662294e6f5b26b75d2d432e4fc021dd0edf3a` |
| `cron/scheduler.py` (dirty) | `72c6a155f68f70886fbd810cd911f6799a4c4b4c7b6413491b134c7b3de79f2e` |
| `cron/jobs.py` (dirty) | `8e9190778c6ef24921f2df4593326787332d03d901a305fdbbeabf6f19de83b4` |
| `tools/skills_tool.py` (dirty) | `d7c80d57936277a527374ffa52eb4b3b3eb1baff1f4734232fb6d67e7d8858d7` |
| `hermes_cli/web_routers/skills.py` | `eddd41d6fefd4d41964d57a4d2369fd03766569ca83abb5499231efb55eb1c57` |
| `hermes_cli/web_routers/profiles.py` | `bbc827242289bdc395b9836c7e28f36e69029fad07e4d2dfa75686421d6f0eef` |
| `pyproject.toml` | `92b3277631a516ad9ad569d839b4433f1f9ea47ceebf0aaeb7d7a5358bdecae2` |
| `web/package.json` | `4f3c519cfdf7d250a6f24e9f2e638686ada3876af57fb4da516d625bda17aa81` |
| `hermes_cli/kanban_workflow.py` | `fb7f9d33dc989767ebb24424e95265862b31f6f8bf9370bd0a4d7318639a3e1d` |
| `hermes_cli/web_server.py` | `4121d69658cfa058aec0a99a37288afbc5f071eee333ac292116f1d5c615366c` |
| `hermes_cli/web_server_chat.py` | `9517bf55c0ef12927c4421108e1439e6204bb5bb8fb50cb3aa22a42cc19bd64f` |
| `agent/skill_utils.py` | `cb1996a2ef7f52f075f1a45fa64eee4ea9f332b9910da4ecc123ce0ead79fb46` |
| `hermes_cli/web_routers/status.py` | `91d723e7db56ae3c22c4b98eb964e01ea9e2d11d6e209f612d891a951068449b` |
| `cron/scheduler_prompt.py` | `6abdca325b7e56d093efb1dc950a15203f0b2fac5611f9a200700a1427424ab5` |
| `hermes_constants.py` | `870ad9935a62968636d6a14d160c0269dfbefd8091ab3cb71be78b30bef6360f` |
| `hermes_cli/__init__.py` | `6a4ab05b8621ec1cd66a5abbe30fa32ed5bddddea95903036da01f0af1af94ce` |
| `hermes_cli/web_server_profiles.py` | `f3a45f89654810a10381f19936e1295bbb4a46564f34fa01d19a7bebf50343f0` |

Two corrections supersede the planning evidence:

- `hermes_cli/kanban_workflow.py:115` defines **Triage, Todo, Scheduled, Ready, Running, Blocked, Review, Done**. The old seven-column array at `dist/index.js:90` is a frontend fallback, not the current workflow response. Fetch and validate `GET /workflow`; never silently fall back when compatibility is unknown.
- `CreateTaskBody` accepts tenant/skills/workspace fields, but `UpdateTaskBody` does not. `TaskDetail` at `dist/index.js:4028` renders these as metadata. They are create-only, then read-only; do not invent PATCH fields based on the toolbar's tooltip.

## Scope and authentication

All plugin paths below have prefix `/api/plugins/kanban`. Send `profile=default` explicitly. Send the selected `board` on every board read, write, attachment operation and socket, including `board=default`. The native default is environment/current-board/default fallback; omission is not an explicit default. Unknown board/profile returns 404; malformed names return 400. Archived boards cannot be opened. A board tab changes client scope, never the server's current-board pointer.

Loopback bootstrap is `GET /`; parse the JSON string literal assigned to `window.__HERMES_SESSION_TOKEN__` without evaluating JavaScript. The actual HTML injection is in `web_server_dashboard.py:156`, reached by the dashboard UI routing. HTTP uses `X-Hermes-Session-Token`, including binary attachment reads; WS uses `token`. `auth_required:false` does not make tokens optional. The original HTTP server also recognizes a legacy Bearer form, but this client contract uses the canonical session header.

A gated or withheld-token bootstrap is `authentication-required`, with the original dashboard offered by the later client. No OAuth/ticket/native-owner bypass is implemented here. Tokens remain memory-only; queries, headers and HTML containing credentials must not enter logs, fixtures or persistence. An expired read may rebootstrap; an ambiguous write must never automatically replay.

Common failures: 401 auth, 400 domain validation/malformed scope, 404 missing entity/board/plugin/profile, 422 request validation (FastAPI detail array), and 500 unexpected native errors. HTTPException failures use `{detail:...}`. Preserve sanitized actionable errors; network/5xx does not prove a write did not commit. Generic common-error lists are possible envelopes, not a claim that every handler raises every status.

## Route dispositions

The JSON `parameters`, `bodyModel`, `models`, `responseFields`, `returns` and `explicitErrors` hold exact machine fields/source expressions. Native annotations describe what the server accepts; `allowedBodyFields` and dispositions describe the narrower product policy. They are not permission to bypass value restrictions below.

| Method | Native path | Disposition | Body model |
| --- | --- | --- | --- |
| GET | `/board` | supported | — |
| GET | `/tasks/{task_id}` | supported | — |
| POST | `/tasks` | adapted | CreateTaskBody |
| GET | `/tasks/{task_id}/attachments` | supported | — |
| POST | `/tasks/{task_id}/attachments` | excluded | — |
| GET | `/attachments/{attachment_id}` | supported | — |
| DELETE | `/attachments/{attachment_id}` | excluded | — |
| PATCH | `/tasks/{task_id}` | adapted | UpdateTaskBody |
| DELETE | `/tasks/{task_id}` | excluded | — |
| POST | `/tasks/{task_id}/comments` | adapted | CommentBody |
| POST | `/links` | adapted | LinkBody |
| DELETE | `/links` | adapted | — |
| POST | `/tasks/bulk` | adapted | BulkTaskBody |
| GET | `/diagnostics` | supported | — |
| GET | `/workers/active` | excluded | — |
| GET | `/runs/{run_id}` | supported | — |
| GET | `/runs/{run_id}/inspect` | excluded | — |
| POST | `/runs/{run_id}/terminate` | excluded | TerminateRunBody |
| POST | `/tasks/{task_id}/reclaim` | excluded | ReclaimBody |
| POST | `/tasks/{task_id}/specify` | excluded | SpecifyBody |
| POST | `/tasks/{task_id}/reassign` | excluded | ReassignBody |
| POST | `/estimate` | excluded | EstimateBody |
| POST | `/tasks/{task_id}/estimate` | excluded | — |
| GET | `/config` | supported | — |
| GET | `/home-channels` | supported | — |
| POST | `/tasks/{task_id}/home-subscribe/{platform}` | excluded | — |
| DELETE | `/tasks/{task_id}/home-subscribe/{platform}` | excluded | — |
| GET | `/stats` | supported | — |
| GET | `/assignees` | supported | — |
| GET | `/tasks/{task_id}/log` | supported | — |
| POST | `/dispatch` | excluded | — |
| GET | `/model-options` | supported | — |
| GET | `/projects` | excluded | — |
| GET | `/boards` | supported | — |
| POST | `/boards` | excluded | CreateBoardBody |
| PATCH | `/boards/{slug}` | excluded | RenameBoardBody |
| DELETE | `/boards/{slug}` | excluded | — |
| POST | `/boards/{slug}/export` | excluded | ExportBoardBody |
| POST | `/boards/import` | excluded | ImportBoardBody |
| POST | `/boards/{slug}/switch` | excluded | — |
| GET | `/profiles` | supported | — |
| PATCH | `/profiles/{profile_name}` | excluded | DescribeBody |
| POST | `/profiles/{profile_name}/describe-auto` | excluded | DescribeAutoBody |
| POST | `/tasks/{task_id}/decompose` | excluded | DecomposeBody |
| GET | `/workflow` | supported | — |
| GET | `/orchestration` | supported | — |
| PUT | `/orchestration` | excluded | OrchestrationSettingsBody |
| WEBSOCKET | `/events` | adapted | — |

Read results include board columns/task cards and counts; task detail includes task, comments, events, attachments, parent/child IDs and summaries, runs and diagnostics. Task properties are recorded in `entitySchemas`. `GET /tasks/{id}` run filters `run_state_type` and `run_state_name` must be supplied together; type is status/outcome, otherwise 400. Log `tail` is 1..2,000,000; missing log returns `exists:false,content:""` when the task exists, despite a stale source docstring claiming 404. Attachment download rejects absent/missing/out-of-board-root blobs with 404 and returns a FileResponse. No forwarding of arbitrary URLs or paths.

Allowed writes:

- **Create:** all native CreateTaskBody fields and defaults are recorded. Required title; optional body/assignee/tenant, integer priority=0, workspace kind/path, parents=[], triage=false, idempotency key, max runtime, skills, goal mode/turn budget, model/provider/reasoning and project ID. Unknown workspace/model/domain validation is rejected natively; retain the authoritative returned task and optional warning. Idempotency lookup is not a concurrent uniqueness guarantee (`kanban_db.py:1216`).
- **PATCH:** status, assignee, priority, title, body, completion result/summary/metadata, block reason, model/provider, reasoning and explicit clear flags only. Null means absent; empty assignee unassigns; empty body clears; blank title is 400. Model clear clears model/provider together; reasoning "none" is a value and has a separate clear flag. Archived model/reasoning changes fail. Running claimed reassignment is 409. Model/reasoning changes affect a later dispatch.
- **Status:** the captured manual matrix is necessary but not sufficient. Running destination is rejected 400; native state/dependency refusal is 409. Archived source/destination is excluded even though native restore/archive exists. Review needs its native reviewer flow; done needs the upstream completion-summary dialog and confirmation. The native review→todo quirk can land in ready. Status read-back is authoritative.
- **Comments:** nonblank body, author defaults to dashboard; empty body 400, absent task404, result `{ok:true}`.
- **Dependencies:** POST parent_id/child_id; self, cycle, missing task and running child refuse400. `{ok:true,gated:true}` means the ready child was demoted to todo. DELETE uses parent_id/child_id query; `ok:false` can mean no link.
- **Bulk:** only the same allowed status/assignee/priority/model/reasoning/completion operations; `archive` and `reclaim_first` must never be forwarded. Results are per ID. HTTP200 can include failures; do not display all-success from status code alone.

PATCH commits in phases: ordinary assignee, status, model, reasoning, priority, title/body. Combined assignee+review defers assignment so the original implementer remains recorded. This is not atomic and offers no compare-and-swap contract. On failure reread each actual field and retain drafts. Excluded controls include attachment mutations, task delete/archive/restore, board administration/import/export/server switch, worker/dispatcher/reclaim controls, auxiliary LLM specify/estimate/decompose, subscription mutations and global/profile administration.

The 130-row `controls` inventory covers board/filter/search/archive/lane controls, card selection and drag, create fields/dialogs, bulk actions, every editor, native status actions, dependency controls, comments, attachments, results/events/runs/logs, diagnostics, subscriptions, orchestration/profile controls, safe documentation links and error reset. Adapted controls retain native UX with leaf-scoped dialogs, explicit identities, bounded transport, and the same client allowlist. Diagnostic command hints are copied as inert text, never executed; unknown actions are disabled.

## WebSocket and activity boundaries

`/events?profile=default&board={slug}&since={cursor}&token={secret}` binds a board at handshake. Missing/empty/malformed since starts at the current tail; explicit zero replays history and negative clamps to zero. At most 200 ordered events per 0.3-second poll, envelope `{events,cursor}`; event fields are id/task_id/run_id/kind/payload/created_at. Payload is decoded JSON, malformed becomes null. Auth failure or unknown/deleted board closes1008. Malformed board can normalize to absent natively, so reject it before transport. Buffered hosted-plugin isolation does not support this websocket contract.

The plugin's HTTP board connection calls init_db; it must never be reused as the graph's read-only SQLite collector. That later collector requires separate existing-path `mode=ro` snapshots. Creation joins tasks.created_by to the created-event assignee; assignment uses historical from/assignee; review and changes require explicit implementer/reviewer. Unknown historical attribution stays unknown. Schema drift is incomplete/unsupported, never an empty complete graph. No production event bodies were collected for this task.

## Profiles, skills and cron

Native roster is default plus valid named directories with at least one identity marker (config.yaml, .env, SOUL.md, profile.yaml, auth.json, state.db), including a marker symlink; tombstones under profiles/.deleted exclude names. Markerless cron/log shells are not profiles. Zero-cron profiles remain present.

`GET /api/skills?profile={name}` returns loadable visible skills with name/description/category/enabled/usage/provenance. `GET /api/skills/content?name={name}&profile={name}` returns name/content/path; missing skill/file404, read failure500. The catalog omits shadowed/unloadable copies and is not a full identity or session snapshot. Use the native profile-scoped reader for canonical path, configured disabled/platform selection and unresolved states; do not infer missing fields from catalog membership.

Resolution precedence: trusted project > profile-local > create_dir > external_dirs. Same-tier collisions are ambiguous except a provably identical copy with a unique best rank. The catalog resolves before visibility/disabled filtering. Provenance classification is hub > bundled > external > agent; "agent" includes hand-made local skills. Global disabled and platform disabled are unioned, with prompt-index essential skills excluded from that disabled set. Platform precedence is explicit parameter > HERMES_PLATFORM > session HERMES_SESSION_PLATFORM. Some readers have slightly different disabled checks; preserve the reader provenance. Enabled is configured selection, not proof the skill is effective in a particular session.

Cron identity is (connection, storageOwnerProfile, jobId), read from the owner's raw jobs.json. Preserve authored profile separately and label missing values inherited/unknown; the inspected scheduler resolves its active profile-scoped home rather than proving a separate per-job execution-profile override. Do not use profile=all or a cross-owner single-job fallback.

`skills` wins whenever it is not null, including [] and "". Otherwise singular `skill` is used. A string becomes a singleton; scheduler trims/removes blanks. The jobs loader additionally deduplicates and rewrites singular to the first plural entry, so preserve raw authored fields before normalization. Per-job enabled_toolsets overrides platform config when non-null; [] means zero tools including MCP, nonempty merges configured MCP, and denylists still apply. Configuration resolution failure fails closed.

Model precedence is job.model > cron.model > main config model > HERMES_MODEL; a missing model fails. Provider pin/default selection has its own native resolver. no_agent runs script only; agent jobs use script output as context. Missing workdir directory removes the cwd override. The inspector must never execute script or prompt content. Runtime-effective model/toolsets/skills remain qualified by a specific execution snapshot.

## Executable capture validation

`src/domain/native-contracts.ts` accepts a bounded JSON string (256KiB, canonical depth32) and returns a typed immutable identity/source/capability projection. It rejects missing identity/auth/workflow/routes, changed source hashes, route/model/field policy drift, unknown schema and extra fields. Its whole-capture SHA-256 is a deliberately closed review pin; object-key order and whitespace are immaterial. A supported capture is source compatibility evidence, not live authentication or a general transport allowlist.

Do not update the pin merely to make a test pass. Recapture actual source, review route/auth/workflow and policy changes, update the sanitized fixture and docs, then update the fingerprint and rerun M1 tests. No captured production token, prompt, task body or credential is needed.

On the verified M1 task-owned directory:

```sh
HERMES_CONTRACT_SOURCE=/Users/beomsu/.hermes/hermes-agent /opt/homebrew/bin/bun test tests/native-contracts.test.ts
```

The runner guards hardware/user/hostname before writes, supplies task-owned TMPDIR/cache paths, hashes transfers, captures exact invocation/exit/output, and removes only its scratch. Tests also hash the actual source files and bind every route to its native decorator. Manual data-surface QA feeds the parser valid, altered-auth, changed-workflow and unknown-schema captures. This task does not claim native API mutation/GUI QA; those belong to later isolated fixtures.

Evidence: `.omo/evidence/hermes-control-center/task-1/{source-capture.json,commands.log,contract-inventory.json,m1-validation.json,done-claim.json}`. Biome installation was declined; automatic LSP also reports no workspace TypeScript installation. Available standalone TypeScript validation is recorded separately.

### Task24 ledger executable compatibility amendment

The closed `queryExecutions` operation chooses its executable before opening the database: if the fixed `/opt/homebrew/opt/sqlite/bin/sqlite3` is executable, it executes that binary; otherwise it executes the existing `sqlite3`. Exactly one branch runs, using `exec`; a query failure is never retried through the other executable. No executable path is accepted from remote content or user input, and no dependency or PATH modification is performed.

This addresses the observed Apple SQLite 3.51.0 failure on WAL databases without coordination files. The already installed Homebrew SQLite 3.53.4 read those databases correctly. Both branches retain `-readonly -json`, a POSIX-quoted plain absolute database path, the same closed ten-column SELECT, ordering/keyset cursor and bounds. SSH behavior, the eight-operation union and missing/unavailable classifications are unchanged. Normal read-only WAL coordination files remain permitted under AC17; schema initialization, database creation, journal changes, manual production sidecar changes, repair and immutable/no-lock workarounds remain prohibited.
