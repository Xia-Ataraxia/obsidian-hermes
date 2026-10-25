# Hermes Control Center

Monitor and manage remote Hermes Agent profiles over SSH: kanban boards, a profile canvas, skills, cron jobs and chat.

![Hermes Control Center: a kanban board with sample data, the Connections settings where you add an SSH host alias, and the chat panel in its "No SSH host" start state. No real host is connected.](https://raw.githubusercontent.com/Xia-Ataraxia/obsidian-hermes/main/docs/assets/demo.webp)

## Features

- Profiles canvas: each [Hermes Agent](https://github.com/NousResearch/hermes-agent) profile as a card with activity sparkline, token and cost totals, and edges that show how much profiles work together.
- Profile popup to browse sessions, turn skills and cron jobs on or off, and edit the Soul, User and Memory documents.
- Kanban for every board on the host, with live updates and notices when a task gets stuck.
- Chat side panel to talk to any profile: type `/` for a skills menu, see what is running right now in a live strip under the log, and keep typing while a turn runs, because messages queue above the composer and send in order.
- Cron calendar with today and week views.

## Usage

1. Add an SSH host alias in **Settings**, **Hermes Control Center**, then select the plug icon to check the connection. The alias must log in with a key, without a password prompt, and its host key must already be in your `known_hosts`.
2. The host needs Hermes Agent with the `hermes` command on the `PATH`, and `sqlite3`.
3. Open a view from the ribbon or the command palette: **Open profiles**, **Open kanban**, **Open chat**, **Open today timeline**, or **Open week calendar**.

## Installation

Desktop only, because the plugin runs your system's `ssh`.

**Community plugins**: open Settings, Community plugins, Browse, search for "Hermes Control Center", then Install and Enable.

**Manual**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Xia-Ataraxia/obsidian-hermes/releases/latest) into `<vault>/<configDir>/plugins/hermes-control-center/`, then enable the plugin. `<configDir>` is your vault's configuration folder (`.obsidian` by default).

## Disclosures

- **Network use**: the plugin connects only to the SSH hosts you add, by running your system's `ssh` program. Each read or action runs one short POSIX shell script on that host, using standard tools such as `cat`, read-only `sqlite3` queries and the `hermes` command. While a Kanban board is open, one SSH session stays open and about three times a second asks the board's database, read-only, whether anything changed. No other service is contacted. Your Hermes agent may call model providers as you configured it; that traffic comes from your host, not from the plugin.
- **Changes on the host**: only when you ask: toggling a skill, plugin or cron job, saving a skill or document, changing a Kanban task or board, or sending a chat message. A chat message is handled by your Hermes agent, which can use the tools you allowed it.
- **Files outside the vault**: none are read by the plugin. Your system `ssh` reads your SSH config, keys and agent as usual.
- **Account or payment**: none, apart from your own Hermes host.
- **Stored data**: settings and the canvas layout are in the plugin's `data.json`. Last-seen boards (card titles only), profiles, schedules and skill rows are cached in the plugin's `cache` folder and can be cleared from settings; secrets and chat transcripts are never written to disk.
- **Telemetry**: none.

## Development

See the [dev contract](https://github.com/GoBeromsu/obsidian-boiler-template#dev-contract): `bun run dev`, `bun run build`, `bun run ci`.

## License

[MIT](LICENSE)
