import type { CloseDecision, ControlCenterState } from "./control-center-state";
import type { DashboardJson } from "../types/dashboard-client";

export type KanbanDraftScope = { readonly board: string; readonly taskId?: string; readonly createColumn?: string };
export type KanbanNavigation = { readonly board: string; readonly taskId: string | null };
export interface KanbanNativeBridge {
  readonly connect: (navigate: (target: KanbanNavigation) => void, refresh: () => void) => () => void;
  readonly selected: (board: string) => void;
  readonly get: (scope: KanbanDraftScope, field: string, fallback: DashboardJson) => DashboardJson;
  readonly edit: (scope: KanbanDraftScope, field: string, value: DashboardJson) => void;
  readonly clear: (scope: KanbanDraftScope, field?: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly issue: (scope: KanbanDraftScope) => string | null;
}
export type HermesKanbanViewServices = {
  readonly state: ControlCenterState;
  readonly initialBoard?: string;
  readonly confirmDiscard: (decision: Extract<CloseDecision, { kind: "confirm-discard" }>) => Promise<boolean>;
  readonly confirmNavigation?: (decision: Extract<CloseDecision, { kind: "confirm-discard" }>) => Promise<boolean>;
};
