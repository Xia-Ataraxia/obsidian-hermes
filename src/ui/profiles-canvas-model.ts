import { serializeScopedKey } from "../domain/control-center-validation";
import type { ProfileKey } from "../types/control-center";
import type { ActivityEdge, ActivityWindow } from "../types/task-activity";
import type { ProfileActivityNode } from "../types/task-activity-projection";
import type { CanvasFilters, CanvasPoint, CanvasViewport, ProfilesCanvasPreferences } from "../types/profiles-canvas";

export const CANVAS_GEOMETRY = { width: 176, height: 112, column: 272, row: 184, margin: 64 } as const;
const bound = (value: number, fallback = 0): number => Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, value)) : fallback;
export const canvasPoint = (point: CanvasPoint): CanvasPoint => ({ x: bound(point.x), y: bound(point.y) });
export const canvasViewport = (value: CanvasViewport): CanvasViewport => ({ ...canvasPoint(value), zoom: Number.isFinite(value.zoom) ? Math.max(.25, Math.min(2, value.zoom)) : 1 });
export const edgeKey = (edge: ActivityEdge): string => edge.profiles.map(serializeScopedKey).join("|");
export function activityWindow(filters: CanvasFilters, now: number): ActivityWindow {
  return filters.window === "all" ? { preset: "all", start: null, end: now }
    : { preset: filters.window, start: now - filters.window * 86_400_000, end: now };
}
export function peerLabel(node: ProfileActivityNode): string {
  const presence = node.peerPresence;
  switch (presence.kind) {
    case "observed": return `${node.peerDegree}개 연결 · ${presence.distinctTaskCount}개 작업${presence.partial ? " · 부분 기록" : ""}`;
    case "no-observed-activity": return "선택 범위 내 관찰된 연결 없음";
    case "self-or-other-activity": return "자기 / 외부 활동만 관찰됨";
    case "unknown": return "연결 여부 판단 불가";
    default: return unreachable(presence);
  }
}
function unreachable(value: never): never { throw new TypeError(`Unexpected presence: ${String(value)}`); }
/** Fixed monotonic mapping: updates cannot change the meaning of an existing shade. */
export function edgeOpacity(tasks: number): number { return .25 + .65 * Math.max(0, tasks) / (Math.max(0, tasks) + 4); }
export function sketchPath(key: string, from: CanvasPoint, to: CanvasPoint): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const bend = (hash % 13) - 6;
  const middle = { x: (from.x + to.x) / 2 + bend, y: (from.y + to.y) / 2 - bend };
  return `M ${from.x} ${from.y} Q ${middle.x} ${middle.y} ${to.x} ${to.y}`;
}
export function sketchOutline(key: string): string {
  let seed = 0;
  for (const character of key) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  const offset = seed % 3;
  return `M 14 2 Q 86 ${2 + offset} 162 3 Q 173 3 174 16 L 173 96 Q 173 109 159 110 L 15 ${109 - offset} Q 2 109 2 96 L 3 16 Q 2 2 14 2 Z`;
}
/** Positions are mutable view state; roster refresh never reinitializes existing entries. */
export class ProfilesCanvasLayout {
  private readonly positions = new Map<string, CanvasPoint>();
  viewport: CanvasViewport;
  constructor(preferences?: ProfilesCanvasPreferences) {
    this.viewport = canvasViewport(preferences?.viewport ?? { x: 0, y: 0, zoom: 1 });
    for (const point of preferences?.positions.slice(0, 256) ?? []) this.positions.set(point.profile, canvasPoint(point));
  }
  point(profile: ProfileKey): CanvasPoint {
    const known = this.positions.get(profile.profile);
    if (known) return known;
    const index = this.positions.size;
    const point = { x: CANVAS_GEOMETRY.margin + index % 3 * CANVAS_GEOMETRY.column, y: CANVAS_GEOMETRY.margin + Math.floor(index / 3) * CANVAS_GEOMETRY.row };
    this.positions.set(profile.profile, point);
    return point;
  }
  move(profile: ProfileKey, point: CanvasPoint): void { this.positions.set(profile.profile, canvasPoint(point)); }
  pan(point: CanvasPoint): void { this.viewport = { ...this.viewport, ...canvasPoint(point) }; }
  zoom(factor: number, anchor: CanvasPoint): void {
    const old = this.viewport;
    const zoom = canvasViewport({ ...old, zoom: old.zoom * factor }).zoom;
    this.viewport = canvasViewport({ x: anchor.x - (anchor.x - old.x) * zoom / old.zoom, y: anchor.y - (anchor.y - old.y) * zoom / old.zoom, zoom });
  }
  reset(): void { this.viewport = { x: 0, y: 0, zoom: 1 }; }
  metadata(profiles: readonly ProfileKey[], filters: CanvasFilters): ProfilesCanvasPreferences {
    return { positions: profiles.slice(0, 256).map(profile => ({ profile: profile.profile, ...this.point(profile) })), viewport: this.viewport, filters, view: "profiles" };
  }
}
