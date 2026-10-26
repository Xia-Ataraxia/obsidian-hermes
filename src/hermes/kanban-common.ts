import { setTooltip } from "obsidian";
import { type Status } from "./kanban";
import { absolute, icon, relative } from "./ui";
import { plainWhy } from "./send-queue";

export const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** One friendly line for an ssh failure; the raw stderr goes to the console only. Other CLI errors pass through. */
export function friendly(raw: string): string {
  const why = plainWhy(raw);
  if (why !== "Can't reach Hermes") return raw;
  console.debug("[hermes]", raw);
  return `${why}. Check the SSH host in settings and try again.`;
}

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
  specify: "Specify this task? Hermes asks an LLM to flesh out the spec; it can take a minute.",
  decompose: "Decompose this task? Hermes asks an LLM to split it into child tasks; it can take a minute.",
};

/** The Delete confirm: the count, that it can't be undone, and that a running task's worker is stopped first (the archive step does that). */
export const deleteText = (n: number, running: number): string =>
  `Delete ${n === 1 ? "this task" : `${n} tasks`} permanently? This can't be undone.${running ? ` ${running === 1 ? "A running worker is" : `${running} running workers are`} stopped first.` : ""}`;

/** Relative time that the view's minute tick keeps fresh; the absolute time is the tooltip. */
export function when(parent: HTMLElement, at: number | undefined, cls = "hm-muted"): HTMLElement {
  const el = parent.createSpan({ cls, text: relative(at) });
  if (at) { el.dataset.at = String(at); setTooltip(el, absolute(at)); }
  return el;
}

export const elapsed = (s: number): string => s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

/** Chat and thread ids show only their last 4 characters. */
export const mask = (id: string): string => id.length > 4 ? `…${id.slice(-4)}` : id;

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
