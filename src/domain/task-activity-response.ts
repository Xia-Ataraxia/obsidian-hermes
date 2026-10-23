import type { IncompleteReason } from "../types/control-center";
import { ACTIVITY_LIMITS } from "../types/task-activity";
import type { ActivityActor, ActivityType, BoardActivitySnapshot, TaskActivity } from "../types/task-activity";
import type { ActivityReadRequest } from "../types/task-activity-read";
import { parseControlCenterPath, parseControlCenterToken } from "./control-center-validation";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function reason(value: unknown): value is IncompleteReason {
  return value === "missing-source" || value === "unsupported-schema" || value === "malformed-data" || value === "missing-attribution"
    || value === "row-cap" || value === "byte-cap" || value === "deadline" || value === "transport-failure";
}
function activityType(value: unknown): value is ActivityType {
  return value === "creation" || value === "transfer" || value === "review" || value === "revision";
}
function label(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && [...value].length <= 256 && !/[\u0000-\u001f\u007f]/.test(value));
}
function actor(value: string | null, absent: "missing-creator" | "missing-endpoint" | "malformed-payload"): ActivityActor {
  return value === null ? { kind: "unknown", reason: absent } : { kind: "unknown", reason: "unrecognized-actor", recordedLabel: value };
}

export function failedActivitySnapshot(request: ActivityReadRequest, failure: IncompleteReason): BoardActivitySnapshot {
  const path = parseControlCenterPath(`${request.root}/${request.board.board === "default" ? "kanban.db" : `kanban/boards/${request.board.board}/kanban.db`}`, request.root);
  if (!path.ok) throw new TypeError("Validated activity request produced an invalid path");
  return { board: request.board, databasePath: path.value, window: request.window, snapshotAt: request.window.end,
    schemaFingerprint: "", highWaterEventId: null, qualifyingRowCount: 0, malformedRowCount: 0, missingAttributionCount: 0,
    coverage: { kind: "incomplete", reasons: [failure] }, freshness: { kind: "unknown", lastSuccessAt: null }, activities: [] };
}

export function parseActivityResponse(raw: string, request: ActivityReadRequest): BoardActivitySnapshot {
  const invalid = () => failedActivitySnapshot(request, "malformed-data");
  if (Buffer.byteLength(raw, "utf8") > ACTIVITY_LIMITS.bytesPerBoard) return failedActivitySnapshot(request, "byte-cap");
  let data: unknown;
  try { data = JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return invalid(); throw error; }
  if (!record(data) || data.board !== request.board.board || !record(data.window)
    || data.window.preset !== request.window.preset || data.window.start !== request.window.start || data.window.end !== request.window.end
    || !count(data.snapshotAt) || !count(data.qualifyingRowCount) || !count(data.malformedRowCount) || !count(data.missingAttributionCount)
    || typeof data.schemaFingerprint !== "string" || !/^(?:[a-f0-9]{64})?$/.test(data.schemaFingerprint)
    || !Array.isArray(data.rows) || data.rows.length > ACTIVITY_LIMITS.rowsPerBoard || !Array.isArray(data.reasons)) return invalid();
  const expected = failedActivitySnapshot(request, "malformed-data");
  if (data.databasePath !== expected.databasePath) return invalid();
  const reasons: IncompleteReason[] = [];
  for (const item of data.reasons) { if (!reason(item)) return invalid(); if (!reasons.includes(item)) reasons.push(item); }
  const highwater = data.highWaterEventId === null ? null : parseControlCenterToken("event", data.highWaterEventId);
  if (highwater !== null && !highwater.ok) return invalid();
  const activities: TaskActivity[] = [];
  let previousId = 0;
  for (const row of data.rows) {
    if (!record(row) || !activityType(row.type) || !label(row.source) || !label(row.target) || typeof row.malformed !== "boolean"
      || typeof row.occurredAt !== "number" || !Number.isFinite(row.occurredAt) || row.occurredAt >= request.window.end
      || (request.window.start !== null && row.occurredAt < request.window.start)) return invalid();
    const event = parseControlCenterToken("event", row.eventId);
    const task = parseControlCenterToken("task", row.taskId);
    if (!event.ok || !task.ok || highwater === null || !highwater.ok || Number(event.value) > Number(highwater.value) || Number(event.value) <= previousId) return invalid();
    previousId = Number(event.value);
    const scope = { connection: request.board.connection, board: request.board.board };
    activities.push({ event: { kind: "event", ...scope, eventId: event.value }, task: { kind: "task", ...scope, taskId: task.value },
      type: row.type, occurredAt: row.occurredAt,
      from: actor(row.source, row.type === "creation" ? "missing-creator" : row.malformed ? "malformed-payload" : "missing-endpoint"),
      to: actor(row.target, row.malformed ? "malformed-payload" : "missing-endpoint") });
  }
  const missing = activities.filter((item) => (item.from.kind === "unknown" && item.from.recordedLabel === undefined) || (item.to.kind === "unknown" && item.to.recordedLabel === undefined)).length;
  if (data.qualifyingRowCount < activities.length || data.missingAttributionCount < missing) return invalid();
  if (data.malformedRowCount > 0 && !reasons.includes("malformed-data")) return invalid();
  if (data.missingAttributionCount > 0 && !reasons.includes("missing-attribution")) return invalid();
  const firstReason = reasons[0];
  if (firstReason === undefined && (data.schemaFingerprint === "" || data.qualifyingRowCount !== activities.length)) return invalid();
  return { ...expected, snapshotAt: data.snapshotAt, schemaFingerprint: data.schemaFingerprint,
    highWaterEventId: highwater !== null && highwater.ok ? { kind: "event", connection: request.board.connection, board: request.board.board, eventId: highwater.value } : null,
    qualifyingRowCount: data.qualifyingRowCount, malformedRowCount: data.malformedRowCount, missingAttributionCount: data.missingAttributionCount,
    coverage: firstReason === undefined ? { kind: "complete" } : { kind: "incomplete", reasons: [firstReason, ...reasons.slice(1)] },
    freshness: { kind: "fresh", lastSuccessAt: data.snapshotAt }, activities };
}
