import type { DashboardClient } from "./dashboard-client";
import type { DashboardEventBatch, DashboardClientError, DashboardMutationResult } from "../types/dashboard-client";
import type { KanbanNativeBridge } from "./kanban-view-contract";

export type KanbanWatch = {
  readonly board: string;
  readonly since: number;
  readonly onEvents: (batch: DashboardEventBatch) => void;
  readonly onRefresh: () => void;
  readonly onFailure: (error: DashboardClientError) => void;
};

/** The caller owns visibility, polling and reconnect. One watch per mounted page. */
export interface KanbanHostServices {
  readonly client: Pick<DashboardClient, "read" | "mutate" | "attachment">;
  readonly watch: (request: KanbanWatch) => () => void;
  readonly onMutation: (result: DashboardMutationResult) => void;
  readonly initialBoard?: string;
  readonly bridge?: KanbanNativeBridge;
}
