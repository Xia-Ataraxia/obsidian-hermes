# Hermes for Obsidian

View remote Hermes cron schedules and edit Hermes profile documents from inside Obsidian, over your existing SSH aliases.

![Release](https://img.shields.io/github/v/release/Xia-Ataraxia/obsidian-hermes) ![Desktop only](https://img.shields.io/badge/platform-desktop--only-gray)

> Plugin ID: `hermes-cron-viewer` · Desktop only · Minimum Obsidian version 1.5.0

## Features

- **Today timeline** view (right sidebar) and **Week calendar** view (tab) of Hermes cron schedules and occurrences.
- Discovers Hermes profiles on each configured SSH host alias and lets you select which sources to show.
- Job detail modal with execution history and run output reader.
- Auto-refresh (default every 60 seconds) with stale-cache indicators; snapshots are cached locally so views open instantly.
- Cron access is **read-only** over SSH.
- Narrow writable surface: edit a profile's `SOUL.md` and `memories/USER.md` only (256 KiB cap, discard confirmation).

## Installation

No community-plugin listing yet. Install manually from a [GitHub release](https://github.com/Xia-Ataraxia/obsidian-hermes/releases) or build from source:

1. Build (see [Development](#development)) to produce `main.js`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/hermes-cron-viewer/`.
3. Enable **Hermes** in Settings → Community plugins.

Requires a working `ssh` client and host aliases (e.g. in `~/.ssh/config`) that reach machines running Hermes.

## Usage

1. Open Settings → Hermes → **Connections** and add an SSH host alias.
2. Under **Profiles**, select the discovered Hermes profiles to follow.
3. Use the ribbon icon or commands:
   - `Hermes: Open today timeline`
   - `Hermes: Open week calendar`
   - `Hermes: Refresh now`
   - `Hermes: Open settings`

**Storage** settings: store job names on disk, history rows per query (default 50), and clear cached schedule metadata.

## Development

Uses [Bun](https://bun.sh).

```bash
bun install
bun run build      # bundle src/main.ts -> main.js
bun run typecheck  # tsc --noEmit
bun test           # run tests in tests/
```

## License

No LICENSE file is present in this repository yet.
