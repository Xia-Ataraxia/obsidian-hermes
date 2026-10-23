import { expect, test } from "bun:test";
import { projectTaskActivity } from "../src/domain/task-activity-projector";
import { ProfilesCanvasLayout, activityWindow, canvasViewport, edgeOpacity, peerLabel, sketchPath } from "../src/ui/profiles-canvas-model";
import { CANVAS_DEFAULT_FILTERS } from "../src/types/profiles-canvas";
import { cycle, input, profile, snapshot } from "./task-activity-projector-fixture";

test("dragged positions and anchored zoom survive roster refresh and ordering changes", () => {
  const layout = new ProfilesCanvasLayout();
  const xia = profile("xia"), empty = profile("empty");
  layout.point(xia); layout.move(xia, { x: 312, y: 144 });
  layout.point(empty);
  layout.zoom(2, { x: 400, y: 200 });
  const before = layout.viewport;
  const metadata = layout.metadata([empty, xia], CANVAS_DEFAULT_FILTERS);
  const restored = new ProfilesCanvasLayout(metadata);
  expect(restored.point(xia)).toEqual({ x: 312, y: 144 });
  expect(restored.viewport).toEqual(before);
  expect((400 - before.x) / before.zoom).toBe(400);
  expect((200 - before.y) / before.zoom).toBe(200);
  layout.move(xia, { x: Infinity, y: -1e9 });
  expect(layout.point(xia)).toEqual({ x: 0, y: -100000 });
  expect(canvasViewport({ x: NaN, y: Infinity, zoom: NaN })).toEqual({ x: 0, y: 0, zoom: 1 });
});

test("one task with three events renders a one-task label and stable monotonic darkness", () => {
  const projection = projectTaskActivity(input());
  const edge = projection.edges[0];
  if (!edge) throw new TypeError("Missing synthetic edge");
  expect([edge.distinctTaskCount, edge.events.length]).toEqual([1, 3]);
  const opacity = edgeOpacity(edge.distinctTaskCount);
  projectTaskActivity(input([snapshot(cycle), snapshot(cycle, "other")]));
  expect(edgeOpacity(1)).toBe(opacity);
  expect([1, 2, 3, 30, 100].map(edgeOpacity)).toEqual([1, 2, 3, 30, 100].map(edgeOpacity).sort((a, b) => a - b));
  const line = sketchPath("pair", { x: 1, y: 2 }, { x: 3, y: 4 });
  expect(sketchPath("pair", { x: 1, y: 2 }, { x: 3, y: 4 })).toBe(line);
});

test("partial and self-only observations cannot produce absence labels", () => {
  const full = snapshot(cycle);
  const partial = projectTaskActivity(input([{ ...full, coverage: { kind: "incomplete", reasons: ["row-cap"] } }]));
  expect(partial.nodes.find(node => node.profile.profile === "empty")?.peerPresence.kind).toBe("unknown");
  expect(partial.nodes.map(peerLabel)).toContain("연결 여부 판단 불가");
  const self = projectTaskActivity(input([snapshot([{ eventId: "1", taskId: "self", type: "review", source: "xia", target: "xia" }])]));
  expect(self.nodes.map(peerLabel)).toContain("자기 / 외부 활동만 관찰됨");
  expect(self.edges).toHaveLength(0);
});

test("saved metadata contains layout and filter IDs without fetched entities or events", () => {
  const layout = new ProfilesCanvasLayout();
  const result = layout.metadata(input().roster.profiles, CANVAS_DEFAULT_FILTERS);
  expect(Object.keys(result).sort()).toEqual(["filters", "positions", "view", "viewport"]);
  expect(JSON.stringify(result)).not.toMatch(/events|taskId|body|token|SOUL/);
  expect(activityWindow(CANVAS_DEFAULT_FILTERS, 2_000_000_000_000)).toEqual({ preset: 30, start: 2_000_000_000_000 - 30 * 86_400_000, end: 2_000_000_000_000 });
});
