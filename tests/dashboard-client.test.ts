import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DashboardClientError } from "../src/types/dashboard-client";
import type { DashboardEventBatch } from "../src/types/dashboard-client";
import { parseDashboardTask } from "../src/ui/dashboard-response";
import { DashboardSession } from "../src/ui/dashboard-auth";
import { faultFixture, fixtureClient, gate, lifecycle } from "./dashboard-client-fixture";

describe("pinned native dashboard", () => {
  beforeAll(() => lifecycle("start"), 60_000);
  afterAll(() => lifecycle("stop"), 60_000);
  test("authenticates HTTP and WS then creates and edits a synthetic title", async () => {
    const { client } = fixtureClient();
    const events = gate<DashboardEventBatch>();
    try {
      await client.ready();
      expect(Array.isArray((await client.read({ route: "GET /boards" }))["boards"])).toBe(true);
      expect(Array.isArray((await client.read({ route: "GET /workflow" }))["columns"])).toBe(true);
      expect(Array.isArray((await client.read({ route: "GET /board", board: "default" }))["columns"])).toBe(true);
      const socket = await client.subscribe({ board: "default", onEvents: batch => events.resolve(batch) });
      const created = await client.mutate({ route: "POST /tasks", board: "default", body: { title: "Task7 synthetic", triage: true } });
      if (created.kind !== "applied") throw new TypeError("Create failed");
      const task = parseDashboardTask(created.response);
      const edited = await client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: task.id, body: { title: "Task7 synthetic edited" } });
      expect(edited.kind).toBe("applied");
      expect((await client.task("default", task.id)).title).toBe("Task7 synthetic edited");
      expect((await events.promise).events.length).toBeGreaterThan(0);
      socket.close();
      expect(await socket.closed).toBeNull();
    } finally { client.dispose(); }
  }, 15_000);
  test("recovers expired read authentication with a fresh bootstrap", async () => {
    const { client } = fixtureClient();
    try { await client.ready(); await lifecycle("control", ["--scenario", "expire-auth"]); expect((await client.task("default", "repeat-001")).id).toBe("repeat-001"); }
    finally { client.dispose(); }
  });
  test("rejects an unknown board with native status", async () => {
    const { client } = fixtureClient();
    try { await expect(client.task("missing", "repeat-001")).rejects.toMatchObject({ code: "native-error" }); }
    finally { client.dispose(); }
  });
});

describe("bounded dashboard fault transport", () => {
  test("reconciles partial PATCH once while retaining requested fields", async () => {
    const fixture = faultFixture();
    fixture.setMode("partial");
    try {
      const result = await fixture.client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { title: "Persisted synthetic", assignee: "default" } });
      expect(result.kind).toBe("uncertain");
      if (result.kind !== "uncertain") throw new TypeError("Expected uncertainty");
      expect(result.actual?.title).toBe("Persisted synthetic");
      expect(result.actual?.assignee).toBe("xia");
      expect(result.draft).toEqual({ title: "Persisted synthetic", assignee: "default" });
      expect(result.fields.map(field => field.outcome)).toEqual(["matches", "differs"]);
      expect(fixture.counts().writes).toBe(1);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("never replays a write after an authentication failure", async () => {
    const fixture = faultFixture(); fixture.setMode("write-expired");
    try {
      const result = await fixture.client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { title: "Ambiguous synthetic" } });
      expect(result.kind).toBe("uncertain"); expect(fixture.counts()).toEqual({ writes: 1, bootstraps: 2 });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test.each(["gated", "status-gated", "protected-denied", "invalid-bootstrap"])("returns original dashboard fallback when %s", async mode => {
    const fixture = faultFixture(); fixture.setMode(mode);
    try { await expect(fixture.client.ready()).rejects.toMatchObject({ code: "authentication-required", originalDashboard: fixture.connection.baseUrl + "/" }); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test.each(["cap", "chunk-cap", "malformed"])("rejects %s responses", async mode => {
    const fixture = faultFixture();
    try { await fixture.client.ready(); fixture.setMode(mode); await expect(fixture.client.task("default", "repeat-001")).rejects.toMatchObject({ code: mode === "malformed" ? "malformed-response" : "response-cap" }); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("denies direct administrative invocations before any request", async () => {
    const fixture = faultFixture();
    try {
      for (const route of ["POST /dispatch", "DELETE /tasks/{task_id}", "PUT /orchestration", "POST /boards/default/switch", "GET https://example.com"])
        await expect(Reflect.apply(fixture.client.mutate, fixture.client, [{ route, board: "default", id: "repeat-001", body: {} }])).rejects.toMatchObject({ code: "unsupported-operation" });
      expect(fixture.requests).toHaveLength(0);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("cancels a hung HTTP request on actual request arrival", async () => {
    const fixture = faultFixture();
    try {
      await fixture.client.ready(); fixture.setMode("hang");
      const pending = fixture.client.task("default", "repeat-001").catch((error: unknown) => error);
      await fixture.seen.promise; fixture.controller.abort();
      expect(await pending).toMatchObject({ code: "cancelled" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("rejects stale request generations before transport", async () => {
    const fixture = faultFixture();
    try { await expect(fixture.client.task("default", "repeat-001", { isCurrent: () => false })).rejects.toMatchObject({ code: "stale-generation" }); expect(fixture.requests).toHaveLength(0); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("preserves actionable conflicts while removing token and markup", async () => {
    const fixture = faultFixture();
    try {
      await fixture.client.ready(); fixture.setMode("conflict");
      const result = await fixture.client.task("default", "repeat-001").catch((error: unknown) => error);
      expect(result).toBeInstanceOf(DashboardClientError);
      if (!(result instanceof DashboardClientError)) throw new TypeError("Expected typed error");
      expect(result.status).toBe(409); expect(result.detail).toContain("Running task reassignment refused"); expect(result.detail).not.toMatch(/[a-f0-9]{64}|<script>/);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("rejects a late successful response after request generation changes", async () => {
    const fixture = faultFixture(); let current = true;
    try {
      await fixture.client.ready(); fixture.setMode("late");
      const pending = fixture.client.task("default", "repeat-001", { isCurrent: () => current }).catch((error: unknown) => error);
      await fixture.seen.promise; current = false; fixture.release.resolve();
      expect(await pending).toMatchObject({ code: "stale-generation" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("terminates a hung request at the bounded deadline", async () => {
    const fixture = faultFixture();
    try {
      await fixture.client.ready(); fixture.setMode("hang");
      await expect(fixture.client.task("default", "repeat-001")).rejects.toMatchObject({ code: "timeout" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  }, 15_000);
  test("rejects over-cap binary attachment bytes", async () => {
    const fixture = faultFixture();
    try { await fixture.client.ready(); fixture.setMode("cap"); await expect(fixture.client.attachment("default", "1")).rejects.toMatchObject({ code: "response-cap" }); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("closes malformed socket frames without delivering an event", async () => {
    const fixture = faultFixture(); fixture.setMode("socket-malformed"); let delivered = 0;
    try {
      const socket = await fixture.client.subscribe({ board: "default", onEvents: () => { delivered++; } });
      expect(await socket.closed).toMatchObject({ code: "malformed-response" }); expect(delivered).toBe(0);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("keeps bulk per-ID failure distinct from HTTP success", async () => {
    const fixture = faultFixture();
    try {
      const result = await fixture.client.mutate({ route: "POST /tasks/bulk", board: "default", body: { ids: ["repeat-001"], assignee: "default" } });
      expect(result.kind).toBe("bulk");
      if (result.kind !== "bulk") throw new TypeError("Expected per-ID outcome");
      expect(result.results).toEqual([{ id: "repeat-001", ok: false, error: "Synthetic assignment refused" }]);
      expect(result.reconciliations[0]?.actual?.assignee).toBe("xia");
      expect(result.reconciliations[0]?.fields[0]?.outcome).toBe("differs");
      expect(result.draft).toEqual({ ids: ["repeat-001"], assignee: "default" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("denies archived source bulk restore before mutation", async () => {
    const fixture = faultFixture(); fixture.setMode("archived");
    try {
      await expect(fixture.client.mutate({ route: "POST /tasks/bulk", board: "default", body: { ids: ["repeat-001"], status: "todo" } })).rejects.toMatchObject({ code: "unsupported-operation" });
      expect(fixture.requests.some(request => request.method !== "GET")).toBe(false);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("denies policy bypass fields and wrong profile before transport", async () => {
    const fixture = faultFixture();
    try {
      for (const body of [{ archive: true }, { reclaim_first: true }, { status: "running" }, { status: "archived" }])
        await expect(fixture.client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body })).rejects.toMatchObject({ code: "unsupported-operation" });
      await expect(fixture.client.read({ route: "GET /board", board: "default", query: { profile: "xia" } })).rejects.toMatchObject({ code: "invalid-request" });
      expect(fixture.requests).toHaveLength(0);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("rejects stale mutation results and leaves the caller draft intact", async () => {
    const fixture = faultFixture(); let current = true;
    const draft = { title: "Synthetic draft" };
    try {
      fixture.setMode("late-write");
      const pending = fixture.client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: draft }, { isCurrent: () => current }).catch((error: unknown) => error);
      await fixture.seen.promise; current = false; fixture.release.resolve();
      expect(await pending).toMatchObject({ code: "stale-generation" });
      expect(draft.title).toBe("Synthetic draft"); expect(fixture.counts().writes).toBe(1);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("maps clear flags and completion fields to actual native storage fields", async () => {
    const fixture = faultFixture(); fixture.setMode("semantic");
    try {
      const result = await fixture.client.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { clear_model_override: true, clear_reasoning_effort: true, summary: "Synthetic summary", metadata: { synthetic: true } } });
      expect(result.kind).toBe("uncertain");
      if (result.kind !== "uncertain") throw new TypeError("Expected uncertainty");
      expect(result.fields.map(field => [field.field, field.outcome])).toEqual([["task.model_override", "matches"], ["task.provider_override", "matches"], ["task.reasoning_effort", "matches"], ["task.latest_summary", "matches"], ["latestRun.metadata", "matches"]]);
      expect(fixture.counts().writes).toBe(1);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("rejects malformed successful native envelopes", async () => {
    const fixture = faultFixture();
    try {
      await fixture.client.ready(); fixture.setMode("empty");
      for (const route of ["GET /board", "GET /workflow", "GET /config", "GET /profiles"] as const)
        await expect(fixture.client.read({ route, ...(route === "GET /board" ? { board: "default" } : {}) })).rejects.toMatchObject({ code: "malformed-response" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("rejects credential-helper origin and admin bypasses before bootstrap", async () => {
    const fixture = faultFixture(); const session = new DashboardSession(fixture.connection);
    try {
      for (const url of ["http://example.com/api/plugins/kanban/board?profile=default&board=default", `${fixture.connection.baseUrl}/api/plugins/kanban/dispatch?profile=default&board=default`])
        await expect(session.send({ url: new URL(url), method: "POST", body: "{}", cap: 1024 }, {})).rejects.toMatchObject({ code: "unsupported-operation" });
      expect(fixture.requests).toHaveLength(0);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test("pins skills profile without a global profile write", async () => {
    const fixture = faultFixture();
    try {
      expect((await fixture.client.skills("xia"))[0]?.name).toBe("synthetic");
      expect((await fixture.client.skillContent("xia", "synthetic")).path).toBe("/synthetic/SKILL.md");
      expect(fixture.requests.filter(request => request.path.startsWith("/api/skills")).every(request => request.profile === "xia" && request.method === "GET")).toBe(true);
      await expect(fixture.client.skills("all")).rejects.toMatchObject({ code: "invalid-request" });
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
});


describe("native skills category boundary", () => {
  const row = { name: "synthetic", description: "Synthetic skill", category: "qa", enabled: true, usage: 0, provenance: "agent" } as const;
  test("preserves mixed null/string categories and scoped authenticated reads", async () => {
    const fixture = faultFixture();
    const rows = [{ ...row, category: null }, { ...row, name: "categorized" }];
    fixture.setSkills(rows.map(skill => ({ ...skill, instruction: "UNTRUSTED_EXTRA_FIELD" })));
    try {
      expect(await fixture.client.skills("xia")).toEqual(rows);
      expect(fixture.requests.filter(request => request.path === "/api/skills")).toEqual([{ method: "GET", path: "/api/skills", board: null, profile: "xia" }]);
      expect(fixture.counts().writes).toBe(0);
    } finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test.each([undefined, 0, false, {}, []].map(category => ({ category })))("rejects missing or invalid category %j without discarding validation", async ({ category }) => {
    const fixture = faultFixture(); fixture.setSkills([{ ...row, category }]);
    try { await expect(fixture.client.skills("xia")).rejects.toMatchObject({ code: "malformed-response" }); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
  test.each([{ name: null }, { description: [] }, { enabled: 1 }, { usage: "0" }, { provenance: "unknown" }])("still rejects other malformed fields %j beside null category", async fields => {
    const fixture = faultFixture(); fixture.setSkills([{ ...row, category: null, ...fields }]);
    try { await expect(fixture.client.skills("xia")).rejects.toMatchObject({ code: "malformed-response" }); }
    finally { fixture.client.dispose(); await fixture.stop(); }
  });
});
