import { AbstractInputSuggest, Component, Modal, Notice, setTooltip, type App } from "obsidian";
import type { HermesClient } from "./data";
import type { Card, Detail, Diagnostic, KanbanClient, NewTask, Status, TaskRow, Verb } from "./kanban";
import { renderSafe } from "./markdown";
import { absolute, avatar, compact, icon, iconButton, relative } from "./ui";

export const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const matches = (query: string, ...texts: (string | undefined)[]): boolean => {
  const q = query.trim().toLowerCase();
  return !q || texts.some(t => t?.toLowerCase().includes(q));
};

export const COLUMNS: Record<Status, { icon: string; label: string; help: string }> = {
  triage: { icon: "inbox", label: "Triage", help: "Raw ideas — a specifier will flesh out the spec" },
  todo: { icon: "circle-dashed", label: "Todo", help: "Waiting on dependencies or unassigned" },
  scheduled: { icon: "clock", label: "Scheduled", help: "Waiting on a known time delay or scheduled follow-up" },
  ready: { icon: "circle-dot", label: "Ready", help: "Dependencies satisfied; assign a profile to dispatch" },
  running: { icon: "play", label: "In progress", help: "Claimed by a worker — in-flight" },
  blocked: { icon: "ban", label: "Blocked", help: "Worker asked for human input" },
  review: { icon: "eye", label: "Review", help: "Implementation complete — awaiting review" },
  done: { icon: "circle-check", label: "Done", help: "Completed" },
  archived: { icon: "archive", label: "Archived", help: "Archived" },
};

const SEVERITY: Record<string, { rank: number; icon: string } | undefined> = {
  critical: { rank: 3, icon: "octagon-alert" }, error: { rank: 2, icon: "circle-alert" }, warning: { rank: 1, icon: "triangle-alert" },
};
export const severityRank = (s: string): number => SEVERITY[s]?.rank ?? 1;
export const severityIcon = (s: string): string => SEVERITY[s]?.icon ?? "triangle-alert";

export const CONFIRM = {
  done: "Mark this task as done? The worker's claim is released and dependent children become ready.",
  archive: "Archive this task? It disappears from the default board view.",
  reclaim: "Reclaim this task? Its worker is stopped and the task returns to the queue.",
  reassign: "Reassign this running task? Its worker is stopped and the task returns to the queue.",
  specify: "Specify this task? Hermes asks an LLM to flesh out the spec; it can take a minute.",
  decompose: "Decompose this task? Hermes asks an LLM to split it into child tasks; it can take a minute.",
};

export function copy(text: string, what = text): void {
  void navigator.clipboard.writeText(text).then(() => new Notice(`Copied ${what}`), () => new Notice(text));
}

/** Relative time that the view's minute tick keeps fresh; the absolute time is the tooltip. */
export function when(parent: HTMLElement, at: number | undefined, cls = "hm-muted"): HTMLElement {
  const el = parent.createSpan({ cls, text: relative(at) });
  if (at) { el.dataset.at = String(at); setTooltip(el, absolute(at)); }
  return el;
}

const elapsed = (s: number): string => s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

/** Text button with an optional leading icon. */
export function action(parent: HTMLElement, label: string, onClick: () => void, iconName = "", tip = ""): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "hm-k-act" });
  if (iconName) icon(button, iconName);
  button.createSpan({ text: label });
  if (tip) setTooltip(button, tip);
  button.addEventListener("click", event => { event.stopPropagation(); onClick(); });
  return button;
}

/* ───────────── forms ───────────── */

export function suggestion(el: HTMLElement, title: string, note?: string): void {
  el.addClass("mod-complex");
  const content = el.createDiv("suggestion-content");
  content.createDiv({ cls: "suggestion-title", text: title });
  if (note) content.createDiv({ cls: "suggestion-note", text: note });
}

export class Suggest<T> extends AbstractInputSuggest<T> {
  constructor(app: App, input: HTMLInputElement, private readonly items: (query: string) => T[] | Promise<T[]>, private readonly draw: (item: T, el: HTMLElement) => void, chosen: (item: T) => void) {
    super(app, input);
    this.onSelect(item => { chosen(item); this.close(); });
  }

  protected getSuggestions(query: string): T[] | Promise<T[]> { return this.items(query); }
  renderSuggestion(item: T, el: HTMLElement): void { this.draw(item, el); }
}

export interface Suggestion { value: string; label: string; note?: string; fill?: Record<string, string> }

export interface Field {
  key: string; label: string; kind?: "text" | "textarea" | "dropdown" | "number"; value?: string; options?: [string, string][];
  placeholder?: string; required?: boolean; desc?: string;
  /** Enter submits (Shift+Enter keeps a newline). */
  enter?: boolean;
  suggest?: (query: string, values: Record<string, string>) => Suggestion[] | Promise<Suggestion[]>;
}

export interface Ask {
  title: string; text?: string; fields?: Field[]; cta?: string; warning?: boolean;
  /** Copy `map(from)` into `to` until the user edits `to`. */
  follow?: { from: string; to: string; map: (v: string) => string };
  hint?: (values: Record<string, string>) => string;
  /** Resolve null to close, or an error to show in the form. */
  submit: (values: Record<string, string>) => Promise<string | null>;
  closed?: () => void;
}

export type Focus = "diagnostics" | "comment";

class AskModal extends Modal {
  private dismissed = false;
  constructor(app: App, private readonly ask: Ask) { super(app); }

  override onOpen(): void {
    const a = this.ask, fields = a.fields ?? [];
    this.modalEl.addClass("hm-modal");
    this.setTitle(a.title);
    const form = this.contentEl.createEl("form", { cls: fields.length > 4 ? "hm-form is-grid" : "hm-form" });
    if (a.text) form.createEl("p", { cls: "hm-k-ask-text", text: a.text });
    const inputs = new Map<string, HTMLElement & { value: string }>();
    const values = (): Record<string, string> => Object.fromEntries([...inputs].map(([key, el]) => [key, el.value.trim()]));
    for (const f of fields) {
      const label = form.createEl("label", { cls: f.kind === "textarea" ? "hm-k-field is-wide" : "hm-k-field" });
      label.createSpan({ cls: "hm-k-field-label", text: f.label });
      const placeholder = f.placeholder ? { placeholder: f.placeholder } : {};
      let input: HTMLElement & { value: string };
      if (f.kind === "textarea") input = label.createEl("textarea", { attr: { rows: 3, ...placeholder } });
      else if (f.kind === "dropdown") {
        const select = label.createEl("select", { cls: "dropdown" });
        for (const [value, text] of f.options ?? []) select.createEl("option", { value, text });
        input = select;
      } else {
        const text = label.createEl("input", { type: f.kind ?? "text", ...placeholder });
        const suggest = f.suggest;
        if (suggest) new Suggest<Suggestion>(this.app, text, q => suggest(q, values()), (s, el) => suggestion(el, s.label, s.note), s => {
          text.value = s.value;
          for (const [key, value] of Object.entries(s.fill ?? {})) { const other = inputs.get(key); if (other) other.value = value; }
          form.dispatchEvent(new Event("change"));
        });
        input = text;
      }
      if (f.value !== undefined) input.value = f.value;
      if (f.enter) label.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.isComposing) return;
        event.preventDefault();
        form.requestSubmit();
      });
      if (f.desc) label.createDiv({ cls: "hm-k-field-desc", text: f.desc });
      inputs.set(f.key, input);
    }
    const follow = a.follow, src = follow && inputs.get(follow.from), dst = follow && inputs.get(follow.to);
    if (follow && src && dst) {
      let touched = !!dst.value;
      dst.addEventListener("input", () => { touched = true; });
      src.addEventListener("input", () => { if (!touched) dst.value = follow.map(src.value); });
    }
    const hint = form.createDiv("hm-k-hint"), error = form.createDiv("hm-k-error");
    const sync = (): void => { hint.setText(a.hint?.(values()) ?? ""); };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
    const buttons = form.createDiv("modal-button-container");
    // type=button: with a submit button, Enter in any one-line field (a picker mid-choice too) would submit.
    const cta = buttons.createEl("button", { cls: a.warning ? "mod-warning" : "mod-cta", text: a.cta ?? "Save", attr: { type: "button" } });
    cta.addEventListener("click", () => form.requestSubmit());
    buttons.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
    form.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    let busy = false;
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (busy) return;
      const v = values(), missing = fields.find(f => f.required && !v[f.key]);
      if (missing) { error.setText(`${missing.label} is required`); inputs.get(missing.key)?.focus(); return; }
      busy = true;
      cta.disabled = true;
      error.setText("");
      void a.submit(v).catch(message).then(result => {
        busy = false;
        cta.disabled = false;
        if (result === null) this.close(); else if (this.dismissed) new Notice(result, 10_000); else error.setText(result);
      });
    });
    ([...inputs.values()].find(el => el.tagName !== "SELECT") ?? cta).focus();
  }

  override onClose(): void {
    // A write still in flight reports its failure in a Notice: the form is gone.
    this.dismissed = true;
    this.contentEl.empty();
    this.ask.closed?.();
  }
}

export function ask(app: App, a: Ask): void {
  new AskModal(app, a).open();
}

export function confirmed(app: App, title: string, text: string, cta = "Confirm", warning = false): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false;
    ask(app, { title, text, cta, warning, submit: () => { ok = true; return Promise.resolve(null); }, closed: () => resolve(ok) });
  });
}

type BlockKind = NonNullable<Extract<Verb, { verb: "block" }>["kind"]>;
const BLOCK_KINDS: [BlockKind, string][] = [["needs_input", "Needs input"], ["capability", "Capability"], ["dependency", "Dependency"], ["transient", "Transient"]];

export function askBlock(app: App, cards: Pick<Card, "blockKind" | "blockRecurrences">[], submit: (kind: BlockKind, reason: string) => Promise<string | null>): void {
  const one = cards.length === 1 ? cards[0] : undefined;
  ask(app, {
    title: one ? "Block task" : `Block ${cards.length} tasks`, cta: "Block",
    fields: [
      { key: "kind", label: "Kind", kind: "dropdown", value: "needs_input", options: BLOCK_KINDS },
      { key: "reason", label: "Reason", kind: "textarea", required: true, enter: true, placeholder: "What does the worker need?" },
    ],
    hint: v => one?.blockRecurrences && one.blockKind === v.kind ? `Blocked as ${v.kind} ${one.blockRecurrences}× already — another block of this kind may send it to triage.` : "",
    submit: v => submit((v.kind || "needs_input") as BlockKind, v.reason ?? ""),
  });
}

export function askComplete(app: App, n: number, submit: (summary: string, result: string) => Promise<string | null>): void {
  ask(app, {
    title: n === 1 ? "Complete task" : `Complete ${n} tasks`, text: n === 1 ? CONFIRM.done : `Mark ${n} tasks as done?`, cta: "Complete",
    fields: [
      { key: "summary", label: "Summary", kind: "textarea", placeholder: "Optional" },
      { key: "result", label: "Result", kind: "textarea", placeholder: "Optional" },
    ],
    submit: v => submit(v.summary ?? "", v.result ?? ""),
  });
}

/** Model suggestions from a profile's provider cache, read once per modal. */
function modelPicker(host: TaskHost): (query: string, profile: string) => Promise<Suggestion[]> {
  const cache = new Map<string, Promise<[string, string][]>>();
  return async (query, profile) => {
    const models = cache.get(profile) ?? host.client.models(host.alias, profile).catch(() => []);
    cache.set(profile, models);
    return (await models).filter(([m, p]) => matches(query, m, p)).slice(0, 50).map(([m, p]) => ({ value: m, label: m, note: p, fill: { provider: p } }));
  };
}

/* ───────────── task host ───────────── */

/** What the drawer and the task modals need from the board view. */
export interface TaskHost {
  readonly app: App;
  readonly owner: Component;
  readonly alias: string;
  readonly slug: string;
  readonly kanban: KanbanClient;
  readonly client: HermesClient;
  cards(): Card[];
  profiles(): string[];
  diagnostics(id: string): Diagnostic[];
  /** Run a verb, then refresh; resolves to the CLI error or null. */
  write(v: Verb): Promise<string | null>;
  /** Why this host takes no more writes (the SSH host changed since it was built: its alias and board are stale), else null. */
  moved(): string | null;
  open(id: string, focus?: Focus): void;
  close(): void;
}

export function openCreate(host: TaskHost, column: "ready" | "triage" | "blocked", workdir: string | undefined, created: () => void): void {
  const cards = host.cards(), models = modelPicker(host);
  const tenants = [...new Set(cards.map(c => c.tenant ?? ""))].filter(Boolean).sort();
  ask(host.app, {
    title: `New task — ${COLUMNS[column].label}`, cta: "Create",
    fields: [
      { key: "title", label: "Title", kind: "textarea", required: true, enter: true, placeholder: column === "triage" ? "Rough idea — AI will spec it…" : "New task title…" },
      { key: "body", label: "Description", kind: "textarea" },
      { key: "assignee", label: column === "triage" ? "Specifier" : "Assignee", kind: "dropdown", options: [["", "(blank = dispatcher picks)"], ...host.profiles().map((p): [string, string] => [p, p])] },
      { key: "priority", label: "Priority", kind: "number", value: "0" },
      { key: "tenant", label: "Tenant", suggest: q => tenants.filter(t => matches(q, t)).map(t => ({ value: t, label: t })) },
      { key: "parent", label: "Parent", desc: "(child stays blocked until the parent is done)", suggest: q => cards.filter(c => matches(q, c.id, c.title)).slice(0, 50).map(c => ({ value: c.id, label: c.title || "(untitled)", note: c.id })) },
      { key: "skills", label: "Skills", placeholder: "comma separated" },
      { key: "workspace", label: "Workspace", kind: "dropdown", value: workdir ? "dir" : "scratch", options: [["scratch", "Temporary — deleted on completion"], ["worktree", "Git worktree — preserved"], ["dir", "Directory — preserved"]] },
      { key: "path", label: "Path", value: workdir ?? "" },
      { key: "branch", label: "Branch" },
      { key: "model", label: "Model", placeholder: "model name (empty = profile default)", suggest: (q, v) => models(q, v.assignee || "default") },
      { key: "provider", label: "Provider" },
      { key: "maxRuntime", label: "Max runtime", placeholder: "30m" },
      { key: "maxRetries", label: "Max retries", kind: "number" },
      { key: "goal", label: "Goal mode", kind: "dropdown", options: [["", "Off"], ["on", "On"]] },
      { key: "goalMaxTurns", label: "Goal max turns", kind: "number", placeholder: "max turns (default 20)" },
    ],
    hint: v => v.workspace === "scratch" ? "This workspace and any files left in it are deleted when the task completes." : "",
    submit: async v => {
      const moved = host.moved();
      if (moved) return moved;
      const { title = "", body = "", assignee = "", priority = "", tenant = "", parent = "", skills = "", workspace = "scratch", path = "", branch = "", model = "", provider = "", maxRuntime = "", maxRetries = "", goal = "", goalMaxTurns = "" } = v;
      if (priority && !/^-?\d+$/.test(priority)) return "Priority must be a whole number";
      for (const [value, label] of [[maxRetries, "Max retries"], [goalMaxTurns, "Goal max turns"]] as const) {
        if (value && !(/^\d+$/.test(value) && Number(value) >= 1)) return `${label} must be a whole number of at least 1`;
      }
      if (maxRuntime && !/^\d+[smhd]?$/.test(maxRuntime)) return "Max runtime looks like 30m, 2h or 1d";
      if (workspace !== "scratch" && !path) return "Pick a path for this workspace";
      if (branch && workspace !== "worktree") return "branch_name is only valid for worktree workspaces";
      if (provider && !model) return "provider_override requires a model_override";
      if (new TextEncoder().encode(title + body).length > 65536) return "Title and description must stay under 64 KiB";
      const task: NewTask = {
        title, workspace: workspace === "scratch" ? "scratch" : `${workspace}:${path}`,
        ...(body ? { body } : {}), ...(assignee ? { assignee } : {}), ...(parent ? { parents: [parent] } : {}),
        ...(branch ? { branch } : {}), ...(tenant ? { tenant } : {}), ...(Number(priority) ? { priority: Number(priority) } : {}),
        ...(column !== "ready" ? { status: column } : {}),
        ...(maxRuntime ? { maxRuntime } : {}), ...(maxRetries ? { maxRetries: Number(maxRetries) } : {}),
        ...(skills ? { skills: skills.split(",").map(s => s.trim()).filter(Boolean) } : {}),
        ...(model ? { model } : {}), ...(provider ? { provider } : {}),
        ...(goal ? { goal: true, ...(goalMaxTurns ? { goalMaxTurns: Number(goalMaxTurns) } : {}) } : {}),
      };
      const out = await host.kanban.create(host.alias, host.slug, task).catch((e: unknown) => ({ ok: false as const, message: message(e) }));
      if (!out.ok) return out.message;
      if (out.warning) new Notice(`⚠ ${out.warning}`, 0);
      new Notice(out.id ? `Created ${out.id}` : "Created");
      created();
      return null;
    },
  });
}

/** One diagnostic with its recovery actions; results land in a Notice. */
export function diagCard(parent: HTMLElement, host: TaskHost, task: { id: string; status: Status }, d: Diagnostic): void {
  const card = parent.createDiv(`hm-k-diag is-${d.severity}`);
  const head = card.createDiv("hm-k-diag-head");
  setTooltip(icon(head, severityIcon(d.severity)), d.severity);
  head.createSpan({ cls: "hm-k-diag-title", text: d.title });
  if ((d.count ?? 0) > 1) head.createSpan({ cls: "hm-muted", text: `×${d.count}` });
  if (d.detail) card.createDiv({ cls: "hm-k-diag-detail", text: d.detail });
  if (!d.actions.length) return;
  const row = card.createDiv("hm-k-acts");
  const id = task.id, reason = `recovery action for ${d.kind}`;
  const run = (v: Verb, ok: string, fail: string): void => {
    void host.write(v).then(error => { new Notice(error === null ? ok : fail + error, error === null ? 4000 : 10_000); });
  };
  for (const a of d.actions) {
    const label = `${a.suggested ? "☆ " : ""}${a.label}`, payload = (a.payload ?? {}) as Record<string, unknown>;
    switch (a.kind) {
      case "reclaim":
        action(row, label, () => void confirmed(host.app, "Reclaim task", CONFIRM.reclaim, "Reclaim", true).then(ok => {
          if (ok) run({ verb: "reclaim", id, reason }, `Reclaimed ${id}. Task is back to ready.`, "Reclaim failed: ");
        }));
        break;
      case "unblock":
        action(row, label, () => run({ verb: "unblock", id, reason }, `Unblocked ${id}. Task is ready for the next tick.`, "Unblock failed: "));
        break;
      case "reassign": {
        const select = row.createEl("select", { cls: "dropdown" });
        const options: [string, string][] = [["", "Pick a profile…"], ["none", "(unassigned)"], ...host.profiles().map((p): [string, string] => [p, p])];
        for (const [value, text] of options) select.createEl("option", { value, text });
        action(row, label, () => {
          if (!select.value) { new Notice("Pick a profile first."); return; }
          const profile = select.value === "none" ? null : select.value;
          const verb = payload.reclaim_first === true || task.status === "running" ? "reassign" : "assign";
          const go = (): void => run({ verb, id, profile, reason }, `Reassigned ${id} to ${profile ?? "(unassigned)"}.`, "Reassign failed: ");
          if (verb === "assign") go();
          else void confirmed(host.app, "Reassign task", CONFIRM.reassign, "Reassign", true).then(ok => { if (ok) go(); });
        });
        break;
      }
      case "cli_hint": {
        const command = typeof payload.command === "string" && payload.command ? payload.command : a.label;
        action(row, label, () => copy(command, "command"), "copy", "Copy command to clipboard");
        break;
      }
      case "comment":
        action(row, label, () => host.open(id, "comment"), "message-square", "Write a comment for the worker");
        break;
      case "open_docs": {
        const url = typeof payload.url === "string" && /^https?:\/\//.test(payload.url) ? payload.url : "";
        if (url) row.createEl("a", { cls: "hm-k-act", href: url, text: label, attr: { target: "_blank", rel: "noreferrer" } });
        else row.createSpan({ cls: "hm-muted", text: label });
        break;
      }
      default:
        row.createSpan({ cls: "hm-muted", text: label });
    }
  }
}

/* ───────────── drawer ───────────── */

/** Section names folded by the user, kept for the session. */
const folded = new Set(["Events", "Worker log"]);

export class TaskDrawer {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly composer: HTMLTextAreaElement;
  private detail: Detail | null = null;
  private part: Component | null = null;
  private seq = 0;
  /** A specify or decompose LLM call is in flight. */
  private busy = false;
  private focus: Focus | undefined;

  constructor(readonly host: TaskHost, parent: HTMLElement, readonly id: string, focus?: Focus) {
    this.focus = focus;
    this.el = parent.createDiv("hm-drawer hm-k-drawer");
    this.head = this.el.createDiv("hm-drawer-head hm-k-head");
    this.pane = this.el.createDiv("hm-pane");
    const foot = this.el.createDiv("hm-k-composer");
    this.composer = foot.createEl("textarea", { attr: { rows: 2, placeholder: "Add a comment… (enter to submit)" } });
    setTooltip(icon(foot, "info"), "Comments reach the worker on its next run or kanban_show() — no need to block the task first.");
    this.composer.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const text = this.composer.value.trim();
      if (!text || this.composer.disabled) return;
      this.composer.disabled = true;
      void this.host.write({ verb: "comment", id: this.id, text }).then(error => {
        this.composer.disabled = false;
        if (error !== null) { new Notice(error, 10_000); return; }
        this.composer.value = "";
        this.composer.focus();
      });
    });
    this.renderHead();
    this.pane.createDiv({ cls: "hm-muted hm-pad", text: "Loading…" });
    this.el.win.requestAnimationFrame(() => this.el.addClass("is-open"));
    void this.refresh();
  }

  /** Re-read the task. A quiet refresh skips while the user edits inside the drawer. */
  async refresh(quiet = false): Promise<void> {
    // ponytail: a skipped refresh waits for the next board change or write
    if (quiet && this.editing()) return;
    const seq = ++this.seq;
    const detail = await this.host.kanban.detail(this.host.alias, this.host.slug, this.id).catch(message);
    if (seq !== this.seq) return;
    if (typeof detail !== "string") return this.render(detail);
    if (!this.detail) { this.pane.empty(); this.pane.createDiv({ cls: "hm-error hm-pad", text: detail }); }
    else if (!quiet) new Notice(detail, 10_000);
  }

  show(focus?: Focus): void {
    this.focus = focus;
    if (this.detail) this.applyFocus();
  }

  close(): void {
    this.seq++;
    if (this.part) this.host.owner.removeChild(this.part);
    this.part = null;
    this.el.removeClass("is-open");
    this.el.win.setTimeout(() => this.el.remove(), 200);
  }

  private editing(): boolean {
    const active = this.el.doc.activeElement;
    return !!this.el.querySelector(".hm-k-edit") || (!!active && active !== this.composer && this.el.contains(active) && active.matches("input, textarea, select"));
  }

  private applyFocus(): void {
    const focus = this.focus;
    this.focus = undefined;
    if (focus === "comment") this.composer.focus();
    const box = focus === "diagnostics" ? this.pane.querySelector<HTMLDetailsElement>(".hm-k-diags") : null;
    if (box) { box.open = true; box.scrollIntoView({ block: "start" }); }
  }

  private async write(v: Verb, undo?: () => void): Promise<void> {
    const error = await this.host.write(v);
    if (error === null) return;
    new Notice(error, 10_000);
    undo?.();
  }

  private section(key: string, label = key): { details: HTMLDetailsElement; head: HTMLElement; body: HTMLElement } {
    const details = this.pane.createEl("details", { cls: "hm-k-section" });
    details.open = !folded.has(key);
    details.addEventListener("toggle", () => { if (details.open) folded.delete(key); else folded.add(key); });
    const head = details.createEl("summary");
    head.createSpan({ cls: "hm-k-section-name", text: label });
    return { details, head, body: details.createDiv("hm-k-section-body") };
  }

  private render(detail: Detail): void {
    this.detail = detail;
    const t = detail.task, app = this.host.app, top = this.pane.scrollTop;
    if (this.part) this.host.owner.removeChild(this.part);
    const part = this.part = this.host.owner.addChild(new Component());
    const md = (parent: HTMLElement, text: string): void => { void renderSafe(app, text, parent.createDiv("hm-doc markdown-rendered"), part); };
    this.renderHead(t);
    this.pane.empty();

    const diags = this.host.diagnostics(this.id);
    if (diags.length) {
      const { details, body } = this.section("Diagnostics", `Diagnostics (${diags.length})`);
      details.addClass("hm-k-diags");
      for (const d of diags) diagCard(body, this.host, t, d);
    }

    this.meta(this.section("Details").body.createDiv("hm-k-meta"), t);

    const desc = this.section("Description");
    const showBody = (body: string | undefined): void => {
      desc.body.empty();
      if (body) md(desc.body, body); else desc.body.createDiv({ cls: "hm-muted", text: "— no description —" });
    };
    showBody(t.body);
    iconButton(desc.head, "pencil", "Edit description", () => {
      if (desc.body.querySelector(".hm-k-edit")) return;
      desc.details.open = true;
      desc.body.empty();
      const area = desc.body.createEl("textarea", { cls: "hm-k-edit", attr: { rows: 10 } });
      area.value = t.body ?? "";
      const bar = desc.body.createDiv("hm-k-edit-bar");
      const save = bar.createEl("button", { cls: "mod-cta", text: "Save" });
      const cancel = (): void => showBody(t.body);
      const submit = (): void => {
        const body = area.value;
        if (body === (t.body ?? "")) return cancel();
        area.disabled = save.disabled = true;
        void this.host.write({ verb: "edit", id: this.id, body }).then(error => {
          area.disabled = save.disabled = false;
          if (error !== null) { new Notice(error, 10_000); return; }
          t.body = body;
          showBody(body);
        });
      };
      save.addEventListener("click", submit);
      bar.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
      area.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      });
      area.focus();
    }, "hm-push");

    const deps = this.section("Dependencies");
    iconButton(deps.head, "plus", "Add dependency", () => this.addDependency(), "hm-push");
    for (const [label, list, isParent] of [["Parents:", detail.parents, true], ["Children:", detail.children, false]] as const) {
      const line = deps.body.createDiv("hm-k-deps");
      line.createSpan({ cls: "hm-muted", text: label });
      if (!list.length) line.createSpan({ cls: "hm-muted", text: "none" });
      for (const r of list) {
        const chip = line.createSpan(`hm-k-dep is-${r.status}`);
        const open = chip.createEl("button", { cls: "hm-k-dep-open", text: r.id });
        setTooltip(open, `${r.title || "(untitled)"} · ${COLUMNS[r.status].label}`);
        open.addEventListener("click", () => this.host.open(r.id));
        iconButton(chip, "x", "Remove dependency", () => void this.write(isParent ? { verb: "unlink", id: r.id, child: this.id } : { verb: "unlink", id: this.id, child: r.id }));
      }
    }

    const summary = [...detail.runs].reverse().find(r => r.summary)?.summary;
    if (t.result) md(this.section("Result").body, t.result);
    else if (summary) md(this.section("Result", "Final Result (run summary)").body, summary);
    else if (t.status === "done") this.section("Result").body.createDiv({ cls: "hm-muted", text: detail.children.length ? "This card is an orchestrator / parent task. Review the child results section for the substantive work." : "No final result was recorded. Check Run History, Logs, or Child Tasks for details." });

    if (detail.children.length) {
      const box = this.section("Child results", `Child results (${detail.children.length})`).body;
      for (const c of detail.children) {
        const item = box.createDiv("hm-k-item");
        const line = item.createDiv("hm-k-line");
        line.createSpan({ cls: "hm-k-line-text", text: `${c.id} · ${c.title || "(untitled)"}` });
        line.createSpan({ cls: `hm-k-chip is-${c.status}`, text: COLUMNS[c.status].label });
        action(line, "Open", () => this.host.open(c.id));
        const text = c.result || c.summary;
        if (text) md(item, text); else item.createDiv({ cls: "hm-muted", text: "No result recorded yet." });
      }
    }

    if (detail.attachments.length) {
      const box = this.section("Attachments", `Attachments (${detail.attachments.length})`).body;
      for (const a of detail.attachments) {
        const line = box.createDiv("hm-k-line");
        setTooltip(icon(line, "paperclip"), a.type || "Attachment");
        line.createSpan({ cls: "hm-k-line-text", text: a.name });
        if (a.size) line.createSpan({ cls: "hm-muted", text: `${compact(a.size)}B` });
        when(line, a.at);
        iconButton(line, "trash-2", "Remove attachment", () => void confirmed(app, "Remove attachment", "Remove this attachment?", "Delete", true).then(ok => {
          if (ok) void this.write({ verb: "attach-rm", id: this.id, attachment: a.id });
        }));
      }
    }

    const comments = this.section("Comments", `Comments (${detail.comments.length})`).body;
    if (!detail.comments.length) comments.createDiv({ cls: "hm-muted", text: "— no comments —" });
    for (const c of detail.comments) {
      const item = comments.createDiv("hm-k-item");
      const line = item.createDiv("hm-k-line");
      line.createSpan({ cls: "hm-k-author", text: c.author || "anon" });
      when(line, c.at);
      md(item, c.body);
    }

    const events = this.section("Events", `Events (${detail.events.length} of ${detail.eventCount})`).body;
    for (const e of detail.events) {
      const line = events.createDiv("hm-k-event");
      line.createSpan({ cls: "hm-k-author", text: e.kind });
      when(line, e.at);
      if (e.payload !== undefined && e.payload !== null) line.createEl("code", { text: JSON.stringify(e.payload) });
    }

    const log = this.section("Worker log", detail.log ? `Worker log (${detail.log.size} B)` : "Worker log");
    iconButton(log.head, "refresh-cw", "Refresh log", () => void this.refresh(), "hm-push");
    if (!detail.log) log.body.createDiv({ cls: "hm-muted", text: "— no worker log yet (task hasn't spawned or log was rotated away) —" });
    else {
      if (detail.log.size > 100_000) log.body.createDiv({ cls: "hm-muted", text: "(showing last 100 KB)" });
      log.body.createEl("pre", { cls: "hm-k-log", text: detail.log.text || "(empty)" });
    }

    const runs = this.section("Run history", `Run history (${detail.runs.length})`).body;
    const drawRuns = (all: boolean): void => {
      runs.empty();
      if (!detail.runs.length) runs.createDiv({ cls: "hm-muted", text: "— no runs —" });
      for (const r of all ? detail.runs : detail.runs.slice(-3)) {
        const item = runs.createDiv("hm-k-item");
        const line = item.createDiv("hm-k-line");
        line.createSpan({ cls: "hm-k-chip", text: r.endedAt ? r.outcome || r.status || "ended" : "active" });
        line.createSpan({ text: r.profile ? `@${r.profile}` : "(no profile)" });
        if (r.startedAt) line.createSpan({ cls: "hm-muted", text: elapsed((r.endedAt ?? Date.now() / 1000) - r.startedAt) });
        when(line, r.startedAt);
        if (r.summary) item.createDiv({ cls: "hm-k-run-text", text: r.summary });
        if (r.error) item.createDiv({ cls: "hm-error", text: r.error });
        if (r.metadata !== undefined && r.metadata !== null) {
          const json = JSON.stringify(r.metadata, null, 2), box = item.createEl("details", { cls: "hm-k-json" });
          box.open = json.length <= 300;
          box.createEl("summary", { text: "Metadata" });
          box.createEl("pre", { text: json });
        }
      }
      if (!all && detail.runs.length > 3) action(runs, "Show all attempts", () => drawRuns(true));
    };
    drawRuns(false);

    this.pane.scrollTop = top;
    this.applyFocus();
  }

  private renderHead(t?: TaskRow): void {
    const head = this.head;
    head.empty();
    const top = head.createDiv("hm-k-head-top");
    if (t) setTooltip(icon(top, COLUMNS[t.status].icon, `hm-icon hm-k-status is-${t.status}`), COLUMNS[t.status].label);
    const id = top.createEl("button", { cls: "hm-k-id hm-code", text: this.id });
    setTooltip(id, "Copy id");
    id.addEventListener("click", () => copy(this.id));
    iconButton(top, "x", "Close (Esc)", () => this.host.close(), "hm-push");
    if (!t) return;
    const title = head.createDiv({ cls: "hm-drawer-name hm-k-title", text: t.title || "(untitled)" });
    setTooltip(title, "Click to edit");
    title.addEventListener("click", () => this.editTitle(title, t));
    const chips = head.createDiv("hm-k-chips");
    chips.createSpan({ cls: `hm-k-chip is-${t.status}`, text: COLUMNS[t.status].label });
    chips.createSpan({ cls: "hm-k-chip", text: `P${t.priority}` });
    if (t.tenant) chips.createSpan({ cls: "hm-k-chip", text: t.tenant });
    if (t.assignee) {
      const chip = chips.createSpan("hm-k-chip");
      avatar(chip, t.assignee, "hm-avatar is-small");
      chip.createSpan({ text: t.assignee });
    }
    this.actions(head.createDiv("hm-k-acts"), t);
  }

  private editTitle(title: HTMLElement, t: TaskRow): void {
    const input = createEl("input", { cls: "hm-k-edit hm-k-title", type: "text", value: t.title });
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.replaceWith(title);
      if (!save || !text || text === t.title) return;
      title.setText(text);
      void this.write({ verb: "edit", id: this.id, title: text }, () => title.setText(t.title || "(untitled)"));
    };
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private actions(row: HTMLElement, t: TaskRow): void {
    const app = this.host.app, id = this.id, s = t.status;
    const add = (iconName: string, label: string, tip: string, run: () => void): void => { action(row, label, run, iconName, tip); };
    const sure = (title: string, text: string, cta: string, warning: boolean, v: Verb): void => {
      void confirmed(app, title, text, cta, warning).then(ok => { if (ok) void this.write(v); });
    };
    if (s === "triage") {
      add("sparkles", "Specify", "Let an LLM flesh out the spec", () => void this.slow("specify"));
      add("split", "Decompose", "Let an LLM split it into child tasks", () => void this.slow("decompose"));
    }
    if (s === "todo") add("circle-dot", "Ready", "Promote to ready", () => void this.write({ verb: "promote", id }));
    if (s === "scheduled") add("circle-dot", "Ready", "Unblock to ready", () => void this.write({ verb: "unblock", id }));
    if (s === "running") add("rotate-ccw", "Reclaim", "Stop the worker and return the task to ready", () => sure("Reclaim task", CONFIRM.reclaim, "Reclaim", true, { verb: "reclaim", id, reason: "reclaimed from Obsidian" }));
    if (s === "blocked") add("lock-open", "Unblock", "Move back to ready", () => void this.write({ verb: "unblock", id }));
    if (s === "review") add("undo-2", "Request changes", "Send back to ready with a reason", () => ask(app, {
      title: "Request changes", cta: "Send back",
      fields: [{ key: "reason", label: "What should change?", kind: "textarea", required: true, enter: true }],
      submit: v => this.host.write({ verb: "reopen-review", id, reason: v.reason ?? "" }),
    }));
    if (s === "ready" || s === "running") add("ban", "Block…", "Block with a reason", () => askBlock(app, [t], (kind, reason) => this.host.write({ verb: "block", id, kind, reason })));
    if (s === "ready" || s === "running" || s === "blocked" || s === "review") add("circle-check", "Complete…", "Mark as done", () => askComplete(app, 1, (summary, result) =>
      this.host.write({ verb: "complete", id, ...(summary ? { summary } : {}), ...(result ? { result } : {}), ...(s === "running" ? { force: true } : {}) })));
    if (s === "todo" || s === "ready" || s === "running" || s === "blocked") add("clock", "Schedule", "Park until a known time or follow-up", () => ask(app, {
      title: "Schedule task", cta: "Schedule",
      fields: [{ key: "reason", label: "Reason", kind: "textarea", enter: true, placeholder: "Optional" }],
      submit: v => this.host.write({ verb: "schedule", id, ...(v.reason ? { reason: v.reason } : {}) }),
    }));
    if (s === "ready") add("eye", "Request review", "Move to review", () => void this.write({ verb: "request-review", id }));
    if (s === "running") add("eye", "Request review", "Move to review", () => sure("Request review", "Move this task to review? Its worker may still be running.", "Move", false, { verb: "request-review", id, force: true }));
    if (s !== "archived") add("archive", "Archive", "Archive this task", () => sure("Archive task", CONFIRM.archive, "Archive", true, { verb: "archive", id }));
  }

  /** Specify and decompose call an LLM on the host; they get the slow adapter and a sticky notice. */
  private async slow(v: "specify" | "decompose"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const specify = v === "specify";
      if (!await confirmed(this.host.app, specify ? "Specify task" : "Decompose task", CONFIRM[v], specify ? "Specify" : "Decompose")) return;
      const notice = new Notice(`${specify ? "Specifying" : "Decomposing"} ${this.id}… (can take a minute)`, 0);
      const error = await this.host.write({ verb: v, id: this.id });
      notice.hide();
      if (error !== null) new Notice(error, 10_000);
    } finally {
      this.busy = false;
    }
  }

  private meta(grid: HTMLElement, t: TaskRow): void {
    const app = this.host.app;
    const key = (label: string): HTMLElement => { grid.createDiv({ cls: "hm-k-meta-key", text: label }); return grid.createDiv("hm-k-meta-value"); };
    const row = (label: string, value: string | number | undefined, tip = ""): void => {
      if (value === undefined || value === "") return;
      const el = key(label).createSpan({ text: String(value) });
      if (tip) setTooltip(el, tip);
    };
    const time = (label: string, at: number | undefined): void => { if (at) when(key(label), at, ""); };

    const who = key("Assignee").createEl("select", { cls: "dropdown" });
    for (const p of new Set(["", ...this.host.profiles(), t.assignee ?? ""])) who.createEl("option", { value: p, text: p || "unassigned" });
    who.value = t.assignee ?? "";
    who.addEventListener("change", () => {
      const profile = who.value || null, undo = (): void => { who.value = t.assignee ?? ""; };
      who.blur();
      if (t.status !== "running") { void this.write({ verb: "assign", id: this.id, profile }, undo); return; }
      void confirmed(app, "Reassign task", CONFIRM.reassign, "Reassign", true).then(ok => {
        if (ok) void this.write({ verb: "reassign", id: this.id, profile, reason: "reassigned from Obsidian" }, undo); else undo();
      });
    });

    const priority = key("Priority");
    priority.createSpan({ text: `P${t.priority}` });
    iconButton(priority, "pencil", "Set priority", () => ask(app, {
      title: "Set priority", cta: "Save",
      fields: [{ key: "priority", label: "Priority", kind: "number", value: String(t.priority) }],
      submit: v => /^-?\d+$/.test(v.priority ?? "") ? this.host.write({ verb: "edit", id: this.id, priority: Number(v.priority) }) : Promise.resolve("Priority must be a whole number"),
    }));

    const model = key("Model");
    model.createSpan({ text: t.model ? (t.provider ? `${t.provider}: ${t.model}` : t.model) : "profile default" });
    iconButton(model, "pencil", "Set model", () => {
      const models = modelPicker(this.host);
      ask(app, {
        title: "Set model", cta: "Save",
        fields: [
          { key: "model", label: "Model", value: t.model ?? "", placeholder: "empty = profile default", suggest: q => models(q, t.assignee || "default") },
          { key: "provider", label: "Provider", value: t.provider ?? "" },
        ],
        submit: v => v.provider && !v.model ? Promise.resolve("provider_override requires a model_override")
          : this.host.write({ verb: "set-model", id: this.id, model: v.model || null, ...(v.model && v.provider ? { provider: v.provider } : {}) }),
      });
    });

    row("Tenant", t.tenant);
    row("Workspace", t.workspaceKind && (t.workspacePath ? `${t.workspaceKind}: ${t.workspacePath}` : t.workspaceKind));
    row("Branch", t.branch);
    row("Skills", t.skills?.join(", "));
    row("Goal", t.goalMode ? `on (max ${t.goalMaxTurns ?? 20} turns)` : undefined);
    row("Max runtime", t.maxRuntime ? elapsed(t.maxRuntime) : undefined);
    row("Max retries", t.maxRetries);
    row("Failures", t.failures, t.lastError);
    row("Created by", t.createdBy);
    time("Created", t.createdAt);
    time("Started", t.startedAt);
    time("Completed", t.completedAt);
    time("Heartbeat", t.heartbeatAt);
    row("Claim", t.claimLock, t.claimExpires ? `Expires ${absolute(t.claimExpires)}` : "");
    row("PID", t.pid);
    row("Run", t.runId && `#${t.runId}`);
  }

  private addDependency(): void {
    const cards = this.host.cards().filter(c => c.id !== this.id);
    ask(this.host.app, {
      title: "Add dependency", cta: "Link",
      fields: [
        { key: "relation", label: "This task", kind: "dropdown", value: "child", options: [["child", "waits for (is a child of)"], ["parent", "is a parent of"]] },
        { key: "other", label: "Task", required: true, placeholder: "Task id or title", suggest: q => cards.filter(c => matches(q, c.id, c.title)).slice(0, 50).map(c => ({ value: c.id, label: c.title || "(untitled)", note: c.id })) },
      ],
      submit: v => {
        // An exact id wins, else the one card with that title; `cards` leaves this task out, so it never links to itself.
        const text = (v.other ?? "").trim(), named = cards.filter(c => c.title.trim().toLowerCase() === text.toLowerCase());
        const other = cards.find(c => c.id === text)?.id ?? (named.length === 1 ? named[0]?.id : undefined);
        if (!other) return Promise.resolve("Pick a task from the list");
        return this.host.write(v.relation === "parent" ? { verb: "link", id: this.id, child: other } : { verb: "link", id: other, child: this.id });
      },
    });
  }
}
