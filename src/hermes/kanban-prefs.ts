import { type BoardMeta, type Card, type Status, type Verb } from "./kanban";

export interface Pref { lanes?: boolean; archived?: boolean; folds?: Partial<Record<Status, boolean>> }
export type Item = { kind: "board"; meta: BoardMeta } | { kind: "new" | "settings" | "archive" };

export const AUTO = "Orchestration: Auto — the dispatcher decomposes new triage tasks automatically every tick.";
export const MANUAL = "Orchestration: Manual — triage tasks stay in triage until you click Decompose on each card.";
export const NEEDS = "Dependencies are satisfied, but the dispatcher skips this task until you assign a profile.";
export const CAPPED = new Set<Status>(["done", "archived"]);
export const plural = (n: number): string => n === 1 ? "" : "s";
/** Delete for good: the CLI purges only archived tasks, so each task on the board not archived yet gets an archive verb ahead of
 *  its purge (an id the read lacks is archived, or gone, and gets the purge alone). One bulk round trip runs the pairs in order. */
export const deletion = (ids: string[], tasks: Card[]): Verb[] => {
  const open = new Set(tasks.filter(c => c.status !== "archived").map(c => c.id));
  return ids.flatMap((id): Verb[] => [...(open.has(id) ? [{ verb: "archive", id } as const] : []), { verb: "purge", id }]);
};
export const on = (v?: string): boolean => !/^(false|no|off|0)$/i.test(v ?? "");
/** What a dialog left open across a host change gets back: the board and task ids it holds belong to the old host. */
export const MOVED = "The SSH host changed; open it again.";

/** Rebuild a filter select only when its options change; returns the kept value ("" when it vanished). */
export function fill(select: HTMLSelectElement, all: string, options: [string, string][], value: string): string {
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

