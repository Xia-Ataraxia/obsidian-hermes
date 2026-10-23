import { expect, test } from "bun:test";
import { ControlCenterState } from "../src/ui/control-center-state";
import { KanbanViewDrafts } from "../src/ui/kanban-view-drafts";
import { KanbanViewSession } from "../src/ui/kanban-view-session";
import { controlledClock, connectionId, identity, selection } from "./control-center-state-fixture";
import { faultFixture, gate } from "./dashboard-client-fixture";
import type { DashboardObject } from "../src/types/dashboard-client";
import { requireObject } from "../src/ui/dashboard-response";

function setup() {
  const wire = faultFixture(), clock = controlledClock();
  const state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  return { wire, clock, state, async close() { state.dispose(); wire.client.dispose(); await wire.stop(); } };
}

test("external delivery rejects stale A after A to B to A without starting refresh IO", async () => {
  const fixture = setup(), leaf = fixture.state.createLeaf<string>();
  let loads = 0;
  const source = (name: string) => selection(async () => { loads++; return name; }, value => value, name);
  try {
    const oldA = leaf.selectExternal(source("a"));
    oldA("first", { kind: "fresh", lastSuccessAt: 12 });
    leaf.selectExternal(source("b"));
    const currentA = leaf.selectExternal(source("a"));
    expect(oldA("late", { kind: "fresh", lastSuccessAt: 99 })).toBe(false);
    expect(currentA("current", { kind: "stale", lastSuccessAt: 12, reason: "age" })).toBe(true);
    await leaf.refresh(); fixture.clock.advance(60_000);
    expect(leaf.snapshot).toMatchObject({ value: "current", freshness: { kind: "stale", lastSuccessAt: 12 } });
    expect([loads, fixture.clock.size, fixture.wire.requests.length]).toEqual([0, 0, 0]);
  } finally { await fixture.close(); }
});

test("external delivery preserves dirty drafts and source freshness when remote fields change", async () => {
  const fixture = setup(), leaf = fixture.state.createLeaf<string>();
  try {
    const receive = leaf.selectExternal(selection(async () => "unused", value => value));
    receive("base", { kind: "fresh", lastSuccessAt: 100 }); leaf.edit("local");
    receive("remote", { kind: "stale", lastSuccessAt: 100, reason: "transport-failure" });
    expect(leaf.snapshot).toMatchObject({ value: "remote", draft: "local", baseRevision: "base", conflict: true, freshness: { kind: "stale" } });
    expect(leaf.close()).toBe(false);
  } finally { await fixture.close(); }
});

test("hidden resume and repeated disposal invalidate external receivers without polling", async () => {
  const fixture = setup(), leaf = fixture.state.createLeaf<string>();
  try {
    const receive = leaf.selectExternal(selection(async () => "must not load", value => value));
    leaf.setVisible(false);
    expect(receive("hidden", { kind: "fresh", lastSuccessAt: 1 })).toBe(false);
    leaf.setVisible(true);
    expect(receive("old generation", { kind: "fresh", lastSuccessAt: 2 })).toBe(false);
    expect(fixture.clock.size).toBe(0);
    const resumed = leaf.selectExternal(selection(async () => "must not load", value => value));
    expect(resumed("resumed", { kind: "unknown", lastSuccessAt: null })).toBe(true);
    leaf.dispose(); leaf.dispose();
    expect(resumed("disposed", { kind: "fresh", lastSuccessAt: 3 })).toBe(false);
    expect([leaf.retainedCount, fixture.wire.requests.length]).toEqual([0, 0]);
  } finally { await fixture.close(); }
});

test("drafts remain separate across boards and independent mounted leaves", async () => {
  const fixture = setup(), one = new KanbanViewDrafts(fixture.state), two = new KanbanViewDrafts(fixture.state);
  const a = { board: "default", taskId: "repeat-001" }, b = { board: "second", taskId: "repeat-001" };
  try {
    one.begin(a)({ title: "base" }, { kind: "fresh", lastSuccessAt: 1 });
    one.edit(a, "title", "<script>inert local</script>");
    one.begin(b)({ title: "second" }, { kind: "fresh", lastSuccessAt: 2 });
    expect(one.get(a, "title", "fallback")).toBe("<script>inert local</script>");
    expect(one.get(b, "title", "second")).toBe("second");
    expect(two.get(a, "title", "base")).toBe("base");
    one.edit(a, "model_override", null);
    expect(one.get(a, "model_override", "old-model")).toBeNull();
    one.edit(a, "assignee", "");
    expect(one.get(a, "assignee", "old-assignee")).toBe("");
    expect(one.closeDecision().kind).toBe("confirm-discard");
    one.dispose(); one.dispose();
    expect(one.closeDecision()).toEqual({ kind: "allow" });
  } finally { two.dispose(); await fixture.close(); }
});

test("partial PATCH retains all local fields and exposes native readback without replay", async () => {
  const fixture = setup(), session = new KanbanViewSession(fixture.state);
  const scope = { board: "default", taskId: "repeat-001" };
  try {
    await session.services.client.read({ route: "GET /tasks/{task_id}", board: scope.board, id: scope.taskId });
    session.drafts.edit(scope, "title", "Committed title"); session.drafts.edit(scope, "body", "Still local body");
    fixture.wire.setMode("partial");
    const result = await session.services.client.mutate({ route: "PATCH /tasks/{task_id}", board: scope.board, id: scope.taskId, body: { title: "Committed title", body: "Still local body" } });
    expect(result.kind).toBe("uncertain");
    expect(session.drafts.get(scope, "title", "fallback")).toBe("Committed title");
    expect(session.drafts.get(scope, "body", "fallback")).toBe("Still local body");
    expect(session.drafts.issue(scope)).toContain("title: matches");
    expect(fixture.wire.counts().writes).toBe(1);
    expect(session.status()).toContain("Write uncertain");
    fixture.wire.setMode("normal");
    await session.services.client.mutate({ route: "PATCH /tasks/{task_id}", board: scope.board, id: scope.taskId, body: { title: "Committed title" } });
    expect(session.status()).not.toContain("Write uncertain");
    expect(session.drafts.get(scope, "body", "fallback")).toBe("Still local body");
  } finally { session.dispose(); await fixture.close(); }
});

test("external mutation uses a live context without adding a refresh path", async () => {
  const fixture = setup(), leaf = fixture.state.createLeaf<string>();
  let loads = 0;
  try {
    const selected = { entity: identity({ kind: "task", connection: "fixture", board: "default", taskId: "repeat-001" }), channel: "editor", load: async () => { loads++; return "unused"; }, revision: (value: string) => value };
    leaf.selectExternal(selected)("base", { kind: "fresh", lastSuccessAt: 1 });
    leaf.edit("local");
    const result = await leaf.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { title: "Saved externally" } });
    fixture.clock.advance(60_000);
    expect(result.kind).toBe("applied");
    expect([loads, fixture.clock.size, fixture.wire.counts().writes]).toEqual([0, 0, 1]);
    expect(leaf.snapshot.draft).toBe("local");
    expect(() => leaf.selectExternal({ ...selected, entity: identity({ kind: "task", connection: "other", board: "default", taskId: "repeat-001" }) })).toThrow();
  } finally { await fixture.close(); }
});

test("confirmed native field readback clears only the submitted matching draft", async () => {
  const fixture = setup(), session = new KanbanViewSession(fixture.state);
  const scope = { board: "default", taskId: "repeat-001" };
  try {
    await session.services.client.read({ route: "GET /tasks/{task_id}", board: scope.board, id: scope.taskId });
    session.drafts.edit(scope, "title", "Saved"); session.drafts.edit(scope, "body", "Keep editing");
    await session.services.client.mutate({ route: "PATCH /tasks/{task_id}", board: scope.board, id: scope.taskId, body: { title: "Saved" } });
    expect(session.drafts.get(scope, "title", "Saved remotely")).toBe("Saved remotely");
    expect(session.drafts.get(scope, "body", "fallback")).toBe("Keep editing");
  } finally { session.dispose(); await fixture.close(); }
});

test("late cancelled save cannot clear draft or replay after visible resume", async () => {
  const fixture = setup(), session = new KanbanViewSession(fixture.state);
  const scope = { board: "default", taskId: "repeat-001" };
  try {
    await session.services.client.read({ route: "GET /tasks/{task_id}", board: scope.board, id: scope.taskId });
    session.drafts.edit(scope, "title", "Late save"); fixture.wire.setMode("late-write");
    const write = session.services.client.mutate({ route: "PATCH /tasks/{task_id}", board: scope.board, id: scope.taskId, body: { title: "Late save" } }).catch(error => error);
    await fixture.wire.seen.promise;
    session.setVisible(false); session.setVisible(true); fixture.wire.release.resolve(); await write;
    expect(session.drafts.get(scope, "title", "fallback")).toBe("Late save");
    expect(fixture.wire.counts().writes).toBe(1);
    expect(session.closeDecision().kind).toBe("confirm-discard");
  } finally { fixture.wire.release.resolve(); session.dispose(); await fixture.close(); }
});

test("navigation validates scope and queues only the newest explicit request for its own leaf", async () => {
  const fixture = setup(), one = new KanbanViewSession(fixture.state), two = new KanbanViewSession(fixture.state);
  const navigated: unknown[] = [];
  try {
    one.navigate("default", "one"); one.navigate("second", "two");
    expect(() => one.navigate("../../escape", "one")).toThrow();
    const disconnect = one.bridge.connect(target => navigated.push(target), () => undefined);
    two.bridge.connect(target => navigated.push(target), () => undefined);
    expect(navigated).toEqual([{ board: "second", taskId: "two" }]);
    disconnect(); one.dispose(); one.navigate("default", "later");
    expect(navigated).toHaveLength(1);
  } finally { one.dispose(); two.dispose(); await fixture.close(); }
});

test("late detail delivery rejects before the native page can consume an obsolete response", async () => {
  const fixture = setup(), session = new KanbanViewSession(fixture.state), delayed = gate<DashboardObject>();
  const original = fixture.wire.client.read.bind(fixture.wire.client);
  let first = true;
  fixture.wire.client.read = (request, context) => { if (first) { first = false; return delayed.promise; } return original(request, context); };
  try {
    const request = { route: "GET /tasks/{task_id}" as const, board: "default", id: "repeat-001" };
    const late = session.services.client.read(request).catch(error => error);
    await session.services.client.read(request);
    session.drafts.edit({ board: "default", taskId: "repeat-001" }, "title", "Local");
    delayed.resolve({ task: { id: "repeat-001", title: "Obsolete" } });
    expect((await late).code).toBe("stale-generation");
    expect(session.drafts.issue({ board: "default", taskId: "repeat-001" })).toBeNull();
    expect(session.drafts.get({ board: "default", taskId: "repeat-001" }, "title", "fallback")).toBe("Local");
  } finally { delayed.resolve({}); session.dispose(); await fixture.close(); }
});

test("gated save readback preserves newer whitespace-significant body and discard protection", async () => {
  const fixture = setup(), session = new KanbanViewSession(fixture.state);
  const scope = { board: "default", taskId: "repeat-001" }, seen = gate<void>(), release = gate<void>();
  const original = fixture.wire.client.read.bind(fixture.wire.client);
  let saving = false;
  fixture.wire.client.read = async (request, context) => {
    const result = await original(request, context);
    if (request.route !== "GET /tasks/{task_id}") return result;
    if (saving) { seen.resolve(); await release.promise; }
    return { ...result, task: { ...requireObject(result["task"] ?? null), body: saving ? "text" : "Original body" } };
  };
  try {
    await session.services.client.read({ route: "GET /tasks/{task_id}", board: scope.board, id: scope.taskId });
    session.drafts.edit(scope, "body", "text"); saving = true;
    const result = session.services.client.mutate({ route: "PATCH /tasks/{task_id}", board: scope.board, id: scope.taskId, body: { body: "text" } });
    await seen.promise;
    session.drafts.edit(scope, "body", " text "); release.resolve();
    expect((await result).kind).toBe("applied");
    expect(session.drafts.get(scope, "body", "ABSENT")).toBe(" text ");
    expect(session.closeDecision().kind).toBe("confirm-discard");
    expect(fixture.wire.counts().writes).toBe(1);
  } finally { release.resolve(); session.dispose(); await fixture.close(); }
});

test("native input conversions clear only unchanged submitted fields", async () => {
  const fixture = setup(), drafts = new KanbanViewDrafts(fixture.state), scope = { board: "default", taskId: "repeat-001" };
  try {
    drafts.edit(scope, "title", " title "); drafts.edit(scope, "assignee", " xia "); drafts.edit(scope, "priority", "2"); drafts.edit(scope, "body", " body ");
    const submitted = drafts.capture(scope);
    drafts.edit(scope, "title", "title");
    drafts.confirmFields(scope, { title: "title", assignee: "xia", priority: 2, body: "body" }, { title: "title", assignee: "xia", priority: 2, body: "body" }, submitted);
    expect(drafts.get(scope, "assignee", "ABSENT")).toBe("ABSENT");
    expect(drafts.get(scope, "priority", "ABSENT")).toBe("ABSENT");
    expect(drafts.get(scope, "title", "ABSENT")).toBe("title");
    expect(drafts.get(scope, "body", "ABSENT")).toBe(" body ");
  } finally { drafts.dispose(); await fixture.close(); }
});
