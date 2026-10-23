import type { AbsolutePath, BoardKey, BoundaryResult, IncompleteReason } from "./control-center";
import type { ActivityWindow, ActivityWindowPreset, BoardActivitySnapshot } from "./task-activity";

export type ActivityReadRequest = {
  readonly board: BoardKey;
  /** Configured shared Hermes root, never a caller-supplied database path. */
  readonly root: AbsolutePath;
  readonly window: ActivityWindow;
};
export type ActivityReadInput = {
  readonly connection: unknown;
  readonly board: unknown;
  readonly root: unknown;
  readonly end: number;
  readonly preset?: ActivityWindowPreset;
};
export type ActivityCommand = {
  readonly kind: "read-board-activity";
  readonly request: ActivityReadRequest;
  readonly file: "ssh";
  readonly args: readonly string[];
};
export type ActivityRunResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: IncompleteReason };
export interface ActivityRunner {
  (command: ActivityCommand, signal: AbortSignal): Promise<ActivityRunResult>;
}
export interface TaskActivityReader {
  read(input: ActivityReadInput, signal: AbortSignal): Promise<BoundaryResult<BoardActivitySnapshot>>;
  dispose(): void;
}
