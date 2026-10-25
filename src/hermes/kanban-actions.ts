import { Notice } from "obsidian";
import { askBlock, askComplete, askReassign, COLUMNS, CONFIRM, confirmed, message } from "./kanban-drawer";
import { OrchestrationModal } from "./kanban-orchestration";
import { dropVerb, refusal, type Card, type Drop, type Status, type Verb } from "./kanban";
import { MOVED, on } from "./kanban-prefs";
import type { KanbanView } from "./kanban-view";

/**
 * Runs verbs in one round trip. With `to`, the cards move first and a failed one moves back.
 * `alias` and `board` are the host and board the dialog behind this call was opened on. Once the host changed, the ids and
 * the board belong to the old one, so the answer is MOVED and nothing is sent. A switch to another board of the same host
 * still sends to `board` (the user asked for that board); the board on screen is then only reloaded, never patched.
 * Forms show the answer; the confirm-only callers drop it, like the picker's.
 */
export async function applyVerbs(this: KanbanView, alias: string, board: string, verbs: Verb[], to?: Status): Promise<string | null> {
  if (alias !== this.alias) return MOVED;
  if (!verbs.length) return null;
  const r = this.current(alias, board);
  const cards = new Map((r?.tasks ?? []).map((c): [string, Card] => [c.id, c]));
  const before = new Map(verbs.map((v): [string, Status | undefined] => [v.id, cards.get(v.id)?.status]));
  if (to) for (const v of verbs) {
    const c = cards.get(v.id);
    if (c) c.status = to;
  }
  if (r) this.render();
  const results = await this.host.kanban.bulk(alias, board, verbs).catch((e: unknown) => message(e));
  // After a board or server switch (switchBoard() empties `read` at once) or a close, the marks, banner and landing
  // belong to the old board: only the notice is left. Failed cards still move back: they are the client's cached
  // objects, which the next read of that board reuses while its token is unchanged.
  const same = this.current(alias, board) !== null, ok: string[] = [], errors: string[] = [];
  let unsure = "";
  // A delete sends two verbs for one task (its archive and its purge): the answers, marks and counts go by task.
  const ids = [...new Set(verbs.map(v => v.id))];
  for (const id of ids) {
    const o = typeof results === "string" ? { ok: false as const, message: results } : results[id] ?? { ok: false as const, message: "No result from the host" };
    if (o.ok) {
      if (same) this.failed.delete(id);
      ok.push(id);
      continue;
    }
    const c = cards.get(id), was = before.get(id);
    if (c && was) c.status = was;
    // A batch that broke off may have run any of its verbs: no failed mark, the reload shows which did.
    if ("unknown" in o) { unsure = o.message; continue; }
    errors.push(`${id}: ${o.message}`);
    if (same) this.failed.add(id);
  }
  const failure = ids.length === 1 ? `${to ? "Move" : "Action"} failed: ${errors[0]}`
    : `${to ? "Bulk move" : "Bulk action"}: ${errors.length} of ${ids.length} failed\n${errors.slice(0, 3).join("\n")}`;
  if (errors.length && ids.length === 1 && same) this.banner = failure;
  else if (errors.length) new Notice(failure, 10_000);
  if (unsure) new Notice(`The batch did not finish (${unsure}). The reload shows what was applied.`, 10_000);
  if (same) {
    if (to && ok.length) this.landing = { ids: ok, to };
    this.render();
  }
  // Also when the view left `board`: the board on screen may have changed under the same host, and a reload is cheap.
  void this.reload();
  return null;
}

export async function dropCards(this: KanbanView, ids: string[], to: Status): Promise<void> {
  const r = this.read, alias = this.alias;
  if (!r) return;
  const board = r.board, label = COLUMNS[to].label;
  const go: [Card, Drop][] = [];
  for (const c of r.tasks.filter(t => ids.includes(t.id))) {
    const d = dropVerb(c.status, to, c.openParents);
    if (d === "refuse") {
      new Notice(`${ids.length > 1 ? `${c.id}: ` : ""}${refusal(c.status, to, c.openParents)}`);
      return;
    }
    if (d) go.push([c, d]);
  }
  if (!go.length) {
    new Notice(`No command moves ${ids.length === 1 ? "this task" : "these tasks"} to ${label}.`);
    return;
  }
  const cards = go.map(([c]) => c);
  if (to === "blocked") return askBlock(this.app, cards, (kind, reason) => this.apply(alias, board, cards.map((c): Verb => ({ verb: "block", id: c.id, kind, reason })), to));
  if (to === "done") return askComplete(this.app, cards.length, (summary, result) => this.apply(alias, board, cards.map((c): Verb => ({
    verb: "complete", id: c.id, ...(summary ? { summary } : {}), ...(result ? { result } : {}), ...(c.status === "running" ? { force: true } : {}),
  })), to));
  if (to === "archived" && !await confirmed(this.app, "Archive", cards.length === 1 ? CONFIRM.archive : `Archive ${cards.length} tasks?`, "Archive", true)) return;
  if (go.some(([, d]) => d === "reclaim") && !await confirmed(this.app, "Reclaim", CONFIRM.reclaim, "Reclaim", true)) return;
  // "block" gets here only for a drop onto To-do (a drop onto Blocked asked above): a dependency block, which has no reason to ask for.
  await this.apply(alias, board, go.map(([c, d]): Verb => d === "reclaim" ? { verb: d, id: c.id, reason: "reclaimed from Obsidian" }
    : d === "block" ? { verb: d, id: c.id, kind: "dependency", reason: "moved to To-do from Obsidian" } : { verb: d, id: c.id }), to);
}

/** A running card needs `reassign`; the CLI refuses it while its worker holds it, unless `--reclaim` stops the worker first, so
 *  the form asks (unchecked) and a refusal shows per card like any other failure. Without a running card there is nothing to ask.
 *  `board` is the one the cards were picked on. */
export async function assignCards(this: KanbanView, cards: Card[], profile: string | null, board: string): Promise<void> {
  const alias = this.alias;
  const send = (reclaim: boolean): Promise<string | null> => this.apply(alias, board, cards.map((c): Verb => c.status === "running"
    ? { verb: "reassign", id: c.id, profile, reason: "reassigned from Obsidian", ...(reclaim ? { reclaim } : {}) }
    : { verb: "assign", id: c.id, profile }));
  if (cards.some(c => c.status === "running")) askReassign(this.app, send);
  else await send(false);
}

export async function nudgeDispatcher(this: KanbanView): Promise<void> {
  const alias = this.alias;
  if (!await confirmed(this.app, "Nudge dispatcher", "Wake the dispatcher to claim up to 8 ready tasks now?", "Nudge")) return;
  if (alias !== this.alias) {
    new Notice(MOVED);
    return;
  }
  const r = await this.host.kanban.nudge(alias, this.read?.board ?? this.host.board(alias))
    .catch((e: unknown) => ({ ok: false as const, message: message(e) }));
  new Notice(r.ok ? r.text || "Dispatcher nudged; nothing to spawn." : r.message, 10_000);
  void this.reload();
}

/** The pill flips kanban.auto_decompose, which every board shares, like the web's. */
export async function toggleAuto(this: KanbanView): Promise<void> {
  const r = this.read, alias = this.alias;
  if (!r || this.pill.disabled) return;
  const next = String(!on(r.config.auto_decompose));
  this.pill.disabled = true;
  const o = await this.host.kanban.setConfig(alias, "auto_decompose", next).catch((e: unknown) => ({ ok: false as const, message: message(e) }));
  this.pill.disabled = false;
  if (!o.ok) {
    new Notice(`Save failed: ${o.message}`, 10_000);
    return;
  }
  r.config.auto_decompose = next;
  if (this.read === r) this.syncTools(r);
  void this.reload();
}

export function openOrchestration(this: KanbanView): void {
  const alias = this.alias;
  new OrchestrationModal({
    app: this.app, kanban: this.host.kanban, alias, read: () => this.read, reload: () => this.reload(),
    moved: () => this.closed ? "The board view is closed." : this.alias === alias ? null : MOVED,
  }).open();
}
