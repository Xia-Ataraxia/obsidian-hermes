import type { ControlCenterProcesses } from "../ui/control-center-processes";
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import { profileDir } from "./data";
import { json, runScript, safeToken, shellCommand, STATUS } from "./remote";

/* Plain JSON-serialisable state, so chunk 5 can persist it as is. */
interface Thread { id: string; source: string; title: string; at: number }
interface Row { id: number; role: "user" | "assistant"; at: number; text: string; tools: string | null }
export interface Tool { id: string; name: string; input: string; output: string | null; ms: number | null; error: boolean }
export interface Usage { in: number; out: number; ms: number }
export interface Turn { user: string; after: number | null; sid: string; code: number | null; text: string; tools: Tool[]; usage: Usage | null; error: string | null; done: boolean; refused?: boolean }
export interface ChatState { sid: string; threads: Thread[]; rows: Row[]; draft: string; turn: Turn | null; extras: Record<number, { tools: Tool[]; usage: Usage }> }

/** `YYYYMMDD_HHMMSS_<hex>` and `local-<64 hex>`; never a leading "-", so it is safe in argv and SQL; never `latest` (the CLI's alias). */
export const SESSION_ID = /^(?!latest$)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/i;
const CAP = 8 * 1024 * 1024;

/** The CLI prints `Session: <sid>` on stderr before submitting, and `session_id: <sid>` after the result. */
export function sessionFrom(line: string): string | null {
  const sid = /^(?:Session|session_id): (\S+)\s*$/.exec(line)?.[1];
  return sid && SESSION_ID.test(sid) ? sid : null;
}

interface Event {
  type?: string; id?: number; text?: string; name?: string; tool_call_id?: string; input?: unknown; output?: unknown;
  duration_ms?: number; is_error?: boolean; exit_code?: number; session_id?: string; error?: string;
  tokens?: { input?: number; output?: number };
}

/** Fold one `--format stream-json` line (hermes_cli/stream_json.py) into the turn: "text" for a delta, "turn" for any other change. */
export function reduce(turn: Turn, line: string): "text" | "turn" | null {
  const event = json<Event | null>(line, null);
  if (!event || typeof event !== "object") return null;
  switch (event.type) {
    case "after": // ours (sendScript): the newest message id before this turn, so the rows above it belong to the turn
      turn.after = event.id ?? turn.after;
      return "turn";
    case "text":
      turn.text += event.text ?? "";
      return "text";
    case "tool_use":
      turn.tools.push({ id: event.tool_call_id ?? "", name: event.name ?? "tool", input: event.input === undefined ? "" : JSON.stringify(event.input, null, 2), output: null, ms: null, error: false });
      return "turn";
    case "tool_result": {
      let tool = turn.tools.find(t => event.tool_call_id && t.id === event.tool_call_id) ?? turn.tools.find(t => t.name === event.name && t.output === null);
      if (!tool) turn.tools.push(tool = { id: event.tool_call_id ?? "", name: event.name ?? "tool", input: "", output: null, ms: null, error: false });
      tool.output = typeof event.output === "string" ? event.output : event.output === undefined ? "" : JSON.stringify(event.output, null, 2);
      tool.ms = event.duration_ms ?? null;
      tool.error = event.is_error === true;
      return "turn";
    }
    case "result":
      turn.code = event.exit_code ?? null;
      if (event.session_id && SESSION_ID.test(event.session_id)) turn.sid = event.session_id;
      turn.text = event.text || turn.text; // after a replay gap only the final text is whole
      turn.usage = event.tokens ? { in: event.tokens.input ?? 0, out: event.tokens.output ?? 0, ms: event.duration_ms ?? 0 } : null;
      turn.error = event.error || null;
      turn.done = true;
      return "turn";
    default:
      return null;
  }
}

// Reachable = the profile's own gateway pid is alive, or the live default gateway serves it: the Profiles view's
// rule (data.ts parseProfiles), as the CLI resolves it (gateway_runtime.py:289 → _served_by_multiplexer :209).
const LIVE = String.raw`gpid() { (cd "$1" 2>/dev/null && sqlite3 :memory: "select json_extract(cast(readfile('gateway_state.json') as text),'\$.pid')" 2>/dev/null); }
up() { case $1 in ''|0*|*[!0-9]*) return 1;; esac; kill -0 "$1" 2>/dev/null; }
sv=$(up "$(gpid "$H")" && cd "$H" && sqlite3 :memory: "select value from json_each(cast(readfile('gateway_state.json') as text),'\$.served_profiles')" 2>/dev/null)
live() { up "$(gpid "$1")" || printf '%s\n' "$sv" | grep -qxF -- "$2"; }
`;

function readScript(profile: string, sid: string): string {
  const db = `${profileDir(profile)}/state.db`;
  // ponytail: the tip session's last 50 active rows, 16000 chars each; no "load older", no compacted-parent stitching.
  const rows = SESSION_ID.test(sid) ? String.raw`S rows
if [ -f ${db} ]; then ro ${db} <<'Q' || printf '[]\n'
.mode json
SELECT id, role, timestamp AS at,
  substr(coalesce(content, ''), 1, 16000) || CASE WHEN length(content) > 16000 THEN ' …' ELSE '' END AS text,
  CASE WHEN json_valid(tool_calls) THEN (SELECT group_concat(coalesce(json_extract(value, '$.function.name'), json_extract(value, '$.name')), ', ')
    FROM json_each(tool_calls)) END AS tools
FROM messages WHERE session_id = '${sid}' AND active = 1 AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 50;
Q
fi
` : "";
  return LIVE + String.raw`S profiles
for d in "$H" "$H"/profiles/*; do
  [ -d "$d" ] || continue
  if [ "$d" = "$H" ]; then n=default; else n=$(basename "$d"); [ "$n" = default ] && continue; fi
  case "$n" in *[!A-Za-z0-9_.-]*|.*|-*) continue;; esac
  [ "$n" = default ] || [ -f "$d/config.yaml" ] || continue
  if live "$d" "$n"; then echo "$n 1"; else echo "$n 0"; fi
done
S threads
if [ -f ${db} ]; then ro ${db} <<'Q' || printf '[]\n'
.mode json
SELECT s.id, s.source,
  coalesce(substr(replace(nullif(s.title, ''), char(10), ' '), 1, 60),
    (SELECT substr(replace(m.content, char(10), ' '), 1, 60) FROM messages m
     WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1 ORDER BY m.id LIMIT 1), '') AS title,
  coalesce(s.last_activity_at, s.started_at) AS at
FROM sessions s
WHERE s.archived = 0 AND s.hidden = 0 AND s.source IN ('cli', 'tui', 'desktop', 'acp', 'local') AND s.message_count > 0
  AND CASE WHEN json_valid(s.model_config) THEN json_extract(s.model_config, '$._delegate_from') END IS NULL AND coalesce(s.end_reason, '') != 'compression'
ORDER BY coalesce(s.last_activity_at, s.started_at) DESC, s.started_at DESC, s.id DESC LIMIT 20;
Q
fi
` + rows;
}

/** New thread without `sid`; resume takes no creation flag (`--source` included), or the CLI exits 2. */
function sendScript(profile: string, sid: string, query: string): string {
  if (sid && !SESSION_ID.test(sid)) throw new Error(`Unsafe session id: ${sid}`);
  const id = safeToken(profile);
  const db = `${profileDir(id)}/state.db`;
  // Exit 75 instead of letting the CLI auto-start an idle-exit gateway (gateway_client.py:288).
  // ponytail: guard→connect race; a gateway that dies in between still gets that idle-exit replacement. Accepted.
  // Without `--source cli` a new thread is labelled `oneshot` and hidden from every picker.
  // The server's newest message id beats the client's (possibly stale) rows as the turn's lower bound.
  return LIVE + `live ${profileDir(id)} ${id} || { echo "Gateway is not running" >&2; exit 75; }
n=$([ -f ${db} ] && echo 'SELECT max(id) FROM messages;' | ro ${db} 2>/dev/null)
case $n in ''|*[!0-9]*) ;; *) echo '{"type":"after","id":'$n'}';; esac
arg ${Buffer.from(query, "utf8").toString("base64")} | hermes -p ${id} chat${sid ? ` --resume ${sid}` : ""} --query-file - --format stream-json${sid ? "" : " --source cli"}
`;
}

export class HermesChat {
  constructor(private readonly adapter: SshReadOnlyAdapter, private readonly processes: ControlCenterProcesses) {}

  /** Profiles with gateway liveness, the recent threads and, with a sid, its last rows (oldest first); or an error message.
   *  Never throws (an unsafe profile comes back as its message). */
  async read(alias: string, profile: string, sid: string): Promise<{ profiles: { id: string; live: boolean }[]; threads: Thread[]; rows: Row[] } | string> {
    try {
      const result = await runScript(this.adapter, alias, readScript(profile, sid));
      if (!result.ok) return result.message;
      return {
        profiles: (result.sections.get("profiles") ?? "").split("\n").flatMap(line => {
          const [id = "", live] = line.trim().split(" ");
          return id ? [{ id, live: live === "1" }] : [];
        }),
        threads: json<Thread[]>(result.sections.get("threads"), []).filter(t => typeof t.id === "string" && SESSION_ID.test(t.id)),
        rows: json<Row[]>(result.sections.get("rows"), []).reverse(),
      };
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** One turn as a stream; never throws (a refused alias, profile or sid comes back already done, with `refused`). The exit code is the
   *  script's own (its last `\x1e?<code>` line, see STATUS), since ssh exits 0; null when stopped. */
  send(alias: string, profile: string, sid: string, query: string, onStdout: (line: string) => void, onStderr: (line: string) => void): ReturnType<ControlCenterProcesses["stream"]> {
    try {
      const argv = this.adapter.buildArgv(alias, { kind: "hermes", remoteCommand: shellCommand(sendScript(profile, sid, query)), byteCap: CAP, nulSeparated: false });
      let status: number | null = null;
      const run = this.processes.stream("ssh", argv, { timeoutMs: 900_000, maxBytes: CAP, onStderr, onStdout: line => {
        const end = STATUS.exec(line);
        // Text before the status is hermes's last line, printed without a newline.
        if (end?.index) onStdout(line.slice(0, end.index));
        if (end) status = Number(end[1]);
        else onStdout(line);
      } });
      return { ...run, done: run.done.then(result => ({ ...result, exitCode: result.exitCode === null ? null : status ?? result.exitCode })) };
    } catch (error) {
      return { stop() {}, done: Promise.resolve({ exitCode: null, stderrTail: error instanceof Error ? error.message : String(error), refused: true }) };
    }
  }
}
