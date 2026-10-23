import { expect, test } from "bun:test";
import { ProfilesCanvasSource } from "../src/ui/profiles-canvas-source";
import { ControlCenterState } from "../src/ui/control-center-state";
import type { ProfilesCanvasServices } from "../src/types/profiles-canvas";
import { CANVAS_DEFAULT_FILTERS } from "../src/types/profiles-canvas";
import { DashboardClientError } from "../src/types/dashboard-client";
import type { BoardActivitySnapshot } from "../src/types/task-activity";
import type { BoardKey, ProfileRoster } from "../src/types/control-center";
import { controlledClock } from "./control-center-state-fixture";
import { faultFixture, gate } from "./dashboard-client-fixture";
import { connection, cycle, roster, snapshot, token } from "./task-activity-projector-fixture";

function setup() {
  const wire = faultFixture(), clock = controlledClock();
  clock.advance(2_000_000_000_000);
  const state = new ControlCenterState(connection, wire.client, undefined, clock.clock);
  const first = snapshot(cycle);
  let boards: readonly BoardKey[] = [first.board];
  let currentRoster: ProfileRoster = roster;
  let failure = false;
  let activityRead: ProfilesCanvasServices["loadActivity"] = async (_board, window) => {
    if (failure) throw new DashboardClientError("transport");
    return { ...first, window };
  };
  const services: ProfilesCanvasServices = { state,
    loadRoster: async () => currentRoster,
    loadBoards: async () => boards,
    loadActivity: (board, window, context) => activityRead(board, window, context),
    mountInspector: () => ({ select: async () => true, refresh: async () => undefined, close: async () => true, dispose: () => undefined }),
    openTask: () => undefined, savePreferences: async () => undefined,
  };
  const source = new ProfilesCanvasSource(services);
  return { source, state, clock, first, setRoster(value: ProfileRoster) { currentRoster = value; }, setBoards(value: readonly BoardKey[]) { boards = value; }, fail() { failure = true; }, setRead(read: typeof activityRead) { activityRead = read; },
    async stop() { source.dispose(); source.dispose(); state.dispose(); wire.client.dispose(); await wire.stop(); expect(clock.size).toBe(0); } };
}
function until(source: ProfilesCanvasSource, match: () => boolean): Promise<void> {
  if (match()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cancel(); reject(new DashboardClientError("timeout")); }, 3000);
    const cancel = source.subscribe(() => { if (match()) { clearTimeout(timeout); cancel(); resolve(); } });
  });
}

test("source passes state12 stale freshness to projector while retaining roster and positive edges", async () => {
  const fixture = setup();
  try {
    await fixture.source.start();
    await until(fixture.source, () => fixture.source.projection.edges.length === 1);
    expect(fixture.source.projection.nodes.find(node => node.profile.profile === "empty")?.peerPresence.kind).toBe("no-observed-activity");
    fixture.fail();
    fixture.setRoster({ ...roster, profiles: [], coverage: { kind: "incomplete", reasons: ["transport-failure"] }, freshness: { kind: "stale", lastSuccessAt: null, reason: "transport-failure" } });
    await fixture.source.refresh();
    expect(fixture.source.projection.nodes).toHaveLength(3);
    expect(fixture.source.projection.edges[0]?.distinctTaskCount).toBe(1);
    expect(fixture.source.projection.nodes.find(node => node.profile.profile === "empty")?.peerPresence.kind).toBe("unknown");
    expect(fixture.source.projection.coverage.fresh).toBe(false);
    expect(fixture.source.orchestrator).toEqual({ kind: "unknown" });
  } finally { await fixture.stop(); }
});

test("late old window reads cannot leak into a new scope, and hide cancels then resume refreshes", async () => {
  const fixture = setup(), release = gate<BoardActivitySnapshot>(), seen = gate<void>();
  let aborted: AbortSignal | undefined;
  fixture.setRead(async (_board, _window, context) => { aborted = context.signal; seen.resolve(); return release.promise; });
  try {
    await fixture.source.start(); await seen.promise;
    fixture.setRead(async (_board, window) => ({ ...fixture.first, window, activities: [], qualifyingRowCount: 0 }));
    fixture.source.setFilters({ ...CANVAS_DEFAULT_FILTERS, window: 7, types: ["creation"] });
    await until(fixture.source, () => fixture.source.projection.coverage.complete);
    expect(aborted?.aborted).toBe(true);
    release.resolve(fixture.first);
    await fixture.source.refresh();
    expect(fixture.source.projection.edges).toHaveLength(0);
    fixture.source.setVisible(false);
    expect(fixture.clock.size).toBe(0);
    fixture.source.setVisible(true);
    await fixture.source.refresh();
    expect(fixture.source.projection.nodes).toHaveLength(3);
  } finally { release.resolve(fixture.first); await fixture.stop(); }
});

test("activity failure never prevents native roster selection and empty result stays unknown", async () => {
  const fixture = setup(); fixture.fail();
  try {
    await fixture.source.start(); await fixture.source.refresh();
    expect(fixture.source.currentRoster.profiles).toEqual(roster.profiles);
    expect(fixture.source.projection.edges).toHaveLength(0);
    expect(fixture.source.projection.nodes.every(node => node.peerPresence.kind === "unknown")).toBe(true);
  } finally { await fixture.stop(); }
});

test("after-open event enters a newly captured rolling window on refresh", async () => {
  const fixture = setup();
  const openedAt = fixture.clock.clock.now();
  const windows: number[] = [];
  fixture.setRead(async (_board, window) => {
    windows.push(window.end);
    const event = fixture.first.activities[0];
    if (!event) throw new TypeError("Missing fixture event");
    const later = { ...event, task: { ...event.task, taskId: token("task", "later") }, occurredAt: openedAt + 500 };
    return { ...fixture.first, window, activities: [later].filter(event => event.occurredAt < window.end) };
  });
  try {
    await fixture.source.start(); await fixture.source.refresh();
    expect(fixture.source.projection.edges).toHaveLength(0);
    fixture.clock.advance(1000);
    await fixture.source.refresh();
    await until(fixture.source, () => fixture.source.projection.edges[0]?.tasks[0]?.taskId === "later");
    expect(windows.at(-1)).toBe(openedAt + 1000);
    expect(fixture.source.projection.edges[0]?.tasks[0]?.taskId).toBe(token("task", "later"));
  } finally { await fixture.stop(); }
});

test("mixed board failure keeps positive first-load evidence and retains previous exact window later", async () => {
  const fixture = setup(), second = snapshot([], "second").board;
  fixture.setBoards([fixture.first.board, second]);
  const windows: number[] = [];
  fixture.setRead(async (board, window) => {
    windows.push(window.end);
    if (board.board === "second") throw new DashboardClientError("transport");
    return { ...fixture.first, window };
  });
  try {
    await fixture.source.start(); await fixture.source.refresh();
    expect(fixture.source.projection.edges[0]?.distinctTaskCount).toBe(1);
    expect(fixture.source.projection.nodes.find(node => node.profile.profile === "empty")?.peerPresence.kind).toBe("unknown");
    const originalScope = fixture.source.scopeLabel;
    expect(new Set(windows).size).toBe(1);
    fixture.clock.advance(60_000);
    await fixture.source.refresh();
    expect(fixture.source.scopeLabel).toBe(originalScope);
    expect(fixture.source.projection.edges[0]?.distinctTaskCount).toBe(1);
    expect(fixture.source.projection.coverage.fresh).toBe(false);
  } finally { await fixture.stop(); }
});
