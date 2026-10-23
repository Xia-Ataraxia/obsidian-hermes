import type { AbsolutePath, BoardKey, EventKey, Freshness, ProfileKey, ReadCoverage, TaskKey } from "./control-center";

export const ACTIVITY_LIMITS = { rowsPerBoard: 100_000, bytesPerBoard: 16 * 1024 * 1024, deadlineMs: 15_000, concurrentBoards: 2 } as const;
export type ActivityWindowPreset = 7 | 30 | 90 | "all";
/** UTC epoch milliseconds; half-open [start,end), with null start only for all-time. */
export type ActivityWindow =
  | { readonly preset: 7 | 30 | 90; readonly start: number; readonly end: number }
  | { readonly preset: "all"; readonly start: null; readonly end: number };
export type ActivityType = "creation" | "transfer" | "review" | "revision";
export type UnknownAttributionReason = "missing-creator" | "missing-endpoint" | "malformed-payload" | "unrecognized-actor";
export type ActivityActor =
  | { readonly kind: "current-profile"; readonly profile: ProfileKey }
  | { readonly kind: "retired-profile"; readonly profile: ProfileKey }
  | { readonly kind: "system" | "generic"; readonly label: string }
  | { readonly kind: "unknown"; readonly reason: UnknownAttributionReason; readonly recordedLabel?: string };

/** Structural projection only: never task body, prompt, comment or arbitrary event payload. */
export type TaskActivity = {
  readonly event: EventKey;
  readonly task: TaskKey;
  readonly type: ActivityType;
  readonly occurredAt: number;
  readonly from: ActivityActor;
  readonly to: ActivityActor;
};
export type BoardActivitySnapshot = {
  readonly board: BoardKey;
  readonly databasePath: AbsolutePath;
  readonly window: ActivityWindow;
  readonly snapshotAt: number;
  readonly schemaFingerprint: string;
  readonly highWaterEventId: EventKey | null;
  readonly qualifyingRowCount: number;
  readonly malformedRowCount: number;
  readonly missingAttributionCount: number;
  readonly coverage: ReadCoverage;
  readonly freshness: Freshness;
  readonly activities: readonly TaskActivity[];
};
/** Counts overlap by type; three review-cycle events on one task still weigh one task. */
export type ActivityEdge = {
  readonly profiles: readonly [ProfileKey, ProfileKey];
  readonly tasks: readonly TaskKey[];
  readonly events: readonly TaskActivity[];
  readonly distinctTaskCount: number;
  readonly taskCountByType: Readonly<Record<ActivityType, number>>;
};
/** No absence claim unless every selected board and roster is complete and fresh. */
export type ProfileActivityPresence =
  | { readonly kind: "observed"; readonly distinctTaskCount: number; readonly partial: boolean }
  | { readonly kind: "no-observed-activity"; readonly window: ActivityWindow }
  | { readonly kind: "unknown"; readonly reason: "coverage" | "freshness" | "attribution" };
