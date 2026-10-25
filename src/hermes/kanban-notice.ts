import { Notice } from "obsidian";
import { type Alert } from "./kanban";
import { icon } from "./ui";

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

