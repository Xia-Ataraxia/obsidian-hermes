import type { EdgeMode } from "../types/snapshot";
import type { Profile } from "./data";
import { hue } from "./geometry";

export const CARD_W = 280;
const SVG = "http://www.w3.org/2000/svg";
export const LOAD: readonly [keyof Profile["load"], string, string][] = [
  ["running", "play", "Running"],
  ["ready", "circle-dot", "Ready"],
  ["todo", "circle-dashed", "Todo"],
  ["review", "eye", "Review"],
  ["blocked", "ban", "Blocked"],
  ["done7d", "check", "Done · 7d"],
];
export function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = parent.doc.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}

export const color = (id: string): string => `hsl(${Math.round(hue(id))} 68% 58%)`;
export const shortModel = (model: string): string => model.split("/").pop() ?? model;
export const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** What an edge counts, for the legend switch and the settings dropdown: mode, icon, label, unit, meaning. */
export const EDGE_MODES: readonly (readonly [EdgeMode, string, string, string, string])[] = [
  ["handoffs", "arrow-right-left", "Handoffs", "handoff", "tasks one profile created for the other"],
  ["comments", "message-square", "Comments", "comment", "comments on tasks assigned to the other"],
  ["links", "link", "Dependencies", "link", "parent/child task links between them"],
  ["all", "layers", "All", "interaction", "handoffs + comments + dependencies"],
];
