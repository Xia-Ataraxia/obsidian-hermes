import type { BoardKey, ProfileKey, ProfileRoster, TaskKey } from "./control-center";
import type { ActivityWindow, BoardActivitySnapshot } from "./task-activity";
import type { DashboardRequestContext } from "./dashboard-client";
import type { ControlCenterState } from "../ui/control-center-state";
import type { CanvasFilters, ProfilesCanvasPreferences } from "./control-center-preferences";
export type { CanvasPoint, CanvasViewport, CanvasFilters, ProfilesCanvasPreferences } from "./control-center-preferences";
export type ConfiguredOrchestrator = { readonly kind: "configured"; readonly profile: ProfileKey; readonly source: "GET /orchestration" } | { readonly kind: "unknown" };
export interface CanvasInspector {
  select(profile: ProfileKey, focusReturn?: HTMLElement): Promise<boolean>;
  refresh(): Promise<void>;
  close(): Promise<boolean>;
  dispose(): void;
  setVisible?(visible: boolean): void;
}
export interface ProfilesCanvasServices {
  readonly state: ControlCenterState;
  loadRoster(context: DashboardRequestContext): Promise<ProfileRoster>;
  loadBoards(context: DashboardRequestContext): Promise<readonly BoardKey[]>;
  loadActivity(board: BoardKey, window: ActivityWindow, context: DashboardRequestContext): Promise<BoardActivitySnapshot>;
  loadConfiguration?(context: DashboardRequestContext): Promise<ConfiguredOrchestrator>;
  mountInspector(container: HTMLElement, onClose: () => void): CanvasInspector;
  openTask(task: TaskKey): void | Promise<void>;
  readonly preferences?: ProfilesCanvasPreferences;
  savePreferences(preferences: ProfilesCanvasPreferences): Promise<void>;
}
export const CANVAS_TYPES = ["creation", "transfer", "review", "revision"] as const;
export const CANVAS_DEFAULT_FILTERS: CanvasFilters = { boards: [], window: 30, types: CANVAS_TYPES };
