import { setIcon, setTooltip, SuggestModal } from "obsidian";
import { ask, matches, message, openCreate, suggestion } from "./kanban-drawer";
import { STATUSES, type BoardRead } from "./kanban";
import { icon, iconButton } from "./ui";
import { AUTO, type Item, MANUAL, MOVED, fill, on, plural } from "./kanban-prefs";
import type { KanbanView } from "./kanban-view";

export function buildTools(this: KanbanView): void {
  this.switcher = this.tools.createEl("button", { cls: "hm-k-switch", attr: { type: "button", "aria-label": "Switch board" } });
  setTooltip(this.switcher, "Switch board");
  this.switcher.addEventListener("click", () => this.openSwitcher());
  this.pill = this.tools.createEl("button", { cls: "hm-k-pill", attr: { type: "button" } });
  this.pill.addEventListener("click", () => void this.toggleAuto());
  iconButton(this.tools, "settings", "Orchestration settings", () => this.openOrchestration());
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

export function syncTools(this: KanbanView, r: BoardRead): void {
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
  setTooltip(this.pill, `${auto ? AUTO : MANUAL} Click to switch to ${auto ? "manual" : "auto"}.\nOrchestrator: ${r.config.orchestrator_profile || "—"}\nDefault assignee: ${r.config.default_assignee || "—"}`);
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

/** Board switcher with per-board counts, plus New board, Board settings and Remove this board. */
export function openSwitcher(this: KanbanView): void {
  const r = this.read;
  if (!r) return;
  const alias = this.alias;
  const items: Item[] = [...r.boards.filter(b => !b.archived).map((meta): Item => ({ kind: "board", meta })), { kind: "new" }, { kind: "settings" }];
  if (r.board !== "default") items.push({ kind: "archive" });
  const label = (i: Item): string => i.kind === "board" ? i.meta.name || i.meta.slug
    : i.kind === "new" ? "New board…" : i.kind === "settings" ? "Board settings…" : "Remove this board…";
  const draw = (i: Item, el: HTMLElement): void => {
    if (i.kind !== "board") return suggestion(el, label(i));
    const total = STATUSES.reduce((n, s) => s === "archived" ? n : n + (i.meta.counts[s] ?? 0), 0);
    const blocked = i.meta.counts.blocked ?? 0;
    suggestion(el, label(i), `${total} task${plural(total)}${blocked ? ` · ${blocked} blocked` : ""}${i.meta.slug === r.board ? " · current" : ""}`);
  };
  const choose = (i: Item): void => {
    // The picker and the dialogs behind it can outlive a host change; `r` and its board belong to the old host.
    if (alias !== this.alias) return;
    if (i.kind === "board") {
      if (i.meta.slug !== r.board) this.switchBoard(i.meta.slug);
      return;
    }
    const meta = this.meta();
    if (i.kind === "archive") {
      const name = meta?.name || r.board;
      // Ticking "Delete it instead" turns the text and the button into what the click will do: a deletion, with no way back.
      ask(this.app, {
        title: "Remove board",
        cta: v => v.delete ? "Delete permanently" : "Remove",
        warning: true,
        text: v => v.delete ? `Delete board '${name}' and all its tasks from the host? This can't be undone.`
          : `Remove board '${name}'? It is archived and its tasks are kept on the host.`,
        fields: [{ key: "delete", label: "Delete it instead", kind: "checkbox", desc: "Removes the board's folder and all its tasks from the host. This can't be undone." }],
        submit: async v => {
          if (alias !== this.alias) return MOVED;
          const o = await this.host.kanban.boards(this.alias, { verb: "rm", slug: r.board, ...(v.delete ? { delete: true } : {}) })
            .catch((e: unknown) => ({ ok: false as const, message: message(e) }));
          if (!o.ok) return o.message;
          // Host still on the removed board: back to default (this view follows if it shows that host). Else a view of that host reloads, so the switcher drops the board.
          if (this.host.board(alias) === r.board) {
            if (this.alias === alias) this.switchBoard("default"); else this.host.saveBoard(alias, "default");
          } else if (this.alias === alias) void this.reload();
          return null;
        },
      });
      return;
    }
    const settings = i.kind === "settings";
    const val = (x?: string): string => settings ? x ?? "" : "";
    ask(this.app, {
      title: settings ? "Board settings" : "New board",
      cta: settings ? "Save" : "Create",
      // The CLI can neither bind nor unbind a project, and no read here names it, so the id is shown as is.
      ...(settings && meta?.project ? { text: `Bound to project ${meta.project}; new tasks on this board inherit it. Change the binding in the Hermes dashboard.` } : {}),
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
        if (alias !== this.alias) return MOVED;
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
