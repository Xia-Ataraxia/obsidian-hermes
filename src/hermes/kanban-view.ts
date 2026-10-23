import { MarkdownRenderer, Modal, Notice, setTooltip, type App, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { dropMove, STATUSES, type Board, type Column, type Move, type Status, type Task, type TaskDetail } from "./data";
import { absolute, avatar, HermesView, icon, iconButton, relative, stat, type HermesHost } from "./ui";

export const KANBAN_VIEW = "hermes-kanban";

const COLUMNS: Record<Column, [string, string]> = {
  triage: ["inbox", "Triage"],
  todo: ["circle-dashed", "Todo"],
  scheduled: ["clock", "Scheduled"],
  ready: ["circle-dot", "Ready"],
  running: ["play", "Running"],
  blocked: ["ban", "Blocked"],
  review: ["eye", "Review"],
  done: ["circle-check", "Done"],
};

const AFTER: Record<Move, Status> = { complete: "done", block: "blocked", unblock: "ready", promote: "ready", archive: "archived" };

/** Hermes kanban boards as Bases-style columns. Moves and edits go through `hermes kanban`. */
export class KanbanView extends HermesView {
  private boards: Board[] = [];
  private board = "default";
  private query = "";
  private assignee = "";
  private dragging: Task | null = null;
  private selected: Task | null = null;
  private composing = false;
  private drawer: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 15_000);
  }

  getViewType(): string { return KANBAN_VIEW; }
  getDisplayText(): string { return "Hermes kanban"; }
  override getIcon(): string { return "square-kanban"; }

  protected override busy(): boolean { return this.dragging !== null || this.composing; }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), board: this.board };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const board = (state as { board?: unknown } | null)?.board;
    if (typeof board === "string") this.board = board;
    await super.setState(state, result);
  }

  protected async pull(alias: string): Promise<string | null> {
    const result = await this.host.client.boards(alias);
    if (typeof result === "string") return result;
    this.boards = result;
    if (!result.some(board => board.slug === this.board)) this.board = result[0]?.slug ?? "default";
    return null;
  }

  private get current(): Board | undefined {
    return this.boards.find(board => board.slug === this.board);
  }

  protected render(): void {
    this.contentEl.addClass("hm-kanban");
    this.renderTools();
    this.renderColumns();
    if (this.selected) {
      const fresh = this.current?.tasks.find(task => task.id === this.selected!.id);
      if (fresh) this.selected = fresh;
    }
  }

  /* ───────────── toolbar ───────────── */

  private renderTools(): void {
    const tools = this.tools;
    tools.empty();
    const pills = tools.createDiv("hm-pills");
    for (const board of this.boards) {
      const pill = pills.createEl("button", { cls: `hm-pill${board.slug === this.board ? " is-active" : ""}` });
      if (board.icon) pill.createSpan({ text: board.icon });
      pill.createSpan({ text: board.name });
      pill.createSpan({ cls: "hm-count", text: String(board.tasks.filter(task => task.status !== "done").length) });
      if (board.description) setTooltip(pill, board.description);
      pill.addEventListener("click", () => { this.board = board.slug; this.closeDrawer(); this.app.workspace.requestSaveLayout(); this.render(); });
    }

    const search = tools.createDiv("hm-search");
    icon(search, "search");
    const input = search.createEl("input", { type: "search", attr: { placeholder: "Filter" }, value: this.query });
    input.addEventListener("input", () => { this.query = input.value; this.renderColumns(); });

    const people = [...new Set((this.current?.tasks ?? []).map(task => task.assignee ?? ""))].sort();
    const select = tools.createEl("select", { cls: "dropdown hm-assignee" });
    setTooltip(select, "Assignee");
    select.createEl("option", { text: "Everyone", value: "" });
    for (const person of people) select.createEl("option", { text: person || "Unassigned", value: person || "-" });
    select.value = this.assignee;
    select.addEventListener("change", () => { this.assignee = select.value; this.renderColumns(); });

    iconButton(tools, "plus", "New task", () => this.newTask(), "hm-new");
  }

  /* ───────────── columns ───────────── */

  private visible(task: Task): boolean {
    if (this.assignee && (task.assignee ?? "-") !== this.assignee) return false;
    const q = this.query.trim().toLowerCase();
    return !q || `${task.title} ${task.id} ${task.assignee ?? ""} ${task.snippet}`.toLowerCase().includes(q);
  }

  private renderColumns(): void {
    this.body.empty();
    const board = this.current;
    if (!board) return this.empty("square-kanban", "No boards");
    const columns = STATUSES.map(status => [status, board.tasks.filter(task => task.status === status && this.visible(task))
      .sort((a, b) => b.priority - a.priority || (status === "done" ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : b.createdAt - a.createdAt))] as const);
    if (columns.every(([, tasks]) => tasks.length === 0)) {
      if (this.query.trim() || this.assignee) return this.empty("search", "No matching tasks");
      return this.empty("square-kanban", "No tasks", "New task", () => this.newTask());
    }
    const lanes = this.body.createDiv("hm-lanes");
    const now = Date.now() / 1000;
    for (const [status, tasks] of columns) {
      const [iconName, label] = COLUMNS[status];
      const lane = lanes.createDiv({ cls: `hm-lane is-${status}${tasks.length === 0 ? " is-empty" : ""}`, attr: { "data-status": status } });
      const head = lane.createDiv("hm-lane-head");
      icon(head, iconName);
      head.createSpan({ cls: "hm-lane-name", text: label });
      head.createSpan({ cls: "hm-count", text: String(tasks.length) });
      setTooltip(head, label);
      const list = lane.createDiv("hm-lane-list");
      for (const task of tasks) this.card(list, task, now);
      this.dropZone(lane, status);
    }
  }

  private card(parent: HTMLElement, task: Task, now: number): void {
    const card = parent.createDiv({ cls: `hm-task is-${task.status}${this.selected?.id === task.id ? " is-selected" : ""}`, attr: { draggable: "true", tabindex: "0" } });
    card.createDiv({ cls: "hm-task-title", text: task.title });
    const meta = card.createDiv("hm-task-meta");
    if (task.assignee) setTooltip(avatar(meta, task.assignee, "hm-avatar is-small"), task.assignee);
    if (task.priority > 0) stat(meta, "flag", task.priority, "Priority", "is-priority");
    if (task.block) stat(meta, "ban", task.block, "Blocked", "is-bad");
    if (task.comments) stat(meta, "message-circle", task.comments, "Comments");
    if (task.children) stat(meta, "git-branch", task.children, "Subtasks");
    const at = task.status === "done" ? task.completedAt : task.status === "running" ? task.startedAt : task.createdAt;
    setTooltip(meta.createSpan({ cls: "hm-push hm-muted", text: relative(at, now) }), absolute(at));

    card.addEventListener("click", () => this.openTask(task));
    card.addEventListener("keydown", event => { if (event.key === "Enter") this.openTask(task); });
    card.addEventListener("dragstart", event => {
      this.dragging = task;
      event.dataTransfer?.setData("text/plain", task.id);
      card.addClass("is-dragging");
      this.body.addClass("is-dragging");
      for (const lane of Array.from(this.body.querySelectorAll<HTMLElement>(".hm-lane"))) {
        lane.toggleClass("is-target", dropMove(task.status, lane.dataset.status as Column) !== null);
      }
    });
    card.addEventListener("dragend", () => {
      this.dragging = null;
      card.removeClass("is-dragging");
      this.body.removeClass("is-dragging");
      for (const lane of Array.from(this.body.querySelectorAll(".hm-lane"))) lane.removeClass("is-target", "is-over");
    });
  }

  private dropZone(lane: HTMLElement, status: Column): void {
    lane.addEventListener("dragover", event => {
      if (!this.dragging || !dropMove(this.dragging.status, status)) return;
      event.preventDefault();
      lane.addClass("is-over");
    });
    lane.addEventListener("dragleave", event => { if (!lane.contains(event.relatedTarget as Node)) lane.removeClass("is-over"); });
    lane.addEventListener("drop", event => {
      event.preventDefault();
      const task = this.dragging;
      const move = task && dropMove(task.status, status);
      if (task && move) void this.apply(task, move);
    });
  }

  /** Optimistic: move locally, run the CLI, roll back on failure. */
  private async apply(task: Task, move: Move): Promise<void> {
    const board = this.current;
    if (!board) return;
    const replace = (status: Status): void => {
      (board as { tasks: readonly Task[] }).tasks = board.tasks.map(t => (t.id === task.id ? { ...t, status } : t));
      this.renderColumns();
    };
    replace(AFTER[move]);
    const outcome = await this.host.client.move(this.alias, board.slug, task.id, move);
    if (!outcome.ok) { replace(task.status); new Notice(`${task.id}: ${outcome.message}`); return; }
    if (this.selected?.id === task.id) this.closeDrawer();
    void this.reload(true);
  }

  /* ───────────── detail drawer ───────────── */

  private closeDrawer(): void {
    this.selected = null;
    this.composing = false;
    const drawer = this.drawer;
    this.drawer = null;
    drawer?.removeClass("is-open");
    window.setTimeout(() => drawer?.remove(), 200);
    for (const el of Array.from(this.body.querySelectorAll(".hm-task.is-selected"))) el.removeClass("is-selected");
  }

  private async openTask(task: Task): Promise<void> {
    this.selected = task;
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>(".hm-task"))) el.removeClass("is-selected");
    this.drawer?.remove();
    const drawer = this.drawer = this.contentEl.createDiv("hm-drawer is-task");
    requestAnimationFrame(() => drawer.addClass("is-open"));
    drawer.addEventListener("keydown", event => { if (event.key === "Escape") this.closeDrawer(); });

    const head = drawer.createDiv("hm-drawer-head");
    const [iconName, label] = COLUMNS[task.status as Column] ?? ["circle", task.status];
    setTooltip(icon(head, iconName, `hm-icon hm-status is-${task.status}`), label);
    const title = head.createDiv("hm-drawer-title");
    title.createDiv({ cls: "hm-drawer-name", text: task.title });
    title.createDiv({ cls: "hm-muted hm-code", text: task.id });
    iconButton(head, "x", "Close", () => this.closeDrawer(), "hm-push");

    const bar = drawer.createDiv("hm-task-bar");
    const people = this.people();
    const assign = bar.createEl("select", { cls: "dropdown" });
    setTooltip(assign, "Assignee");
    assign.createEl("option", { text: "Unassigned", value: "" });
    for (const person of people) assign.createEl("option", { text: person, value: person });
    assign.value = task.assignee ?? "";
    assign.addEventListener("change", async () => {
      const outcome = await this.host.client.assign(this.alias, task.board, task.id, assign.value || null);
      if (!outcome.ok) { new Notice(outcome.message); assign.value = task.assignee ?? ""; } else void this.reload(true);
    });
    const actions = bar.createDiv("hm-actions");
    const action = (move: Move, name: string, text: string): void => { iconButton(actions, name, text, () => void this.apply(task, move)); };
    if (task.status !== "done") action("complete", "circle-check", "Complete");
    if (task.status === "blocked") action("unblock", "lock-open", "Unblock");
    else if (task.status !== "done") action("block", "ban", "Block");
    if (task.status === "todo" || task.status === "triage") action("promote", "circle-dot", "Promote to ready");
    action("archive", "archive", "Archive");

    const meta = drawer.createDiv("hm-drawer-meta hm-pad-x");
    if (task.createdBy) stat(meta, "user-pen", task.createdBy, "Created by");
    setTooltip(stat(meta, "calendar-plus", relative(task.createdAt), "Created"), `Created · ${absolute(task.createdAt)}`);
    if (task.startedAt) setTooltip(stat(meta, "play", relative(task.startedAt), "Started"), `Started · ${absolute(task.startedAt)}`);
    if (task.completedAt) setTooltip(stat(meta, "circle-check", relative(task.completedAt), "Completed"), `Completed · ${absolute(task.completedAt)}`);

    const pane = drawer.createDiv("hm-pane");
    pane.createDiv({ cls: "hm-muted hm-pad", text: "…" });
    const detail = await this.host.client.task(this.alias, task.board, task.id);
    if (this.drawer !== drawer) return;
    pane.empty();
    if (!detail) return void pane.createDiv({ cls: "hm-muted hm-pad", text: "Could not load task" });
    await this.renderDetail(pane, task, detail);
  }

  private async renderDetail(pane: HTMLElement, task: Task, detail: TaskDetail): Promise<void> {
    const section = (name: string, label: string): HTMLElement => {
      const el = pane.createDiv("hm-section");
      const head = el.createDiv("hm-section-head");
      icon(head, name);
      head.createSpan({ text: label });
      return el;
    };
    const markdown = async (parent: HTMLElement, text: string): Promise<void> => {
      const box = parent.createDiv("hm-doc markdown-rendered");
      await MarkdownRenderer.render(this.app, text, box, "", this);
    };

    if (detail.body.trim()) await markdown(section("align-left", "Body"), detail.body);
    if (detail.result?.trim()) await markdown(section("flag-triangle-right", "Result"), detail.result);
    if (detail.parents.length || detail.childIds.length) {
      const links = section("git-branch", "Links");
      for (const id of detail.parents) stat(links, "arrow-up", id, "Parent", "hm-tag");
      for (const id of detail.childIds) stat(links, "arrow-down", id, "Subtask", "hm-tag");
    }
    if (detail.runs.length) {
      const runs = section("history", "Runs");
      for (const run of detail.runs) {
        const row = runs.createDiv(`hm-run is-${run.outcome ?? run.status}`);
        const top = row.createDiv("hm-run-top");
        top.createSpan({ cls: "hm-job-dot" });
        if (run.profile) top.createSpan({ text: run.profile });
        top.createSpan({ cls: "hm-tag", text: run.outcome ?? run.status });
        const span = run.ended ? `${Math.max(1, Math.round((run.ended - run.started) / 60))}m` : "…";
        setTooltip(top.createSpan({ cls: "hm-push hm-muted", text: `${relative(run.started)} · ${span}` }), absolute(run.started));
        if (run.summary) row.createDiv({ cls: "hm-run-summary", text: run.summary });
        if (run.error) row.createDiv({ cls: "hm-error", text: run.error });
      }
    }

    const comments = section("message-circle", "Comments");
    for (const comment of detail.comments) {
      const row = comments.createDiv("hm-comment");
      avatar(row, comment.author, "hm-avatar is-small");
      const main = row.createDiv("hm-comment-main");
      const top = main.createDiv("hm-comment-top");
      top.createSpan({ cls: "hm-comment-author", text: comment.author });
      setTooltip(top.createSpan({ cls: "hm-muted", text: relative(comment.at) }), absolute(comment.at));
      await markdown(main, comment.body);
    }
    const composer = comments.createDiv("hm-composer");
    const area = composer.createEl("textarea", { attr: { placeholder: "Comment…  ⌘↵", rows: "2" } });
    const send = iconButton(composer, "send", "Send (⌘↵)", async () => {
      const text = area.value.trim();
      if (!text) return;
      send.disabled = true;
      const outcome = await this.host.client.comment(this.alias, task.board, task.id, text);
      send.disabled = false;
      if (!outcome.ok) return void new Notice(outcome.message);
      area.value = "";
      this.composing = false;
      void this.openTask(task);
      void this.reload(true);
    });
    area.addEventListener("input", () => { this.composing = area.value.trim() !== ""; });
    area.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send.click(); });
  }

  /* ───────────── new task ───────────── */

  private people(): string[] {
    return [...new Set(this.boards.flatMap(board => board.tasks.map(task => task.assignee)).filter((p): p is string => !!p))].sort();
  }

  private newTask(): void {
    const board = this.current;
    if (!board) return;
    const people = this.people();
    new NewTaskModal(this.app, board.name, people, async (title, assignee, body) => {
      const outcome = await this.host.client.create(this.alias, board.slug, title, assignee, body);
      if (!outcome.ok) { new Notice(outcome.message); return false; }
      void this.reload(true);
      return true;
    }).open();
  }

  override async onClose(): Promise<void> {
    this.drawer?.remove();
  }
}

class NewTaskModal extends Modal {
  constructor(app: App, private readonly board: string, private readonly people: readonly string[],
    private readonly submit: (title: string, assignee: string | null, body: string) => Promise<boolean>) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("hm-modal");
    this.setTitle(this.board);
    const form = this.contentEl.createEl("form", { cls: "hm-form" });
    const title = form.createEl("input", { type: "text", attr: { placeholder: "Title", required: "true" } });
    const body = form.createEl("textarea", { attr: { placeholder: "Details (markdown)", rows: "6" } });
    const row = form.createDiv("hm-form-row");
    const assignee = row.createEl("select", { cls: "dropdown" });
    assignee.createEl("option", { text: "Unassigned", value: "" });
    for (const person of this.people) assignee.createEl("option", { text: person, value: person });
    const create = row.createEl("button", { cls: "mod-cta", text: "Create", attr: { type: "submit" } });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!title.value.trim()) return;
      create.disabled = true;
      if (await this.submit(title.value.trim(), assignee.value || null, body.value.trim())) this.close();
      create.disabled = false;
    });
    body.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit(); });
    title.focus();
  }

  override onClose(): void { this.contentEl.empty(); }
}
