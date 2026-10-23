import { expect, test } from "bun:test";
import { ControlCenterState } from "../src/ui/control-center-state";
import { KanbanViewSession } from "../src/ui/kanban-view-session";
import { connectionId } from "./control-center-state-fixture";
import { faultFixture, gate } from "./dashboard-client-fixture";

test("programmatic navigation waits for decision; cancellation preserves current scope and drafts", async () => {
  const wire = faultFixture(), state = new ControlCenterState(connectionId(), wire.client), session = new KanbanViewSession(state);
  const navigated: unknown[] = [], scope = { board: "default", taskId: "a" };
  try {
    session.bridge.connect(target => navigated.push(target), () => undefined);
    session.navigate("default", "a"); session.drafts.edit(scope, "body", "initial draft");
    const decision = gate<boolean>();
    const pending = session.requestNavigation("other-board", "b", () => decision.promise);
    expect(navigated).toEqual([{ board: "default", taskId: "a" }]);
    session.drafts.edit(scope, "body", "newer draft"); decision.resolve(false);
    expect(await pending).toBe(false); expect(navigated).toHaveLength(1);
    expect(await session.requestNavigation("other-board", "b", async () => true)).toBe(true);
    expect(navigated.at(-1)).toEqual({ board: "other-board", taskId: "b" });
    expect(session.drafts.get(scope, "body", "missing")).toBe("newer draft");
  } finally { session.dispose(); state.dispose(); wire.client.dispose(); await wire.stop(); }
});

test("pending A-B-A navigation and unload reject obsolete approvals without losing drafts", async () => {
  const wire = faultFixture(), state = new ControlCenterState(connectionId(), wire.client), session = new KanbanViewSession(state);
  const navigated: unknown[] = [], first = gate<boolean>(), second = gate<boolean>();
  try {
    session.bridge.connect(target => navigated.push(target), () => undefined);
    session.drafts.edit({ board: "default", taskId: "a" }, "title", "keep");
    const old = session.requestNavigation("other-board", "b", () => first.promise);
    const current = session.requestNavigation("default", "a", () => second.promise);
    second.resolve(true); expect(await current).toBe(true);
    first.resolve(true); expect(await old).toBe(false);
    expect(navigated).toEqual([{ board: "default", taskId: "a" }]);
    const late = gate<boolean>(), pending = session.requestNavigation("other-board", "b", () => late.promise);
    session.dispose(); late.resolve(true); expect(await pending).toBe(false);
    expect(navigated).toHaveLength(1);
  } finally { first.resolve(false); second.resolve(false); session.dispose(); state.dispose(); wire.client.dispose(); await wire.stop(); }
});
