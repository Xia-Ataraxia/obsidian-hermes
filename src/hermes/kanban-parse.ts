/** Parsers for the kanban scripts' replies, CLI argument builders and pure board logic. */
import { type Outcome } from "./data";
import { b64Arg, json, safeToken, type RemoteResult, type Sections } from "./remote";
import type { Alert, BoardMeta, BoardRead, Card, Detail, Diagnostic, Drop, Feed, NewTask, Status, TaskRow, Verb } from "./kanban-types";

export const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const rec = (value: unknown): Record<string, unknown> => isRec(value) ? value : {};
export const obj = (text: string | undefined): Record<string, unknown> => rec(json<unknown>(text, null));
export const str = (value: unknown): string => typeof value === "string" ? value : "";
export const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export function parseBoard(sections: Sections, previous: Card[] = []): BoardRead {
  const boards: BoardMeta[] = [];
  for (const [section, text] of sections) {
    if (!section.startsWith("meta ")) continue;
    const slug = section.slice(5), meta = obj(text);
    const description = str(meta.description), icon = str(meta.icon), color = str(meta.color), workdir = str(meta.default_workdir), project = str(meta.project_id);
    boards.push({
      slug, name: str(meta.name).trim() || (slug === "default" ? "Default" : slug),
      ...(description ? { description } : {}), ...(icon ? { icon } : {}), ...(color ? { color } : {}), ...(workdir ? { workdir } : {}), ...(project ? { project } : {}),
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

export function parseDetail(sections: Sections): Detail | null {
  const detail = obj(sections.get("detail")), log = sections.get("log"), aroot = sections.get("aroot");
  if (!isRec(detail.task)) return null;
  const cut = log?.indexOf("\n") ?? -1;
  return {
    task: detail.task as unknown as TaskRow, parents: list(detail.parents), children: list(detail.children), comments: list(detail.comments),
    eventCount: typeof detail.eventCount === "number" ? detail.eventCount : 0, events: list(detail.events), runs: list(detail.runs),
    attachments: list(detail.attachments), ...(aroot ? { attachRoot: aroot } : {}),
    ...(log === undefined ? {} : { log: { size: Number.parseInt(log, 10) || 0, text: cut < 0 ? "" : log.slice(cut + 1) } }),
  };
}

// eslint-disable-next-line no-control-regex -- control characters never belong in a path handed to the host
const CONTROL = /[\u0000-\u001f\u007f]/;

/** stored_path when it is exactly `<root>/<task id>/<file>` under the board's attachments folder, else null.
 *  Plain segments only (no `.`, `..` or empty ones); the host checks the same again with symlinks resolved. */
export function attachmentPath(stored: string | undefined, root: string | undefined, taskId: string): string | null {
  if (!stored || !root || CONTROL.test(stored + root)) return null;
  const segments = (path: string): string[] | null => {
    const parts = path.split("/");
    return parts[0] === "" && parts.slice(1).every(part => part && part !== "." && part !== "..") ? parts.slice(1) : null;
  };
  const s = segments(stored), r = segments(root);
  return s && r && s.length === r.length + 2 && r.every((part, i) => s[i] === part) && s[r.length] === taskId ? stored : null;
}

export function parseFeed(sections: Sections): Feed {
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

/** One outcome per verb of a chunk. Archives share the `archive` section and purges the `purge` one: `Archived <id>` /
 *  `Deleted <id>`, else the id's own `cannot ... <id>` line, else the section's last line that names no id (a call
 *  that aborted). Any other verb: `ok <id>`, or `fail <id>` followed by that call's stderr. */
export function replies(sections: Sections, verbs: Verb[]): [Verb, Outcome][] {
  const last = (lines: string[]) => lines.filter(Boolean).pop() || "No confirmation from host";
  return verbs.map((v): [Verb, Outcome] => {
    const { verb: kind, id } = v;
    if (kind !== "archive" && kind !== "purge") return [v, sections.has(`ok ${id}`) ? { ok: true }
      : { ok: false, message: last((sections.get(`fail ${id}`) ?? "").split("\n").map(line => line.trim())) }];
    const lines = (sections.get(kind) ?? "").split("\n").map(line => line.trim());
    if (lines.includes(`${kind === "archive" ? "Archived" : "Deleted"} ${id}`)) return [v, { ok: true }];
    return [v, { ok: false, message: lines.find(line => line.startsWith("cannot ") && line.split(/\s+/)[2] === id)
      ?? last(lines.filter(line => !/^(Archived|Deleted|cannot) /.test(line))) }];
  });
}

/** An id's outcome so far plus the next verb's, in run order. A delete is archive, then purge, and the pair can land in two
 *  chunks. The first failure stands, since a failed archive makes the purge fail with a lesser message, and a failure that is
 *  already definite or unknown is not replaced by a later "unknown" or "Skipped". An ok purge wins whatever the archive said
 *  (the card was archived elsewhere). A purge that fails after an ok archive says so, unless it is unknown (it may have run). */
export function fold(prev: Outcome | undefined, kind: string, o: Outcome): Outcome {
  if (!prev) return o;
  if (kind !== "purge") return prev.ok ? o : prev;
  if (o.ok) return o;
  if (!prev.ok) return prev;
  return o.unknown ? o : { ...o, message: `Archived, but not deleted: ${o.message}` };
}

/** Bulk replies for one chunk, by id. */
export function parseBulk(sections: Sections, verbs: Verb[]): Record<string, Outcome> {
  const out: Record<string, Outcome> = {};
  for (const [v, o] of replies(sections, verbs)) out[v.id] = fold(out[v.id], v.verb, o);
  return out;
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

/** Hermes has no status verb; these land a card in todo, and only while a parent is open (else blocked/scheduled/review go to
 *  ready, and block turns into needs_input). Running is not here: block never stops the worker, so reclaim comes first.
 *  ponytail: an open parent is one that is not done or archived (the kernel's terminal statuses as read). If the kernel counts
 *  more as terminal, a drop is allowed and lands in Ready (the landing notice says so); if fewer, a drop that would work is refused. */
const TODO: Partial<Record<Status, Drop>> = { blocked: "unblock", scheduled: "unblock", review: "reopen-review", ready: "block" };

/** The verb a column drop runs; "refuse" where no command lands there, null where the move is locked. `open` is the card's open parents. */
export function dropVerb(from: Status, to: Status, open = 0): Drop | "refuse" | null {
  if (from === to) return null;
  if (to === "archived") return "archive";
  if (to === "triage") return "refuse";
  if (to === "todo") return (open ? TODO[from] : undefined) ?? "refuse";
  return DROPS[to]?.[from] ?? null;
}

/** Why a "refuse" drop does nothing, for the notice. `open` is the card's open parents, as for dropVerb. */
export function refusal(from: Status, to: Status, open = 0): string {
  return to === "triage" ? "Only Hermes moves tasks into Triage."
    : !open ? "To-do holds tasks that wait on an unfinished parent."
    : from === "running" ? "A running task can't wait on a parent. Reclaim it to Ready first."
    : `Hermes can't move a ${from} task to To-do.`;
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
    case "reassign": return `reassign${v.reclaim ? " --reclaim" : ""}${flag("reason", v.reason)} -- ${id} ${v.profile ? safeToken(v.profile) : "none"}`;
    case "set-model": return `set-model${flag("provider", v.provider)} -- ${id} ${v.model ? b64Arg(v.model) : "none"}`;
    case "edit": return `edit${flag("title", v.title)}${v.body === undefined ? "" : ` --body=${b64Arg(v.body)}`}${v.priority === undefined ? "" : ` --priority=${int(v.priority)}`} -- ${id}`;
    case "link": case "unlink": return `${v.verb} -- ${id} ${safeToken(v.child)}`;
    case "comment": return `comment --author=obsidian -- ${id} ${b64Arg(v.text)}`;
    case "attach-rm": return `attach-rm -- ${int(v.attachment)}`;
    // "$t" is the temp file run() writes the bytes to.
    case "attach": return `attach --author=obsidian${flag("name", v.name)}${flag("content-type", v.type)} -- ${id} "$t"`;
    // The default profile's gateway owns the home channels homes() reads, so it delivers.
    case "notify-subscribe": case "notify-unsubscribe":
      return `${v.verb}${flag("platform", v.platform)}${flag("chat-id", v.chat)}${flag("thread-id", v.thread)}${v.verb === "notify-subscribe" ? " --notifier-profile=default" : ""} -- ${id}`;
  }
}

export function createArgs(t: NewTask): string {
  return "create --created-by=obsidian"
    + (t.status === "triage" ? " --triage" : t.status === "blocked" ? " --initial-status=blocked" : "")
    + flag("body", t.body) + (t.assignee ? ` --assignee=${safeToken(t.assignee)}` : "")
    + (t.parents ?? []).map(parent => ` --parent=${safeToken(parent)}`).join("")
    + flag("workspace", t.workspace) + flag("branch", t.branch) + flag("tenant", t.tenant) + flag("project", t.project)
    + (t.priority === undefined ? "" : ` --priority=${int(t.priority)}`)
    + (t.maxRuntime ? ` --max-runtime=${safeToken(t.maxRuntime)}` : "")
    + (t.maxRetries === undefined ? "" : ` --max-retries=${int(t.maxRetries)}`)
    + (t.skills ?? []).map(skill => ` --skill=${b64Arg(skill)}`).join("")
    + flag("model", t.model) + (t.model ? flag("provider", t.provider) : "")
    + (t.goal ? ` --goal${t.goalMaxTurns === undefined ? "" : ` --goal-max-turns=${int(t.goalMaxTurns)}`}` : "")
    + ` -- ${b64Arg(t.title)}`;
}

export const outcome = (result: RemoteResult): Outcome =>
  result.ok && result.sections.has("ok") ? { ok: true } : { ok: false, message: result.ok ? "No confirmation from host" : result.message };

export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Verbs per bulk script; the ceiling is in bulk(). */
export const CHUNK = 15;
