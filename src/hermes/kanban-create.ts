import { Component, Notice, setTooltip, type App } from "obsidian";
import type { HermesClient } from "./data";
import { type Card, type Diagnostic, type KanbanClient, type NewTask, type Status, type Verb } from "./kanban";
import { icon } from "./ui";
import { COLUMNS, CONFIRM, action, copy, matches, message, severityIcon } from "./kanban-common";
import { type Focus, type Suggestion, ask, askReassign, confirmed } from "./kanban-ask";

/** Model suggestions from a profile's provider cache, read once per modal. */
export function modelPicker(host: TaskHost): (query: string, profile: string) => Promise<Suggestion[]> {
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
  /** Delete a task for good (archive, then purge, in one round trip), then refresh; resolves to the CLI error or null. */
  remove(id: string): Promise<string | null>;
  /** Why this host takes no more writes (the view closed, or the SSH host changed since it was built: its alias and board are stale), else null. */
  moved(): string | null;
  open(id: string, focus?: Focus): void;
  close(): void;
}

export function openCreate(host: TaskHost, column: "ready" | "triage" | "blocked", workdir: string | undefined, created: () => void): void {
  const cards = host.cards(), models = modelPicker(host);
  const tenants = [...new Set(cards.map(c => c.tenant ?? ""))].filter(Boolean).sort();
  const dialog = ask(host.app, {
    title: `New task — ${COLUMNS[column].label}`, cta: "Create",
    fields: [
      { key: "title", label: "Title", kind: "textarea", required: true, enter: true, placeholder: column === "triage" ? "Rough idea — AI will spec it…" : "New task title…" },
      { key: "body", label: "Description", kind: "textarea", mono: true },
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
      const { title = "", body = "", assignee = "", priority = "", tenant = "", project = "", parent = "", skills = "", workspace = "scratch", path = "", branch = "", model = "", provider = "", maxRuntime = "", maxRetries = "", goal = "", goalMaxTurns = "" } = v;
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
        ...(branch ? { branch } : {}), ...(tenant ? { tenant } : {}), ...(project ? { project } : {}), ...(Number(priority) ? { priority: Number(priority) } : {}),
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
  // The dialog opens at once; projects.db answers while it is up. A project to pick adds the select, a failed or empty read leaves it out, a closed dialog takes nothing.
  void host.kanban.projects(host.alias).then(found => {
    if (typeof found === "string" || !found.length) return;
    dialog.addField({ key: "project", label: "Project", kind: "dropdown", options: [["", "(none, or the board's project)"], ...found.map(({ id, name }): [string, string] => [id, name])] }, "parent");
  }, () => undefined);
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
          const profile = select.value === "none" ? null : select.value, done = `Reassigned ${id} to ${profile ?? "(unassigned)"}.`;
          // The dashboard's own default: the diagnostic says whether to reclaim first, and the box starts there.
          const reclaim = payload.reclaim_first === true;
          if (!reclaim && task.status !== "running") { run({ verb: "assign", id, profile, reason }, done, "Reassign failed: "); return; }
          askReassign(host.app, async r => {
            const error = await host.write({ verb: "reassign", id, profile, reason, ...(r ? { reclaim: r } : {}) });
            if (error === null) new Notice(done, 4000);
            return error;
          }, { reclaim });
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

