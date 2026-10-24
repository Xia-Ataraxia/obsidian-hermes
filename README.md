# Hermes Control Center

Monitor and manage [Hermes Agent](https://github.com/NousResearch/hermes-agent) from Obsidian. The plugin reaches the machine that runs Hermes over SSH, through a host alias you already use.

## Features

- **Profiles canvas.** Each profile is a card with a live indicator. Profiles that work together share one edge, and its color and thickness show how active the link is. You choose what an edge means in settings or on the canvas. Cards snap to alignment and equal-spacing guides, and **Tidy up** straightens rows and columns without reshuffling your layout. Pick each profile's default model from its card.
- **Profile inspector.** Turn skills on or off and edit them. See whether a skill ships with Hermes or comes from a plugin, and sort by longest unused. Read plugin settings, with secrets masked. Turn cron jobs on or off and browse their run history. Edit SOUL and USER.
- **Kanban.** Every board on the host, with the columns of the Hermes web dashboard. Open a card for its full details; create, move, complete or block tasks. Obsidian shows a notice when a task becomes blocked.
- **Chat.** A side panel for talking to any profile. Switch agents without leaving your note.
- **Cron calendar.** Today and week views of scheduled runs.

## Requirements

- Obsidian on desktop. The plugin is desktop-only.
- An SSH host alias in your SSH config that logs in with a key, without a password prompt. The host key must already be in your `known_hosts`, so connect once from a terminal first.
- On that host: Hermes Agent with the `hermes` command on the `PATH`, and `sqlite3`.

## Getting started

1. Install and enable the plugin.
2. Open **Settings → Hermes Control Center** and add your SSH host alias. Use the plug icon to check the connection.
3. Open a view from the ribbon or the command palette: **Profiles**, **Kanban**, **Today** or **Chat**.

## Disclosures

- **Network use.** The plugin connects only to the SSH hosts you add, by running your system's `ssh` program. Each read or action runs one short POSIX shell script on that host. The script uses standard tools such as `cat`, read-only `sqlite3` queries and the `hermes` command. The plugin contacts no other service. Your Hermes agent may call model providers as you configured it; that traffic comes from your host, not from the plugin.
- **Changes on the host.** The plugin changes something only when you ask: toggling a skill, plugin or cron job, saving a skill or document, changing a Kanban task, or sending a chat message. A chat message is handled by your Hermes agent, which can use the tools you allowed it.
- **Files outside your vault.** The plugin reads no files outside your vault. Your system `ssh` reads your SSH config, keys and agent as usual; the plugin never changes them.
- **Accounts and payment.** None, apart from your own Hermes host.
- **Telemetry and ads.** None.
- **Stored data.** Settings and the canvas layout live in the plugin's `data.json`, inside your vault's `.obsidian` folder. Secrets and chat transcripts are never written to disk.

## Development

```sh
bun install
bun run build      # writes main.js and styles.css
bun run typecheck
bun test
```

Releases are built by GitHub Actions with `npm ci` and `npm run build`; both paths produce the same `main.js`.

## License

[MIT](LICENSE)
