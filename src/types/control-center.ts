/** Semantic tokens are produced only by the control-center boundary parsers. */
declare const tokenBrand: unique symbol;
export type TokenKind = "connection" | "profile" | "board" | "task" | "event" | "job" | "path";
export type ControlCenterToken<K extends TokenKind> = string & { readonly [tokenBrand]: K };
export type ConnectionId = ControlCenterToken<"connection">;
export type ProfileId = ControlCenterToken<"profile">;
export type BoardId = ControlCenterToken<"board">;
export type TaskId = ControlCenterToken<"task">;
export type EventId = ControlCenterToken<"event">;
export type JobId = ControlCenterToken<"job">;
export type AbsolutePath = ControlCenterToken<"path">;

export type ConnectionKey = { readonly kind: "connection"; readonly connection: ConnectionId };
export type ProfileKey = { readonly kind: "profile"; readonly connection: ConnectionId; readonly profile: ProfileId };
export type BoardKey = { readonly kind: "board"; readonly connection: ConnectionId; readonly board: BoardId };
export type TaskKey = { readonly kind: "task"; readonly connection: ConnectionId; readonly board: BoardId; readonly taskId: TaskId };
export type EventKey = { readonly kind: "event"; readonly connection: ConnectionId; readonly board: BoardId; readonly eventId: EventId };
/** Authored execution profile never replaces the storage owner in a job's identity. */
export type JobKey = { readonly kind: "job"; readonly connection: ConnectionId; readonly storageOwnerProfile: ProfileId; readonly jobId: JobId };
export type ScopedIdentity = ConnectionKey | ProfileKey | BoardKey | TaskKey | EventKey | JobKey;

export type BoundaryFailure = "invalid-shape" | "invalid-token" | "invalid-json" | "too-large" | "path-escape" | "unsupported-capability";
export type BoundaryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BoundaryFailure };

/** Scope plus generation belongs to each request; alias replacement increments generation. */
export type RequestScope = {
  readonly entity: ScopedIdentity;
  readonly connectionGeneration: number;
  readonly requestGeneration: number;
};
export type Freshness =
  | { readonly kind: "unknown"; readonly lastSuccessAt: null }
  | { readonly kind: "fresh"; readonly lastSuccessAt: number }
  | { readonly kind: "stale"; readonly lastSuccessAt: number | null; readonly reason: "age" | "transport-failure" };
export type IncompleteReason = "missing-source" | "unsupported-schema" | "malformed-data" | "missing-attribution" | "row-cap" | "byte-cap" | "deadline" | "transport-failure";
export type ReadCoverage =
  | { readonly kind: "complete" }
  | { readonly kind: "incomplete"; readonly reasons: readonly [IncompleteReason, ...IncompleteReason[]] }
  | { readonly kind: "unknown" };
export type ProfileRoster = {
  readonly connection: ConnectionId;
  /** Includes valid zero-cron profiles; excludes native tombstones and markerless shells. */
  readonly profiles: readonly ProfileKey[];
  readonly coverage: ReadCoverage;
  readonly freshness: Freshness;
};

export const MANAGEMENT_PROFILE = "default";
export const CONTROL_CENTER_TIMING = { staleAfterMs: 30_000, pollMs: 15_000, coalesceMs: 250 } as const;

const CREATE_FIELDS = ["title", "body", "assignee", "tenant", "priority", "workspace_kind", "workspace_path", "parents", "triage", "idempotency_key", "max_runtime_seconds", "skills", "goal_mode", "goal_max_turns", "model_override", "provider_override", "reasoning_effort", "project_id"] as const;
const UPDATE_FIELDS = ["status", "assignee", "priority", "title", "body", "result", "block_reason", "summary", "metadata", "model_override", "provider_override", "clear_model_override", "reasoning_effort", "clear_reasoning_effort"] as const;
const BULK_FIELDS = ["ids", "status", "assignee", "priority", "result", "summary", "metadata", "model_override", "provider_override", "clear_model_override", "reasoning_effort", "clear_reasoning_effort"] as const;

export type RouteCapability = {
  readonly scope: "board" | "management";
  readonly access: "read" | "write" | "subscribe";
  readonly bodyFields: readonly string[];
};
const BOARD_READ = { scope: "board", access: "read", bodyFields: [] } as const;
const MANAGEMENT_READ = { scope: "management", access: "read", bodyFields: [] } as const;
/** Closed native route templates, relative to /api/plugins/kanban; all pin profile=default.
 * Board routes also require explicit board. Field allowlists do not authorize arbitrary values:
 * later write validation must enforce native statuses, preconditions and per-ID read-back.
 */
export const ROUTE_CAPABILITIES = {
  "GET /board": BOARD_READ,
  "GET /tasks/{task_id}": BOARD_READ,
  "POST /tasks": { scope: "board", access: "write", bodyFields: CREATE_FIELDS },
  "GET /tasks/{task_id}/attachments": BOARD_READ,
  "GET /attachments/{attachment_id}": BOARD_READ,
  "PATCH /tasks/{task_id}": { scope: "board", access: "write", bodyFields: UPDATE_FIELDS },
  "POST /tasks/{task_id}/comments": { scope: "board", access: "write", bodyFields: ["body", "author"] },
  "POST /links": { scope: "board", access: "write", bodyFields: ["parent_id", "child_id"] },
  "DELETE /links": { scope: "board", access: "write", bodyFields: [] },
  "POST /tasks/bulk": { scope: "board", access: "write", bodyFields: BULK_FIELDS },
  "GET /diagnostics": BOARD_READ,
  "GET /runs/{run_id}": BOARD_READ,
  "GET /config": MANAGEMENT_READ,
  "GET /home-channels": BOARD_READ,
  "GET /stats": BOARD_READ,
  "GET /assignees": BOARD_READ,
  "GET /tasks/{task_id}/log": BOARD_READ,
  "GET /model-options": MANAGEMENT_READ,
  "GET /boards": MANAGEMENT_READ,
  "GET /profiles": MANAGEMENT_READ,
  "GET /workflow": MANAGEMENT_READ,
  "GET /orchestration": MANAGEMENT_READ,
  "WEBSOCKET /events": { scope: "board", access: "subscribe", bodyFields: [] },
} as const satisfies Readonly<Record<string, RouteCapability>>;
export type RouteCapabilityName = keyof typeof ROUTE_CAPABILITIES;
