import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import type { TransportStatus } from "../types/remote-command";

/**
 * One SSH round trip per read: a POSIX `sh` script that prints `\x1e<name>` headers between
 * sections. The script travels base64-encoded so the remote login shell never parses its body;
 * every value that is not validated to a safe token travels the same way (see `b64Arg`).
 * Remote tools: sh, cat, sqlite3 (readfile + JSON1), hermes. No Python, no venv.
 */
export type Sections = ReadonlyMap<string, string>;

export type RemoteResult =
  | { readonly ok: true; readonly sections: Sections }
  | { readonly ok: false; readonly transport: TransportStatus; readonly message: string };

// `ro`: a WAL db opens -readonly only while a writer holds its -wal/-shm; without them nothing is pending, so read it immutable.
// The SQL is buffered, so a -wal that vanishes between the test and the open (CANTOPEN) falls back to immutable too.
// ponytail: immutable skips locks, so a writer starting mid-read can garble one poll; the next poll heals it.
const PRELUDE = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
H="$HOME/.hermes"
S() { printf '\\036%s\\n' "$1"; }
arg() { printf %s "$1" | base64 -d; }
ro() { q=$(cat); if [ -e "$1-wal" ] && printf '%s\\n' "$q" | sqlite3 -readonly "$1" 2>/dev/null; then :; else printf '%s\\n' "$q" | sqlite3 "file:$1?immutable=1"; fi; }
`;

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Profile ids, board slugs and task ids are interpolated only after this check. */
export function safeToken(value: string): string {
  if (!SAFE_TOKEN.test(value) || value.startsWith(".")) throw new Error(`Unsafe remote token: ${value}`);
  return value;
}

/** Free text (comments, titles, documents) as a quoted shell expression that decodes remotely. */
export function b64Arg(value: string): string {
  return `"$(arg ${Buffer.from(value, "utf8").toString("base64")})"`;
}

export function parseSections(stdout: string): Sections {
  const sections = new Map<string, string>();
  for (const chunk of stdout.split("\u001e").slice(1)) {
    const newline = chunk.indexOf("\n");
    const name = newline < 0 ? chunk : chunk.slice(0, newline);
    sections.set(name.trim(), newline < 0 ? "" : chunk.slice(newline + 1).trimEnd());
  }
  return sections;
}

export async function runScript(adapter: SshReadOnlyAdapter, alias: string, script: string, byteCap = 4 * 1024 * 1024): Promise<RemoteResult> {
  const encoded = Buffer.from(PRELUDE + script, "utf8").toString("base64");
  const outcome = await adapter.run(alias, {
    kind: "hermes",
    remoteCommand: `sh -c "$(printf %s ${encoded} | base64 -d)"`,
    byteCap,
    nulSeparated: false,
  });
  if (outcome.transport !== "connected") return { ok: false, transport: outcome.transport, message: outcome.stderr.trim() || outcome.transport };
  if (outcome.capExceeded) return { ok: false, transport: "connected", message: "Response too large" };
  if (outcome.exitCode !== 0) return { ok: false, transport: "connected", message: outcome.stderr.trim().split("\n").pop() || `Exit ${outcome.exitCode}` };
  return { ok: true, sections: parseSections(outcome.stdout) };
}

export function json<T>(text: string | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
