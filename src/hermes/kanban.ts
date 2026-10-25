/** Kanban over SSH: each read is one POSIX sh script (sqlite3 read-only through the PRELUDE `ro`), each write one `hermes kanban` verb. */
import type { ControlCenterProcesses } from "../ui/control-center-processes";
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import { profileDir, type Outcome } from "./data";
import { b64Arg, json, readBytes, runScript, safeToken, shellCommand, STATUS, type Sections } from "./remote";
import type { Attachment, BoardRead, BoardVerb, Detail, Diagnostic, Feed, NewTask, NotifyTarget, Verb } from "./kanban-types";
import { attachRoot, boardScript, detailScript, eventsScript, HC, live, MAX_ATTACHMENT, probeScript, watchScript } from "./kanban-scripts";
import { attachmentPath, CHUNK, createArgs, fold, isRec, list, obj, outcome, parseBoard, parseCreate, parseDetail, parseDiagnostics, parseFeed, rec, replies, SLUG, str, verb } from "./kanban-parse";

export * from "./kanban-types";
export * from "./kanban-parse";
export { MAX_ATTACHMENT } from "./kanban-scripts";

/* ───────────────────────── Client ───────────────────────── */

type Captured = { ok: true; text: string } | { ok: false; message: string };

export class KanbanClient {
  /** Task id → when this client blocked it (ms); the watcher skips those for 5 min (D27). */
  readonly mine = new Map<string, number>();
  private readonly reads = new Map<string, BoardRead>();

  /** `slow` carries specify and decompose, which wait on an LLM; `processes` runs live mode's stream (watch). */
  constructor(private readonly adapter: SshReadOnlyAdapter, private readonly slow = adapter, private readonly processes?: ControlCenterProcesses) {}

  /* The in-memory side of the view's disk cache. What reaches disk is keepBoard(read) (cache.ts), a whitelist of
     card metadata and titles, the stored board entries (slug, name, description, workdir, icon, color, archived,
     counts) and the profile names, plus two layout flags of `config` (lane_by_profile, auto_decompose) written as
     the strings "true"/"false": never the rest of `config`, bodies, comment text, events or logs. `cacheData` hands
     back the full read, so a caller that saves it passes it through keepBoard first. */
  cacheKey(alias: string, slug: string, archived: boolean): string {
    return `${alias}|${slug}|${archived ? 1 : 0}`;
  }

  /** The last read for a key, in full; never save it as it is. */
  cacheData(key: string): BoardRead | undefined {
    return this.reads.get(key);
  }

  /** Seeds a key from a saved copy (its token is null, so the next live read is a full one); false (nothing kept) when the shape is off. */
  cacheRestore(key: string, data: unknown): boolean {
    const d = rec(data);
    const ok = typeof d.board === "string" && (typeof d.token === "string" || d.token === null)
      && [d.boards, d.tasks, d.profiles].every(Array.isArray) && isRec(d.config);
    if (ok) this.reads.set(key, d as unknown as BoardRead);
    return ok;
  }

  /** The single fetch entry point: sends the cached token, so an unchanged board answers without its tasks. */
  async board(alias: string, slug: string, archived: boolean, force = false): Promise<BoardRead | string> {
    const cached = this.reads.get(this.cacheKey(alias, slug, archived));
    const result = await runScript(this.adapter, alias, boardScript(slug, force ? null : cached?.token ?? null, archived));
    if (!result.ok) return result.message;
    const read = parseBoard(result.sections, cached?.tasks);
    this.reads.set(this.cacheKey(alias, read.board, archived), read);
    return read;
  }

  /** A poll tick: one sqlite3 read of the board's token, and the full read only when it moved since the cached read; null when it did not.
   *  ponytail: only this board's db is watched, so other boards' counts, the profiles and the kanban config wait for a
   *  change here or a forced read (focus, Refresh, a write); add them to the probe if that lag matters. */
  async poll(alias: string, slug: string, archived: boolean): Promise<BoardRead | string | null> {
    const last = this.reads.get(this.cacheKey(alias, slug, archived))?.token;
    if (last) {
      const result = await runScript(this.adapter, alias, probeScript(slug));
      if (!result.ok) return result.message;
      if (result.sections.get("token") === last) return null;
    }
    return this.board(alias, slug, archived);
  }

  /** Live mode: one ssh session that answers each `tick()` with the board token, and `changed` when an answer differs from the
   *  cached read's. `tick` is false once the stream ended or a tick went 8 s without a token: live mode is down. */
  watch(alias: string, slug: string, archived: () => boolean, changed: () => void): { tick(): boolean; stop(): void } {
    const cap = 1024 * 1024;
    const argv = this.adapter.buildArgv(alias, { kind: "hermes", remoteCommand: shellCommand(watchScript(slug)), byteCap: cap, nulSeparated: false, keepStdin: true });
    let asked = 0, ended = false;
    // An hour at most; the view starts the next session at once.
    const run = this.processes!.stream("ssh", argv, { stdin: true, timeoutMs: 3_600_000, maxBytes: cap, onStderr() {}, onStdout: line => {
      // Once stopped, close flushes a partial line; it is no token.
      if (ended) return;
      // The script's status line (STATUS) closes the stream; it is no token.
      if (STATUS.test(line)) { ended = true; return; }
      // A failed read answers empty: the tick stays open, so a host whose reads keep failing drops to the poll's probe.
      if (!line) return;
      asked = 0;
      if (line !== this.reads.get(this.cacheKey(alias, slug, archived()))?.token) changed();
    } });
    void run.done.then(() => { ended = true; });
    return {
      tick: () => {
        if (ended || (asked && Date.now() - asked > 8_000)) return false;
        if (!asked) { asked = Date.now(); run.write("\n"); }
        return true;
      },
      stop: () => { ended = true; run.stop(); },
    };
  }

  async detail(alias: string, slug: string, id: string): Promise<Detail | string> {
    const result = await runScript(this.adapter, alias, detailScript(slug, id));
    return result.ok ? parseDetail(result.sections) ?? `No task ${id} on this board` : result.message;
  }

  /** The task's notify subscriptions, and each platform's home channel from the default profile's config.yaml merged like
   *  Hermes's gateway loader (gateway.platforms.*, then platforms.*, then gateway.<platform>; later wins per platform).
   *  A home channel set only in .env or gateway.json is not seen. The config never leaves the host, only hc's fields. */
  async homes(alias: string, slug: string, id: string): Promise<{ homes: NotifyTarget[]; subs: NotifyTarget[] } | string> {
    const result = await runScript(this.adapter, alias, `${live(slug)}${HC}S subs; hermes kanban --board ${safeToken(slug)} notify-list --json -- ${safeToken(id)} </dev/null || exit 1
g=$(hermes -p default config get gateway --json 2>/dev/null </dev/null)
S home1; printf '%s\\n' "$g" | hc '$.platforms'
S home2; hermes -p default config get platforms --json 2>/dev/null </dev/null | hc '$'
S home3; printf '%s\\n' "$g" | hc '$'
S end`, 256 * 1024);
    if (!result.ok) return result.message;
    const merged = { ...obj(result.sections.get("home1")), ...obj(result.sections.get("home2")), ...obj(result.sections.get("home3")) };
    const homes = Object.entries(merged).map(([platform, value]) => {
      const home = rec(value);
      return { platform, chat: str(home.chat_id), thread: str(home.thread_id), name: str(home.name) || "Home" };
    }).filter(home => home.chat).sort((a, b) => a.platform.localeCompare(b.platform));
    const subs = list<unknown>(json<unknown>(result.sections.get("subs"), null)).map(rec)
      .map(sub => ({ platform: str(sub.platform), chat: str(sub.chat_id), thread: str(sub.thread_id) }));
    return { homes, subs };
  }

  /** An attachment's bytes, only from `<board attachments>/<task id>/`: checked here, then on the host with symlinks resolved. */
  async download(alias: string, slug: string, id: string, a: Attachment, root: string | undefined): ReturnType<typeof readBytes> {
    const path = attachmentPath(a.path, root, id);
    if (!path) return { ok: false, message: "This attachment is outside the board's folder" };
    if ((a.size ?? 0) > MAX_ATTACHMENT) return { ok: false, message: "Larger than 25 MiB" };
    return readBytes(this.slow, alias, `p=${b64Arg(path)}; r=$(cd -P ${attachRoot(slug)} && pwd -P) || exit 1
d=$(cd -P "$(dirname "$p")" && pwd -P) && [ "$d" = "$r/${safeToken(id)}" ] && [ "$d/$(basename "$p")" = "$p" ] && [ -f "$p" ] && [ ! -L "$p" ] || { echo "Not an attachment of this task" >&2; exit 1; }
cat -- "$p"`, (a.size || MAX_ATTACHMENT) + 64);
  }

  /** live() stops a board without a db with a plain message; for a named board the CLI refuses too
   *  ("does not exist; create it with ..." or "is archived; refusing to recreate its database"). */
  async diagnostics(alias: string, slug: string): Promise<Record<string, Diagnostic[]> | string> {
    const result = await runScript(this.adapter, alias, `${live(slug)}S diag; hermes kanban --board ${safeToken(slug)} diagnostics --json </dev/null`, 1024 * 1024);
    return result.ok ? parseDiagnostics(result.sections.get("diag")) : result.message;
  }

  /** Watcher feed for every board; never throws, null on any failure. */
  async events(alias: string, cursors: Record<string, number>): Promise<Feed | null> {
    try {
      const result = await runScript(this.adapter, alias, eventsScript(cursors), 256 * 1024);
      return result.ok && result.sections.has("end") ? parseFeed(result.sections) : null;
    } catch {
      return null;
    }
  }

  async run(alias: string, slug: string, v: Verb): Promise<Outcome> {
    if (v.verb === "attach") {
      if (v.bytes.length > MAX_ATTACHMENT) return { ok: false, message: "Larger than 25 MiB" };
      // The bytes ride ssh's stdin into a temp file the trap removes; the size check catches a short write.
      // ponytail: one 120 s ssh call carries all the bytes, so a full 25 MiB needs ~0.2 MiB/s; chunk the upload if slow links need it
      return outcome(await runScript(this.slow, alias, `t=$(mktemp "\${TMPDIR:-/tmp}/hermes-attach.XXXXXX") || exit 1
trap 'rm -f "$t"' EXIT; trap 'exit 1' HUP INT TERM
cat > "$t" || exit 1
[ $(wc -c < "$t") -eq ${v.bytes.length} ] || { echo "Upload incomplete" >&2; exit 1; }
hermes kanban --board ${safeToken(slug)} ${verb(v)} </dev/null >/dev/null && S ok`, 64 * 1024, v.bytes));
    }
    if (v.verb === "block") this.mine.set(v.id, Date.now());
    const result = await this.kanban(alias, `--board ${safeToken(slug)} ${verb(v)}`, "", v.verb === "specify" || v.verb === "decompose" ? this.slow : this.adapter);
    if (v.verb === "block" && !result.ok) this.mine.delete(v.id);
    return result;
  }

  /** Chunks of CHUNK verbs, one script each on the slow adapter, one after another. In a chunk all archives share one
   *  CLI call and all purges another; every other verb gets its own, so each failure keeps its own stderr. A failed
   *  chunk stops the run: its own ids come back unknown (any of them may have run), the ids after it skipped, as fold() merges them. */
  async bulk(alias: string, slug: string, verbs: Verb[]): Promise<Record<string, Outcome>> {
    const board = safeToken(slug), now = Date.now(), results: Record<string, Outcome> = {};
    const put = (v: Verb, o: Outcome): void => { results[v.id] = fold(results[v.id], v.verb, o); };
    for (const v of verbs) if (v.verb === "block") this.mine.set(v.id, now);
    // ponytail: 15 running archives x ~5 s + startup is ~85 s, inside the 120 s slow adapter; raise CHUNK only with a longer timeout
    for (let i = 0; i < verbs.length; i += CHUNK) {
      const chunk = verbs.slice(i, i + CHUNK);
      const ids = (kind: "archive" | "purge") => chunk.filter(v => v.verb === kind).map(v => safeToken(v.id)).join(" ");
      const archive = ids("archive"), purge = ids("purge");
      const script = [
        archive && `S archive; hermes kanban --board ${board} archive -- ${archive} 2>&1 </dev/null; :`,
        purge && `S purge; hermes kanban --board ${board} archive --rm ${purge} 2>&1 </dev/null; :`,
        ...chunk.filter(v => v.verb !== "archive" && v.verb !== "purge").map(v => `out=$(hermes kanban --board ${board} ${verb(v)} 2>&1 </dev/null >/dev/null) && S "ok ${safeToken(v.id)}" || { S "fail ${safeToken(v.id)}"; printf '%s\\n' "$out"; }`),
      ].filter(Boolean).join("\n");
      const result = await runScript(this.slow, alias, script, 256 * 1024);
      if (!result.ok) {
        for (const v of chunk) put(v, { ok: false, unknown: true, message: result.message });
        for (const v of verbs.slice(i + CHUNK)) put(v, { ok: false, message: "Skipped: an earlier batch failed" });
        break;
      }
      // A delete's archive and purge can land in different chunks; fold() joins them as it does within one.
      for (const [v, o] of replies(result.sections, chunk)) put(v, o);
    }
    for (const v of verbs) if (v.verb === "block" && !results[v.id]?.ok) this.mine.delete(v.id);
    return results;
  }

  async create(alias: string, slug: string, t: NewTask): Promise<{ ok: true; id?: string; warning?: string } | { ok: false; message: string }> {
    const result = await this.capture(alias, `--board ${safeToken(slug)} ${createArgs(t)}`);
    if (!result.ok) return result;
    const created = parseCreate(result.text);
    if (created.id && t.status === "blocked") this.mine.set(created.id, Date.now());
    return { ok: true, ...created };
  }

  /** The New task dialog's project choices: unarchived rows of the default home's projects.db, read-only; none when the file is
   *  missing. Binding a whole board to a project stays with the dashboard (no CLI verb sets it). */
  async projects(alias: string): Promise<{ id: string; name: string }[] | string> {
    const result = await runScript(this.adapter, alias, `[ -f "$H/projects.db" ] || exit 0
S projects; ro "$H/projects.db" <<'SQL' || exit 1
select json_group_array(json_object('id',cast(id as text),'name',coalesce(nullif(name,''),slug))) from (select * from projects where coalesce(archived,0)=0 order by coalesce(nullif(name,''),slug) collate nocase);
SQL`, 256 * 1024);
    if (!result.ok) return result.message;
    return list<unknown>(json<unknown>(result.sections.get("projects"), null)).map(rec).map(p => ({ id: str(p.id), name: str(p.name) || str(p.id) })).filter(p => p.id);
  }

  /** `dispatch --max=8`, summarised to its Spawned / Skipped lines. */
  async nudge(alias: string, slug: string): Promise<Captured> {
    const result = await this.capture(alias, `--board ${safeToken(slug)} dispatch --max=8`);
    return result.ok ? { ok: true, text: result.text.split("\n").filter(line => /^(Spawned|Skipped)/.test(line)).map(line => line.replace(/\s+/g, " ").trim()).join(" · ") } : result;
  }

  /** Never `--switch`. Create refuses an existing slug or tombstone (`boards create` would revive it); settings and rm need a live board. */
  async boards(alias: string, v: BoardVerb): Promise<Outcome> {
    if (v.slug === "default" && v.verb !== "settings") return { ok: false, message: "The default board is built in" };
    if (v.verb === "create" && !SLUG.test(v.slug)) return { ok: false, message: "Slugs use lowercase letters, digits, - and _" };
    const slug = safeToken(v.slug);
    if (v.verb === "rm") return this.kanban(alias, `boards rm${v.delete ? " --delete" : ""} -- ${slug}`, live(slug));
    const guard = v.verb === "create" ? `[ -e "$H/kanban/boards/${slug}" ] && { echo "Board '${slug}' already exists" >&2; exit 1; }\n` : live(slug);
    return this.kanban(alias, `boards create --name=${b64Arg(v.name)} --description=${b64Arg(v.description)} --icon=${b64Arg(v.icon)} --color=${b64Arg(v.color)} --default-workdir=${b64Arg(v.workdir)} -- ${slug}`, guard);
  }

  /* Orchestration (O1-O8): kanban.* sits in the config.yaml LIST reads, the default profile's, so it applies to every
     board; `-p default` pins that file against a sticky active profile, and describe resolves names the same way. */

  /** null runs `config unset`. Values are profile names or true/false, stored as they are; the caller checks names against the profile list. */
  async setConfig(alias: string, key: "auto_decompose" | "orchestrator_profile" | "default_assignee", value: string | null): Promise<Outcome> {
    // SLUG also keeps a leading "-" away from the CLI's flag parser (`--help` exits 0 without writing).
    if (value !== null && !SLUG.test(value)) return { ok: false, message: `Unknown profile: ${value}` };
    const args = value === null ? `unset kanban.${key}` : `set kanban.${key} ${b64Arg(value)}`;
    return outcome(await runScript(this.adapter, alias, `hermes -p default config ${args} </dev/null >/dev/null && S ok`, 64 * 1024));
  }

  /** Each profile's profile.yaml in a section named after it, empty when missing: `profile list` prints no descriptions. */
  async profileMeta(alias: string, names: readonly string[]): Promise<Sections | string> {
    const result = await runScript(this.adapter, alias, `${names.map(p => `S ${safeToken(p)}; cat ${profileDir(p)}/profile.yaml 2>/dev/null`).join("\n")}\ntrue`);
    return result.ok ? result.sections : result.message;
  }

  /** "" clears (the CLI reads an empty --text as "show", and strips " "); null auto-generates, a model call, on the slow adapter. */
  async describe(alias: string, name: string, text: string | null): Promise<Outcome> {
    const how = text === null ? "--auto --overwrite" : `--text=${b64Arg(text.trim() || " ")}`;
    return outcome(await runScript(text === null ? this.slow : this.adapter, alias, `hermes -p default profile describe ${safeToken(name)} ${how} </dev/null >/dev/null && S ok`, 64 * 1024));
  }

  private async kanban(alias: string, args: string, guard = "", adapter = this.adapter): Promise<Outcome> {
    return outcome(await runScript(adapter, alias, `${guard}hermes kanban ${args} </dev/null >/dev/null && S ok`, 64 * 1024));
  }

  /** Like `kanban`, but hands back the CLI's combined output; on failure its last line is the message. */
  private async capture(alias: string, args: string): Promise<Captured> {
    const result = await runScript(this.adapter, alias, `out=$(hermes kanban ${args} 2>&1 </dev/null) && { S ok; printf '%s\\n' "$out"; } || { printf '%s\\n' "$out" >&2; exit 1; }`, 64 * 1024);
    if (!result.ok) return { ok: false, message: result.message };
    return result.sections.has("ok") ? { ok: true, text: result.sections.get("ok") ?? "" } : { ok: false, message: "No confirmation from host" };
  }
}
