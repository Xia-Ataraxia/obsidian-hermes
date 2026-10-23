import { expect, test } from "bun:test";
import { ViewerState } from "../src/ui/viewer-state";
import { SshReadOnlyAdapter } from "../src/ui/ssh-read-only-adapter";
import { Logger } from "../src/utils/logger";
import { DEFAULT_SETTINGS } from "../src/types/snapshot";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";
import { PluginDataGateway } from "../src/ui/plugin-data-gateway";
import { SnapshotDiskStore } from "../src/ui/snapshot-disk-store";
import type { PersistedSourceSnapshot } from "../src/types/snapshot";

test("an old target round cannot repopulate state or persistence after settings change", async () => {
  verifyFixtureHost();
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: unknown[] = [];
  const state = new ViewerState(new SshReadOnlyAdapter({ runner: async () => {
    began.resolve();
    await release.promise;
    return { stdout: "", stderr: "synthetic unavailable", exitCode: 1, capExceeded: false };
  } }), { ...DEFAULT_SETTINGS, servers: ["old-target"], selectedSources: ["old-target\u0000default"] }, new Logger());
  state.rememberHome("old-target", "/private/tmp/task20-synthetic");
  state.setPersistSink(async snapshots => { writes.push(snapshots); });
  const pending = state.refresh();
  await began.promise;
  state.setSettings({ ...DEFAULT_SETTINGS, servers: ["new-target"], selectedSources: [] });
  state.restore([]);
  release.resolve();
  await pending;
  expect({ snapshots: state.getSnapshots(), writes }).toEqual({ snapshots: [], writes: [] });
});

test("old finally cannot stop a newer A-B-A round and forced disposal rejects late delivery", async () => {
  verifyFixtureHost();
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let round = 0;
  const settings = { ...DEFAULT_SETTINGS, servers: ["a"], selectedSources: ["a\u0000default"] };
  const state = new ViewerState(new SshReadOnlyAdapter({ runner: async () => {
    const index = round++; started[index]?.resolve(); await gates[index]?.promise;
    return { stdout: "", stderr: "unavailable", exitCode: 1, capExceeded: false };
  } }), settings, new Logger());
  state.rememberHome("a", "/private/tmp/a");
  const old = state.refresh(); await started[0]?.promise;
  state.setSettings({ ...DEFAULT_SETTINGS, servers: ["b"] }); state.setSettings(settings);
  const newer = state.refresh(); await started[1]?.promise;
  gates[0]?.resolve(); await old; expect(state.isRefreshing()).toBe(true);
  state.dispose(); gates[1]?.resolve(); await newer;
  expect(state.getSnapshots()).toEqual([]); expect(state.freshnessEntries()).toEqual([]);
  expect(state.getRemoteHome("a")).toBeUndefined(); expect(state.isRefreshing()).toBe(false);
});

test("queued obsolete projection cannot restore a removed target", async () => {
  verifyFixtureHost();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let data: Record<string, unknown> = {}, current = true;
  const blocker = new PluginDataGateway({ loadData: async () => { entered.resolve(); await release.promise; return data; }, saveData: async next => { data = next; } });
  const store = new SnapshotDiskStore(blocker);
  const snapshot: PersistedSourceSnapshot = { alias: "old", profileId: "default", home: "/private/tmp/old", jobs: [], executions: [], outputFileNames: [], transport: "connected", sourceStatus: "read", lastUpdatedAt: null };
  const pending = store.save([snapshot], () => current);
  await entered.promise; current = false; release.resolve(); await pending;
  expect(await store.load()).toEqual([]);
});
