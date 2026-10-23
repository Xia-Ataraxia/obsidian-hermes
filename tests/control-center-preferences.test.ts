import { describe, expect, test } from "bun:test";
import { PREFERENCE_LIMITS, projectControlCenterPreferences } from "../src/domain/control-center-preferences";
import { PreferencesSaveError } from "../src/types/control-center-preferences";
import { ControlCenterPreferencesStore } from "../src/ui/control-center-preferences-store";
import { PluginDataGateway } from "../src/ui/plugin-data-gateway";
import { fixture, forbiddenKeys, layout, token } from "./control-center-preferences-fixtures";

const A = token("connection", "host-a"), B = token("connection", "host-b");

describe("bounded control center preferences", () => {
  test("restores distinct scoped metadata after serialized competing writes and restart", async () => {
    // Given a real gateway adapter paused at its first load.
    const f = fixture({ settings: { interval: 60 }, remoteHomes: { a: "/synthetic" }, store: { version: 1, snapshots: [] } });
    f.adapter.blocked = true;
    const first = f.store.bind(A).save(layout(11));
    await f.adapter.entered.promise;
    const settings = f.gateway.update((data) => ({ ...data, settings: { interval: 120 } }));
    const second = f.store.bind(B).save({ ...layout(77), view: "kanban" });
    // When competing writes complete and a new gateway/store reads the JSON.
    f.adapter.release.resolve();
    await Promise.all([first, settings, second]);
    const restarted = new ControlCenterPreferencesStore(new PluginDataGateway(f.adapter));
    // Then layouts stay scoped and siblings survive the queue.
    expect((await restarted.bind(A).load()).preferences).toEqual(layout(11));
    expect((await restarted.bind(B).load()).preferences).toEqual({ ...layout(77), view: "kanban" });
    expect(JSON.parse(f.adapter.serialized)).toMatchObject({ settings: { interval: 120 }, remoteHomes: { a: "/synthetic" }, store: { version: 1, snapshots: [] } });
  });

  test("returns safe defaults for absent and malformed values", async () => {
    // Given malformed envelopes and metadata fields.
    for (const input of [undefined, null, false, 22, "bad", [], { version: 1, connections: "bad" }]) {
      const f = fixture({ controlCenterPreferences: input });
      // When loading the matching connection.
      const result = await f.store.bind(A).load();
      // Then no input crashes or becomes preference data.
      expect(result).toEqual({ status: "ready", preferences: projectControlCenterPreferences(undefined) });
    }
  });

  test("strips bodies and malformed IDs at every allowed nesting boundary", async () => {
    // Given poison fields mixed with real metadata, including prompt-like external IDs.
    const sentinel = "SYNTHETIC_PRIVATE_BODY";
    const poison = { body: sentinel, token: sentinel, events: [sentinel], draft: sentinel, search: sentinel };
    const f = fixture();
    // When saving through the actual gateway adapter.
    await f.store.bind(A).save({ ...layout(), ...poison,
      positions: [{ profile: "ignore_previous_instructions", x: 1, y: 2, ...poison }, { profile: "$(touch x)", x: 3, y: 4 }],
      viewport: { ...layout().viewport, ...poison }, filters: { ...layout().filters, ...poison },
    });
    // Then valid external IDs remain inert metadata and no unallowlisted fields persist.
    expect(forbiddenKeys(JSON.parse(f.adapter.serialized))).toEqual([]);
    expect(f.adapter.serialized).not.toContain(sentinel);
    expect((await f.store.bind(A).load()).preferences.positions).toEqual([{ profile: token("profile", "ignore_previous_instructions"), x: 1, y: 2 }]);
  });

  test("bounds finite coordinates, zoom, arrays and enum filters", async () => {
    // Given oversized arrays and nonfinite/out-of-range scalars.
    const f = fixture();
    const positions = Array.from({ length: 280 }, (_, i) => ({ profile: `p${i}`, x: 200_000, y: -200_000 }));
    positions[0] = { profile: "nonfinite", x: Number.NaN, y: Number.POSITIVE_INFINITY };
    // When saving oversized metadata.
    await f.store.bind(A).save({ positions, viewport: { x: Number.NaN, y: Infinity, zoom: 99 }, view: "unknown",
      filters: { boards: Array.from({ length: 80 }, (_, i) => `b${i}`), window: -1, types: ["review", "bad", "creation", "review", "transfer"] },
    });
    const result = (await f.store.bind(A).load()).preferences;
    // Then every persisted dimension has the declared bound.
    expect(result.positions).toHaveLength(255);
    expect(result.positions.every((p) => p.x === 100_000 && p.y === -100_000)).toBe(true);
    expect(result.viewport).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(result.filters.boards).toHaveLength(64);
    expect(result.filters.window).toBe(30);
    expect(result.filters.types).toEqual(["review", "creation"]);
    expect(result.view).toBe("profiles");
    expect(projectControlCenterPreferences({ viewport: { zoom: -1 } }).viewport.zoom).toBe(0.25);
  });

  test("deduplicates IDs and rejects tokens outside accepted native bounds", async () => {
    // Given duplicate and invalid identifiers.
    const f = fixture();
    // When projecting and saving them.
    await f.store.bind(A).save({ ...layout(), positions: [
      { profile: "xia", x: 1, y: 2 }, { profile: "xia", x: 3, y: 4 }, { profile: "x".repeat(65), x: 5, y: 6 },
    ], filters: { boards: ["work", "work", "../escape", "b".repeat(65)], window: "all", types: [] } });
    const result = (await f.store.bind(A).load()).preferences;
    // Then each valid ID appears once and empty type selection is preserved.
    expect(result.positions).toEqual([{ profile: token("profile", "xia"), x: 1, y: 2 }]);
    expect(result.filters).toEqual({ boards: [token("board", "work")], window: "all", types: [] });
  });

  test("keeps only the most recently saved bounded connections", async () => {
    // Given more connections than the storage budget.
    const f = fixture();
    // When saving distinct layouts for all of them.
    for (let i = 0; i < 40; i += 1) await f.store.bind(token("connection", `host-${i}`)).save(layout(i));
    // Then retained connections restore correctly and evicted ones use defaults.
    const document = JSON.parse(f.adapter.serialized);
    expect(document.controlCenterPreferences.connections).toHaveLength(PREFERENCE_LIMITS.connections);
    expect((await f.store.bind(token("connection", "host-39")).load()).preferences.positions[0]?.x).toBe(39);
    expect((await f.store.bind(token("connection", "host-0")).load()).preferences.positions).toEqual([]);
  });

  test("refuses unsupported versions without any preference write or data loss", async () => {
    // Given opaque future/unknown schema data already on disk.
    for (const version of [2, 0, "1", null]) {
      const f = fixture({ controlCenterPreferences: { version, opaque: { token: "SYNTHETIC_FUTURE" } } });
      const before = f.adapter.serialized;
      // When reading, attempting save and attempting removal.
      const result = await f.store.bind(A).load();
      const writes = await Promise.allSettled([f.store.bind(A).save(layout()), f.store.remove(A)]);
      // Then defaults are explicit and the opaque original remains byte-for-byte unchanged.
      expect(result.status).toBe("unsupported-version");
      expect(result.preferences.positions).toEqual([]);
      expect(writes.every((entry) => entry.status === "rejected" && entry.reason instanceof PreferencesSaveError && entry.reason.code === "unsupported-version")).toBe(true);
      expect(f.adapter.serialized).toBe(before);
      expect(f.adapter.writes).toBe(0);
    }
  });

  test("rechecks the version inside the queue after a competing upgrade", async () => {
    // Given a version replacement queued before the preference save.
    const f = fixture();
    const upgrade = f.gateway.update((data) => ({ ...data, controlCenterPreferences: { version: 9, future: true } }));
    // When an earlier bound view attempts to save.
    const save = f.store.bind(A).save(layout());
    await upgrade;
    // Then its stale write is refused against the current serialized document.
    await expect(save).rejects.toMatchObject({ code: "unsupported-version" });
    expect(JSON.parse(f.adapter.serialized).controlCenterPreferences).toEqual({ version: 9, future: true });
  });

  test("recovers the queue after repeated rejected writes", async () => {
    // Given an adapter that rejects its next two writes.
    const f = fixture();
    f.adapter.failures = 2;
    // When two saves reject and a third retries.
    const results = await Promise.allSettled([f.store.bind(A).save(layout(1)), f.store.bind(A).save(layout(2)), f.store.bind(A).save(layout(3))]);
    // Then the caller sees both failures and the later save succeeds.
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect((await f.store.bind(A).load()).preferences.positions[0]?.x).toBe(3);
  });

  test("captures connection and input snapshot before deferred queue execution", async () => {
    // Given a save callback for A followed by a current-target switch to B.
    const f = fixture();
    let current = A;
    const callback = f.store.bind(current).save;
    f.adapter.blocked = true;
    const input = { ...layout(31), positions: [{ profile: token("profile", "xia"), x: 31, y: 9 }] };
    const pending = callback(input);
    await f.adapter.entered.promise;
    current = B;
    input.positions.splice(0, 1, { profile: token("profile", "xia"), x: 999, y: 9 });
    // When the old callback completes after the switch.
    f.adapter.release.resolve();
    await pending;
    // Then A receives the captured metadata and B remains untouched.
    expect((await f.store.bind(A).load()).preferences.positions[0]?.x).toBe(31);
    expect((await f.store.bind(current).load()).preferences.positions).toEqual([]);
  });

  test("rejects queued saves after repeated disposal and allows replacement scope", async () => {
    // Given a paused queue and an old bound view.
    const f = fixture();
    f.adapter.blocked = true;
    const settings = f.gateway.update((data) => ({ ...data, settings: { retained: true } }));
    await f.adapter.entered.promise;
    const old = f.store.bind(A);
    const save = old.save(layout());
    old.dispose(); old.dispose();
    // When the queue resumes and a new binding saves.
    f.adapter.release.resolve();
    await settings;
    await expect(save).rejects.toMatchObject({ code: "disposed" });
    await f.store.bind(A).save(layout(44));
    // Then no disposed write persists and repeated use is rejected.
    expect(f.adapter.writes).toBe(2);
    await expect(old.save(layout())).rejects.toMatchObject({ code: "disposed" });
    await expect(old.load()).rejects.toMatchObject({ code: "disposed" });
    expect((await f.store.bind(A).load()).preferences.positions[0]?.x).toBe(44);
  });

  test("removes only the replaced connection while preserving other settings", async () => {
    // Given saved layouts for both connections.
    const f = fixture({ settings: { retained: true } });
    await f.store.bind(A).save(layout(1));
    await f.store.bind(B).save(layout(2));
    // When composition removes a known replaced connection.
    await f.store.remove(A);
    // Then only that scope resets.
    expect((await f.store.bind(A).load()).preferences.positions).toEqual([]);
    expect((await f.store.bind(B).load()).preferences.positions[0]?.x).toBe(2);
    expect(JSON.parse(f.adapter.serialized).settings).toEqual({ retained: true });
  });
});
