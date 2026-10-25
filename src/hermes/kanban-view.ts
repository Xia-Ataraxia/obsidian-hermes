import { Menu, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { COLUMNS, message, TaskDrawer, type Focus, type TaskHost } from "./kanban-drawer";
import { keepBoard } from "./cache";
import { type BoardMeta, type BoardRead, type Card, type Diagnostic, type Status, type Verb } from "./kanban";
import { HermesView, relative, type HermesHost } from "./ui";
import { MOVED, type Pref, deletion, on } from "./kanban-prefs";
import { applyVerbs, dropCards, assignCards, nudgeDispatcher, toggleAuto, openOrchestration } from "./kanban-actions";
import { buildTools, syncTools, openSwitcher } from "./kanban-tools";
import { renderBoard, bulkBar, foldLane } from "./kanban-board";
import { renderCard, clickCard, markTargets, cardMenu } from "./kanban-card";
export * from "./kanban-notice";
export * from "./kanban-prefs";

export const KANBAN_VIEW = "hermes-kanban";

export class KanbanView extends HermesView {
  read: BoardRead | null = null;
  key = "";
  diags: Record<string, Diagnostic[]> = {};
  diagSeq = 0;
  prefs: Record<string, Pref> = {};
  search = "";
  tenant = "";
  profile = "";
  readonly selected = new Set<string>();
  readonly failed = new Set<string>();
  /** The column each card was last painted in, so a move can be told from a repaint. */
  readonly painted = new Map<string, Status>();
  anchor = "";
  dragging: string[] | null = null;
  readonly allow = new Set<Status>();
  drawer: TaskDrawer | null = null;
  drawerJson = "";
  dirty: string | null = null;
  pending: { board: string; task: string } | null = null;
  banner = "";
  hiddenAttention: string | null = null;
  attentionOpen = false;
  shown: Partial<Record<Status, number>> = {};
  force = false;
  /** Poll ticks still to skip after a failed read, so a failing host is tried once a minute. */
  backoff = 0;
  /** Live mode's session for the shown host and board; null while hidden or down (then the poll tick probes). */
  live: { tick(): boolean; stop(): void } | null = null;
  /** Live mode's last start (host and board, and when): after a failure the same pair waits out a minute before the next try. */
  tried = { key: "", at: 0 };
  liveTimer = 0;
  landing: { ids: string[]; to: Status } | null = null;
  switcher!: HTMLButtonElement;
  pill!: HTMLButtonElement;
  searchInput!: HTMLInputElement;
  tenantSelect!: HTMLSelectElement;
  profileSelect!: HTMLSelectElement;
  archivedButton!: HTMLButtonElement;
  lanesButton!: HTMLButtonElement;
  clearButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    // 20 s, not 10: the ssh argv has no ControlMaster, so every probe opens its own connection.
    super(leaf, host, 20_000);
  }

  getViewType(): string { return KANBAN_VIEW; }
  getDisplayText(): string { return "Hermes kanban"; }
  override getIcon(): string { return "square-kanban"; }
  protected override busy(): boolean { return !!this.dragging; }

  protected override cacheKey(): string { return `kanban/${this.host.board(this.alias)}`; }

  protected override cacheData(): unknown { return this.read && keepBoard(this.read); }

  protected override cacheRestore(saved: unknown): boolean {
    this.read = null;
    if (saved == null) return false;
    const slug = this.host.board(this.alias), client = this.host.kanban;
    const key = client.cacheKey(this.alias, slug, !!this.prefs[slug]?.archived);
    // A read from this session is fuller than the saved copy, so it wins.
    const read = client.cacheData(key) ?? (client.cacheRestore(key, saved) ? client.cacheData(key) : undefined);
    if (!read) return false;
    this.adopt(this.alias, read);
    return true;
  }

  /** A host change closes the drawer and drops the selection at once, like switchBoard; the base then empties `read` (cacheRestore(null)). */
  protected override leaveHost(): void { this.resetTransient(); }

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
      this.openTask(task);
    }
  }

  protected override async reload(quiet = false): Promise<void> {
    if (!quiet) this.force = true;
    // After a failed read a poll tick skips two turns: 60 s between tries instead of 20 s.
    else if (!this.force && this.backoff > 0) { this.backoff--; return; }
    // Live mode watches the token itself, so a poll tick has nothing to probe.
    else if (!this.force && this.live) return;
    return super.reload(quiet);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.contentEl.addClass("hm-k-view");
    // ponytail: D29, the board token moves on every task event (heartbeat and claim included), not on a write that appends none
    // (workspace path, branch); that waits for the next event or a forced read (open, board switch, window focus, Refresh, a write).
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
    // ponytail: live mode asks every 0.3 s like the web dashboard's task_events tail, one sqlite3 run on the host per answer and
    // never two asks at once (a slow host just answers less often); lengthen this if hosts feel the load.
    this.registerInterval(window.setInterval(() => this.pulse(), 300));
    this.register(() => this.stopLive());
  }

  /** Every 0.3 s, one live session per shown board. While it answers, poll ticks skip their probe; once it is down they take
   *  over again, and live mode retries a minute after its last start. */
  pulse(): void {
    const slug = this.alias && this.host.board(this.alias), key = `${this.alias}|${slug}`;
    const shown = !!slug && !this.closed && !this.contentEl.doc.hidden && this.contentEl.isShown();
    // Hidden or on another host or board: stop, and start at once when shown again.
    if (this.live && (!shown || key !== this.tried.key)) { this.stopLive(); this.tried.at = 0; }
    if (!shown) return;
    if (!this.live) {
      if (key === this.tried.key && Date.now() - this.tried.at < 60_000) return;
      this.tried = { key, at: Date.now() };
      try { this.live = this.host.kanban.watch(this.alias, slug, () => !!this.prefs[slug]?.archived, () => this.moved()); } catch { return; }
    }
    if (!this.live.tick()) this.stopLive();
  }

  stopLive(): void {
    window.clearTimeout(this.liveTimer);
    this.live?.stop();
    this.live = null;
  }

  /** A live answer differs from the cached read's token: one forced read 250 ms later (the dashboard's delay, shorter than the
   *  300 ms tick, so each tick's change gets its own read). Mid-read it does nothing, since the next tick compares against what
   *  that read cached, so a change the read missed still gets its single follow-up: one board read at a time, never a queue. */
  moved(): void {
    window.clearTimeout(this.liveTimer);
    if (this.inflight) return;
    this.liveTimer = window.setTimeout(() => {
      if (this.closed || this.inflight || this.backoff > 0 || this.busy()) return;
      this.force = true;
      void this.reload(true);
    }, 250);
  }

  protected async pull(alias: string): Promise<string | null> {
    const force = this.force, landing = this.landing, dirty = this.dirty;
    this.force = false;
    this.landing = null;
    this.dirty = null;
    const slug = this.host.board(alias), archived = !!this.prefs[slug]?.archived;
    // Only a poll tick is unforced: it probes the board's token and reads the board only when the token moved.
    const r = force ? await this.host.kanban.board(alias, slug, archived, true) : await this.host.kanban.poll(alias, slug, archived);
    // Closed while the read was in flight: no diagnostics read, drawer refresh or paint (the base class stops the rest).
    if (this.closed) return null;
    if (alias !== this.alias || slug !== this.host.board(alias)) {
      // A stale read: the next pull, for the board shown now, still owes these.
      this.force ||= force;
      this.landing ??= landing;
      this.dirty ??= dirty;
      return null;
    }
    // A failed read makes the next two poll ticks skip (see reload); any read that answers ends that.
    this.backoff = typeof r === "string" ? 2 : 0;
    if (typeof r === "string") return r;
    // The probe saw no change: nothing new to show.
    if (!r) return null;
    const changed = r.tasks !== this.read?.tasks;
    this.adopt(alias, r);
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
      if (p.board === r.board) this.openTask(p.task);
    }
    return null;
  }

  /** Shows `r`, from a pull or from disk; another board or host starts clean. */
  adopt(alias: string, r: BoardRead): void {
    if (`${alias}|${r.board}` !== this.key) {
      this.key = `${alias}|${r.board}`;
      this.resetTransient();
    }
    this.read = r;
  }

  /** Selection, filters, banners and the drawer belong to one board on one host. */
  resetTransient(): void {
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

  switchBoard(slug: string): void {
    this.host.saveBoard(this.alias, slug);
    this.resetTransient();
    this.read = null;
    this.empty("loader", "Loading…");
    void this.reload();
  }

  async loadDiagnostics(alias: string, slug: string): Promise<void> {
    const seq = ++this.diagSeq;
    // ponytail: best effort; a failed read keeps the last diagnostics until the board changes again.
    const r = await this.host.kanban.diagnostics(alias, slug).catch(() => null);
    if (this.closed || seq !== this.diagSeq || !r || typeof r === "string" || alias !== this.alias || slug !== this.read?.board) return;
    const id = this.drawer?.id ?? "";
    const before = JSON.stringify(this.diags[id] ?? []);
    this.diags = r;
    if (this.drawer && JSON.stringify(r[id] ?? []) !== before) void this.drawer.refresh(true);
    if (!this.busy()) this.render();
  }

  /** The read on screen when it is `board` of `alias`, else null: what an action begun there may patch once it answers. */
  current(alias: string, board: string): BoardRead | null {
    return !this.closed && this.alias === alias && this.read?.board === board ? this.read : null;
  }

  /** `slug` is the board the drawer was opened on: a write goes there even when the view has moved on, and then only reloads. */
  async write(v: Verb, slug: string): Promise<string | null> {
    const { alias } = this;
    const r = await this.host.kanban.run(alias, slug, v)
      .catch((e: unknown) => ({ ok: false as const, message: message(e) }));
    if (!r.ok) return r.message;
    if (this.current(alias, slug)) this.dirty = v.id;
    void this.reload();
    return null;
  }

  /** The drawer's Delete: the task's archive and purge in one round trip; resolves to the CLI's error, if any. */
  async remove(id: string, slug: string): Promise<string | null> {
    // A view that has left `slug` has no statuses for it: the purge then goes alone, and the CLI refuses it unless the task is archived.
    const tasks = this.current(this.alias, slug)?.tasks ?? [];
    const results = await this.host.kanban.bulk(this.alias, slug, deletion([id], tasks)).catch((e: unknown) => message(e));
    const o = typeof results === "string" ? { ok: false as const, message: results } : results[id];
    // Whatever the outcome (a card archived but not purged), the board changed: reload.
    void this.reload();
    return o?.ok ? null : o?.message ?? "No result from the host";
  }

  // Not `open`: Obsidian mounts a view through View.open(containerEl), and shadowing it leaves the tab blank.
  openTask(id: string, focus?: Focus): void {
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

  closeDrawer(): void {
    this.drawer?.close();
    this.drawer = null;
  }

  taskHost(): TaskHost {
    const { alias } = this, slug = this.read?.board ?? this.host.board(alias);
    const moved = (): string | null => this.closed ? "The board view is closed." : this.alias === alias ? null : MOVED;
    const h: TaskHost = {
      app: this.app, owner: this, alias, slug,
      kanban: this.host.kanban, client: this.host.client,
      cards: () => this.current(alias, slug)?.tasks ?? [],
      profiles: () => this.read?.profiles ?? [],
      diagnostics: id => this.diags[id] ?? [],
      write: v => { const why = moved(); return why === null ? this.write(v, slug) : Promise.resolve(why); },
      remove: id => { const why = moved(); return why === null ? this.remove(id, slug) : Promise.resolve(why); },
      moved,
      open: (id, focus) => this.openTask(id, focus),
      // Only the drawer this host opened: a Delete that ends after another card was opened, or after the view left the board, must not close the one shown now.
      close: () => { if (this.drawer?.host === h) { this.closeDrawer(); this.render(); } },
    };
    return h;
  }

  meta(): BoardMeta | undefined { return this.read?.boards.find(b => b.slug === this.read?.board); }
  pref(): Pref { return this.prefs[this.read?.board ?? this.host.board(this.alias)] ??= {}; }
  lanes(): boolean { return this.pref().lanes ?? on(this.read?.config.lane_by_profile); }
  clearFilters(): void {
    this.search = this.tenant = this.profile = "";
    this.render();
  }

  /**
   * Runs verbs in one round trip. With `to`, the cards move first and a failed one moves back.
   * `alias` and `board` are the host and board the dialog behind this call was opened on. Once the host changed, the ids and
   * the board belong to the old one, so the answer is MOVED and nothing is sent. A switch to another board of the same host
   * still sends to `board` (the user asked for that board); the board on screen is then only reloaded, never patched.
   * Forms show the answer; the confirm-only callers drop it, like the picker's.
   */
  apply(alias: string, board: string, verbs: Verb[], to?: Status): Promise<string | null> { return applyVerbs.call(this, alias, board, verbs, to); }

  drop(ids: string[], to: Status): Promise<void> { return dropCards.call(this, ids, to); }

  /** A running card needs `reassign`; the CLI refuses it while its worker holds it, unless `--reclaim` stops the worker first, so
   *  the form asks (unchecked) and a refusal shows per card like any other failure. Without a running card there is nothing to ask.
   *  `board` is the one the cards were picked on. */
  assign(cards: Card[], profile: string | null, board: string): Promise<void> { return assignCards.call(this, cards, profile, board); }

  nudge(): Promise<void> { return nudgeDispatcher.call(this); }

  /** The pill flips kanban.auto_decompose, which every board shares, like the web's. */
  toggleAuto(): Promise<void> { return toggleAuto.call(this); }

  openOrchestration(): void { return openOrchestration.call(this); }

  buildTools(): void { return buildTools.call(this); }

  syncTools(r: BoardRead): void { return syncTools.call(this, r); }

  /** Board switcher with per-board counts, plus New board, Board settings and Remove this board. */
  openSwitcher(): void { return openSwitcher.call(this); }

  protected render(): void { return renderBoard.call(this); }

  bulkBar(r: BoardRead, visible: Card[]): void { return bulkBar.call(this, r, visible); }

  /** Remembers a fold only where it differs from the default (a column with no tasks starts folded). */
  fold(s: Status, folded: boolean, auto: boolean): void { return foldLane.call(this, s, folded, auto); }

  card(parent: HTMLElement, c: Card, now: number): void { return renderCard.call(this, parent, c, now); }

  /** Plain click opens; Shift extends from the last picked card in on-screen order; Ctrl/Cmd toggles. */
  click(id: string, event: MouseEvent): void { return clickCard.call(this, id, event); }

  /** Columns that take at least one dragged card light up; columns that take none are locked. */
  markTargets(ids: string[]): void { return markTargets.call(this, ids); }

  menu(c: Card): Menu { return cardMenu.call(this, c); }
}
