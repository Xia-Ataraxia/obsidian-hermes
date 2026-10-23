import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskActivityCollector } from "../src/ui/task-activity-collector";
import { activityProcessRunner } from "../src/ui/task-activity-runner";
import { buildActivityCommand } from "../src/domain/task-activity-command";
import { concurrentSnapshot, end, fixture, parsed, python, rawSnapshot } from "./task-activity-fixture";
import { parseActivityResponse } from "../src/domain/task-activity-response";
import type { ActivityRunner } from "../src/types/task-activity-read";

describe("activity lifecycle bounds", () => {
  test("interrupts a blocked board read at the real fifteen-second deadline", async () => {
    // Given
    const source = fixture();
    const started = performance.now();
    try {
      // When
      const snapshot = await concurrentSnapshot(source.input, source.db, true);
      // Then
      expect(snapshot.coverage).toEqual({ kind: "incomplete", reasons: ["deadline"] });
      expect(performance.now() - started).toBeLessThan(18_000);
    } finally { source.cleanup(); }
  }, 20_000);

  test("allows at most two boards in flight and aborts queued work on disposal", async () => {
    // Given
    let started = 0;
    let active = 0;
    let peak = 0;
    let bothStarted: () => void = () => { throw new Error("Missing readiness resolver"); };
    const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
    const runner: ActivityRunner = (_command, signal) => new Promise((resolve) => {
      started++; active++; peak = Math.max(peak, active);
      signal.addEventListener("abort", () => { active--; resolve({ ok: false, reason: "transport-failure" }); }, { once: true });
      if (started === 2) bothStarted();
    });
    const collector = new TaskActivityCollector(runner);
    const requests = ["one", "two", "three"].map((board) => collector.read({ connection: "fixture", root: "/safe", board, end }, new AbortController().signal));
    await ready;
    // When
    collector.dispose();
    const results = await Promise.all(requests);
    // Then
    expect(started).toBe(2);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(results.every((result) => result.ok && result.value.coverage.kind === "incomplete")).toBe(true);
  });

  test("kills and reaps an active transport when aborted", async () => {
    // Given
    const source = fixture();
    const bin = join(source.root, "bin");
    mkdirSync(bin);
    const ssh = join(bin, "ssh");
    writeFileSync(ssh, `#!${python}\nimport signal\nsignal.pause()\n`);
    chmodSync(ssh, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    const controller = new AbortController();
    const started = performance.now();
    try {
      const pending = activityProcessRunner(buildActivityCommand(parsed(source.input)), controller.signal);
      // When
      controller.abort();
      const result = await pending;
      // Then
      expect(result).toEqual({ ok: false, reason: "transport-failure" });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      source.cleanup();
    }
  });

  test.each([
    ["assigned", { from: "first", assignee: "second", body: "PRIVATE_SENTINEL" }, "transfer", "first", "second"],
    ["review_requested", { implementer: "worker", reviewer: "reviewer", comments: "PRIVATE_SENTINEL" }, "review", "worker", "reviewer"],
    ["changes_requested", { implementer: "worker", reviewer: "reviewer", prompt: "PRIVATE_SENTINEL" }, "revision", "reviewer", "worker"],
  ] as const)("preserves only structural %s provenance", (kind, payload, type, from, to) => {
    // Given
    const source = fixture({ kind, payload });
    try {
      // When
      const raw = rawSnapshot(source.input);
      const snapshot = parseActivityResponse(raw, parsed(source.input));
      // Then
      expect(snapshot.activities[0]).toMatchObject({ type, from: { recordedLabel: from }, to: { recordedLabel: to } });
      expect(raw).not.toContain("PRIVATE_SENTINEL");
    } finally { source.cleanup(); }
  });
});
