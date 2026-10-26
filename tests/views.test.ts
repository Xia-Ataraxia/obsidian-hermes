import { expect, test } from "bun:test";
import type { SkillInfo } from "../src/hermes/inspect";
import { duration, hint, shows } from "../src/hermes/inspector-common";
import type { Card } from "../src/hermes/kanban";
import { deletion, on } from "../src/hermes/kanban-prefs";
import { hasSchedule } from "../src/ui/cron-empty";
import type { ViewerState } from "../src/ui/viewer-state";

const card = (id: string, status: Card["status"]): Card => ({ id, title: id, status, priority: 0, createdAt: 0 });
const skill = (source: SkillInfo["source"], enabled = true): SkillInfo => ({
  name: "s", rdir: "", category: "", tier: 1, path: "s/SKILL.md", source, owner: "p", enabled, platformOff: [],
  lastUsed: null, uses: 0, description: "", verdict: null, readOnly: null,
});

test("deletion archives open tasks ahead of their purge and purges unknown ids alone", () => {
  expect(deletion(["a", "b", "c"], [card("a", "todo"), card("b", "archived")])).toEqual([
    { verb: "archive", id: "a" }, { verb: "purge", id: "a" }, { verb: "purge", id: "b" }, { verb: "purge", id: "c" },
  ]);
});

test("on reads the lane flag as off only for false, no, off and 0", () => {
  expect(["false", "No", "OFF", "0"].map(on)).toEqual([false, false, false, false]);
  expect([undefined, "true", "1", "yes"].map(on)).toEqual([true, true, true, true]);
});

test("duration formats seconds, minutes and hours", () => {
  expect([duration(-5), duration(59.6), duration(125), duration(3725)]).toEqual(["0s", "1m 0s", "2m 5s", "1h 2m"]);
});

test("hint names what editing a skill means and is null for local skills", () => {
  expect(hint(skill("bundled"))).toContain("hermes skills reset s");
  expect(hint(skill("plugin"))).toContain("plugin p");
  expect(hint(skill("local"))).toBeNull();
});

test("shows filters skills by source, the plugin filter keeps omh, disabled keeps switched-off skills", () => {
  expect(shows(skill("hub"), "all")).toBe(true);
  expect(shows(skill("omh"), "plugin")).toBe(true);
  expect(shows(skill("hub"), "plugin")).toBe(false);
  expect(shows(skill("hub", false), "disabled")).toBe(true);
  expect(shows(skill("hub"), "disabled")).toBe(false);
  expect(shows(skill("local"), "local")).toBe(true);
});

test("a source that failed before its first read is not a schedule", () => {
  const state = (snapshots: { jobs: unknown[]; transport: string }[]) => ({ getSnapshots: () => snapshots }) as unknown as ViewerState;
  expect(hasSchedule(state([]))).toBe(false);
  expect(hasSchedule(state([{ jobs: [], transport: "disconnected" }]))).toBe(false);
  expect(hasSchedule(state([{ jobs: [], transport: "connected" }]))).toBe(true);
  expect(hasSchedule(state([{ jobs: [{}], transport: "disconnected" }]))).toBe(true);
});
