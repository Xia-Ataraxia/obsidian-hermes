import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseControlCenterPath, parseControlCenterToken, parseRouteCapability, parseScopedIdentity, parseScopedKey, readFreshness, sameRequestScope, serializeScopedKey } from "../src/domain/control-center-validation";
import { parseNativeContracts } from "../src/domain/native-contracts";
import { ROUTE_CAPABILITIES } from "../src/types/control-center";
import type { ScopedIdentity, TokenKind } from "../src/types/control-center";

function identity(raw: unknown): ScopedIdentity {
  const result = parseScopedIdentity(raw);
  if (!result.ok) throw new TypeError(`Invalid test identity: ${result.code}`);
  return result.value;
}
const connection = "m1-pro-file";
const task = (board: string) => identity({ kind: "task", connection, board, taskId: "same-id" });

describe("scoped identity boundary", () => {
  test("round-trips every identity kind when scope is valid", () => {
    // Given
    const values = [
      { kind: "connection", connection }, { kind: "profile", connection, profile: "xia" },
      { kind: "board", connection, board: "xia-dev" },
      { kind: "task", connection, board: "xia-dev", taskId: "same-id" },
      { kind: "event", connection, board: "xia-dev", eventId: "42" },
      { kind: "job", connection, storageOwnerProfile: "xia", jobId: "same-id" },
    ];
    // When
    const results: readonly unknown[] = values.map((value) => parseScopedKey(serializeScopedKey(identity(value))));
    // Then
    expect(results).toEqual(values.map((value) => ({ ok: true, value })));
  });

  test("keeps duplicate task, event and job IDs distinct across boards, owners and connections", () => {
    // Given
    const values = [task("default"), task("xia-dev"),
      identity({ kind: "task", connection: "other-host", board: "default", taskId: "same-id" }),
      ...["default", "xia-dev"].map((board) => identity({ kind: "event", connection, board, eventId: "42" })),
      ...["default", "xia"].map((storageOwnerProfile) => identity({ kind: "job", connection, storageOwnerProfile, jobId: "same-id" })),
    ];
    // When
    const keys = new Set(values.map(serializeScopedKey));
    // Then
    expect(keys.size).toBe(values.length);
  });

  test("retains canonical scope when caller input is reordered or mutated", () => {
    // Given
    const raw = { taskId: "same-id", board: "default", connection, kind: "task" };
    const parsed = identity(raw);
    // When
    raw.board = "xia-dev";
    // Then
    expect(serializeScopedKey(parsed)).toBe(serializeScopedKey(task("default")));
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("rejects malformed, incomplete, extra-field and overlong serialized identities", () => {
    // Given
    const values: readonly unknown[] = [null, [], {}, { kind: "task", connection, taskId: "x" },
      { kind: "task", connection, board: "default", taskId: "x", command: "id" },
      { kind: "job", connection, profile: "xia", jobId: "x" }, { kind: "unknown", connection }];
    // When
    const results = values.map(parseScopedIdentity);
    const serialized = ["{", "null", "[]", "x".repeat(1025), 42].map(parseScopedKey);
    // Then
    expect([...results, ...serialized].every((result) => !result.ok)).toBe(true);
  });

  test("rejects traversal, controls and injection tokens before an identity can be transported", () => {
    // Given
    const invalid = ["", ".", "..", "../etc", "a/b", "-oProxyCommand=id", "a;b", "$(id)", "`id`", "a' OR 1=1", "a\n", "a\u0000", "a\u007f", "a%2fb", "a?b", "a#b", "a".repeat(65)];
    const kinds: readonly TokenKind[] = ["connection", "profile", "board", "task", "event", "job"];
    // When
    const results = kinds.flatMap((kind) => invalid.map((value) => parseControlCenterToken(kind, value)));
    // Then
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  test("enforces native board/profile case and safe event integer boundaries", () => {
    // Given
    const cases: readonly [TokenKind, unknown, boolean][] = [
      ["board", "xia-dev_2", true], ["board", "Xia", false], ["profile", "all", true],
      ["profile", "_retired", false], ["job", "ABC_123", true], ["task", "a".repeat(64), true],
      ["event", "9007199254740991", true], ["event", "9007199254740992", false],
      ["event", "01", false], ["event", "0", false], ["event", 42, false],
    ];
    // When
    const results = cases.map(([kind, value]) => parseControlCenterToken(kind, value).ok);
    // Then
    expect(results).toEqual(cases.map(([, , accepted]) => accepted));
  });

  test("accepts bounded contained paths and rejects traversal, sibling roots and shell syntax", () => {
    // Given
    const root = "/Users/beomsu/.hermes";
    const paths = [`${root}/boards/xia-dev.db`, `${root}/한글 폴더/state.db`, `${root}/../etc`,
      `${root}2/state.db`, `${root}//state.db`, `${root}/a\n.db`, `${root}/$(id).db`,
      `${root}/a;b.db`, `${root}/${"x".repeat(4096)}`, "relative.db"];
    // When
    const results = paths.map((path) => parseControlCenterPath(path, root).ok);
    // Then
    expect(results).toEqual([true, true, false, false, false, false, false, false, false, false]);
  });

  test("rejects late responses after entity, request or connection generation changes", () => {
    // Given
    const current = { entity: task("default"), connectionGeneration: 1, requestGeneration: 2 };
    const candidates = [current, { ...current, entity: task("xia-dev") },
      { ...current, connectionGeneration: 0 }, { ...current, requestGeneration: 1 },
      { ...current, requestGeneration: NaN }];
    // When
    const results = candidates.map((candidate) => sameRequestScope(current, candidate));
    // Then
    expect(results).toEqual([true, false, false, false, false]);
  });
});

describe("coverage freshness and route capability boundaries", () => {
  test("marks unknown, aged and transport-failed reads without a wall clock", () => {
    // Given
    const cases: readonly [number | null, number, boolean][] = [
      [null, 50_000, false], [20_001, 50_000, false], [20_000, 50_000, false],
      [49_999, 50_000, true], [null, 50_000, true], [50_001, 50_000, false], [NaN, 50_000, false],
    ];
    // When
    const results = cases.map(([last, now, failed]) => readFreshness(last, now, failed).kind);
    // Then
    expect(results).toEqual(["unknown", "fresh", "stale", "stale", "stale", "unknown", "unknown"]);
  });

  test("exposes exactly the supported native routes and allowed body fields", () => {
    // Given
    const capture = parseNativeContracts(readFileSync(new URL("./fixtures/hermes-contracts.json", import.meta.url), "utf8"));
    if (capture.status !== "supported") throw new TypeError(capture.status);
    // When
    const results = capture.value.capabilities.map((route) => ({ route,
      parsed: parseRouteCapability(`${route.method} ${route.path.replace("/api/plugins/kanban", "")}`) }));
    // Then
    expect(results.filter(({ parsed }) => parsed.ok)).toHaveLength(Object.keys(ROUTE_CAPABILITIES).length);
    for (const { route, parsed } of results) {
      expect(parsed.ok).toBe(route.disposition !== "excluded");
      if (parsed.ok) {
        const fields: readonly string[] = ROUTE_CAPABILITIES[parsed.value].bodyFields;
        expect(fields).toEqual(route.allowedBodyFields);
      }
    }
  });

  test("requires board scope for board readers and socket; management scope for global readers", () => {
    // Given
    const names = ["GET /assignees", "GET /home-channels", "WEBSOCKET /events", "GET /orchestration", "GET /profiles"] as const;
    // When
    const scopes = names.map((name) => ROUTE_CAPABILITIES[name].scope);
    // Then
    expect(scopes).toEqual(["board", "board", "board", "management", "management"]);
  });

  test("rejects arbitrary origins, query strings, unknown routes and inherited object keys", () => {
    // Given
    const requests = ["GET https://evil.example/board", "GET /board?profile=all", "POST /dispatch",
      "POST /tasks/x/reclaim", "DELETE /tasks/{task_id}", "GET /../board", "__proto__", "toString", null];
    // When
    const results = requests.map(parseRouteCapability);
    // Then
    expect(results.every((result) => !result.ok)).toBe(true);
  });
});
