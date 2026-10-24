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

export const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Profile ids, board slugs and task ids are interpolated only after this check. */
export function safeToken(value: string): string {
  if (!SAFE_TOKEN.test(value)) throw new Error(`Unsafe remote token: ${value}`);
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

// Tailscale SSH reports exit 0 for every command, so the script prints its own status last.
// eslint-disable-next-line no-control-regex -- 0x1e (record separator) marks the status line
export const STATUS = /\u001e\?(\d+)\n?$/;

/** The `sh -c` wrapper every remote script travels in, base64-encoded so the login shell never parses it: PRELUDE,
 *  the script in a subshell, then its exit status as a last `\x1e?<code>` line (see STATUS). */
export function shellCommand(script: string): string {
  const encoded = Buffer.from(`${PRELUDE}(\n${script}\n)\nprintf '\\036?%s\\n' "$?"\n`, "utf8").toString("base64");
  return `sh -c "$(printf %s ${encoded} | base64 -d)"`;
}

/** `stdin` bytes reach the script's standard input; the script itself still travels in the argv. */
export async function runScript(adapter: SshReadOnlyAdapter, alias: string, script: string, byteCap = 4 * 1024 * 1024, stdin?: Uint8Array): Promise<RemoteResult> {
  const outcome = await adapter.run(alias, {
    kind: "hermes",
    remoteCommand: shellCommand(script),
    byteCap,
    nulSeparated: false,
    ...(stdin ? { stdin } : {}),
  });
  if (outcome.transport !== "connected") return { ok: false, transport: outcome.transport, message: outcome.stderr.trim() || outcome.transport };
  if (outcome.capExceeded) return { ok: false, transport: "connected", message: "Response too large" };
  const status = STATUS.exec(outcome.stdout);
  // ponytail: no status line (a fake adapter, or a remote shell killed outright) falls back to ssh's code.
  const code = status ? Number(status[1]) : outcome.exitCode;
  if (code !== 0) return { ok: false, transport: "connected", message: outcome.stderr.trim().split("\n").pop() || `Exit ${code}` };
  return { ok: true, sections: parseSections(status ? outcome.stdout.slice(0, status.index) : outcome.stdout) };
}

/** Raw stdout bytes of a script (a binary `cat`), with the same exit-status check as `runScript`. */
export async function readBytes(adapter: SshReadOnlyAdapter, alias: string, script: string, byteCap: number): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly message: string }> {
  const outcome = await adapter.run(alias, { kind: "hermes", remoteCommand: shellCommand(script), byteCap, nulSeparated: false });
  if (outcome.transport !== "connected") return { ok: false, message: outcome.stderr.trim() || outcome.transport };
  if (outcome.capExceeded) return { ok: false, message: "Response too large" };
  const bytes = outcome.bytes ?? new Uint8Array();
  // The status line is ASCII at the very end, so latin1 maps its bytes one to one.
  const status = STATUS.exec(Buffer.from(bytes.subarray(-8)).toString("latin1"));
  if (!status) return { ok: false, message: "No exit status from host" };
  if (status[1] !== "0") return { ok: false, message: outcome.stderr.trim().split("\n").pop() || `Exit ${status[1]}` };
  return { ok: true, bytes: bytes.subarray(0, bytes.length - status[0].length) };
}

export function json<T>(text: string | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
