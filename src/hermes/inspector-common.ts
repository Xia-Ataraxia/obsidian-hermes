import { Menu } from "obsidian";
import { resolveInstant } from "../domain/instant-timezone-resolver";
import type { LedgerReadResult } from "../types/snapshot";
import type { Outcome } from "./data";
import { type SkillInfo, type Source } from "./inspect";

export type FileRead = { readonly text: string; readonly sum: string };
export type Runs = { readonly at: number; readonly read: Promise<LedgerReadResult>; value?: LedgerReadResult };

/** One rail entry; `live` panes re-render on every poll. */
export interface Tab {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  readonly live?: boolean;
  readonly count?: () => string;
  render(el: HTMLElement): void;
}

export const SOURCES: Record<Source, readonly [icon: string, label: string]> = {
  bundled: ["package", "Built-in"], modified: ["pencil-line", "Built-in, edited here"], hub: ["globe", "Installed from the hub"],
  local: ["folder", "Local"], shared: ["share-2", "Shared with other profiles"], omh: ["puzzle", "Managed by the omh plugin"], plugin: ["puzzle", "Plugin"],
};
export const sourceLabel = (skill: SkillInfo): string => skill.source === "plugin" ? `Plugin ${skill.owner ?? ""}`.trim() : SOURCES[skill.source][1];

/** What editing this skill's file means; null when nothing special. */
export function hint(skill: SkillInfo): string | null {
  switch (skill.source) {
    case "bundled": return `Editing marks it modified, and hermes update stops syncing it. Run hermes skills reset ${skill.name} to restore it.`;
    case "modified": return `Locally modified. Run hermes skills reset ${skill.name} to restore the bundled copy.`;
    case "hub": return "Running hermes skills update --force may overwrite edits.";
    case "shared": return "Shared root: changes apply to every profile using it.";
    case "omh": return "Managed by the omh plugin (read-only).";
    case "plugin": return `Provided by plugin ${skill.owner ?? ""} (read-only).`;
    default: return null;
  }
}

export const FILTERS = [["all", "All"], ["bundled", "Built-in"], ["modified", "Modified"], ["hub", "Hub"], ["local", "Local"], ["shared", "Shared"], ["plugin", "Plugin"], ["disabled", "Disabled only"]] as const;
export type Filter = (typeof FILTERS)[number][0];
export const shows = (skill: SkillInfo, filter: Filter): boolean =>
  filter === "all" || (filter === "disabled" ? !skill.enabled : filter === "plugin" ? skill.source === "plugin" || skill.source === "omh" : skill.source === filter);
export const SORTS = [["category", "Category"], ["name", "Name"], ["lru", "Least recently used"], ["mru", "Recently used"]] as const;
export type Sort = (typeof SORTS)[number][0];
export const PLUGIN_SORTS = [["name", "Name"], ["lru", "Least recently used"]] as const;
export type PluginSort = (typeof PLUGIN_SORTS)[number][0];
export const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
export const DISCARD = "Discard unsaved changes?";
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const fail = (error: unknown): Outcome => ({ ok: false, message: message(error) });
/** Epoch seconds for a stamp with a known offset; naive stamps stay raw text. */
export function instant(raw: string | null): number | null {
  const at = resolveInstant(raw);
  return at?.kind === "absolute" ? at.epochMs / 1000 : null;
}
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
export function skeleton(el: HTMLElement, n: number): void { for (let i = 0; i < n; i++) el.createDiv("hm-skeleton"); }
export function choose<T extends string>(button: HTMLElement, options: readonly (readonly [T, string])[], current: T, pick: (value: T) => void): void {
  const menu = new Menu();
  for (const [value, label] of options) menu.addItem(item => item.setTitle(label).setChecked(value === current).onClick(() => pick(value)));
  const rect = button.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom });
}
