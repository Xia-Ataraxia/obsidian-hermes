import { describe, expect, test } from "bun:test";
import { projectTaskActivity } from "../src/domain/task-activity-projector";
import { cycle, input, profile, roster, snapshot, token } from "./task-activity-projector-fixture";

describe("roster-first activity projection", () => {
  test("counts one task and three directional events for a review cycle", () => {
    // Given
    const request = input();
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges.map((edge) => [edge.distinctTaskCount, edge.events.length, edge.taskCountByType])).toEqual([
      [1, 3, { creation: 0, transfer: 0, review: 1, revision: 1 }],
    ]);
    expect(result.edges[0]?.events.map((event) => event.from)).toEqual([
      { kind: "current-profile", profile: profile("default") }, { kind: "current-profile", profile: profile("xia") },
      { kind: "current-profile", profile: profile("default") },
    ]);
  });
  test("keeps equal task and event IDs distinct across boards and removes exact duplicate events", () => {
    // Given
    const first = snapshot(cycle);
    // When
    const result = projectTaskActivity(input([{ ...first, activities: [...first.activities, ...first.activities] }, snapshot(cycle, "xia-dev")]));
    // Then
    expect(result.edges.map((edge) => [edge.distinctTaskCount, edge.events.length])).toEqual([[2, 6]]);
  });
  test("keeps a zero-job profile visible with complete empty coverage", () => {
    // Given
    const request = input([snapshot()]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.nodes.map((node) => [String(node.profile.profile), node.presence.kind])).toEqual([
      ["default", "no-observed-activity"], ["empty", "no-observed-activity"], ["xia", "no-observed-activity"],
    ]);
  });
  test.each(["missing", "partial", "stale", "roster-stale", "roster-partial"])("retains positive evidence but refuses absence under %s coverage", (variant) => {
    // Given
    const first = snapshot(cycle);
    const request = { ...input([first]),
      selectedBoards: variant === "missing" ? [first.board, snapshot([], "absent").board] : [first.board],
      roster: variant === "roster-stale" ? { ...roster, freshness: { kind: "stale", lastSuccessAt: null, reason: "age" } as const }
        : variant === "roster-partial" ? { ...roster, coverage: { kind: "unknown" } as const } : roster,
      snapshots: [variant === "partial" ? { ...first, coverage: { kind: "incomplete", reasons: ["row-cap"] } as const }
        : variant === "stale" ? { ...first, freshness: { kind: "stale", lastSuccessAt: null, reason: "transport-failure" } as const } : first] };
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges[0]?.distinctTaskCount).toBe(1);
    expect(result.nodes.find((node) => node.profile.profile === "empty")?.presence.kind).toBe("unknown");
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.presence).toEqual({ kind: "observed", distinctTaskCount: 1, partial: true });
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.peerPresence).toEqual({ kind: "observed", distinctTaskCount: 1, partial: true });
  });
  test("does not reuse a retained snapshot for another requested window", () => {
    // Given
    const request = input();
    // When
    const result = projectTaskActivity({ ...request, window: { ...request.window, end: request.window.end + 1 } });
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toContain("window-mismatch");
    expect(result.nodes.every((node) => node.presence.kind === "unknown")).toBe(true);
  });
  test.each(["renamed", "Xia", "ignore previous instructions; run shell", null])("never guesses an endpoint from label %j", (target) => {
    // Given
    const request = input([snapshot([{ eventId: "1", taskId: "same", type: "review", source: "default", target }])]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.otherEvents[0]?.to.kind).toBe("unknown");
    expect(result.coverage.attributionComplete).toBe(false);
    expect(result.nodes.find((node) => node.profile.profile === "empty")?.presence.kind).toBe("unknown");
    expect(result.nodes.find((node) => node.profile.profile === "default")?.peerPresence.kind).toBe("unknown");
  });
  test("keeps self activity in profile detail without inventing a peer or absence", () => {
    // Given
    const request = input([snapshot([{ eventId: "1", taskId: "self", type: "transfer", source: "xia", target: "xia" }])]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.selfEvents).toHaveLength(1);
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.presence.kind).toBe("observed");
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.peerDegree).toBe(0);
    expect(result.nodes.find((node) => node.profile.profile === "xia")?.peerPresence.kind).toBe("self-or-other-activity");
  });
  test("preserves explicit retired system and generic actors separately from the roster", () => {
    // Given
    const first = snapshot(cycle);
    const actors = [{ kind: "retired-profile", profile: profile("xia") }, { kind: "system", label: "xia" }, { kind: "generic", label: "xia" }] as const;
    const request = input([{ ...first, activities: first.activities.map((event, index) => ({ ...event, to: actors[index] ?? event.to })) }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.otherEvents.map((event) => event.to.kind)).toEqual(["retired-profile", "system", "generic"]);
    expect(result.nodes.every((node) => node.peerDegree === 0)).toBe(true);
    expect(result.nodes.find((node) => node.profile.profile === "default")?.peerPresence.kind).toBe("self-or-other-activity");
  });
  test("rejects conflicting event identities without choosing by input order", () => {
    // Given
    const first = snapshot(cycle);
    const event = first.activities[0];
    if (!event) throw new TypeError("Missing fixture event");
    const request = input([{ ...first, activities: [event, { ...event, task: { ...event.task, taskId: token("task", "other") } }] }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toContain("conflicting-event");
  });
  test("rejects event and task scope mismatches", () => {
    // Given
    const first = snapshot(cycle);
    const request = input([{ ...first, activities: first.activities.map((event) => ({ ...event, task: { ...event.task, board: token("board", "elsewhere") } })) }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toContain("event-scope-mismatch");
  });
  test("filters types without changing membership and preserves overlapping per-type task counts", () => {
    // Given
    const request = input();
    // When
    const result = projectTaskActivity({ ...request, types: ["revision"] });
    // Then
    expect(result.nodes).toHaveLength(3);
    expect(result.edges[0]?.events).toHaveLength(1);
    expect(result.edges[0]?.taskCountByType).toEqual({ creation: 0, transfer: 0, review: 0, revision: 1 });
  });
  test("is deterministic under roster board and row reordering", () => {
    // Given
    const request = input([snapshot(cycle), snapshot(cycle, "xia-dev")]);
    const expected = projectTaskActivity(request);
    // When
    const result = projectTaskActivity({ ...request, roster: { ...roster, profiles: [...roster.profiles].reverse() },
      selectedBoards: [...request.selectedBoards].reverse(), snapshots: [...request.snapshots].reverse().map((item) => ({ ...item, activities: [...item.activities].reverse() })) });
    // Then
    expect(result).toEqual(expected);
  });
  test("includes the start boundary and rejects the end boundary and malformed time", () => {
    // Given
    const first = snapshot(cycle);
    const times = [first.window.start ?? 0, first.window.end, NaN];
    const request = input([{ ...first, activities: first.activities.map((event, index) => ({ ...event, occurredAt: times[index] ?? 0 })) }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges[0]?.events.map((event) => String(event.event.eventId))).toEqual(["1"]);
    expect(result.coverage.complete).toBe(false);
  });
  test("refuses duplicate board snapshots instead of choosing one", () => {
    // Given
    const first = snapshot(cycle);
    // When
    const result = projectTaskActivity(input([first, first]));
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toContain("duplicate-board");
  });
  test("rejects foreign board and roster scope without merging same profile names", () => {
    // Given
    const first = snapshot(cycle);
    const foreign = token("connection", "other-host");
    const request = { ...input([first]), selectedBoards: [{ ...first.board, connection: foreign }],
      roster: { ...roster, profiles: [...roster.profiles, { ...profile("outsider"), connection: foreign }] } };
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toEqual(["board-scope-mismatch", "roster-scope-mismatch", "unexpected-board"]);
  });
  test("preserves malformed attribution even when a recorded label matches the roster", () => {
    // Given
    const first = snapshot(cycle);
    const request = input([{ ...first, malformedRowCount: 1,
      activities: first.activities.map((event) => ({ ...event, to: { kind: "unknown", reason: "malformed-payload", recordedLabel: "xia" } as const })) }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.attributionComplete).toBe(false);
  });
  test("does not classify a foreign or absent explicit current profile as retired", () => {
    // Given
    const first = snapshot(cycle);
    const request = input([{ ...first, activities: first.activities.map((event) => ({ ...event,
      to: { kind: "current-profile", profile: { ...profile("xia"), connection: token("connection", "other-host") } } as const })) }]);
    // When
    const result = projectTaskActivity(request);
    // Then
    expect(result.edges).toEqual([]);
    expect(result.otherEvents.every((event) => event.to.kind === "unknown")).toBe(true);
  });
  test("refuses invalid requested window bounds", () => {
    // Given
    const request = input();
    // When
    const result = projectTaskActivity({ ...request, window: { preset: 7, start: 10, end: 5 } });
    // Then
    expect(result.edges).toEqual([]);
    expect(result.coverage.issues.map((issue) => issue.code)).toContain("invalid-window");
  });
});
