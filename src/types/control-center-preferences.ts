import type { BoardId, ConnectionId, ProfileId } from "./control-center";
import type { ActivityType, ActivityWindowPreset } from "./task-activity";

export type CanvasPoint = { readonly x: number; readonly y: number };
export type CanvasViewport = CanvasPoint & { readonly zoom: number };
export type CanvasFilters = {
  readonly boards: readonly BoardId[];
  readonly window: ActivityWindowPreset;
  readonly types: readonly ActivityType[];
};
/** Only layout metadata belongs here. Search, fetched entities and drafts stay in memory. */
export type ProfilesCanvasPreferences = {
  readonly positions: readonly (CanvasPoint & { readonly profile: ProfileId })[];
  readonly viewport: CanvasViewport;
  readonly filters: CanvasFilters;
  readonly view: "profiles" | "kanban";
};
export type ConnectionPreferences = {
  readonly connection: ConnectionId;
  readonly preferences: ProfilesCanvasPreferences;
};
export type PersistedControlCenterPreferences = {
  readonly version: 1;
  readonly connections: readonly ConnectionPreferences[];
};
export type PreferencesRead = {
  readonly preferences: ProfilesCanvasPreferences;
  readonly status: "ready" | "unsupported-version";
};
export class PreferencesSaveError extends Error {
  constructor(readonly code: "unsupported-version" | "disposed" | "invalid-connection") {
    super(`Control center preferences: ${code}`);
    this.name = "PreferencesSaveError";
  }
}
