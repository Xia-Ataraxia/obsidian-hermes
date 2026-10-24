import { Menu, Notice, setIcon, setTooltip, SuggestModal, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { action, ask, askBlock, askComplete, COLUMNS, CONFIRM, confirmed, copy, diagCard, matches, message, openCreate, severityIcon, severityRank, suggestion, TaskDrawer, when, type Focus, type TaskHost } from "./kanban-drawer";
import { dropVerb, staleness, STATUSES, type Alert, type BoardMeta, type BoardRead, type Card, type Diagnostic, type Drop, type Status, type Verb } from "./kanban";
import { avatar, HermesView, icon, iconButton, relative, stat, type HermesHost } from "./ui";

export const KANBAN_VIEW = "hermes-kanban";

const STUCK: Record<string, { icon: string; headline: string; sticky: boolean } | undefined> = {
  blocked: { icon: "ban", headline: "Blocked — needs your input", sticky: true },
  block_loop_detected: { icon: "repeat", headline: "Sent to triage — needs a decision", sticky: true },
  gave_up: { icon: "circle-x", headline: "Stopped — Hermes couldn't finish it", sticky: true },
  crashed: { icon: "zap-off", headline: "Crashed — will retry automatically", sticky: false },
  timed_out: { icon: "timer-off", headline: "Timed out — will retry automatically", sticky: false },
};

/** One Notice per board; a click opens the board, or the task when the Notice names one. */
export function noticeStuck(alerts: Alert[], open: (board: string, task?: string) => void): void {
  const byBoard = new Map<string, Alert[]>();
  for (const a of alerts) byBoard.set(a.board, [...(byBoard.get(a.board) ?? []), a]);
  const look = (a: Alert) => STUCK[a.kind] ?? { icon: "triangle-alert", headline: a.kind, sticky: true };
  for (const list of byBoard.values()) {
    const [first] = list;
    if (!first) continue;
    const fragment = createFragment();
    const box = fragment.createDiv("hm-k-notice");
    const head = box.createDiv("hm-k-notice-head");
    const rows: [HTMLElement, string][] = [];
    if (list.length === 1) {
      icon(head, look(first).icon);
      head.createSpan({ text: look(first).headline });
      box.createDiv({ cls: "hm-k-notice-title", text: `${first.title} · ${first.boardName}` });
      if (first.reason) box.createDiv({ cls: "hm-muted", text: first.reason.slice(0, 160) });
    } else {
      const blocked = list.every(a => a.kind === "blocked");
      icon(head, blocked ? "ban" : "triangle-alert");
      head.createSpan({ text: blocked ? `${list.length} tasks blocked on ${first.boardName}` : `${list.length} tasks need attention · ${first.boardName}` });
      for (const a of list.slice(0, 3)) {
        const row = box.createDiv("hm-k-notice-row");
        icon(row, look(a).icon);
        row.createSpan({ text: a.title });
        rows.push([row, a.task]);
      }
      if (list.length > 3) box.createDiv({ cls: "hm-muted", text: `+${list.length - 3} more` });
    }
    const notice = new Notice(fragment, list.some(a => look(a).sticky) ? 0 : 10_000);
    const go = (task?: string): void => { notice.hide(); open(first.board, task); };
    for (const [row, task] of rows) row.addEventListener("click", event => { event.stopPropagation(); go(task); });
    box.addEventListener("click", () => go(list.length === 1 ? first.task : undefined));
  }
}

interface Pref { lanes?: boolean; archived?: boolean; folds?: Partial<Record<Status, boolean>> }
type Item = { kind: "board"; meta: BoardMeta } | { kind: "new" | "settings" | "archive" };

const AUTO = "Orchestration: Auto — the dispatcher decomposes new triage tasks automatically every tick.";
const MANUAL = "Orchestration: Manual — triage tasks stay in triage until you click Decompose on each card.";
const NEEDS = "Dependencies are satisfied, but the dispatcher skips this task until you assign a profile.";
const CAPPED = new Set<Status>(["done", "archived"]);
const plural = (n: number): string => n === 1 ? "" : "s";
const on = (v?: string): boolean => !/^(false|no|off|0)$/i.test(v ?? "");

/** Rebuild a filter select only when its options change; returns the kept value ("" when it vanished). */
function fill(select: HTMLSelectElement, all: string, options: [string, string][], value: string): string {
  const key = options.map(([v]) => v).join("\n");
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.empty();
    select.createEl("option", { value: "", text: all });
    for (const [v, label] of options) select.createEl("option", { value: v, text: label });
  }
  const kept = options.some(([v]) => v === value) ? value : "";
  select.value = kept;
  return kept;
}

export class KanbanView extends HermesView {
  private read: BoardRead | null = null;
  private key = "";
  private diags: Record<string, Diagnostic[]> = {};
  private diagSeq = 0;
  private prefs: Record<string, Pref> = {};
  private search = "";
  private tenant = "";
  private profile = "";
  private readonly selected = new Set<string>();
  private readonly failed = new Set<string>();
  private anchor = "";
  private dragging: string[] | null = null;
  private readonly allow = new Set<Status>();
  private drawer: TaskDrawer | null = null;
  private drawerJson = "";
  private dirty: string | null = null;
  private pending: { board: string; task: string } | null = null;
  private banner = "";
  private hiddenAttention: string | null = null;
  private attentionOpen = false;
  private shown: Partial<Record<Status, number>> = {};
  private force = false;
  private landing: { ids: string[]; to: Status } | null = null;
  private switcher!: HTMLButtonElement;
  private pill!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private tenantSelect!: HTMLSelectElement;
  private profileSelect!: HTMLSelectElement;
  private archivedButton!: HTMLButtonElement;
  private lanesButton!: HTMLButtonElement;
  private clearButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 15_000);
  }

  getViewType(): string { return KANBAN_VIEW; }
  getDisplayText(): string { return "Hermes kanban"; }
  override getIcon(): string { return "square-kanban"; }
  protected override busy(): boolean { return !!this.dragging; }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), prefs: this.prefs };
  }

  /** `board` switches the board; `board` + `task` also opens that task once the board is read. */
  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { alias?: unknown; board?: unknown; task?: unknown; prefs?: unknown };
    const before = this.alias;
    const alias = typeof s.alias === "string" ? s.alias : this.alias;
    if (s.prefs && typeof s.prefs === "object") this.prefs = s.prefs as Record<string, Pref>;
    let switched = false;
    if (typeof s.board === "string" && alias && s.board !== this.host.board(alias)) {
      this.host.saveBoard(alias, s.board);
      switched = true;
    }
    if (typeof s.board === "string" && typeof s.task === "string") this.pending = { board: s.board, task: s.task };
    await super.setState(state, result);
    if (this.alias !== before || !this.body) return;
    if (switched) this.switchBoard(this.host.board(this.alias));
    else if (this.pending && this.read?.board === this.pending.board) {
      const { task } = this.pending;
      this.pending = null;
      this.open(task);
    }
  }

  protected override async reload(quiet = false): Promise<void> {
    if (!quiet) this.force = true;
    return super.reload(quiet);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.contentEl.addClass("hm-k-view");
    // ponytail: D29, the board token misses heartbeat and claim changes; they wait for a forced read (open, board switch, window focus, Refresh, a write).
    this.registerDomEvent(this.contentEl.win, "focus", () => {
      if (!this.contentEl.isShown() || this.busy()) return;
      this.force = true;
      void this.reload(true);
    });
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Esc in the board's own inputs (search, inline edits) is theirs.
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (this.drawer) this.closeDrawer();
      else if (this.selected.size) this.selected.clear();
      else return;
      event.preventDefault();
      this.render();
    });
    // ponytail: one 60 s pass relabels every relative time; no per-element timers.
    this.registerInterval(window.setInterval(() => {
      for (const el of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-at]"))) el.setText(relative(Number(el.dataset.at)));
    }, 60_000));
  }

  protected async pull(alias: string): Promise<string | null> {
    const force = this.force, landing = this.landing, dirty = this.dirty;
    this.force = false;
    this.landing = null;
    this.dirty = null;
    const slug = this.host.board(alias);
    const r = await this.host.kanban.board(alias, slug, !!this.prefs[slug]?.archived, force);
    if (alias !== this.alias || slug !== this.host.board(alias)) {
      // A stale read: the next pull, for the board shown now, still owes these.
      this.force ||= force;
      this.landing ??= landing;
      this.dirty ??= dirty;
      return null;
    }
    if (typeof r === "string") return r;
    if (`${alias}|${r.board}` !== this.key) {
      this.key = `${alias}|${r.board}`;
      this.resetTransient();
    }
    const changed = r.tasks !== this.read?.tasks;
    this.read = r;
    if (r.board !== slug) this.host.saveBoard(alias, r.board);
    if (changed) {
      const ids = new Set(r.tasks.map(c => c.id));
      for (const set of [this.selected, this.failed]) for (const id of set) if (!ids.has(id)) set.delete(id);
      void this.loadDiagnostics(alias, r.board);
    }
    const drawer = this.drawer;
    if (drawer && (changed || dirty === drawer.id)) {
      const json = JSON.stringify(r.tasks.find(c => c.id === drawer.id) ?? null);
      if (json !== this.drawerJson || dirty === drawer.id) {
        this.drawerJson = json;
        void drawer.refresh(true);
      }
    }
    if (landing) for (const id of landing.ids) {
      const status = r.tasks.find(c => c.id === id)?.status;
      if (status && status !== landing.to) new Notice(`${id} landed in ${COLUMNS[status].label}`, 6_000);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      if (p.board === r.board) this.open(p.task);
    }
    return null;
  }

  /** Selection, filters, banners and the drawer belong to one board on one host. */
  private resetTransient(): void {
    this.selected.clear();
    this.failed.clear();
    this.anchor = "";
    this.search = this.tenant = this.profile = "";
    this.shown = {};
    this.banner = "";
    this.hiddenAttention = null;
    this.diags = {};
    this.diagSeq++;
    this.closeDrawer();
  }

  private switchBoard(slug: string): void {
    this.host.saveBoard(this.alias, slug);
    this.resetTransient();
    this.read = null;
    this.empty("loader", "Loading…");
    void this.reload();
  }

  private async loadDiagnostics(alias: string, slug: string): Promise<void> {
    const seq = ++this.diagSeq;
    // ponytail: best effort; a failed read keeps the last diagnostics until the board changes again.
    const r = await this.host.kanban.diagnostics(alias, slug).catch(() => null);
    if (seq !== this.diagSeq || !r || typeof r === "string" || alias !== this.alias || slug !== this.read?.board) return;
    const id = this.drawer?.id ?? "";
    const before = JSON.stringify(this.diags[id] ?? []);
    this.diags = r;
    if (this.drawer && JSON.stringify(r[id] ?? []) !== before) void this.drawer.refresh(true);
    if (!this.busy()) this.render();
  }

  private async write(v: Verb): Promise<string | null> {
    const r = await this.host.kanban.run(this.alias, this.read?.board ?? this.host.board(this.alias), v)
      .catch((e: unknown) => ({ ok: false as const, message: message(e) }));
    if (!r.ok) return r.message;
    this.dirty = v.id;
    void this.reload();
    return null;
  }

  private open(id: string, focus?: Focus): void {
    if (this.drawer?.id === id) {
      this.drawer.show(focus);
      return;
    }
    this.closeDrawer();
    this.drawer = new TaskDrawer(this.taskHost(), this.contentEl, id, focus);
    // ponytail: top is measured at open; a toolbar that wraps later overlaps the drawer head until it reopens.
    this.drawer.el.setCssProps({ "--hm-k-top": `${this.toolbar.offsetHeight}px` });
    this.drawerJson = JSON.stringify(this.read?.tasks.find(c => c.id === id) ?? null);
    this.render();
  }

  private closeDrawer(): void {
    this.drawer?.close();
    this.drawer = null;
  }

  private taskHost(): TaskHost {
    return {
      app: this.app, owner: this, alias: this.alias, slug: this.read?.board ?? this.host.board(this.alias),
      kanban: this.host.kanban, client: this.host.client,
      cards: () => this.read?.tasks ?? [],
      profiles: () => this.read?.profiles ?? [],
      diagnostics: id => this.diags[id] ?? [],
      write: v => this.write(v),
      open: (id, focus) => this.open(id, focus),
      close: () => { this.closeDrawer(); this.render(); },
    };
  }

  private meta(): BoardMeta | undefined { return this.read?.boards.find(b => b.slug === this.read?.board); }
  private pref(): Pref { return this.prefs[this.read?.board ?? this.host.board(this.alias)] ??= {}; }
  private lanes(): boolean { return this.pref().lanes ?? on(this.read?.config.lane_by_profile); }
  private clearFilters(): void {
    this.search = this.tenant = this.profile = "";
    this.render();
  }

  /** Runs verbs in one round trip. With `to`, the cards move first and a failed one moves back. */
  private async apply(verbs: Verb[], to?: Status): Promise<null> {
    const r = this.read;
    if (!r || !verbs.length) return null;
    const cards = new Map(r.tasks.map((c): [string, Card] => [c.id, c]));
    const before = new Map(verbs.map((v): [string, Status | undefined] => [v.id, cards.get(v.id)?.status]));
    if (to) for (const v of verbs) {
      const c = cards.get(v.id);
      if (c) c.status = to;
    }
    this.render();
    const key = this.key;
    const results = await this.host.kanban.bulk(this.alias, r.board, verbs).catch((e: unknown) => message(e));
    // After a board or server switch (switchBoard() empties `read` at once) the marks, banner and landing belong to the
    // old board: only the notice is left. Failed cards still move back: they are the client's cached objects, which the
    // next read of that board reuses while its token is unchanged.
    const same = this.key === key && this.read !== null, ok: string[] = [], errors: string[] = [];
    for (const v of verbs) {
      const o = typeof results === "string" ? { ok: false as const, message: results } : results[v.id] ?? { ok: false as const, message: "No result from the host" };
      if (o.ok) {
        if (same) this.failed.delete(v.id);
        ok.push(v.id);
        continue;
      }
      errors.push(`${v.id}: ${o.message}`);
      const c = cards.get(v.id), was = before.get(v.id);
      if (c && was) c.status = was;
      if (same) this.failed.add(v.id);
    }
    const failure = verbs.length === 1 ? `${to ? "Move" : "Action"} failed: ${errors[0]}`
      : `${to ? "Bulk move" : "Bulk action"}: ${errors.length} of ${verbs.length} failed\n${errors.slice(0, 3).join("\n")}`;
    if (errors.length && verbs.length === 1 && same) this.banner = failure;
    else if (errors.length) new Notice(failure, 10_000);
    if (!same) return null;
    if (to && ok.length) this.landing = { ids: ok, to };
    this.render();
    void this.reload();
    return null;
  }

  private async drop(ids: string[], to: Status): Promise<void> {
    const r = this.read;
    if (!r) return;
    const label = COLUMNS[to].label;
    const go: [Card, Drop][] = [];
    for (const c of r.tasks.filter(t => ids.includes(t.id))) {
      const d = dropVerb(c.status, to);
      if (d === "refuse") {
        new Notice(`No command moves a task into ${label}.`);
        return;
      }
      if (d) go.push([c, d]);
    }
    if (!go.length) {
      new Notice(`No command moves ${ids.length === 1 ? "this task" : "these tasks"} to ${label}.`);
      return;
    }
    const cards = go.map(([c]) => c);
    if (to === "blocked") return askBlock(this.app, cards, (kind, reason) => this.apply(cards.map((c): Verb => ({ verb: "block", id: c.id, kind, reason })), to));
    if (to === "done") return askComplete(this.app, cards.length, (summary, result) => this.apply(cards.map((c): Verb => ({
      verb: "complete", id: c.id, ...(summary ? { summary } : {}), ...(result ? { result } : {}), ...(c.status === "running" ? { force: true } : {}),
    })), to));
    if (to === "archived" && !await confirmed(this.app, "Archive", cards.length === 1 ? CONFIRM.archive : `Archive ${cards.length} tasks?`, "Archive", true)) return;
    if (go.some(([, d]) => d === "reclaim") && !await confirmed(this.app, "Reclaim", CONFIRM.reclaim, "Reclaim", true)) return;
    await this.apply(go.map(([c, d]): Verb => d === "reclaim" ? { verb: d, id: c.id, reason: "reclaimed from Obsidian" } : { verb: d, id: c.id } as Verb), to);
  }

  private async assign(cards: Card[], profile: string | null): Promise<void> {
    if (cards.some(c => c.status === "running") && !await confirmed(this.app, "Reassign", CONFIRM.reclaim, "Reassign", true)) return;
    await this.apply(cards.map((c): Verb => c.status === "running"
      ? { verb: "reassign", id: c.id, profile, reason: "reassigned from Obsidian" }
      : { verb: "assign", id: c.id, profile }));
  }

  private async nudge(): Promise<void> {
    if (!await confirmed(this.app, "Nudge dispatcher", "Wake the dispatcher to claim up to 8 ready tasks now?", "Nudge")) return;
    const r = await this.host.kanban.nudge(this.alias, this.read?.board ?? this.host.board(this.alias))
      .catch((e: unknown) => ({ ok: false as const, message: message(e) }));
    new Notice(r.ok ? r.text || "Dispatcher nudged; nothing to spawn." : r.message, 10_000);
    void this.reload();
  }

  private buildTools(): void {
    this.switcher = this.tools.createEl("button", { cls: "hm-k-switch", attr: { type: "button", "aria-label": "Switch board" } });
    setTooltip(this.switcher, "Switch board");
    this.switcher.addEventListener("click", () => this.openSwitcher());
    this.pill = this.tools.createSpan("hm-k-pill");
    const search = this.tools.createDiv("hm-search");
    icon(search, "search");
    this.searchInput = search.createEl("input", { attr: { type: "search", placeholder: "Filter cards…", "aria-label": "Filter cards" } });
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value;
      this.render();
    });
    this.tenantSelect = this.tools.createEl("select", { cls: "dropdown hm-k-select" });
    setTooltip(this.tenantSelect, "Filter by tenant");
    this.tenantSelect.addEventListener("change", () => {
      this.tenant = this.tenantSelect.value;
      this.render();
    });
    this.profileSelect = this.tools.createEl("select", { cls: "dropdown hm-k-select" });
    setTooltip(this.profileSelect, "Filter by assignee");
    this.profileSelect.addEventListener("change", () => {
      this.profile = this.profileSelect.value;
      this.render();
    });
    this.archivedButton = iconButton(this.tools, "archive", "Show archived", () => {
      const p = this.pref();
      p.archived = !p.archived;
      this.app.workspace.requestSaveLayout();
      void this.reload();
    });
    this.lanesButton = iconButton(this.tools, "rows-3", "Lanes by profile", () => {
      this.pref().lanes = !this.lanes();
      this.app.workspace.requestSaveLayout();
      this.render();
    });
    this.clearButton = iconButton(this.tools, "filter-x", "Clear filters", () => this.clearFilters());
    iconButton(this.tools, "zap", "Wake the dispatcher to claim ready tasks now", () => void this.nudge());
    iconButton(this.tools, "plus", "New task", () => openCreate(this.taskHost(), "ready", this.meta()?.workdir, () => void this.reload()));
  }

  private syncTools(r: BoardRead): void {
    const meta = this.meta();
    this.switcher.empty();
    const mark = this.switcher.createSpan("hm-k-board-icon");
    setIcon(mark, meta?.icon || "square-kanban");
    if (!mark.querySelector("svg")) mark.setText(meta?.icon ?? "");
    this.switcher.setCssProps({ "--hm-k-board": meta?.color ?? "" });
    this.switcher.createSpan({ cls: "hm-k-board-name", text: meta?.name || r.board });
    icon(this.switcher, "chevron-down");
    const elsewhere = r.boards.filter(b => b.slug !== r.board && !b.archived && (b.counts.blocked ?? 0) > 0);
    if (elsewhere.length) setTooltip(this.switcher.createSpan("hm-k-dot"), `Blocked tasks on ${elsewhere.map(b => b.name || b.slug).join(", ")}`);
    const auto = on(r.config.auto_decompose);
    this.pill.setText(auto ? "Auto" : "Manual");
    this.pill.toggleClass("is-on", auto);
    setTooltip(this.pill, `${auto ? AUTO : MANUAL}\nOrchestrator: ${r.config.orchestrator_profile || "—"}\nDefault assignee: ${r.config.default_assignee || "—"}`);
    const tenants = [...new Set(r.tasks.flatMap(c => c.tenant ? [c.tenant] : []))].sort();
    this.tenant = fill(this.tenantSelect, "All tenants", tenants.map((t): [string, string] => [t, t]), this.tenant);
    this.tenantSelect.toggle(tenants.length > 0);
    const people = [...new Set([...r.profiles, ...r.tasks.flatMap(c => c.assignee ? [c.assignee] : [])])].sort();
    this.profile = fill(this.profileSelect, "All profiles", [...people.map((p): [string, string] => [p, `@${p}`]), [" none", "Unassigned"]], this.profile);
    const press = (b: HTMLButtonElement, active: boolean): void => {
      b.toggleClass("is-active", active);
      b.setAttr("aria-pressed", String(active));
    };
    press(this.archivedButton, !!this.pref().archived);
    press(this.lanesButton, this.lanes());
    this.clearButton.toggle(!!(this.search || this.tenant || this.profile));
    if (this.searchInput.value !== this.search) this.searchInput.value = this.search;
  }

  /** Board switcher with per-board counts, plus New board, Board settings and Archive this board. */
  private openSwitcher(): void {
    const r = this.read;
    if (!r) return;
    const items: Item[] = [...r.boards.filter(b => !b.archived).map((meta): Item => ({ kind: "board", meta })), { kind: "new" }, { kind: "settings" }];
    if (r.board !== "default") items.push({ kind: "archive" });
    const label = (i: Item): string => i.kind === "board" ? i.meta.name || i.meta.slug
      : i.kind === "new" ? "New board…" : i.kind === "settings" ? "Board settings…" : "Archive this board…";
    const draw = (i: Item, el: HTMLElement): void => {
      if (i.kind !== "board") return suggestion(el, label(i));
      const total = STATUSES.reduce((n, s) => s === "archived" ? n : n + (i.meta.counts[s] ?? 0), 0);
      const blocked = i.meta.counts.blocked ?? 0;
      suggestion(el, label(i), `${total} task${plural(total)}${blocked ? ` · ${blocked} blocked` : ""}${i.meta.slug === r.board ? " · current" : ""}`);
    };
    const choose = (i: Item): void => {
      if (i.kind === "board") {
        if (i.meta.slug !== r.board) this.switchBoard(i.meta.slug);
        return;
      }
      const meta = this.meta();
      if (i.kind === "archive") {
        void confirmed(this.app, "Archive board", `Archive board '${meta?.name || r.board}'? Its tasks are kept on the host.`, "Archive", true).then(async yes => {
          if (!yes) return;
          const o = await this.host.kanban.boards(this.alias, { verb: "rm", slug: r.board }).catch((e: unknown) => ({ ok: false as const, message: message(e) }));
          if (!o.ok) new Notice(o.message, 10_000);
          else this.switchBoard("default");
        });
        return;
      }
      const settings = i.kind === "settings";
      const val = (x?: string): string => settings ? x ?? "" : "";
      ask(this.app, {
        title: settings ? "Board settings" : "New board",
        cta: settings ? "Save" : "Create",
        fields: [
          { key: "name", label: "Name", required: true, value: val(meta?.name) },
          ...(settings ? [] : [{ key: "slug", label: "Slug", required: true, desc: "Lowercase letters, digits, - and _" }]),
          { key: "description", label: "Description", value: val(meta?.description) },
          { key: "icon", label: "Icon", placeholder: "Emoji or Lucide icon name", value: val(meta?.icon) },
          { key: "color", label: "Color", placeholder: "#8b5cf6", value: val(meta?.color) },
          { key: "workdir", label: "Project directory", placeholder: "~/code/project", value: val(meta?.workdir) },
        ],
        ...(settings ? {} : { follow: { from: "name", to: "slug", map: (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64) } }),
        submit: async v => {
          const slug = settings ? r.board : v.slug ?? "";
          if (!settings && r.boards.some(b => b.slug === slug)) return `Board '${slug}' already exists`;
          const o = await this.host.kanban.boards(this.alias, {
            verb: settings ? "settings" : "create", slug, name: v.name ?? "", description: v.description ?? "",
            icon: v.icon ?? "", color: v.color ?? "", workdir: v.workdir ?? "",
          }).catch((e: unknown) => ({ ok: false as const, message: message(e) }));
          if (!o.ok) return o.message;
          if (settings) void this.reload();
          else this.switchBoard(slug);
          return null;
        },
      });
    };
    const modal = new (class extends SuggestModal<Item> {
      getSuggestions(query: string): Item[] { return items.filter(i => matches(query, label(i), i.kind === "board" ? i.meta.slug : "")); }
      renderSuggestion(i: Item, el: HTMLElement): void { draw(i, el); }
      onChooseSuggestion(i: Item): void { choose(i); }
    })(this.app);
    modal.setPlaceholder("Switch board…");
    modal.open();
  }

  protected render(): void {
    const r = this.read;
    if (!r) return;
    if (!this.tools.childElementCount) this.buildTools();
    this.syncTools(r);
    const tops = new Map(Array.from(this.body.querySelectorAll<HTMLElement>(".hm-k-col-body")).map((el): [string, number] => [el.dataset.status ?? "", el.scrollTop]));
    const left = this.body.querySelector(".hm-k-board")?.scrollLeft ?? 0;
    const focused = this.body.doc.activeElement?.closest<HTMLElement>(".hm-k-card")?.dataset.id;
    this.body.empty();
    const create = (column: "triage" | "ready" | "blocked"): void => openCreate(this.taskHost(), column, this.meta()?.workdir, () => void this.reload());
    if (!r.tasks.length) return this.empty("square-kanban", "No tasks on this board", "New task", () => create("ready"));
    const visible = r.tasks.filter(c => (!this.tenant || c.tenant === this.tenant)
      && (!this.profile || (this.profile === " none" ? !c.assignee : c.assignee === this.profile))
      && matches(this.search, c.id, c.title, c.text, c.assignee, c.tenant, c.reason));
    if (!visible.length) return this.empty("search-x", "No matching tasks", "Clear filters", () => this.clearFilters());

    if (this.banner) {
      const banner = this.body.createDiv("hm-k-banner");
      icon(banner, "triangle-alert");
      banner.createSpan({ text: this.banner });
      iconButton(banner, "x", "Dismiss", () => {
        this.banner = "";
        this.render();
      }, "hm-push");
    }

    const flagged = r.tasks.filter(c => this.diags[c.id]?.length);
    const flagKey = flagged.map(c => c.id).sort().join(" ");
    if (flagged.length && this.hiddenAttention !== flagKey) {
      const strip = this.body.createDiv("hm-k-attention");
      const head = strip.createDiv("hm-k-attention-head");
      icon(head, "triangle-alert");
      head.createSpan({ text: `${flagged.length} task${plural(flagged.length)} need${flagged.length === 1 ? "s" : ""} attention` });
      action(head, this.attentionOpen ? "Hide" : "Show", () => {
        this.attentionOpen = !this.attentionOpen;
        this.render();
      }, this.attentionOpen ? "chevron-up" : "chevron-down");
      iconButton(head, "x", "Hide until the flagged tasks change", () => {
        this.hiddenAttention = flagKey;
        this.render();
      }, "hm-push");
      if (this.attentionOpen) {
        const host = this.taskHost();
        for (const c of flagged) {
          const task = strip.createDiv("hm-k-attention-task");
          const line = task.createDiv("hm-k-attention-line");
          line.createSpan({ cls: "hm-k-id hm-code", text: c.id });
          line.createSpan({ text: c.title });
          action(line, "Open", () => this.open(c.id, "diagnostics"));
          for (const d of [...(this.diags[c.id] ?? [])].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))) diagCard(task, host, c, d);
        }
      }
    }

    if (this.selected.size) this.bulkBar(r, visible);

    const board = this.body.createDiv("hm-k-board");
    const now = Date.now() / 1000, pref = this.pref();
    for (const s of STATUSES) {
      if (s === "archived" && !pref.archived) continue;
      const all = r.tasks.filter(c => c.status === s);
      const mine = visible.filter(c => c.status === s);
      const label = COLUMNS[s].label;
      const col = board.createDiv({ cls: `hm-k-col is-${s}`, attr: { "data-status": s } });
      col.addEventListener("dragover", event => {
        if (!this.dragging || !this.allow.has(s)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        col.addClass("is-over");
      });
      col.addEventListener("dragleave", event => {
        if (!col.contains(event.relatedTarget as Node | null)) col.removeClass("is-over");
      });
      col.addEventListener("drop", event => {
        const ids = this.dragging;
        col.removeClass("is-over");
        if (!ids || !this.allow.has(s)) return;
        event.preventDefault();
        this.dragging = null;
        void this.drop(ids, s);
      });

      const auto = all.length === 0;
      if (pref.folds?.[s] ?? auto) {
        col.addClass("is-folded");
        const rail = col.createEl("button", { cls: "hm-k-rail", attr: { type: "button", "aria-label": `Expand ${label}` } });
        setTooltip(rail, "Expand column");
        icon(rail, COLUMNS[s].icon);
        rail.createSpan({ cls: "hm-k-rail-name", text: label });
        rail.createSpan({ cls: "hm-count", text: String(all.length) });
        rail.addEventListener("click", () => this.fold(s, false, auto));
        continue;
      }

      const head = col.createDiv("hm-k-col-head");
      if (mine.length) {
        const picked = mine.filter(c => this.selected.has(c.id)).length;
        const check = head.createEl("input", { cls: "hm-k-check", attr: { type: "checkbox", "aria-label": "Select all tasks in this column" } });
        setTooltip(check, "Select all tasks in this column");
        check.checked = picked === mine.length;
        check.indeterminate = picked > 0 && picked < mine.length;
        check.addEventListener("click", () => {
          for (const c of mine) {
            if (picked < mine.length) this.selected.add(c.id);
            else this.selected.delete(c.id);
          }
          this.render();
        });
      }
      icon(head, COLUMNS[s].icon);
      head.createSpan({ cls: "hm-k-col-name", text: label });
      const count = head.createSpan({ cls: "hm-count", text: mine.length === all.length ? String(all.length) : `${mine.length}/${all.length}` });
      if (mine.length !== all.length) setTooltip(count, `${mine.length} of ${all.length} tasks match the filters`);
      setTooltip(icon(head, "circle-help", "hm-icon hm-k-help"), COLUMNS[s].help);
      const creatable = s === "triage" || s === "ready" || s === "blocked";
      if (creatable) iconButton(head, "plus", "Create task in this column", () => create(s), "hm-push");
      iconButton(head, "chevrons-right-left", "Collapse column", () => this.fold(s, true, auto), creatable ? "" : "hm-push");

      const list = col.createDiv({ cls: "hm-k-col-body", attr: { "data-status": s } });
      const sorted = [...mine].sort(CAPPED.has(s)
        ? (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || b.id.localeCompare(a.id)
        : (a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      if (s === "running" && this.lanes()) {
        const lanes = new Map<string, Card[]>();
        for (const c of sorted) lanes.set(c.assignee ?? "", [...(lanes.get(c.assignee ?? "") ?? []), c]);
        for (const [who, cards] of [...lanes].sort(([a], [b]) => a.localeCompare(b))) {
          const lane = list.createDiv("hm-k-lane");
          const laneHead = lane.createDiv("hm-k-lane-head");
          if (who) avatar(laneHead, who, "hm-avatar is-small");
          else icon(laneHead, "user-x");
          laneHead.createSpan({ text: who ? `@${who}` : "Unassigned" });
          laneHead.createSpan({ cls: "hm-count", text: String(cards.length) });
          for (const c of cards) this.card(lane, c, now);
        }
      } else {
        // ponytail: done/archived draw 50 cards at a time; no virtual list.
        const cap = CAPPED.has(s) ? this.shown[s] ?? 50 : Infinity;
        for (const c of sorted.slice(0, cap)) this.card(list, c, now);
        if (sorted.length > cap) action(list, `Show ${Math.min(50, sorted.length - cap)} more`, () => {
          this.shown[s] = cap + 50;
          this.render();
        });
      }
      if (!mine.length) list.createDiv({ cls: "hm-k-none", text: "— no tasks —" });
    }
    board.scrollLeft = left;
    for (const el of Array.from(board.querySelectorAll<HTMLElement>(".hm-k-col-body"))) el.scrollTop = tops.get(el.dataset.status ?? "") ?? 0;
    if (focused) board.querySelector<HTMLElement>(`.hm-k-card[data-id="${CSS.escape(focused)}"]`)?.focus();
  }

  private bulkBar(r: BoardRead, visible: Card[]): void {
    const cards = r.tasks.filter(c => this.selected.has(c.id));
    const ids = cards.map(c => c.id);
    const n = cards.length;
    const bar = this.body.createDiv("hm-k-bulk");
    bar.createSpan({ cls: "hm-k-bulk-count", text: `${n} selected` });
    action(bar, "Ready", () => void this.drop(ids, "ready"), COLUMNS.ready.icon, "Move the selected tasks to Ready");
    action(bar, "Block…", () => void this.drop(ids, "blocked"), COLUMNS.blocked.icon, "Block the selected tasks");
    action(bar, "Unblock", () => {
      const stuck = cards.filter(c => c.status === "blocked" || c.status === "scheduled");
      if (!stuck.length) {
        new Notice("No blocked or scheduled task selected.");
        return;
      }
      void confirmed(this.app, "Unblock", `Unblock ${stuck.length} task${plural(stuck.length)}?`, "Unblock").then(yes => {
        if (yes) void this.apply(stuck.map((c): Verb => ({ verb: "unblock", id: c.id })), "ready");
      });
    }, "lock-open", "Unblock the selected blocked or scheduled tasks");
    action(bar, "Complete…", () => void this.drop(ids, "done"), COLUMNS.done.icon, "Mark the selected tasks done");
    action(bar, "Archive", () => void this.drop(ids, "archived"), COLUMNS.archived.icon, "Archive the selected tasks");
    action(bar, "Priority…", () => ask(this.app, {
      title: "Set priority",
      cta: "Set",
      fields: [{ key: "priority", label: "Priority", kind: "number", required: true, desc: "Higher runs first. Whole numbers, may be negative." }],
      submit: async v => {
        const priority = Number(v.priority);
        if (!Number.isInteger(priority)) return "Priority must be a whole number";
        await this.apply(cards.map((c): Verb => ({ verb: "edit", id: c.id, priority })));
        return null;
      },
    }), "arrow-up-down", "Set the priority of the selected tasks");
    const assign = bar.createEl("select", { cls: "dropdown hm-k-select" });
    setTooltip(assign, "Assign the selected tasks");
    assign.createEl("option", { value: "", text: "— reassign —" });
    assign.createEl("option", { value: " none", text: "Unassign" });
    for (const p of r.profiles) assign.createEl("option", { value: p, text: `@${p}` });
    assign.addEventListener("change", () => {
      const value = assign.value;
      assign.value = "";
      assign.blur();
      if (value) void this.assign(cards, value === " none" ? null : value);
    });
    if (cards.every(c => c.status === "archived")) action(bar, "Delete permanently", () => {
      void confirmed(this.app, "Delete permanently", `Delete ${n} archived task${plural(n)} permanently? This can't be undone.`, "Delete", true).then(yes => {
        if (yes) void this.apply(cards.map((c): Verb => ({ verb: "purge", id: c.id })));
      });
    }, "trash-2").addClass("mod-warning");
    action(bar, "Select all", () => {
      this.selected.clear();
      for (const c of visible) this.selected.add(c.id);
      this.render();
    }, "check-check", "Select every visible task");
    iconButton(bar, "x", "Clear selection", () => {
      this.selected.clear();
      this.render();
    }, "hm-push");
  }

  /** Remembers a fold only where it differs from the default (a column with no tasks starts folded). */
  private fold(s: Status, folded: boolean, auto: boolean): void {
    const folds = this.pref().folds ??= {};
    if (folded === auto) delete folds[s];
    else folds[s] = folded;
    this.app.workspace.requestSaveLayout();
    this.render();
  }

  private card(parent: HTMLElement, c: Card, now: number): void {
    const label = COLUMNS[c.status].label;
    const el = parent.createDiv({
      cls: `hm-k-card is-${c.status}`,
      attr: { draggable: "true", tabindex: "0", role: "button", "aria-label": `${c.title || "(untitled)"} — ${c.id} — ${label}`, "data-id": c.id },
    });
    el.toggleClass("is-selected", this.selected.has(c.id));
    el.toggleClass("is-failed", this.failed.has(c.id));
    el.toggleClass("is-open", this.drawer?.id === c.id);

    const top = el.createDiv("hm-k-card-top");
    const check = top.createEl("input", { cls: "hm-k-check", attr: { type: "checkbox", "aria-label": `Select task ${c.id}` } });
    setTooltip(check, "Select for bulk actions");
    check.checked = this.selected.has(c.id);
    check.addEventListener("click", event => {
      event.stopPropagation();
      if (!this.selected.delete(c.id)) this.selected.add(c.id);
      this.anchor = c.id;
      this.render();
    });
    const id = top.createSpan({ cls: "hm-k-id hm-code", text: c.id });
    setTooltip(id, "Copy id");
    id.addEventListener("click", event => {
      event.stopPropagation();
      copy(c.id);
    });
    const diags = this.diags[c.id] ?? [];
    if (diags.length) {
      const sev = diags.map(d => d.severity).reduce((a, b) => severityRank(b) > severityRank(a) ? b : a);
      iconButton(top, severityIcon(sev), `${diags.length} active diagnostic${plural(diags.length)} (severity: ${sev}). Click to open for details.`, event => {
        event.stopPropagation();
        this.open(c.id, "diagnostics");
      }, `hm-k-warn is-${sev}`);
    }
    if (c.priority) setTooltip(top.createSpan({ cls: "hm-k-prio", text: `P${c.priority}` }), `Priority ${c.priority}. Higher runs first.`);
    if (c.tenant) setTooltip(top.createSpan({ cls: "hm-tag", text: c.tenant }), `Tenant: ${c.tenant}`);
    if (c.children) {
      const done = c.childrenDone ?? 0;
      const progress = top.createSpan({ cls: "hm-k-progress", text: `${done}/${c.children}` });
      progress.toggleClass("is-full", done >= c.children);
      setTooltip(progress, `${done} of ${c.children} child tasks done`);
    }
    if (c.status === "ready" && !c.assignee) setTooltip(top.createSpan({ cls: "hm-k-needs", text: "Needs assignee" }), NEEDS);

    el.createDiv({ cls: "hm-k-card-title", text: c.title || "(untitled)" });
    if (c.reason && (c.status === "blocked" || c.status === "triage")) el.createDiv({ cls: "hm-k-reason", text: c.reason });

    const foot = el.createDiv("hm-k-card-foot");
    const who = foot.createSpan("hm-k-who");
    if (c.assignee) {
      avatar(who, c.assignee);
      who.createSpan({ text: `@${c.assignee}` });
      setTooltip(who, `Assigned to Hermes profile @${c.assignee}`);
    } else {
      who.createSpan({ cls: "hm-muted", text: "unassigned" });
      setTooltip(who, "No profile assigned.");
    }
    if (c.comments) stat(foot, "message-square", c.comments, `${c.comments} comment${plural(c.comments)} on this task`);
    const p = c.parents ?? 0, ch = c.children ?? 0;
    if (p + ch) stat(foot, "arrow-left-right", p + ch, `${p} parent${plural(p)}, ${ch} child${ch === 1 ? "" : "ren"}. Children stay blocked until their parent is done.`);
    const age = when(foot, c.status === "running" ? c.startedAt : CAPPED.has(c.status) ? c.completedAt : c.createdAt, "hm-k-age hm-muted hm-push");
    const stale = staleness(c, now);
    if (stale) age.addClass(`is-${stale}`);

    el.addEventListener("click", event => this.click(c.id, event));
    el.addEventListener("keydown", event => {
      if (event.target !== el || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.open(c.id);
    });
    el.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.menu(c).showAtMouseEvent(event);
    });
    el.addEventListener("dragstart", event => {
      const ids = this.selected.has(c.id) ? [...this.selected] : [c.id];
      this.dragging = ids;
      if (event.dataTransfer) {
        event.dataTransfer.setData("text/x-hermes-task", ids.join(" "));
        event.dataTransfer.effectAllowed = "move";
        if (ids.length > 1) {
          const ghost = this.contentEl.createDiv({ cls: "hm-k-ghost", text: `${ids.length} cards` });
          event.dataTransfer.setDragImage(ghost, 12, 12);
          this.contentEl.win.setTimeout(() => ghost.remove(), 0);
        }
      }
      el.addClass("is-dragging");
      this.markTargets(ids);
    });
    el.addEventListener("dragend", () => {
      this.dragging = null;
      this.render();
    });
  }

  /** Plain click opens; Shift extends from the last picked card in on-screen order; Ctrl/Cmd toggles. */
  private click(id: string, event: MouseEvent): void {
    if (event.shiftKey && this.anchor) {
      const order = Array.from(this.body.querySelectorAll<HTMLElement>(".hm-k-card")).map(el => el.dataset.id ?? "");
      const a = order.indexOf(this.anchor), b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        for (const pick of order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(pick);
        this.render();
        return;
      }
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (!this.selected.delete(id)) this.selected.add(id);
      this.anchor = id;
      this.render();
      return;
    }
    this.open(id);
  }

  /** Columns that take at least one dragged card light up; columns that take none are locked. */
  private markTargets(ids: string[]): void {
    this.allow.clear();
    const cards = this.read?.tasks.filter(c => ids.includes(c.id)) ?? [];
    for (const col of Array.from(this.body.querySelectorAll<HTMLElement>(".hm-k-col"))) {
      const to = col.dataset.status as Status;
      if (cards.every(c => c.status === to)) continue;
      const verbs = cards.map(c => dropVerb(c.status, to));
      if (verbs.every(v => v === null)) {
        col.addClass("is-locked");
        continue;
      }
      this.allow.add(to);
      col.toggleClass("is-target", verbs.some(v => v !== null && v !== "refuse"));
    }
  }

  private menu(c: Card): Menu {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Open").setIcon("panel-right-open").onClick(() => this.open(c.id)));
    const picked = this.selected.has(c.id);
    menu.addItem(i => i.setTitle(picked ? "Deselect" : "Select").setIcon(picked ? "x" : "check").onClick(() => {
      if (!this.selected.delete(c.id)) this.selected.add(c.id);
      this.anchor = c.id;
      this.render();
    }));
    menu.addSeparator();
    for (const to of STATUSES) {
      const verb = dropVerb(c.status, to);
      if (verb === null || verb === "refuse") continue;
      menu.addItem(i => i.setTitle(to === "archived" ? "Archive" : `Move to ${COLUMNS[to].label}`).setIcon(COLUMNS[to].icon)
        .setWarning(to === "archived").onClick(() => void this.drop([c.id], to)));
    }
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Copy ID").setIcon("copy").onClick(() => copy(c.id)));
    return menu;
  }
}
