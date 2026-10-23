import { expect, test } from "bun:test";
import { ControlCenterTargets } from "../src/ui/control-center-targets";
import { DEFAULT_SETTINGS, type ViewerSettings } from "../src/types/snapshot";
import { gate } from "./dashboard-client-fixture";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";

test("queued discovery generation cannot remain current after plugin unload", async () => {
  verifyFixtureHost();
  const settings = { ...DEFAULT_SETTINGS, servers: ["old"] }, result = gate<void>();
  const targets = new ControlCenterTargets({settings:()=>settings,close:async()=>true,cancel:async()=>undefined,save:async()=>undefined,forget:async()=>undefined});
  const generation = targets.generation("old"); let committed = false;
  const pending = result.promise.then(()=>{if(settings.servers.includes("old") && generation === targets.generation("old")) committed = true;});
  targets.dispose(); result.resolve(); await pending;
  expect(committed).toBe(false);
});

test("target confirmation preserves concurrent settings and rejects duplicate pending changes", async () => {
  verifyFixtureHost();
  let settings: ViewerSettings = { ...DEFAULT_SETTINGS, servers: ["old", "keep"], selectedSources: ["old\u0000default", "keep\u0000default"] };
  const decision = gate<boolean>(), entered = gate<void>(), forgotten: string[] = [];
  const targets = new ControlCenterTargets({ settings: () => settings,
    close: async () => { entered.resolve(); return decision.promise; }, cancel: async () => undefined,
    save: async next => { settings = next; }, forget: async alias => { forgotten.push(alias); },
  });
  const pending = targets.replace("old", "new"); await entered.promise;
  settings = { ...settings, historyLimit: 123, servers: [...settings.servers, "added"] };
  expect(await targets.replace("old", "other")).toEqual({ ok: false, reason: "cancelled" });
  decision.resolve(true); expect(await pending).toEqual({ ok: true, changed: true });
  expect(settings).toMatchObject({ servers: ["new", "keep", "added"], historyLimit: 123, selectedSources: ["keep\u0000default"] });
  expect(forgotten).toEqual(["old"]); expect(targets.generation("old")).toBe(1);
});

test("obsolete target after pending dialog cannot overwrite current registration", async () => {
  verifyFixtureHost();
  let settings: ViewerSettings = { ...DEFAULT_SETTINGS, servers: ["old"] };
  const decision = gate<boolean>(), entered = gate<void>(); let cancelled = 0, writes = 0;
  const targets = new ControlCenterTargets({ settings: () => settings,
    close: async () => { entered.resolve(); return decision.promise; }, cancel: async () => { cancelled++; },
    save: async next => { settings = next; writes++; }, forget: async () => undefined,
  });
  const pending = targets.replace("old", "new"); await entered.promise;
  settings = { ...settings, servers: ["other"] }; decision.resolve(true);
  expect(await pending).toEqual({ ok: false, reason: "unknown" });
  expect({ cancelled, writes, servers: settings.servers }).toEqual({ cancelled: 0, writes: 0, servers: ["other"] });
  targets.dispose(); expect(await targets.replace("other", "new")).toEqual({ ok: false, reason: "cancelled" });
});
