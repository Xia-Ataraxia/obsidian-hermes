import { parseControlCenterToken } from "../src/domain/control-center-validation";
import { parseActivityReadRequest } from "../src/domain/task-activity-command";
import { parseActivityResponse } from "../src/domain/task-activity-response";
import type { ProfileKey, ProfileRoster, TokenKind } from "../src/types/control-center";
import type { ActivityType, BoardActivitySnapshot } from "../src/types/task-activity";

export function token<K extends TokenKind>(kind: K, value: string) {
  const result = parseControlCenterToken(kind, value);
  if (!result.ok) throw new TypeError(result.code);
  return result.value;
}
export const connection = token("connection", "fixture");
export const profile = (name: string): ProfileKey => ({ kind: "profile", connection, profile: token("profile", name) });
export const roster: ProfileRoster = { connection, profiles: [profile("default"), profile("xia"), profile("empty")],
  coverage: { kind: "complete" }, freshness: { kind: "fresh", lastSuccessAt: 2_000_000_000_000 } };
export type Row = { readonly eventId: string; readonly taskId: string; readonly type: ActivityType;
  readonly source: string | null; readonly target: string | null; readonly occurredAt?: number; readonly malformed?: boolean };
export function snapshot(rows: readonly Row[] = [], board = "default"): BoardActivitySnapshot {
  const request = parseActivityReadRequest({ connection, board, root: "/fixture", end: 2_000_000_000_000, preset: 7 });
  if (!request.ok) throw new TypeError(request.code);
  const missing = rows.filter((row) => row.source === null || row.target === null).length;
  const malformed = rows.filter((row) => row.malformed).length;
  return parseActivityResponse(JSON.stringify({ board, databasePath: board === "default" ? "/fixture/kanban.db" : `/fixture/kanban/boards/${board}/kanban.db`,
    window: request.value.window, snapshotAt: request.value.window.end, schemaFingerprint: "a".repeat(64),
    highWaterEventId: rows.at(-1)?.eventId ?? null, qualifyingRowCount: rows.length, malformedRowCount: malformed,
    missingAttributionCount: missing, reasons: [...(missing ? ["missing-attribution"] : []), ...(malformed ? ["malformed-data"] : [])],
    rows: rows.map((row) => ({ occurredAt: request.value.window.end - 1000, malformed: false, ...row })) }), request.value);
}
export const cycle: readonly Row[] = [
  { eventId: "1", taskId: "same", type: "review", source: "default", target: "xia" },
  { eventId: "2", taskId: "same", type: "revision", source: "xia", target: "default" },
  { eventId: "3", taskId: "same", type: "review", source: "default", target: "xia" },
];
export function input(snapshots: readonly BoardActivitySnapshot[] = [snapshot(cycle)]) {
  return { roster, selectedBoards: snapshots.map((item) => item.board), window: snapshot().window,
    types: ["creation", "transfer", "review", "revision"] as const, snapshots };
}
