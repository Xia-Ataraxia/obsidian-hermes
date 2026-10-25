import { Menu, setTooltip } from "obsidian";
import { COLUMNS, copy, severityIcon, severityRank, when } from "./kanban-drawer";
import { dropVerb, staleness, STATUSES, type Card, type Status } from "./kanban";
import { avatar, iconButton, stat } from "./ui";
import { CAPPED, NEEDS, plural } from "./kanban-prefs";
import type { KanbanView } from "./kanban-view";

export function renderCard(this: KanbanView, parent: HTMLElement, c: Card, now: number): void {
  const label = COLUMNS[c.status].label;
  const el = parent.createDiv({
    cls: `hm-k-card is-${c.status}`,
    attr: { draggable: "true", tabindex: "0", role: "button", "aria-label": `${c.title || "(untitled)"} — ${c.id} — ${label}`, "data-id": c.id },
  });
  el.toggleClass("is-selected", this.selected.has(c.id));
  el.toggleClass("is-failed", this.failed.has(c.id));
  el.toggleClass("is-open", this.drawer?.id === c.id);
  // A card that changed column since the last paint (dropped here, or moved by an agent) lands with a spring and a flash.
  const was = this.painted.get(c.id);
  el.toggleClass("is-moved", was !== undefined && was !== c.status);
  this.painted.set(c.id, c.status);

  const top = el.createDiv("hm-k-card-top");
  const check = top.createEl("input", { cls: "hm-k-check", attr: { type: "checkbox" } });
  // setTooltip owns aria-label, so the task id goes through it.
  setTooltip(check, `Select ${c.id} for bulk actions`);
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
      this.openTask(c.id, "diagnostics");
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
    this.openTask(c.id);
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
export function clickCard(this: KanbanView, id: string, event: MouseEvent): void {
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
  this.openTask(id);
}

/** Columns that take at least one dragged card light up; columns that take none are locked. */
export function markTargets(this: KanbanView, ids: string[]): void {
  this.allow.clear();
  const cards = this.read?.tasks.filter(c => ids.includes(c.id)) ?? [];
  for (const col of Array.from(this.body.querySelectorAll<HTMLElement>(".hm-k-col"))) {
    const to = col.dataset.status as Status;
    if (cards.every(c => c.status === to)) continue;
    const verbs = cards.map(c => dropVerb(c.status, to, c.openParents));
    if (verbs.every(v => v === null)) {
      col.addClass("is-locked");
      continue;
    }
    this.allow.add(to);
    col.toggleClass("is-target", verbs.some(v => v !== null && v !== "refuse"));
  }
}

export function cardMenu(this: KanbanView, c: Card): Menu {
  const menu = new Menu();
  menu.addItem(i => i.setTitle("Open").setIcon("panel-right-open").onClick(() => this.openTask(c.id)));
  const picked = this.selected.has(c.id);
  menu.addItem(i => i.setTitle(picked ? "Deselect" : "Select").setIcon(picked ? "x" : "check").onClick(() => {
    if (!this.selected.delete(c.id)) this.selected.add(c.id);
    this.anchor = c.id;
    this.render();
  }));
  menu.addSeparator();
  for (const to of STATUSES) {
    const verb = dropVerb(c.status, to, c.openParents);
    if (verb === null || verb === "refuse") continue;
    menu.addItem(i => i.setTitle(to === "archived" ? "Archive" : `Move to ${COLUMNS[to].label}`).setIcon(COLUMNS[to].icon)
      .setWarning(to === "archived").onClick(() => void this.drop([c.id], to)));
  }
  menu.addSeparator();
  menu.addItem(i => i.setTitle("Copy ID").setIcon("copy").onClick(() => copy(c.id)));
  return menu;
}
