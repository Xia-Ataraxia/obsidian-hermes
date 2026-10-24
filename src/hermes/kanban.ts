/** Kanban over SSH: each read is one POSIX sh script (sqlite3 read-only through the PRELUDE `ro`), each write one `hermes kanban` verb. */
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import type { Outcome } from "./data";
import { b64Arg, json, runScript, safeToken, type RemoteResult, type Sections } from "./remote";

/* ───────────────────────── Types ───────────────────────── */

export const STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type Status = typeof STATUSES[number];

/** One board card; times are epoch seconds. */
export interface Card {
  readonly id: string; title: string; status: Status; priority: number; readonly createdAt: number;
  assignee?: string; tenant?: string; startedAt?: number; completedAt?: number; blockKind?: string; blockRecurrences?: number;
  failures?: number; lastError?: string; heartbeatAt?: number; maxRuntime?: number; pid?: number; claimExpires?: number;
  comments?: number; parents?: number; children?: number; childrenDone?: number; text?: string; reason?: string;
}
export interface BoardMeta { slug: string; name: string; description?: string; icon?: string; color?: string; workdir?: string; archived: boolean; counts: Partial<Record<Status, number>> }
/** One board pull; `tasks` is the previous list when the token showed nothing changed. */
export interface BoardRead { board: string; token: string | null; boards: BoardMeta[]; profiles: string[]; config: Record<string, string>; tasks: Card[] }

export interface TaskRow {
  id: string; title: string; status: Status; priority: number; createdAt: number; body?: string; assignee?: string; tenant?: string;
  workspaceKind?: string; workspacePath?: string; branch?: string; project?: string; skills?: string[]; model?: string; provider?: string;
  reasoning?: string; goalMode?: number; goalMaxTurns?: number; createdBy?: string; startedAt?: number; completedAt?: number; result?: string;
  blockKind?: string; blockRecurrences?: number; failures?: number; lastError?: string; claimLock?: string; claimExpires?: number; pid?: number;
  heartbeatAt?: number; runId?: number; maxRuntime?: number; maxRetries?: number; contract?: string; idempotencyKey?: string;
}
export interface Ref { id: string; title: string; status: Status }
export interface ChildRef extends Ref { result?: string; summary?: string }
export interface TaskComment { id: number; author?: string; body: string; at: number }
export interface TaskEvent { id: number; kind: string; payload?: unknown; at: number }
export interface Run { id: number; profile?: string; status?: string; outcome?: string; summary?: string; error?: string; metadata?: unknown; startedAt?: number; endedAt?: number }
export interface Attachment { id: number; name: string; size?: number; type?: string; by?: string; at: number }
export interface Detail {
  task: TaskRow; parents: Ref[]; children: ChildRef[]; comments: TaskComment[]; eventCount: number; events: TaskEvent[]; runs: Run[];
  attachments: Attachment[]; log?: { size: number; text: string };
}
export interface Diagnostic {
  kind: string; severity: string; title: string; detail?: string;
  actions: { kind: string; label: string; payload?: unknown; suggested?: boolean }[]; count?: number; last_seen_at?: number;
}

export interface FeedRow { id: number; task: string; title?: string; kind: string; reason?: string }
export type Feed = Record<string, { name?: string; archived: boolean; max: number; rows: FeedRow[] }>;
export interface Alert { board: string; boardName: string; task: string; title: string; kind: string; reason: string; id: number }

export interface NewTask {
  title: string; body?: string; assignee?: string; parents?: string[]; workspace?: string; branch?: string; tenant?: string; priority?: number;
  status?: "triage" | "blocked"; maxRuntime?: string; maxRetries?: number; skills?: string[]; model?: string; provider?: string;
  goal?: boolean; goalMaxTurns?: number;
}
export type Verb =
  | { verb: "promote" | "archive" | "purge" | "specify" | "decompose"; id: string }
  | { verb: "unblock" | "reopen-review" | "reclaim" | "schedule"; id: string; reason?: string }
  | { verb: "block"; id: string; kind?: "capability" | "dependency" | "needs_input" | "transient"; reason: string }
  | { verb: "complete"; id: string; summary?: string; result?: string; force?: boolean }
  | { verb: "request-review"; id: string; force?: boolean }
  | { verb: "assign" | "reassign"; id: string; profile: string | null; reason?: string }
  | { verb: "set-model"; id: string; model: string | null; provider?: string }
  | { verb: "edit"; id: string; title?: string; body?: string; priority?: number }
  | { verb: "link" | "unlink"; id: string; child: string }
  | { verb: "comment"; id: string; text: string }
  | { verb: "attach-rm"; id: string; attachment: number };
/** `settings` rewrites a live board through `boards create` (there is no edit verb); `rm` archives it. */
export type BoardVerb =
  | { verb: "create" | "settings"; slug: string; name: string; description: string; icon: string; color: string; workdir: string }
  | { verb: "rm"; slug: string };
export type Drop = "promote" | "unblock" | "reopen-review" | "reclaim" | "block" | "complete" | "archive";

/* ───────────────────────── Scripts ───────────────────────── */

const dbPath = (slug: string): string => slug === "default" ? `"$H/kanban.db"` : `"$H/kanban/boards/${safeToken(slug)}/kanban.db"`;
/** Stops a script on a board without a db, with a plain message. sqlite3 reads need it, and so does `boards create`
 *  (settings reuse it), which revives an archived board; the CLI itself refuses to recreate a named board's db. */
const live = (slug: string): string => `[ -f ${dbPath(slug)} ] || { echo "Board '${safeToken(slug)}' has no database" >&2; exit 1; }\n`;

/** Board list with per-status counts, assignable profiles and the config's kanban block. */
const LIST = String.raw`counts() { ro "$1" <<'SQL'
select json_group_object(status,n) from (select status,count(*) n from tasks group by status);
SQL
}
S "meta default"; cat "$H/kanban/boards/default/board.json" 2>/dev/null
[ -f "$H/kanban.db" ] && { S "counts default"; counts "$H/kanban.db"; }
for d in "$H"/kanban/boards/*/; do
  s=$(basename "$d")
  case "$s" in _*|default|*[!A-Za-z0-9_.-]*) continue;; esac
  [ -f "$d/board.json" ] || [ -f "$d/kanban.db" ] || continue
  S "meta $s"; cat "$d/board.json" 2>/dev/null
  [ -f "$d/kanban.db" ] && { S "counts $s"; counts "$d/kanban.db"; }
done
S profiles; for d in "$H"/profiles/*/; do s=$(basename "$d"); [ "$s" != default ] && [ -f "$d/config.yaml" ] && echo "$s"; done
S config; awk '/^kanban:/{f=1;next} f&&/^[^ #]/{exit} f' "$H/config.yaml" 2>/dev/null | grep -viE 'key|token|secret|pass' || true`;

// ponytail: token = last event id + task count, so heartbeat and claim changes wait for the next event (D29)
function boardScript(slug: string, last: string | null, archived: boolean): string {
  return String.raw`${LIST}
db=${dbPath(slug)}; b=${safeToken(slug)}; last=${b64Arg(last ?? "")}
[ -f "$db" ] || { db="$H/kanban.db"; b=default; last=; }
S board; echo "$b"
if [ -f "$db" ]; then
tok=$(ro "$db" <<'SQL'
select coalesce((select max(id) from task_events),0)||'.'||(select count(*) from tasks);
SQL
) || exit 1
S token; echo "$tok"
[ "$tok" = "$last" ] || { S tasks; ro "$db" <<'SQL' || exit 1
with sm as (select task_id, summary from (select task_id, summary, row_number() over (partition by task_id order by coalesce(ended_at,started_at) desc, id desc) rn
              from task_runs where summary is not null and summary<>'') where rn=1),
  kids as (select l.parent_id id, count(*) total, sum(c.status='done') done from task_links l join tasks c on c.id=l.child_id group by l.parent_id),
  ups as (select child_id id, count(*) n from task_links group by child_id),
  cm as (select task_id id, count(*) n from task_comments group by task_id)
select json_group_array(json_patch('{}',json_object(
  'id',t.id,'title',t.title,'assignee',t.assignee,'status',t.status,'priority',t.priority,'tenant',t.tenant,
  'createdAt',t.created_at,'startedAt',coalesce(r.started_at,t.started_at),'completedAt',t.completed_at,
  'blockKind',t.block_kind,'blockRecurrences',nullif(t.block_recurrences,0),'failures',nullif(t.consecutive_failures,0),
  'lastError',substr(t.last_failure_error,1,120),'heartbeatAt',t.last_heartbeat_at,'maxRuntime',t.max_runtime_seconds,
  'pid',t.worker_pid,'claimExpires',t.claim_expires,
  'comments',nullif(cm.n,0),'parents',nullif(ups.n,0),'children',kids.total,'childrenDone',kids.done,
  'text',nullif(trim(substr(coalesce(t.body,''),1,150)||' '||substr(coalesce(t.result,''),1,75)||' '||substr(coalesce(sm.summary,''),1,75)),''),
  'reason',case when t.status in ('blocked','triage') then (select case when json_valid(e.payload) then substr(coalesce(json_extract(e.payload,'$.reason'),json_extract(e.payload,'$.error')),1,200) end
     from task_events e where e.task_id=t.id and e.kind in ('blocked','block_loop_detected','gave_up','timed_out','crashed') order by e.id desc limit 1) end)))
from tasks t left join task_runs r on r.id=t.current_run_id left join sm on sm.task_id=t.id left join kids on kids.id=t.id
  left join ups on ups.id=t.id left join cm on cm.id=t.id
where t.status<>'archived' or ${archived ? 1 : 0};
SQL
}
fi
S end`;
}

// ponytail: the log is the last 100 KB only; page backwards if long runs need more
function detailScript(slug: string, id: string): string {
  const tid = `'${safeToken(id)}'`;
  const log = slug === "default" ? `"$H/kanban/logs/${safeToken(id)}.log"` : `"$H/kanban/boards/${safeToken(slug)}/logs/${safeToken(id)}.log"`;
  return String.raw`${live(slug)}S detail; ro ${dbPath(slug)} <<'SQL' || exit 1
select json_patch('{}',json_object(
 'task',json((select json_patch('{}',json_object('id',id,'title',title,'body',body,'assignee',assignee,'status',status,'priority',priority,'tenant',tenant,
   'workspaceKind',workspace_kind,'workspacePath',workspace_path,'branch',branch_name,'project',project_id,
   'skills',case when json_valid(skills) then json(skills) end,'model',model_override,'provider',provider_override,
   'reasoning',reasoning_effort,'goalMode',goal_mode,'goalMaxTurns',goal_max_turns,'createdBy',created_by,'createdAt',created_at,'startedAt',started_at,'completedAt',completed_at,
   'result',result,'blockKind',block_kind,'blockRecurrences',block_recurrences,'failures',consecutive_failures,'lastError',last_failure_error,
   'claimLock',claim_lock,'claimExpires',claim_expires,'pid',worker_pid,'heartbeatAt',last_heartbeat_at,'runId',current_run_id,
   'maxRuntime',max_runtime_seconds,'maxRetries',max_retries,'contract',completion_contract,'idempotencyKey',idempotency_key)) from tasks where id=${tid})),
 'parents',json((select json_group_array(json_object('id',t.id,'title',t.title,'status',t.status)) from task_links l join tasks t on t.id=l.parent_id where l.child_id=${tid})),
 'children',json((select json_group_array(json_patch('{}',json_object('id',t.id,'title',t.title,'status',t.status,'result',substr(t.result,1,600),'summary',
   (select substr(summary,1,600) from task_runs r where r.task_id=t.id and summary<>'' order by coalesce(ended_at,started_at) desc, id desc limit 1))))
   from task_links l join tasks t on t.id=l.child_id where l.parent_id=${tid})),
 'comments',json((select json_group_array(json_patch('{}',json_object('id',id,'author',author,'body',body,'at',created_at))) from (select * from task_comments where task_id=${tid} order by created_at,id))),
 'eventCount',(select count(*) from task_events where task_id=${tid}),
 'events',json((select json_group_array(json_patch('{}',json_object('id',id,'kind',kind,'payload',case when json_valid(payload) then json(payload) end,'at',created_at)))
   from (select * from task_events where task_id=${tid} order by id desc limit 20))),
 'runs',json((select json_group_array(json_patch('{}',json_object('id',id,'profile',profile,'status',status,'outcome',outcome,'summary',summary,'error',substr(error,1,600),
   'metadata',case when json_valid(metadata) then json(metadata) end,'startedAt',started_at,'endedAt',ended_at))) from (select * from task_runs where task_id=${tid} order by started_at,id))),
 'attachments',json((select json_group_array(json_patch('{}',json_object('id',id,'name',filename,'size',size,'type',content_type,'by',uploaded_by,'at',created_at))) from task_attachments where task_id=${tid}))));
SQL
f=${log}; [ -f "$f" ] && { S log; wc -c < "$f"; tail -c 100000 "$f"; }
S end`;
}

// ponytail: 50 newest stuck events per board per tick; older ones in a burst are skipped
const EVENTS = String.raw`ev() { c=$(cur "$1"); [ -f "$2" ] || return 0; [ -f "$3" ] && { S "meta $1"; cat "$3"; }; S "events $1"; ro "$2" <<SQL
select json_object('max',coalesce((select max(id) from task_events),0),'rows',json((select json_group_array(json_patch('{}',json_object('id',e.id,'task',e.task_id,'title',t.title,'kind',e.kind,
  'reason',case when json_valid(e.payload) then substr(coalesce(json_extract(e.payload,'\$.reason'),json_extract(e.payload,'\$.error')),1,200) end)))
  from (select * from task_events where $c >= 0 and id > $c and kind in ('blocked','block_loop_detected','gave_up','crashed','timed_out') order by id desc limit 50) e left join tasks t on t.id=e.task_id)));
SQL
}
ev default "$H/kanban.db" "$H/kanban/boards/default/board.json"
for d in "$H"/kanban/boards/*/; do s=$(basename "$d"); case "$s" in _*|default|*[!A-Za-z0-9_.-]*) continue;; esac; ev "$s" "$d/kanban.db" "$d/board.json"; done
S end`;

/** Unknown boards get cursor -1: the first read only seeds `max`. */
function eventsScript(cursors: Record<string, number>): string {
  const arms = Object.entries(cursors).flatMap(([slug, n]) => {
    try { return Number.isSafeInteger(n) && n >= 0 ? [`${safeToken(slug)}) echo ${n};;`] : []; } catch { return []; }
  });
  return `cur() { case "$1" in ${arms.join(" ")} *) echo -1;; esac; }\n${EVENTS}`;
}

/* ───────────────────────── Parsers ───────────────────────── */

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rec = (value: unknown): Record<string, unknown> => isRec(value) ? value : {};
const obj = (text: string | undefined): Record<string, unknown> => rec(json<unknown>(text, null));
const str = (value: unknown): string => typeof value === "string" ? value : "";
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export function parseBoard(sections: Sections, previous: Card[] = []): BoardRead {
  const boards: BoardMeta[] = [];
  for (const [section, text] of sections) {
    if (!section.startsWith("meta ")) continue;
    const slug = section.slice(5), meta = obj(text);
    const description = str(meta.description), icon = str(meta.icon), color = str(meta.color), workdir = str(meta.default_workdir);
    boards.push({
      slug, name: str(meta.name).trim() || (slug === "default" ? "Default" : slug),
      ...(description ? { description } : {}), ...(icon ? { icon } : {}), ...(color ? { color } : {}), ...(workdir ? { workdir } : {}),
      archived: meta.archived === true, counts: obj(sections.get(`counts ${slug}`)),
    });
  }
  const config: Record<string, string> = {};
  for (const line of (sections.get("config") ?? "").split("\n")) {
    const [, key, text = ""] = /^\s*([\w.-]+):\s*(.*?)\s*$/.exec(line) ?? [];
    // A quoted value runs to its closing quote, else ` #` starts a comment. ponytail: no YAML escapes (\" or '') inside quotes.
    const value = /^(["'])(.*?)\1/.exec(text)?.[2] ?? text.replace(/(^|\s)#.*$/, "").trim();
    if (key && value) config[key] = value;
  }
  const raw = sections.get("tasks"), parsed = json<unknown>(raw, null), broken = raw !== undefined && !Array.isArray(parsed);
  const token = broken ? null : sections.get("token") || null;
  return {
    board: sections.get("board") || "default", token, boards, config,
    profiles: (sections.get("profiles") ?? "").split("\n").map(name => name.trim()).filter(Boolean),
    tasks: Array.isArray(parsed) ? parsed as Card[] : broken || token ? previous : [],
  };
}

function parseDetail(sections: Sections): Detail | null {
  const detail = obj(sections.get("detail")), log = sections.get("log");
  if (!isRec(detail.task)) return null;
  const cut = log?.indexOf("\n") ?? -1;
  return {
    task: detail.task as unknown as TaskRow, parents: list(detail.parents), children: list(detail.children), comments: list(detail.comments),
    eventCount: typeof detail.eventCount === "number" ? detail.eventCount : 0, events: list(detail.events), runs: list(detail.runs),
    attachments: list(detail.attachments),
    ...(log === undefined ? {} : { log: { size: Number.parseInt(log, 10) || 0, text: cut < 0 ? "" : log.slice(cut + 1) } }),
  };
}

function parseFeed(sections: Sections): Feed {
  const feed: Feed = {};
  for (const [section, text] of sections) {
    if (!section.startsWith("events ")) continue;
    const slug = section.slice(7), events = obj(text), meta = obj(sections.get(`meta ${slug}`)), name = str(meta.name).trim();
    if (typeof events.max === "number") feed[slug] = { ...(name ? { name } : {}), archived: meta.archived === true, max: events.max, rows: list(events.rows) };
  }
  return feed;
}

/** `diagnostics --json` → task id → findings; the trailing board-level row (task_id null) is dropped. */
export function parseDiagnostics(text: string | undefined): Record<string, Diagnostic[]> {
  const out: Record<string, Diagnostic[]> = {};
  for (const row of list<unknown>(json<unknown>(text, null))) {
    const { task_id: id, diagnostics } = rec(row);
    if (typeof id === "string" && id && Array.isArray(diagnostics) && diagnostics.length) out[id] = diagnostics as Diagnostic[];
  }
  return out;
}

/** Bulk replies for one chunk. Archives share the `archive` section and purges the `purge` one: `Archived <id>` /
 *  `Deleted <id>`, else the id's own `cannot ... <id>` line, else the section's last line that names no id (a call
 *  that aborted). Any other verb: `ok <id>`, or `fail <id>` followed by that call's stderr. */
export function parseBulk(sections: Sections, verbs: Verb[]): Record<string, Outcome> {
  const last = (lines: string[]) => lines.filter(Boolean).pop() || "No confirmation from host";
  return Object.fromEntries(verbs.map(({ verb: kind, id }): [string, Outcome] => {
    if (kind !== "archive" && kind !== "purge") return [id, sections.has(`ok ${id}`) ? { ok: true }
      : { ok: false, message: last((sections.get(`fail ${id}`) ?? "").split("\n").map(line => line.trim())) }];
    const lines = (sections.get(kind) ?? "").split("\n").map(line => line.trim());
    if (lines.includes(`${kind === "archive" ? "Archived" : "Deleted"} ${id}`)) return [id, { ok: true }];
    return [id, { ok: false, message: lines.find(line => line.startsWith("cannot ") && line.split(/\s+/)[2] === id)
      ?? last(lines.filter(line => !/^(Archived|Deleted|cannot) /.test(line))) }];
  }));
}

/** `Created <id>  (<status>, assignee=<x>)`, plus the CLI's warning when no dispatcher will pick a ready task up. */
export function parseCreate(text: string): { id?: string; warning?: string } {
  const id = /^Created (\S+)/m.exec(text)?.[1], warning = /⚠️?\s*([^]*)/.exec(text)?.[1]?.trim();
  return { ...(id ? { id } : {}), ...(warning ? { warning } : {}) };
}

/* ───────────────────────── Pure logic ───────────────────────── */

/** New stuck events since each board's cursor; `now` in ms. Unseen boards seed silently, a shrunk `max` reseeds, and a
 *  board missing from this feed or archived keeps its cursor, so its old events never alert again. */
export function stuck(feed: Feed, cursors: Record<string, number>, mine: ReadonlyMap<string, number>, now: number): { alerts: Alert[]; next: Record<string, number> } {
  const alerts: Alert[] = [], next: Record<string, number> = { ...cursors };
  for (const [board, f] of Object.entries(feed)) {
    if (f.archived) continue;
    next[board] = f.max;
    const cursor = cursors[board];
    if (cursor === undefined || f.max < cursor) continue;
    const seen = new Set<string>();
    for (const row of [...f.rows].sort((a, b) => b.id - a.id)) {
      if (seen.has(row.task)) continue;
      seen.add(row.task);
      if (now - (mine.get(row.task) ?? -Infinity) < 300_000) continue;
      alerts.push({ board, boardName: f.name || (board === "default" ? "Default" : board), task: row.task, title: row.title ?? row.task, kind: row.kind, reason: row.reason ?? "", id: row.id });
    }
  }
  return { alerts, next };
}

/** [amber, red] in seconds; running ages from its start, the rest from creation. */
const STALE: Partial<Record<Status, [number, number]>> = { ready: [3600, 86400], running: [600, 3600], blocked: [3600, 86400], todo: [604800, 2592000] };

export function staleness(card: Card, now: number): "" | "amber" | "red" {
  const limits = STALE[card.status];
  if (!limits) return "";
  const age = now - (card.status === "running" ? card.startedAt ?? card.createdAt : card.createdAt);
  return age >= limits[1] ? "red" : age >= limits[0] ? "amber" : "";
}

const DROPS: Partial<Record<Status, Partial<Record<Status, Drop>>>> = {
  ready: { todo: "promote", blocked: "unblock", scheduled: "unblock", review: "reopen-review", running: "reclaim" },
  blocked: { ready: "block", running: "block" },
  done: { ready: "complete", running: "complete", blocked: "complete", review: "complete" },
};

/** The verb a column drop runs; "refuse" where no command lands there, null where the move is locked. */
export function dropVerb(from: Status, to: Status): Drop | "refuse" | null {
  if (from === to) return null;
  if (to === "archived") return "archive";
  if (to === "triage" || to === "todo") return "refuse";
  return DROPS[to]?.[from] ?? null;
}

function int(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Not an integer: ${value}`);
  return value;
}

const flag = (name: string, value: string | undefined): string => value ? ` --${name}=${b64Arg(value)}` : "";

/** CLI arguments after `--board`; ids through safeToken, free text through b64Arg, positionals after `--`. */
export function verb(v: Verb): string {
  const id = safeToken(v.id);
  switch (v.verb) {
    // ponytail: specify/decompose wait on an LLM, so they ride the 120 s slow adapter; detach with nohup if that bites
    case "promote": case "archive": case "specify": case "decompose": return `${v.verb} -- ${id}`;
    case "purge": return `archive --rm=${id}`;
    case "unblock": case "reopen-review": case "reclaim": return `${v.verb}${flag("reason", v.reason)} -- ${id}`;
    case "schedule": return `schedule -- ${id}${v.reason ? ` ${b64Arg(v.reason)}` : ""}`;
    case "block": return `block${v.kind ? ` --kind=${safeToken(v.kind)}` : ""} -- ${id} ${b64Arg(v.reason)}`;
    case "complete": return `complete${flag("summary", v.summary)}${flag("result", v.result)}${v.force ? " --force" : ""} -- ${id}`;
    case "request-review": return `request-review${v.force ? " --force" : ""} -- ${id}`;
    case "assign": return `assign -- ${id} ${v.profile ? safeToken(v.profile) : "none"}`;
    case "reassign": return `reassign --reclaim${flag("reason", v.reason)} -- ${id} ${v.profile ? safeToken(v.profile) : "none"}`;
    case "set-model": return `set-model${flag("provider", v.provider)} -- ${id} ${v.model ? b64Arg(v.model) : "none"}`;
    case "edit": return `edit${flag("title", v.title)}${v.body === undefined ? "" : ` --body=${b64Arg(v.body)}`}${v.priority === undefined ? "" : ` --priority=${int(v.priority)}`} -- ${id}`;
    case "link": case "unlink": return `${v.verb} -- ${id} ${safeToken(v.child)}`;
    case "comment": return `comment --author=obsidian -- ${id} ${b64Arg(v.text)}`;
    case "attach-rm": return `attach-rm -- ${int(v.attachment)}`;
  }
}

function createArgs(t: NewTask): string {
  return "create --created-by=obsidian"
    + (t.status === "triage" ? " --triage" : t.status === "blocked" ? " --initial-status=blocked" : "")
    + flag("body", t.body) + (t.assignee ? ` --assignee=${safeToken(t.assignee)}` : "")
    + (t.parents ?? []).map(parent => ` --parent=${safeToken(parent)}`).join("")
    + flag("workspace", t.workspace) + flag("branch", t.branch) + flag("tenant", t.tenant)
    + (t.priority === undefined ? "" : ` --priority=${int(t.priority)}`)
    + (t.maxRuntime ? ` --max-runtime=${safeToken(t.maxRuntime)}` : "")
    + (t.maxRetries === undefined ? "" : ` --max-retries=${int(t.maxRetries)}`)
    + (t.skills ?? []).map(skill => ` --skill=${b64Arg(skill)}`).join("")
    + flag("model", t.model) + (t.model ? flag("provider", t.provider) : "")
    + (t.goal ? ` --goal${t.goalMaxTurns === undefined ? "" : ` --goal-max-turns=${int(t.goalMaxTurns)}`}` : "")
    + ` -- ${b64Arg(t.title)}`;
}

const outcome = (result: RemoteResult): Outcome =>
  result.ok && result.sections.has("ok") ? { ok: true } : { ok: false, message: result.ok ? "No confirmation from host" : result.message };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Verbs per bulk script; the ceiling is in bulk(). */
const CHUNK = 15;

/* ───────────────────────── Client ───────────────────────── */

type Captured = { ok: true; text: string } | { ok: false; message: string };

export class KanbanClient {
  /** Task id → when this client blocked it (ms); the watcher skips those for 5 min (D27). */
  readonly mine = new Map<string, number>();
  private readonly reads = new Map<string, BoardRead>();

  /** `slow` carries specify and decompose, which wait on an LLM. */
  constructor(private readonly adapter: SshReadOnlyAdapter, private readonly slow = adapter) {}

  /* Disk-cache hooks; chunk 5 wires them to disk. */
  cacheKey(alias: string, slug: string, archived: boolean): string {
    return `${alias}|${slug}|${archived ? 1 : 0}`;
  }

  /** The last read for a key, already plain JSON. */
  cacheData(key: string): BoardRead | undefined {
    return this.reads.get(key);
  }

  /** Seeds a key from disk; false (nothing kept) when the shape is off. */
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

  async detail(alias: string, slug: string, id: string): Promise<Detail | string> {
    const result = await runScript(this.adapter, alias, detailScript(slug, id));
    return result.ok ? parseDetail(result.sections) ?? `No task ${id} on this board` : result.message;
  }

  /** Only where the board's db exists: the CLI's `init_db` would create a missing one. */
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
    if (v.verb === "block") this.mine.set(v.id, Date.now());
    const result = await this.kanban(alias, `--board ${safeToken(slug)} ${verb(v)}`, "", v.verb === "specify" || v.verb === "decompose" ? this.slow : this.adapter);
    if (v.verb === "block" && !result.ok) this.mine.delete(v.id);
    return result;
  }

  /** Chunks of CHUNK verbs, one script each on the slow adapter, one after another. In a chunk all archives share one
   *  CLI call and all purges another; every other verb gets its own, so each failure keeps its own stderr. A failed
   *  chunk stops the run, and the ids after it come back skipped. */
  async bulk(alias: string, slug: string, verbs: Verb[]): Promise<Record<string, Outcome>> {
    const board = safeToken(slug), now = Date.now(), results: Record<string, Outcome> = {};
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
        for (const v of chunk) results[v.id] = { ok: false, message: result.message };
        for (const v of verbs.slice(i + CHUNK)) results[v.id] = { ok: false, message: "Skipped: an earlier batch failed" };
        break;
      }
      Object.assign(results, parseBulk(result.sections, chunk));
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
    if (v.verb === "rm") return this.kanban(alias, `boards rm -- ${slug}`, live(slug));
    const guard = v.verb === "create" ? `[ -e "$H/kanban/boards/${slug}" ] && { echo "Board '${slug}' already exists" >&2; exit 1; }\n` : live(slug);
    return this.kanban(alias, `boards create --name=${b64Arg(v.name)} --description=${b64Arg(v.description)} --icon=${b64Arg(v.icon)} --color=${b64Arg(v.color)} --default-workdir=${b64Arg(v.workdir)} -- ${slug}`, guard);
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
