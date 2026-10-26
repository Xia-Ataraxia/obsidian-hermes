import { setTooltip } from "obsidian";
import type { ChatState, Tool, Turn, Usage } from "./chat";
import { plainWhy } from "./send-queue";
import { compact, icon, iconButton } from "./ui";

/** A plain headline, a way to try again, and the raw error behind Details. */
function failure(log: HTMLElement, error: string, retry?: () => void): void {
  const box = log.createDiv("hm-chat-banner is-error");
  icon(box, "circle-alert");
  const body = box.createDiv();
  body.createDiv({ cls: "hm-chat-banner-title", text: plainWhy(error) });
  const more = body.createEl("details", { cls: "hm-empty-more" });
  more.createEl("summary", { text: "Details" });
  more.createEl("pre", { text: error });
  if (retry) iconButton(box, "rotate-ccw", "Send again", retry);
}

/** How a finished turn ended, when that is not simply its reply. `retry` sends the turn again. */
export function outcome(log: HTMLElement, turn: Turn, s: ChatState, profile: string, retry?: () => void): void {
  switch (turn.code) {
    case 0:
      if (!turn.text) log.createDiv({ cls: "hm-chat-foot", text: "No reply" });
      return;
    case 130:
      log.createDiv({ cls: "hm-chat-foot", text: "Interrupted" });
      return;
    case null:
      // Refused before it ran (a closed connection, an unsafe id): nothing was sent, so this is an error.
      if (turn.refused) failure(log, turn.error ?? "Not sent", retry);
      else log.createDiv({ cls: "hm-chat-foot", text: `Stopped waiting. If the message was accepted, the reply will appear here.${turn.error ? ` (${turn.error})` : ""}` });
      return;
    case 3: {
      // Approvals, "Input required" and Unknown execution blocks: only the TUI can answer them, so offer the way there.
      const banner = log.createDiv("hm-chat-banner");
      icon(banner, "triangle-alert");
      const body = banner.createDiv({ text: turn.error ?? "Input required" });
      const sid = turn.sid || s.sid;
      if (sid) body.createEl("code", { cls: "hm-code hm-selectable", text: `hermes -p ${profile} chat --resume ${sid}` });
      return;
    }
    default:
      failure(log, turn.error || `Exit ${turn.code}`, retry);
  }
}

export function chips(log: HTMLElement, tools: Tool[]): void {
  for (const tool of tools) {
    const blocked = tool.output?.startsWith("BLOCKED:") ?? false;
    const details = log.createEl("details", { cls: "hm-chat-tool" });
    details.toggleClass("is-error", tool.error);
    details.toggleClass("is-blocked", blocked);
    const summary = details.createEl("summary");
    icon(summary, "wrench");
    summary.createSpan({ text: tool.name });
    if (tool.ms !== null) summary.createSpan({ cls: "hm-muted", text: `${(tool.ms / 1000).toFixed(1)}s` });
    if (blocked) setTooltip(summary, "Approval needed; denied in this panel. Use the TUI.");
    if (tool.input) details.createEl("pre", { text: tool.input });
    if (tool.output !== null) details.createEl("pre", { text: tool.output });
  }
}

export function foot(log: HTMLElement, usage: Usage): void {
  const text = `${compact(usage.in)} → ${compact(usage.out)} · ${(usage.ms / 1000).toFixed(1)}s`;
  setTooltip(log.createDiv({ cls: "hm-chat-foot", text }), `${usage.in.toLocaleString()} input tokens, ${usage.out.toLocaleString()} output tokens, ${usage.ms.toLocaleString()} ms`);
}
