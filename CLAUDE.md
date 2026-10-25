# obsidian-hermes

Monitor and manage remote Hermes Agent profiles over SSH (manifest id `hermes-control-center`, desktop only).

## Commands

- `bun install`, `bun run dev` (watch), `bun run build` (-> `dist/`), `bun run ci` (build, typecheck, lint, test).
- Tests use `bun test` (`bun:test`, `bun:sqlite`); `tests/obsidian-mock.ts` is preloaded via `bunfig.toml`.
- Releases are CI-only (`ci / report` is the required check on `main`).

## Architecture

- `src/main.ts` wiring only. `src/domain/`, `src/types/`, `src/utils/` must not import `obsidian` (lint-enforced).
- `src/ui/` cron viewer (week/today views, modals, settings tab built from `getSettingDefinitions()`, requires Obsidian 1.13+).
- `src/hermes/` kanban, profiles canvas, chat, activity and inspector views over SSH; `hermes.css` + `src/ui/viewer.css` are concatenated into `dist/styles.css` by `esbuild.config.mjs`.

## Gotchas

- Never persist Hermes job or output bodies; only parsed projections go to disk (job names only when `persistJobNames` is on).
- No `!important` in CSS: scope under `.hm-view` instead of overriding Obsidian button defaults.
- Oversized modules (>500 LOC) still pending a split: `kanban-view`, `kanban-drawer`, `inspector`, `kanban`, `profiles-view`.
