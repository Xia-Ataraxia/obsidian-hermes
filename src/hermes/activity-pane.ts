import { setTooltip } from "obsidian";
import { only, same, taskOf, type Activity, type ActivityClient, type Call, type Delegation, type LiveLog, type Subagent, type Task } from "./activity";
import { absolute, compact, icon, iconButton, relative, stat } from "./ui";

/* ───────────── Activity pane: what a profile is doing now, and which subagents it called ───────────── */

const SOURCE_ICON: Record<string, string> = {
  cli: "terminal", slack: "message-circle", telegram: "message-circle", discord: "message-circle", cron: "clock",
  kanban: "square-kanban", oneshot: "zap", subagent: "git-fork", api: "globe", webui: "globe",
};
const DELIVERY_ICON: Record<string, string> = { delivered: "mail-check", pending: "mail" };
const DAY = 86400;

/** One line of text. The query keeps 200 characters, so a text that long is marked as cut. */
const flat = (text: string | null): string => {
  const raw = (text ?? "").slice(0, 200);
  const line = raw.replace(/\s+/g, " ").trim();
  return raw.length === 200 ? `${line}…` : line;
};
const agents = (n: number): string => `${n} subagent${n === 1 ? "" : "s"}`;
const nameOf = (k: Subagent): string => k.label || flat(k.goal) || "Subagent";
const tokens = (k: Subagent): number => (k.input ?? 0) + k.cached + (k.output ?? 0);

/** Hermes prices a free (`included`) or unknown run at 0 or not at all; neither is worth a number. */
const priced = (k: { cost: number | null; costStatus: string | null }): number =>
  k.cost !== null && k.costStatus !== null && k.costStatus !== "included" && k.costStatus !== "unknown" ? k.cost : 0;
const money = (cost: number, estimated: boolean): string => (cost < 0.01 ? "<$0.01" : `${estimated ? "~" : ""}$${cost.toFixed(2)}`);

function duration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

/** Class of a call status: "error" is red, "completed" green, anything else neutral ("unknown" is ours, not the host's). */
const outcomeClass = (status: string): string => (status === "error" ? "is-error" : status === "completed" ? "is-done" : "is-ended");

/** What the parent's call recorded for an ended child. A child still running, or a call still in flight, has no outcome. */
function outcome(calls: readonly Call[], k: Subagent): Task | undefined {
  const task = k.status === "ended" ? taskOf(calls, k.goal) : undefined;
  return task?.status === "running" ? undefined : task;
}

/** Class and tooltip of a subagent's dot and bar segment. A crash reads as running for 5 minutes, then as quiet. */
function state(k: Subagent, task?: Task): [string, string] {
  if (k.status === "running") return ["is-running", "Running"];
  if (k.status === "stale") return ["is-stale", "Quiet · No activity for 5 minutes"];
  if (task) return [outcomeClass(task.status), task.exit || task.status];
  return k.end && k.end !== "agent_close" ? ["is-warn", k.end] : ["is-ended", "Ended"];
}

function section(parent: HTMLElement, name: string, label: string, count?: number): HTMLElement {
  const sec = parent.createDiv("hm-section");
  const head = sec.createDiv("hm-section-head");
  icon(head, name);
  head.createSpan({ text: label });
  if (count !== undefined) head.createSpan({ cls: "hm-count", text: String(count) });
  return sec;
}

function sourceIcon(parent: HTMLElement, source: string | null): void {
  setTooltip(icon(parent, SOURCE_ICON[source ?? ""] ?? "circle", "hm-icon hm-muted"), source ?? "Unknown source");
}

/** Right-aligned age. `at` is a host epoch; the tooltip has the exact time, of `at` unless `exact` says otherwise. */
function when(parent: HTMLElement, at: number | null, now: number, label: string, exact = at): void {
  if (at !== null) setTooltip(parent.createSpan({ cls: "hm-act-age", text: relative(at, now) }), `${label} ${absolute(exact)}`);
}

function working(view: HTMLElement, data: Activity, now: number): void {
  const tops = data.now.filter(s => !s.child);
  const orphans = data.now.filter(s => s.child && !tops.some(t => t.id === s.parent)).length;
  const idle = data.recent[0];
  if (!tops.length && !orphans && !idle) return;
  const sec = section(view, "activity", "Now");
  for (const s of tops) {
    const row = sec.createDiv(s.turn ? "hm-act-row is-now is-live" : "hm-act-row is-now");
    setTooltip(row.createSpan(s.turn ? "hm-act-dot is-live" : "hm-act-dot"), s.turn ? "Working" : "Recently active");
    sourceIcon(row, s.source);
    row.createSpan({ cls: "hm-act-name", text: s.title || "Untitled session" });
    if (s.model) row.createSpan({ cls: "hm-act-model", text: s.model });
    const kids = data.now.filter(k => k.child && k.parent === s.id).length;
    if (kids) stat(row, "git-fork", kids, `${agents(kids)} running`);
    when(row, s.last, now, "Started", s.started); // the age is since the last activity, the tooltip has the start
    if (s.doing) row.createDiv({ cls: "hm-act-doing", text: flat(s.doing) });
  }
  if (orphans) {
    const row = sec.createDiv("hm-act-row is-now");
    setTooltip(row.createSpan("hm-act-dot is-running"), "Running");
    icon(row, "git-fork", "hm-icon hm-muted");
    row.createSpan({ cls: "hm-act-name", text: `${agents(orphans)} running` });
  } else if (!tops.length && idle) {
    const row = sec.createDiv("hm-act-row is-now");
    row.createSpan("hm-act-dot");
    row.createSpan({ cls: "hm-act-name hm-muted", text: "Idle" });
    when(row, idle.last, now, "Last active");
  }
}

/** ponytail: a call whose owner died stays `running` in Hermes's table, and shows as running here for 7 days. */
function background(view: HTMLElement, data: Activity, now: number): void {
  const jobs = data.async.filter(j => j.dispatched > now - 7 * DAY);
  if (!jobs.length) return;
  const sec = section(view, "cloud", "Background", jobs.length);
  for (const j of jobs) {
    const row = sec.createDiv("hm-act-row");
    row.createSpan({ cls: `hm-chip ${j.state === "running" ? "is-running" : outcomeClass(j.state)}`, text: j.state });
    const mail = DELIVERY_ICON[j.delivery ?? ""];
    setTooltip(icon(row, mail ?? "mail-x", mail ? "hm-icon hm-muted" : "hm-icon is-warn"), `Delivery: ${j.delivery ?? "unknown"}`);
    if (j.tasks) stat(row, "list-checks", j.tasks, "Tasks");
    const goal = flat(j.goal);
    if (goal) setTooltip(row.createSpan({ cls: "hm-act-name", text: goal }), goal);
    const times = row.createSpan("hm-act-age");
    stat(times, "send", relative(j.dispatched, now), `Sent ${absolute(j.dispatched)}`);
    if (j.completed !== null) stat(times, "check", relative(j.completed, now), `Done ${absolute(j.completed)}`);
  }
}

function recent(view: HTMLElement, data: Activity, now: number): void {
  if (!data.recent.length) return;
  const sec = section(view, "history", "Recent");
  for (const r of data.recent) {
    const row = sec.createDiv("hm-act-row");
    sourceIcon(row, r.source);
    row.createSpan({ cls: "hm-act-name", text: r.title || "Untitled session" });
    if (r.model) row.createSpan({ cls: "hm-act-model", text: r.model });
    if (r.kids) stat(row, "git-fork", r.kids, agents(r.kids));
    if (r.msgs) stat(row, "message-square", r.msgs, "Messages");
    const cost = priced(r);
    if (cost > 0) stat(row, "circle-dollar-sign", money(cost, r.costStatus === "estimated"), "Cost");
    when(row, r.last, now, "Last active");
  }
}

export class ActivityPane {
  private root!: HTMLElement;
  private body!: HTMLElement;
  private stamp!: HTMLElement;
  private refreshButton!: HTMLElement;
  private data: Activity | null = null;
  /** Local clock at the last good read: host times are aged from `data.at` plus the time since this. */
  private readAt = 0;
  private error: string | null = null;
  private reading = false;
  private disposed = false;
  /** Set once the root was in the DOM: a modal may mount before it attaches, and must not read as closed. */
  private attached = false;
  private timer = 0;
  /** Groups and results the viewer opened or closed; it outlives a repaint. */
  private readonly open = new Map<string, boolean>();
  /** The summaries of the last paint by key, so focus can go back to the one that had it. */
  private readonly summaries = new Map<string, HTMLElement>();
  /** Signature of the payload on screen: a read that matches it repaints nothing. */
  private painted = "";
  /** delegate_task results by parent session; `sig` names the children they were read for. A failed read keeps the older calls. */
  private readonly outcomes = new Map<string, { sig: string; calls: readonly Call[]; error: string | null }>();
  private readonly loading = new Set<string>();

  constructor(private readonly client: ActivityClient, private readonly alias: string, private readonly profile: string) {}

  mount(el: HTMLElement): void {
    this.root = el.createDiv("hm-act");
    const head = this.root.createDiv("hm-act-head");
    this.stamp = head.createSpan("hm-stamp");
    this.refreshButton = iconButton(head, "refresh-cw", "Refresh", () => void this.refresh());
    this.body = this.root.createDiv("hm-act-body");
    this.empty("loader", "Loading…");
    this.attached = this.root.isConnected;
    void this.refresh();
    this.timer = window.setInterval(() => this.tick(), 10_000);
  }

  /** Reads only while the pane is on screen; once it was attached and is gone from the DOM, it disposes itself. */
  private tick(): void {
    if (this.root.isConnected) this.attached = true;
    else if (this.attached) {
      this.dispose();
      return;
    }
    if (this.root.doc.hidden || !this.root.isShown()) return;
    this.stampText();
    void this.refresh();
  }

  /** Ends the timer and drops what the pane holds. A read still in flight finds it disposed and paints nothing. */
  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.timer);
    this.data = null;
    this.open.clear();
    this.summaries.clear();
    this.outcomes.clear();
    this.loading.clear();
    this.root.remove();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.reading) return;
    this.reading = true;
    this.refreshButton.addClass("hm-spinning");
    const result = await this.client.read(this.alias, this.profile).catch((e: unknown) => e instanceof Error ? e.message : String(e));
    this.reading = false;
    if (this.disposed) return;
    this.refreshButton.removeClass("hm-spinning");
    if (typeof result === "string") {
      this.error = result;
      if (!this.data) this.empty("wifi-off", result, true);
    } else {
      this.error = null;
      this.data = result;
      this.readAt = Date.now();
      // ponytail: ages are minute-grained, so the minute of `at` stays in the signature; a quiet child's `secs` keeps counting, so a profile with one still repaints on every read.
      const sig = JSON.stringify({ ...result, at: Math.floor(result.at / 60) });
      if (sig !== this.painted) {
        this.painted = sig;
        this.paint(result);
      }
    }
    this.stampText();
  }

  private stampText(): void {
    this.stamp.setText(this.readAt ? relative(this.readAt / 1000) : "");
    this.stamp.toggleClass("is-stale", this.error !== null);
    const tip = this.error ?? (this.readAt ? `Updated ${new Date(this.readAt).toLocaleTimeString()}` : null);
    if (tip !== null) setTooltip(this.stamp, tip);
  }

  private empty(name: string, text: string, retry = false): void {
    this.body.empty();
    const box = this.body.createDiv("hm-empty");
    icon(box, name, "hm-empty-icon");
    box.createDiv({ text });
    if (retry) box.createEl("button", { text: "Retry" }).addEventListener("click", () => void this.refresh());
  }

  /** Built off screen and swapped in one step, so the scroll position holds. */
  private paint(data: Activity): void {
    const now = data.at + (Date.now() - this.readAt) / 1000;
    const active = this.root.ownerDocument.activeElement;
    const focused = [...this.summaries].find(([, el]) => el === active)?.[0];
    this.summaries.clear();
    const view = createDiv();
    working(view, data, now);
    this.subagents(view, data, now);
    background(view, data, now);
    recent(view, data, now);
    if (view.childElementCount) this.body.replaceChildren(...Array.from(view.childNodes));
    else this.empty("moon", "No activity yet");
    if (focused !== undefined) this.summaries.get(focused)?.focus({ preventScroll: true });
  }

  /** A <details> that remembers what the viewer did. It records the click, not `toggle`, so a repaint can't flip it back; until a click, it follows the `open` default of each paint. */
  private fold(parent: HTMLElement, cls: string, key: string, open = false): [HTMLDetailsElement, HTMLElement] {
    const details = parent.createEl("details", { cls });
    details.open = this.open.get(key) ?? open;
    const summary = details.createEl("summary");
    summary.addEventListener("click", () => this.open.set(key, !details.open));
    this.summaries.set(key, summary);
    return [details, summary];
  }

  /** One SSH run per group: when it opens and when its children change state. A failed read is retried by the next click. */
  private async load(id: string, sig: string, clicked = false): Promise<void> {
    const have = this.outcomes.get(id);
    if (this.disposed || this.loading.has(id) || (have?.sig === sig && !(clicked && have.error))) return;
    this.loading.add(id);
    const result = await this.client.detail(this.alias, this.profile, id).catch((e: unknown) => e instanceof Error ? e.message : String(e));
    this.loading.delete(id);
    if (this.disposed) return;
    this.outcomes.set(id, typeof result === "string" ? { sig, calls: have?.calls ?? [], error: result } : { sig, calls: result, error: null });
    if (this.data) this.paint(this.data);
  }

  private subagents(view: HTMLElement, data: Activity, now: number): void {
    const total = data.delegations.reduce((n, g) => n + g.children.length, 0);
    if (!total) return;
    const sec = section(view, "git-fork", "Subagents", total);
    for (const g of data.delegations) this.group(sec, g, data.live, now);
  }

  private group(parent: HTMLElement, g: Delegation, live: readonly LiveLog[], now: number): void {
    const { id, children: kids } = g;
    const [details, summary] = this.fold(parent, "hm-group", String(id), kids.some(k => k.status === "running"));
    const found = id === null ? undefined : this.outcomes.get(id);
    const calls = found?.calls ?? [];
    if (id !== null) {
      const sig = kids.map(k => `${k.id}:${k.status}`).join();
      summary.addEventListener("click", () => { if (!details.open) void this.load(id, sig, true); });
      if (details.open && kids.some(k => k.status === "ended")) void this.load(id, sig);
    }
    sourceIcon(summary, g.source);
    summary.createSpan({ cls: "hm-act-name", text: g.title || "Untitled session" });
    const bar = summary.createSpan("hm-act-bar");
    for (const k of kids.slice(-12)) { // the newest 12 fit the 64px bar at 3px a segment
      const [cls, tip] = state(k, outcome(calls, k));
      setTooltip(bar.createSpan(`hm-act-dot hm-act-seg ${cls}`), `${nameOf(k)} · ${tip}`);
    }
    stat(summary, "git-fork", kids.length, agents(kids.length));
    // A quiet child is still open in the table, so its clock keeps running; leave it out of the wall time.
    const active = kids.filter(k => k.status !== "stale");
    if (active.length) stat(summary, "timer", duration(Math.max(...active.map(k => k.started + k.secs)) - Math.min(...active.map(k => k.started))), "Wall time");
    const used = kids.reduce((n, k) => n + tokens(k), 0);
    if (used) stat(summary, "coins", compact(used), "Tokens", "hm-opt");
    const cost = kids.reduce((n, k) => n + priced(k), 0);
    if (cost > 0) stat(summary, "circle-dollar-sign", money(cost, kids.some(k => k.costStatus === "estimated")), "Cost", "hm-opt");
    when(summary, Math.min(...kids.map(k => k.started)), now, "Started");
    const list = details.createDiv("hm-act-kids");
    for (const k of kids) this.child(list, k, outcome(calls, k), live);
    // A refused spawn has no child session, so it shows here instead of on a kid.
    for (const c of calls) {
      if (c.tasks.length || !c.error) continue;
      const row = list.createDiv("hm-act-kid");
      setTooltip(icon(row, "triangle-alert", "hm-icon is-warn"), "Subagent call refused");
      setTooltip(row.createSpan({ cls: "hm-act-name", text: flat(c.error) }), flat(c.error));
      when(row, c.at, now, "Refused");
    }
    if (found?.error) list.createDiv({ cls: "hm-act-kid hm-muted", text: flat(found.error) });
  }

  private child(parent: HTMLElement, k: Subagent, task: Task | undefined, live: readonly LiveLog[]): void {
    const row = parent.createDiv("hm-act-kid");
    const [cls, tip] = state(k, task);
    setTooltip(row.createSpan(`hm-act-dot ${cls}`), tip);
    const name = nameOf(k);
    row.createSpan({ cls: "hm-act-name", text: name });
    if (k.model) row.createSpan({ cls: "hm-act-model", text: k.model });
    if (task) row.createSpan({ cls: `hm-chip ${outcomeClass(task.status)}`, text: task.status });
    if (k.status !== "stale") stat(row, "timer", duration(k.secs), "Duration");
    if (k.calls) stat(row, "repeat", k.calls, "API calls");
    const used = tokens(k);
    if (used) stat(row, "coins", compact(used), `${compact((k.input ?? 0) + k.cached)} in · ${compact(k.output ?? 0)} out`);
    const cost = priced(k);
    if (cost > 0) stat(row, "circle-dollar-sign", money(cost, k.costStatus === "estimated"), "Cost");
    const goal = flat(k.goal);
    if (goal && goal !== name) setTooltip(row.createDiv({ cls: "hm-act-goal", text: goal }), goal);
    if (task?.error) {
      const note = flat(task.error);
      setTooltip(row.createDiv({ cls: `hm-act-note ${outcomeClass(task.status)}`, text: note }), note);
    }
    if (k.status === "running" && k.doing) row.createDiv({ cls: "hm-act-doing", text: flat(k.doing) });
    // The live log of a running child, found by its goal when exactly one log fits; the refresh that reads `live` keeps this current.
    const log = k.status === "running" ? only(live, l => same(l.goal, k.goal)) : undefined;
    const tail = (log?.tail ?? "").split("\n").map(l => l.trim()).filter(Boolean).slice(-3);
    if (tail.length) {
      const box = row.createDiv("hm-act-tail");
      for (const line of tail) box.createDiv({ text: line });
    }
    const result = task?.summary || k.result;
    if (k.status === "ended" && result) {
      const [details, summary] = this.fold(row, "hm-act-result", `result:${k.id}`);
      icon(summary, "file-text");
      summary.createSpan({ text: "Result" });
      details.createDiv({ text: flat(result) });
    }
  }
}
