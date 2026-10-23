import type { ActivityType, ActivityWindowPreset } from "../types/task-activity";
import type { ConnectionPreferences, PersistedControlCenterPreferences, ProfilesCanvasPreferences } from "../types/control-center-preferences";
import { parseControlCenterToken } from "./control-center-validation";

export const PREFERENCE_LIMITS = { connections: 32, positions: 256, boards: 64, coordinate: 100_000, minZoom: 0.25, maxZoom: 2 } as const;
const ACTIVITY_TYPES = ["creation", "transfer", "review", "revision"] as const;

function record(value: unknown): Record<string, unknown> {
  function isRecord(candidate: unknown): candidate is Record<string, unknown> {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
  }
  return isRecord(value) ? value : {};
}
function items(value: unknown, limit: number): readonly unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function coordinate(value: number): number {
  return Math.max(-PREFERENCE_LIMITS.coordinate, Math.min(PREFERENCE_LIMITS.coordinate, value));
}
function windowPreset(value: unknown): ActivityWindowPreset {
  switch (value) {
    case 7: case 30: case 90: case "all": return value;
    default: return 30;
  }
}
function activityType(value: unknown): value is ActivityType {
  return value === "creation" || value === "transfer" || value === "review" || value === "revision";
}

/** Reuse the accepted boundary token parsers; copy only explicitly permitted fields. */
export function projectControlCenterPreferences(value: unknown): ProfilesCanvasPreferences {
  const input = record(value), viewport = record(input.viewport), filters = record(input.filters);
  const positions: ProfilesCanvasPreferences["positions"][number][] = [];
  const profiles = new Set<string>();
  for (const raw of items(input.positions, PREFERENCE_LIMITS.positions)) {
    const point = record(raw), profile = parseControlCenterToken("profile", point.profile);
    if (!profile.ok || profiles.has(profile.value) || !finite(point.x) || !finite(point.y)) continue;
    profiles.add(profile.value);
    positions.push({ profile: profile.value, x: coordinate(point.x), y: coordinate(point.y) });
  }
  const boards: ProfilesCanvasPreferences["filters"]["boards"][number][] = [];
  for (const raw of items(filters.boards, PREFERENCE_LIMITS.boards)) {
    const board = parseControlCenterToken("board", raw);
    if (board.ok && !boards.includes(board.value)) boards.push(board.value);
  }
  const types = Array.isArray(filters.types)
    ? [...new Set(items(filters.types, ACTIVITY_TYPES.length).filter(activityType))] : [...ACTIVITY_TYPES];
  return {
    positions,
    viewport: {
      x: finite(viewport.x) ? coordinate(viewport.x) : 0,
      y: finite(viewport.y) ? coordinate(viewport.y) : 0,
      zoom: finite(viewport.zoom) ? Math.max(PREFERENCE_LIMITS.minZoom, Math.min(PREFERENCE_LIMITS.maxZoom, viewport.zoom)) : 1,
    },
    filters: { boards, window: windowPreset(filters.window), types },
    view: input.view === "kanban" ? "kanban" : "profiles",
  };
}

/** Unknown versions are opaque: callers must refuse mutation, including removal. */
export function readPreferenceEnvelope(value: unknown): PersistedControlCenterPreferences | null {
  const input = record(value);
  if (Object.hasOwn(input, "version") && input.version !== 1) return null;
  const connections: ConnectionPreferences[] = [];
  if (input.version === 1) {
    for (const raw of items(input.connections, PREFERENCE_LIMITS.connections)) {
      const entry = record(raw), connection = parseControlCenterToken("connection", entry.connection);
      if (!connection.ok || connections.some((item) => item.connection === connection.value)) continue;
      connections.push({ connection: connection.value, preferences: projectControlCenterPreferences(entry.preferences) });
    }
  }
  return { version: 1, connections };
}
