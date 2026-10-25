import { Notice, setTooltip } from "obsidian";
import { action, ask, COLUMNS, confirmed, deleteText, diagCard, matches, openCreate, severityRank } from "./kanban-drawer";
import { STATUSES, type BoardRead, type Card, type Status, type Verb } from "./kanban";
import { avatar, icon, iconButton } from "./ui";
import { CAPPED, deletion, plural } from "./kanban-prefs";
import type { KanbanView } from "./kanban-view";

export function renderBoard(this: KanbanView): void {
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
        action(line, "Open", () => this.openTask(c.id, "diagnostics"));
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
      const rail = col.createEl("button", { cls: "hm-k-rail", attr: { type: "button" } });
      // setTooltip owns aria-label, so the column name goes through it.
      setTooltip(rail, `Expand ${label}`);
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

export function bulkBar(this: KanbanView, r: BoardRead, visible: Card[]): void {
  // The dialogs opened from this bar hold its cards: they go to the board the bar was drawn for, or, once the host changed, nowhere.
  const alias = this.alias, board = r.board;
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
      if (yes) void this.apply(alias, board, stuck.map((c): Verb => ({ verb: "unblock", id: c.id })), "ready");
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
      return this.apply(alias, board, cards.map((c): Verb => ({ verb: "edit", id: c.id, priority })));
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
    if (value) void this.assign(cards, value === " none" ? null : value, board);
  });
  action(bar, "Delete permanently", () => {
    const running = cards.filter(c => c.status === "running").length;
    void confirmed(this.app, "Delete permanently", deleteText(n, running), "Delete", true).then(yes => {
      if (yes) void this.apply(alias, board, deletion(ids, this.current(alias, board)?.tasks ?? r.tasks));
    });
  }, "trash-2", "Delete the selected tasks permanently").addClass("mod-warning");
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
export function foldLane(this: KanbanView, s: Status, folded: boolean, auto: boolean): void {
  const folds = this.pref().folds ??= {};
  if (folded === auto) delete folds[s];
  else folds[s] = folded;
  this.app.workspace.requestSaveLayout();
  this.render();
}
