import { expect, test } from "bun:test";
import { ControlCenterState, retainProfileRoster } from "../src/ui/control-center-state";
import { ControlCenterRefresh } from "../src/ui/control-center-refresh";
import { DashboardClientError } from "../src/types/dashboard-client";
import type { DashboardEventBatch, DashboardTask, DashboardRequestContext } from "../src/types/dashboard-client";
import type { ProfileRoster } from "../src/types/control-center";
import type { ProfileMetadataReader } from "../src/types/profile-catalog";
import { controlledClock, controlledSubscriptions, connectionId, identity, selection, when } from "./control-center-state-fixture";
import { faultFixture, gate } from "./dashboard-client-fixture";

test("late A cannot overwrite selected B even when the loader ignores cancellation", async () => {
  // Given an unresolved first selection and a separate immediate second selection.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  const leaf = state.createLeaf<string>(), release = gate<string>(), seen = gate<void>();
  let signal: AbortSignal | undefined;
  try {
    const old = leaf.select(selection(context => { signal = context.signal; seen.resolve(); return release.promise; }, value => value));
    await seen.promise;
    // When B finishes before A.
    await leaf.select(selection(async () => "B", value => value, "xia"));
    release.resolve("A"); await old;
    // Then A is aborted and cannot replace B.
    expect(signal?.aborted).toBe(true);
    expect(leaf.snapshot.value).toBe("B");
    expect(leaf.snapshot.loading).toBe(false);
  } finally { release.resolve("A"); state.dispose(); await wire.stop(); }
});

test("dirty drafts survive refresh and reselection with an explicit remote conflict", async () => {
  // Given local edits based on remote version one.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  const leaf = state.createLeaf<string>(); let remote = "one";
  const source = selection(async () => remote, value => value);
  try {
    await leaf.select(source); leaf.edit("local"); remote = "two";
    // When another profile is visited and the edited profile is reselected.
    await leaf.select(selection(async () => "other", value => value, "xia")); await leaf.select(source);
    // Then the remote copy and local draft remain separate and close requires a decision.
    expect(leaf.snapshot).toMatchObject({ value: "two", draft: "local", conflict: true, baseRevision: "one" });
    expect(leaf.close()).toBe(false);
    expect(leaf.closeDecision()).toEqual({ kind: "confirm-discard", dirtyCount: 1, saving: false });
    expect(leaf.close(true)).toBe(true); expect(leaf.retainedCount).toBe(0);
  } finally { state.dispose(); await wire.stop(); }
});

test("visible file polling preserves content and marks a hung scheduled read stale at 30 seconds", async () => {
  // Given a first successful read followed by a blocked refresh.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  const leaf = state.createLeaf<string>(), seen = gate<void>(), release = gate<string>(); let initial = true;
  try {
    await leaf.select(selection(() => { if (initial) { initial = false; return Promise.resolve("old"); } seen.resolve(); return release.promise; }, value => value));
    clock.advance(14_999); expect(leaf.snapshot.loading).toBe(false);
    // When the 15 second poll hangs past the 30 second freshness deadline.
    clock.advance(1); await seen.promise; clock.advance(14_999); expect(leaf.snapshot.freshness.kind).toBe("fresh"); clock.advance(1);
    // Then content is retained but stale, and recovery updates it.
    expect(leaf.snapshot).toMatchObject({ value: "old", loading: true, freshness: { kind: "stale", lastSuccessAt: 0, reason: "age" } });
    const recovered = when(leaf, () => leaf.snapshot.value === "new"); release.resolve("new"); await recovered;
    expect(leaf.snapshot.freshness).toEqual({ kind: "fresh", lastSuccessAt: 30_000 });
  } finally { release.resolve("new"); state.dispose(); expect(clock.size).toBe(0); await wire.stop(); }
});

test("transport failure immediately marks retained content stale", async () => {
  // Given a selected body that was successfully read.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  const leaf = state.createLeaf<string>(); let fail = false;
  try {
    await leaf.select(selection(async () => { if (fail) throw new DashboardClientError("transport"); return "held"; }, value => value));
    // When a manual refresh fails.
    fail = true; await leaf.refresh();
    // Then the stale marker appears without waiting for age expiry.
    expect(leaf.snapshot).toMatchObject({ value: "held", freshness: { kind: "stale", reason: "transport-failure" } });
  } finally { state.dispose(); await wire.stop(); }
});

test("independent leaf catalogs do not cancel another profile selection", async () => {
  // Given two leaves sharing transport but owning separate catalog generations.
  const wire = faultFixture(), clock = controlledClock(), seen = gate<void>(), release = gate<void>();
  const metadata: ProfileMetadataReader = { async read(_profile, context) { seen.resolve(); await release.promise; if (context.isCurrent?.() === false) throw new DashboardClientError("stale-generation"); throw new DashboardClientError("transport"); } };
  const state = new ControlCenterState(connectionId(), wire.client, metadata, clock.clock), one = state.createLeaf<string>(), two = state.createLeaf<string>();
  const profile = identity({ kind: "profile", connection: "fixture", profile: "default" });
  if (profile.kind !== "profile" || one.catalog === null || two.catalog === null) throw new DashboardClientError("invalid-request");
  try {
    const first = one.catalog.skills(profile); await seen.promise;
    // When the other leaf loads the same profile independently and the first closes.
    const second = two.catalog.skills(profile); const aborted = first.catch((error: unknown) => error); one.close(); release.resolve();
    // Then only the closed leaf is aborted; the live leaf receives its partial catalog.
    expect(await aborted).toMatchObject({ code: "aborted" });
    expect((await second).coverage.kind).toBe("incomplete");
  } finally { release.resolve(); state.dispose(); await wire.stop(); }
});

test("failed roster refresh retains the exact connection membership without claiming freshness", async () => {
  // Given known current membership and an accepted reader's empty failure snapshot.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock);
  const leaf = state.createLeaf<ProfileRoster>(), profile = identity({ kind: "profile", connection: "fixture", profile: "default" });
  if (profile.kind !== "profile") throw new DashboardClientError("invalid-request");
  let remote: ProfileRoster = { connection: connectionId(), profiles: [profile], coverage: { kind: "complete" }, freshness: { kind: "fresh", lastSuccessAt: 0 } };
  try {
    await leaf.select({ ...selection(async () => remote, value => JSON.stringify(value.profiles)), merge: retainProfileRoster, freshness: value => value.freshness });
    // When the roster reader reports transport failure.
    remote = { ...remote, profiles: [], coverage: { kind: "incomplete", reasons: ["transport-failure"] }, freshness: { kind: "stale", lastSuccessAt: null, reason: "transport-failure" } }; await leaf.refresh();
    // Then membership survives with incomplete/stale coverage and the old success timestamp.
    expect(leaf.snapshot.value?.profiles).toEqual([profile]); expect(leaf.snapshot.value?.coverage.kind).toBe("incomplete"); expect(leaf.snapshot.freshness).toEqual({ kind: "stale", lastSuccessAt: 0, reason: "transport-failure" });
  } finally { state.dispose(); await wire.stop(); }
});

test("partial native writes preserve the draft and expose authoritative per-field reconciliation", async () => {
  // Given an edited task and a wire server that commits title before failing status.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock), leaf = state.createLeaf<DashboardTask>();
  try {
    await leaf.select({ entity: identity({ kind: "task", connection: "fixture", board: "default", taskId: "repeat-001" }), channel: "task", load: context => wire.client.task("default", "repeat-001", context), revision: task => JSON.stringify([task.title, task.status]) });
    const old = leaf.snapshot.value; if (old === null) throw new DashboardClientError("malformed-response");
    leaf.edit({ ...old, title: "local", status: "ready" }); wire.setMode("partial");
    // When the native update partially commits.
    const result = await leaf.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { title: "local", status: "ready" } });
    // Then only one write occurs and the reread and draft distinguish actual from requested status.
    expect(result.kind).toBe("uncertain"); expect(wire.counts().writes).toBe(1);
    expect(leaf.snapshot).toMatchObject({ mutation: "uncertain", value: { title: "local", status: "todo" }, draft: { title: "local", status: "ready" }, conflict: true });
    if (result.kind !== "uncertain") throw new DashboardClientError("malformed-response");
    expect(result.fields.find(field => field.inputField === "status")?.outcome).toBe("differs");
  } finally { state.dispose(); await wire.stop(); }
});

test("selection change during an applied late write never labels it uncommitted or replays it", async () => {
  // Given a draft whose PATCH is paused after server commit.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock), leaf = state.createLeaf<DashboardTask>();
  const source = { entity: identity({ kind: "task", connection: "fixture", board: "default", taskId: "repeat-001" }), channel: "task", load: (context: DashboardRequestContext) => wire.client.task("default", "repeat-001", context), revision: (task: DashboardTask) => task.title };
  try {
    await leaf.select(source); const old = leaf.snapshot.value; if (old === null) throw new DashboardClientError("malformed-response"); leaf.edit({ ...old, title: "committed" }); wire.setMode("late-write");
    const mutation = leaf.mutate({ route: "PATCH /tasks/{task_id}", board: "default", id: "repeat-001", body: { title: "committed" } }).catch((error: unknown) => error); await wire.seen.promise;
    // When the leaf hides while the write response is outstanding.
    leaf.setVisible(false); wire.release.resolve(); await mutation; wire.setMode("normal"); leaf.setVisible(true); await when(leaf, () => leaf.snapshot.value?.title === "committed");
    // Then the uncertain draft survives and the resumed read observes the commit exactly once.
    expect(leaf.snapshot).toMatchObject({ mutation: "uncertain", draft: { title: "committed" }, value: { title: "committed" } }); expect(wire.counts().writes).toBe(1);
  } finally { wire.release.resolve(); state.dispose(); await wire.stop(); }
});

test("last close and unload erase bodies and suppress callbacks from ignored aborts", async () => {
  // Given a selected draft and a deferred read that ignores AbortSignal.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock), leaf = state.createLeaf<string>(), release = gate<string>(), seen = gate<void>(); let changes = 0;
  try {
    await leaf.select(selection(async () => "private", value => value)); leaf.edit("local private");
    const pending = leaf.select(selection(() => { seen.resolve(); return release.promise; }, value => value, "xia")); await seen.promise; leaf.subscribe(() => { changes++; });
    // When the whole connection state unloads before the late response.
    state.dispose(); release.resolve("late private"); await pending; clock.advance(100_000);
    // Then there is no retained body, callback, or timer.
    expect(leaf.retainedCount).toBe(0); expect(leaf.snapshot.value).toBeNull(); expect(changes).toBe(0); expect(clock.size).toBe(0);
  } finally { release.resolve("late"); state.dispose(); await wire.stop(); }
});

test("board watches coalesce events and release only their own polling and socket lease", async () => {
  // Given two visible owners sharing a board socket.
  const clock = controlledClock(), connected = gate<void>(), closed = gate<DashboardClientError | null>();
  let deliver: (batch: DashboardEventBatch) => void = () => undefined; let closes = 0; let one = 0; let two = 0; const detailCursors: number[] = [];
  const refresh = new ControlCenterRefresh({ async subscribe(request) { deliver = request.onEvents; connected.resolve(); return { closed: closed.promise, close() { closes++; closed.resolve(null); } }; } }, clock.clock);
  const first = refresh.watch({ board: "default", since: 0, onEvents: batch => { detailCursors.push(batch.cursor); }, onRefresh: () => { one++; }, onFailure: () => undefined });
  const second = refresh.watch({ board: "default", since: 0, onEvents: () => undefined, onRefresh: () => { two++; }, onFailure: () => undefined }); await connected.promise; await Promise.resolve();
  try {
    // When three invalidations arrive and the first owner then closes.
    for (const cursor of [1, 2, 3]) deliver({ events: [], cursor }); expect(detailCursors).toEqual([]); clock.advance(249); expect([one, two]).toEqual([0, 0]); expect(detailCursors).toEqual([]); clock.advance(1); expect(detailCursors).toEqual([3]); first(); clock.advance(14_750);
    // Then each had one coalesced refresh, only the live owner polls, and last close owns the socket.
    expect([one, two, closes]).toEqual([1, 2, 0]); second(); expect(closes).toBe(1); expect(clock.size).toBe(0);
  } finally { refresh.dispose(); }
});

test("reconnect follows bounded backoff and manual retry cancels the waiting deadline", async () => {
  // Given a transport that fails each connection attempt.
  const clock = controlledClock(); let attempted = gate<void>(); const times: number[] = [];
  const refresh = new ControlCenterRefresh({ async subscribe() { times.push(clock.clock.now()); throw new DashboardClientError("transport"); } }, clock.clock);
  const close = refresh.watch({ board: "default", since: 0, onEvents: () => undefined, onRefresh: () => undefined, onFailure: () => { attempted.resolve(); } }); await attempted.promise;
  try {
    // When automatic retries exhaust the exponential segment and a manual retry is requested.
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) { attempted = gate<void>(); clock.advance(delay); await attempted.promise; }
    attempted = gate<void>(); clock.advance(100); refresh.retry("default"); await attempted.promise;
    // Then the actual attempts reflect the deadlines and no orphan timer survives release.
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 30_100]); close(); clock.advance(60_000); expect(times).toHaveLength(7); expect(clock.size).toBe(0);
  } finally { refresh.dispose(); }
});

test("different window channels retain separate drafts and never relabel remote snapshots", async () => {
  // Given an edited 7 day result.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock), leaf = state.createLeaf<string>();
  try {
    await leaf.select({ ...selection(async () => "7-day snapshot", value => value), channel: "activity:7:0:7" }); leaf.edit("7-day draft");
    // When a 30 day scope is selected.
    await leaf.select({ ...selection(async () => "30-day snapshot", value => value), channel: "activity:30:0:30" });
    // Then neither the old remote body nor its draft is presented under the new scope.
    expect(leaf.snapshot).toMatchObject({ value: "30-day snapshot", draft: null, conflict: false });
  } finally { state.dispose(); await wire.stop(); }
});

test("repeated hide and resume suppress each abandoned request without losing the draft", async () => {
  // Given a dirty leaf and a loader whose responses can outlive visibility.
  const wire = faultFixture(), clock = controlledClock(), state = new ControlCenterState(connectionId(), wire.client, undefined, clock.clock), leaf = state.createLeaf<string>();
  let load = () => Promise.resolve("initial");
  try {
    await leaf.select(selection(() => load(), value => value)); leaf.edit("local");
    // When the leaf repeatedly hides during a read and resumes with a newer response.
    for (const version of [1, 2, 3]) {
      const seen = gate<void>(), release = gate<string>();
      load = () => { seen.resolve(); return release.promise; };
      const old = leaf.refresh(); await seen.promise; leaf.setVisible(false);
      load = () => Promise.resolve(`resumed-${version}`); leaf.setVisible(true);
      await when(leaf, () => leaf.snapshot.value === `resumed-${version}`); release.resolve(`abandoned-${version}`); await old;
      expect(leaf.snapshot).toMatchObject({ value: `resumed-${version}`, draft: "local", conflict: true });
    }
    // Then the final visible generation has no abandoned loading state.
    expect(leaf.snapshot.loading).toBe(false);
  } finally { state.dispose(); expect(clock.size).toBe(0); await wire.stop(); }
});

test("closing during socket startup aborts its context and closes the late subscription", async () => {
  // Given a socket handshake held beyond its owner's lifetime.
  const clock = controlledClock(), ready = gate<void>(), closed = gate<DashboardClientError | null>();
  let signal: AbortSignal | undefined; let delivered = 0; let closes = 0;
  const refresh = new ControlCenterRefresh({ async subscribe(request, context) { signal = context?.signal; await ready.promise; request.onEvents({ cursor: 1, events: [] }); return { closed: closed.promise, close() { closes++; closed.resolve(null); } }; } }, clock.clock);
  const close = refresh.watch({ board: "default", since: 0, onEvents: () => { delivered++; }, onRefresh: () => { delivered++; }, onFailure: () => { delivered++; } });
  // When the owner releases before the handshake completes.
  close(); ready.resolve(); await closed.promise; clock.advance(60_000);
  // Then late events are suppressed and the late resource is explicitly closed.
  expect(signal?.aborted).toBe(true); expect(closes).toBe(1); expect(delivered).toBe(0); expect(clock.size).toBe(0); refresh.dispose();
});

test("one coalesced deadline preserves every buffered task event and the latest cursor", async () => {
  // Given a native event source and two task identities in one burst.
  const clock = controlledClock(), closed = gate<DashboardClientError | null>();
  let deliver: (batch: DashboardEventBatch) => void = () => undefined;
  const batches: DashboardEventBatch[] = [], refreshTimes: number[] = [];
  const refresh = new ControlCenterRefresh({ async subscribe(request) { deliver = request.onEvents; return { closed: closed.promise, close() { closed.resolve(null); } }; } }, clock.clock);
  const close = refresh.watch({ board: "default", since: 0, onEvents: batch => { batches.push(batch); }, onRefresh: () => { refreshTimes.push(clock.clock.now()); }, onFailure: () => undefined });
  try {
    // When separate native messages invalidate the first task twice and another task once.
    for (const [id, task] of [[1, "one"], [2, "two"], [3, "one"]] as const) deliver({ cursor: id, events: [{ id, task_id: task, run_id: null, kind: "updated", payload: null, created_at: id }] });
    clock.advance(249); expect(batches).toEqual([]); expect(refreshTimes).toEqual([]); clock.advance(1);
    // Then event details and board refresh share exactly the first 250 ms deadline.
    expect(batches.map(batch => ({ cursor: batch.cursor, tasks: batch.events.map(event => event.task_id) }))).toEqual([{ cursor: 3, tasks: ["one", "two", "one"] }]); expect(refreshTimes).toEqual([250]);
  } finally { close(); refresh.dispose(); await closed.promise; }
});

for (const bound of ["events", "bytes"] as const) test(`an overflowing ${bound} burst requests a full refresh without partial events`, async () => {
  // Given a burst larger than the bounded pending event capacity.
  const clock = controlledClock(), closed = gate<DashboardClientError | null>();
  let deliver: (batch: DashboardEventBatch) => void = () => undefined; let delivered = 0; let refreshes = 0; const failures: string[] = [];
  const refresh = new ControlCenterRefresh({ async subscribe(request) { deliver = request.onEvents; return { closed: closed.promise, close() { closed.resolve(null); } }; } }, clock.clock);
  const close = refresh.watch({ board: "default", since: 0, onEvents: () => { delivered++; }, onRefresh: () => { refreshes++; }, onFailure: error => { failures.push(error.code); } });
  try {
    // When individually bounded messages exceed the shared pending buffer before its deadline.
    if (bound === "events") deliver({ cursor: 1025, events: Array.from({ length: 1025 }, (_, index) => ({ id: index + 1, task_id: `task-${index}`, run_id: null, kind: "updated", payload: null, created_at: index })) });
    else for (const id of [1, 2]) deliver({ cursor: id, events: [{ id, task_id: "one", run_id: null, kind: "updated", payload: "x".repeat(524_288), created_at: id }] });
    clock.advance(250);
    // Then no partial batch escapes and the consumer receives failure plus full reread.
    expect(failures).toEqual(["response-cap"]); expect(delivered).toBe(0); expect(refreshes).toBe(1); close(); expect(clock.size).toBe(0);
  } finally { refresh.dispose(); }
});

test("retry uses the received cursor before flush and dispose cancels every buffered callback", async () => {
  // Given received events that have not yet reached their 250 ms consumer deadline.
  const clock = controlledClock(), closed = gate<DashboardClientError | null>(); const cursors: (number | undefined)[] = [];
  let deliver: (batch: DashboardEventBatch) => void = () => undefined; let callbacks = 0;
  const refresh = new ControlCenterRefresh({ async subscribe(request) { cursors.push(request.since); deliver = request.onEvents; return { closed: closed.promise, close() { closed.resolve(null); } }; } }, clock.clock);
  refresh.watch({ board: "default", since: 0, onEvents: () => { callbacks++; }, onRefresh: () => { callbacks++; }, onFailure: () => { callbacks++; } });
  deliver({ cursor: 7, events: [{ id: 7, task_id: "one", run_id: null, kind: "updated", payload: "private buffered payload", created_at: 7 }] });
  // When manual retry occurs before flush, followed immediately by unload.
  refresh.retry(); expect(cursors).toEqual([0, 7]); const before = callbacks; refresh.dispose(); clock.advance(100_000); await Promise.resolve();
  // Then retry used the new cursor and unload prevents both queued and late socket callbacks.
  expect(callbacks).toBe(before); expect(clock.size).toBe(0);
});

test("review H1: releasing an old lease twice cannot unregister its replacement", async () => {
  // Given an established channel A that is released before channel B takes the same board.
  const clock = controlledClock(), sockets = controlledSubscriptions(), refresh = new ControlCenterRefresh(sockets.client, clock.clock);
  const events: number[] = [], refreshes: number[] = [];
  const releaseA = refresh.watch({ board: "default", since: 0, onEvents: () => undefined, onRefresh: () => undefined, onFailure: () => undefined });
  await sockets.attempt(0).established; releaseA();
  refresh.watch({ board: "default", since: 0, onEvents: batch => { events.push(batch.cursor); }, onRefresh: () => { refreshes.push(clock.clock.now()); }, onFailure: () => undefined });
  const replacement = sockets.attempt(1); await replacement.established;
  try {
    // When the old release is called again after the replacement has connected.
    releaseA(); replacement.events({ cursor: 1, events: [] }); clock.advance(250); clock.advance(14_750); refresh.dispose();
    // Then B still delivered events/polling and final disposal closes and aborts its ownership.
    expect({ events, refreshes, replacementClosed: replacement.closes(), replacementAborted: replacement.signal?.aborted, timers: clock.size }).toEqual({ events: [1], refreshes: [250, 15_000], replacementClosed: 1, replacementAborted: true, timers: 0 });
  } finally { refresh.dispose(); sockets.cleanup(); }
});

test("review M1: synchronous failure retry cannot leave an obsolete reconnect", async () => {
  // Given an established socket and a failure callback that retries exactly once.
  const clock = controlledClock(), sockets = controlledSubscriptions(), refresh = new ControlCenterRefresh(sockets.client, clock.clock);
  let retried = false; const events: number[] = [];
  refresh.watch({ board: "default", since: 0, onEvents: batch => { events.push(batch.cursor); }, onRefresh: () => undefined, onFailure: () => { if (!retried) { retried = true; refresh.retry("default"); } } });
  await sockets.attempt(0).established;
  try {
    // When transport failure synchronously starts a replacement before the old failure unwinds.
    sockets.attempt(0).end(new DashboardClientError("transport")); await Promise.resolve();
    const replacement = sockets.attempt(1); await replacement.established; clock.advance(1_000);
    const latest = sockets.attempt(sockets.attempts.length - 1); await latest.established;
    replacement.events({ cursor: 2, events: [] }); clock.advance(250); refresh.dispose();
    // Then only one replacement exists, remains active and is fully owned through teardown.
    expect({ connections: sockets.attempts.length, events, replacementClosed: replacement.closes(), allAborted: sockets.attempts.every(attempt => attempt.signal?.aborted), timers: clock.size }).toEqual({ connections: 2, events: [2], replacementClosed: 1, allAborted: true, timers: 0 });
  } finally { refresh.dispose(); sockets.cleanup(); }
});
