import { describe, expect, test } from "bun:test";
import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildActivityCommand, parseActivityReadRequest } from "../src/domain/task-activity-command";
import { TaskActivityCollector } from "../src/ui/task-activity-collector";
import { concurrentSnapshot, digest, end, fixture, localCommandRunner, namedBoard, parsed, runSnapshot, sql } from "./task-activity-fixture";
import type { ActivityRunner } from "../src/types/task-activity-read";

describe("bounded activity snapshots", () => {
  test("pairs the actual creator and initial assignee through the collector command surface", async () => {
    // Given
    const source = fixture();
    const collector = new TaskActivityCollector(localCommandRunner);
    try {
      // When
      const result = await collector.read(source.input, new AbortController().signal);
      // Then
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.value.coverage.kind).toBe("complete");
      expect(result.value.activities[0]?.from).toEqual({ kind: "unknown", reason: "unrecognized-actor", recordedLabel: "creator" });
      expect(result.value.activities[0]?.to).toEqual({ kind: "unknown", reason: "unrecognized-actor", recordedLabel: "initial" });
      expect(String(result.value.highWaterEventId?.eventId)).toBe("1");
      expect(result.value.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally { collector.dispose(); source.cleanup(); }
  });

  test("keeps creator and event highwater coherent when a writer commits during the read", async () => {
    // Given
    const source = fixture();
    try {
      // When
      const snapshot = await concurrentSnapshot(source.input, source.db);
      // Then
      expect(snapshot.coverage.kind).toBe("complete");
      expect(String(snapshot.highWaterEventId?.eventId)).toBe("1");
      expect(snapshot.activities).toHaveLength(1);
      expect(snapshot.activities[0]?.from).toEqual({ kind: "unknown", reason: "unrecognized-actor", recordedLabel: "creator" });
      expect(sql(source.db, "SELECT COUNT(*) FROM task_events").trim()).toBe("[[2]]");
    } finally { source.cleanup(); }
  });

  test("leaves database bytes schema and contents unchanged without a writer", () => {
    // Given
    const source = fixture();
    const before = [digest(source.db), sql(source.db, "SELECT * FROM tasks"), sql(source.db, "SELECT * FROM task_events"), sql(source.db, "SELECT sql FROM sqlite_master ORDER BY name")];
    try {
      // When
      const result = runSnapshot(source.input);
      // Then
      expect(result.coverage.kind).toBe("complete");
      expect([digest(source.db), sql(source.db, "SELECT * FROM tasks"), sql(source.db, "SELECT * FROM task_events"), sql(source.db, "SELECT sql FROM sqlite_master ORDER BY name")]).toEqual(before);
    } finally { source.cleanup(); }
  });

  test.each([
    [{ schema: "CREATE TABLE tasks(id TEXT);" }, "unsupported-schema"],
    [{ stamp: "not-a-timestamp" }, "malformed-data"],
    [{ creator: null }, "missing-attribution"],
    [{ kind: "assigned", payload: { assignee: "new" } }, "missing-attribution"],
    [{ payload: "not-an-object" }, "malformed-data"],
  ] as const)("reports incomplete data for %j", (seed, failure) => {
    // Given
    const source = fixture(seed);
    try {
      // When
      const result = runSnapshot(source.input);
      // Then
      expect(result.coverage.kind).toBe("incomplete");
      if (result.coverage.kind !== "incomplete") throw new Error("Expected incomplete");
      expect(result.coverage.reasons).toContain(failure);
    } finally { source.cleanup(); }
  });

  test("reports a missing board without creating its database", () => {
    // Given
    const source = fixture();
    try {
      // When
      const result = runSnapshot({ ...source.input, board: "absent" });
      // Then
      expect(result.coverage).toEqual({ kind: "incomplete", reasons: ["missing-source"] });
      expect(existsSync(join(source.root, "kanban", "boards", "absent", "kanban.db"))).toBe(false);
    } finally { source.cleanup(); }
  });

  test.each(["archived", "stub", "symlink"])("refuses a discovered %s board", (variant) => {
    // Given
    const source = fixture();
    const path = namedBoard(source.root, "other");
    if (variant === "archived") writeFileSync(join(path, "board.json"), '{"archived":true}');
    if (variant === "symlink") { writeFileSync(join(path, "board.json"), '{}'); symlinkSync(source.db, join(path, "kanban.db")); }
    else renameSync(source.db, join(path, "kanban.db"));
    try {
      // When
      const result = runSnapshot({ ...source.input, board: "other" });
      // Then
      expect(result.coverage).toEqual({ kind: "incomplete", reasons: ["missing-source"] });
    } finally { source.cleanup(); }
  });

  test("reads an existing named board only from its contained native path", () => {
    // Given
    const source = fixture();
    const path = namedBoard(source.root, "other");
    writeFileSync(join(path, "board.json"), '{}');
    renameSync(source.db, join(path, "kanban.db"));
    try {
      // When
      const result = runSnapshot({ ...source.input, board: "other" });
      // Then
      expect(result.coverage.kind).toBe("complete");
      expect(String(result.databasePath)).toBe(join(path, "kanban.db"));
      expect(String(result.activities[0]?.event.board)).toBe("other");
    } finally { source.cleanup(); }
  });

  test("applies the UTC half-open window to qualifying timestamps", () => {
    // Given
    const source = fixture({ stamp: (end - 7 * 86_400_000) / 1000 });
    sql(source.db, `INSERT INTO task_events VALUES(2,'t_one','created','{"assignee":"end"}',${end / 1000})`);
    try {
      // When
      const result = runSnapshot({ ...source.input, preset: 7 });
      // Then
      expect(result.activities.map((row) => String(row.event.eventId))).toEqual(["1"]);
      expect(result.qualifyingRowCount).toBe(1);
    } finally { source.cleanup(); }
  });

  test.each([
    ["row-cap", { count: 100001 }],
    ["byte-cap", { count: 40000, creator: "x".repeat(256), payload: { assignee: "y".repeat(256) } }],
  ] as const)("marks %s as incomplete at the production cap", (failure, seed) => {
    // Given
    const source = fixture(seed);
    try {
      // When
      const result = runSnapshot(source.input);
      // Then
      expect(result.coverage.kind).toBe("incomplete");
      if (result.coverage.kind !== "incomplete") throw new Error("Expected incomplete");
      expect(result.coverage.reasons).toContain(failure);
    } finally { source.cleanup(); }
  }, 20_000);

  test("retains the last complete snapshot as stale after a partial refresh", async () => {
    // Given
    const source = fixture();
    const collector = new TaskActivityCollector(localCommandRunner);
    await collector.read(source.input, new AbortController().signal);
    sql(source.db, "INSERT INTO task_events VALUES(2,'t_one','assigned','{\"assignee\":\"later\"}',1999999999)");
    try {
      // When
      const result = await collector.read(source.input, new AbortController().signal);
      // Then
      if (!result.ok) throw new Error(result.code);
      expect(result.value.freshness.kind).toBe("stale");
      expect(result.value.activities).toHaveLength(1);
      expect(String(result.value.highWaterEventId?.eventId)).toBe("1");
      expect(result.value.coverage.kind).toBe("incomplete");
    } finally { collector.dispose(); source.cleanup(); }
  });

  test.each(["../outside", "x;id", "x' OR 1=1", "x\n", "-oProxyCommand=id"])("rejects injection %j before invoking any runner", async (board) => {
    // Given
    let invocations = 0;
    const runner: ActivityRunner = async () => { invocations++; return { ok: false, reason: "transport-failure" }; };
    const collector = new TaskActivityCollector(runner);
    // When
    const result = await collector.read({ connection: "fixture", board, root: "/safe", end }, new AbortController().signal);
    // Then
    expect(result.ok).toBe(false);
    expect(invocations).toBe(0);
    collector.dispose();
  });

  test("defaults to thirty days and carries no arbitrary SQL or database path option", () => {
    // Given
    const request = parsed({ connection: "fixture", board: "default", root: "/safe", end });
    // When
    const command = buildActivityCommand(request);
    // Then
    expect(request.window).toEqual({ preset: 30, start: end - 30 * 86_400_000, end });
    expect(command.kind).toBe("read-board-activity");
    expect(parseActivityReadRequest({ connection: "fixture", board: "default", root: "/safe/../other", end }).ok).toBe(false);
  });
});
