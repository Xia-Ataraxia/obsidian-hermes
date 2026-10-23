import type { BoardKey, EventKey, ProfileKey, ProfileRoster } from "./control-center";
import type { ActivityEdge, ActivityType, ActivityWindow, BoardActivitySnapshot, ProfileActivityPresence, TaskActivity } from "./task-activity";

/** Already parsed reader values. Consumers must update freshness on age/transport failure. */
export type TaskActivityProjectionInput = {
  readonly roster: ProfileRoster;
  readonly selectedBoards: readonly BoardKey[];
  readonly window: ActivityWindow;
  readonly types: readonly ActivityType[];
  readonly snapshots: readonly BoardActivitySnapshot[];
};
export type ActivityProjectionIssueCode = "roster-coverage" | "roster-freshness" | "roster-scope-mismatch"
  | "invalid-window" | "board-scope-mismatch" | "missing-board" | "duplicate-board" | "unexpected-board"
  | "window-mismatch" | "board-coverage" | "board-freshness" | "malformed-rows" | "missing-attribution"
  | "event-scope-mismatch" | "event-window-mismatch" | "conflicting-event" | "unknown-actor";
export type ActivityProjectionIssue = {
  readonly code: ActivityProjectionIssueCode;
  readonly board?: BoardKey;
  readonly event?: EventKey;
};
export type ProfileActivityNode = {
  readonly profile: ProfileKey;
  /** All observed involvement, including self/other actors; edge degree is edges only. */
  readonly presence: ProfileActivityPresence;
  readonly peerDegree: number;
  /** Canvas state: self/external observations never imply a current peer connection or an orphan. */
  readonly peerPresence: ProfileActivityPresence | { readonly kind: "self-or-other-activity"; readonly distinctTaskCount: number; readonly partial: boolean };
  readonly selfEvents: readonly TaskActivity[];
};
export type TaskActivityProjection = {
  readonly nodes: readonly ProfileActivityNode[];
  readonly edges: readonly ActivityEdge[];
  /** Non-current or unknown endpoints. Self events live only in node.selfEvents. */
  readonly otherEvents: readonly TaskActivity[];
  readonly coverage: {
    /** All roster/board collection, scope and row integrity checks succeeded. */
    readonly complete: boolean;
    readonly fresh: boolean;
    readonly attributionComplete: boolean;
    /** Definitive absence requires all three flags; positive evidence survives partial data. */
    readonly issues: readonly ActivityProjectionIssue[];
  };
};
