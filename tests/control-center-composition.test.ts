import { expect, test } from "bun:test";
import { ControlCenterConnections } from "../src/ui/control-center-connections";
import { ControlCenterProcesses } from "../src/ui/control-center-processes";
import { guardControlCenterClose } from "../src/ui/control-center-close-guard";
import { ProfileCatalogError } from "../src/types/profile-catalog";
import { SshReadOnlyAdapter } from "../src/ui/ssh-read-only-adapter";
import type { ControlCenterDependencies } from "../src/types/control-center-composition";
import { faultFixture, gate } from "./dashboard-client-fixture";
import { selection } from "./control-center-state-fixture";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";

function setup() {
  const wire = faultFixture();
  let acquisitions = 0, releases = 0, discoveries = 0, failed = false;
  const sessions: AbortController[] = [];
  const dependencies: ControlCenterDependencies = {
    connections: {
      acquire(alias) {
        const controller = new AbortController(); sessions.push(controller); acquisitions++;
        let released = false;
        return { ready: Promise.resolve({ alias, generation: acquisitions, baseUrl: wire.connection.baseUrl, signal: controller.signal }), release: async () => { if (!released) { released = true; releases++; controller.abort(); } } };
      },
      async invalidate() {}, async dispose() { for (const session of sessions) session.abort(); },
    },
    adapter: new SshReadOnlyAdapter({ runner: async () => { throw new Error("unexpected legacy read"); } }),
    async location(connection) { discoveries++; if (failed) throw new ProfileCatalogError("read-failed"); return { connection, root: "/private/tmp/synthetic", sourceRoot: "/private/tmp/native-source" }; },
    metadata() { return { read: async () => { throw new Error("metadata not requested in scope test"); } }; },
    activity() { return { read: async () => { throw new Error("activity not requested in scope test"); }, dispose() {} }; },
  };
  const pool = new ControlCenterConnections(dependencies);
  return { pool, dependencies, failLocation(value: boolean) { failed = value; }, counts: () => ({ acquisitions, releases, discoveries }), async close() { await pool.dispose(); wire.client.dispose(); await wire.stop(); } };
}

for (const reverse of [false, true]) test(`shared visible leaves retain one transport and close in ${reverse ? "reverse" : "creation"} order`, async () => {
  const fixture = setup(), one = fixture.pool.bind("fixture"), two = fixture.pool.bind("fixture");
  try {
    const [a, b] = await Promise.all([one.show(), two.show()]);
    expect(a).toBe(b); expect(fixture.counts().acquisitions).toBe(1);
    const leaf = a.state.createLeaf<string>();
    leaf.selectExternal(selection(async () => "base", value => value))("base", { kind: "fresh", lastSuccessAt: 1 }); leaf.edit("unsaved");
    const first = reverse ? two : one, last = reverse ? one : two;
    await first.dispose(); expect(fixture.counts().releases).toBe(0);
    await last.hide(); expect(fixture.counts().releases).toBe(1);
    expect(leaf.snapshot.draft).toBe("unsaved");
    expect(await last.show()).toBe(a); expect(fixture.counts().acquisitions).toBe(2);
    expect(leaf.snapshot.draft).toBe("unsaved");
    await last.dispose(); await last.dispose();
    expect(fixture.counts().releases).toBe(2);
    expect(leaf.retainedCount).toBe(0);
    expect(() => a.client.resume({ alias: "fixture", generation: 10, baseUrl: "http://127.0.0.1:1", signal: new AbortController().signal })).toThrow();
  } finally { await fixture.close(); }
});

test("transient native location failure retries in the same scope without dropping drafts", async () => {
  const fixture = setup(), binding = fixture.pool.bind("fixture");
  try {
    fixture.failLocation(true);
    const scope = await binding.show(), leaf = scope.state.createLeaf<string>();
    leaf.selectExternal(selection(async () => "base", value => value))("base", { kind: "fresh", lastSuccessAt: 1 }); leaf.edit("local");
    expect(await scope.resolveLocation({})).toBeNull();
    fixture.failLocation(false);
    expect((await scope.resolveLocation({}))?.root).toBe("/private/tmp/synthetic");
    expect(leaf.snapshot.draft).toBe("local");
    expect(fixture.counts()).toEqual({ acquisitions: 1, releases: 0, discoveries: 2 });
    await binding.hide(); expect(await binding.show()).toBe(scope);
    fixture.dependencies.location = async connection => ({ connection, root: "/private/tmp/restarted-dashboard", sourceRoot: "/private/tmp/source" });
    expect((await scope.resolveLocation({}))?.root).toBe("/private/tmp/restarted-dashboard");
    expect(leaf.snapshot.draft).toBe("local");
    fixture.dependencies.location = async connection => ({ connection, root: "/private/tmp/same-wire-new-root", sourceRoot: "/private/tmp/source" });
    expect((await scope.resolveLocation({}))?.root).toBe("/private/tmp/same-wire-new-root");
    fixture.dependencies.location = async () => { throw new ProfileCatalogError("read-failed"); };
    expect(await scope.resolveLocation({})).toBeNull(); expect(scope.location).toBeNull();
    expect(leaf.snapshot.draft).toBe("local");
  } finally { await fixture.close(); }
});

test("late location result after hide cannot become authoritative and programming errors propagate", async () => {
  const fixture = setup(), binding = fixture.pool.bind("fixture"), entered = gate<void>(), release = gate<void>();
  fixture.dependencies.location = async (connection) => { entered.resolve(); await release.promise; return { connection, root: "/private/tmp/late", sourceRoot: "/private/tmp/source" }; };
  try {
    const scope = await binding.show();
    const pending = scope.resolveLocation({}).catch(error => error);
    await entered.promise; await binding.hide(); release.resolve();
    expect((await pending).code).toBe("aborted"); expect(scope.location).toBeNull();
    fixture.dependencies.location = async () => { throw new TypeError("synthetic coding error"); };
    await binding.show();
    await expect(scope.resolveLocation({})).rejects.toBeInstanceOf(TypeError);
  } finally { release.resolve(); await fixture.close(); }
});

test("owned detach guard deduplicates, refuses, preserves receiver and restores original", async () => {
  verifyFixtureHost();
  const decision = gate<boolean>();
  let prompts = 0, detaches = 0;
  const leaf = { detach() { expect(this).toBe(leaf); detaches++; } }, original = leaf.detach;
  const guard = guardControlCenterClose(leaf, () => { prompts++; return decision.promise; }, error => { throw error; });
  leaf.detach(); const pending = guard.close(); expect(prompts).toBe(1);
  decision.resolve(false); expect(await pending).toBe(false); expect(detaches).toBe(0);
  guard.restore(); guard.restore(); expect(leaf.detach).toBe(original);
  leaf.detach(); expect(detaches).toBe(1);
  const late = gate<boolean>(), next = guardControlCenterClose(leaf, () => late.promise, error => { throw error; });
  const accepted = next.close(); next.restore(); late.resolve(true);
  expect(await accepted).toBe(false); expect(detaches).toBe(1);
  let cleaned = 0;
  const success = guardControlCenterClose(leaf, async () => true, error => { throw error; }, async () => { cleaned++; });
  expect(await success.close()).toBe(true); expect(detaches).toBe(2); expect(cleaned).toBe(1);
  success.restore();
});

test("process owner aborts bounded children and permanently refuses work after disposal", async () => {
  verifyFixtureHost();
  const processes = new ControlCenterProcesses();
  const pending = processes.runner("/bin/sh", ["-c", "exec sleep 20", "--", "fixture"], { timeoutMs: 30_000, maxBytes: 1024 });
  await processes.cancel("fixture"); expect((await pending).exitCode).toBeNull();
  expect((await processes.runner("/bin/echo", ["--", "fixture"], { timeoutMs: 1000, maxBytes: 1024 })).exitCode).toBeNull();
  processes.allow(["fixture"]);
  expect((await processes.runner("/bin/sh", ["-c", "printf bounded", "--", "fixture"], { timeoutMs: 1000, maxBytes: 1024 })).stdout).toBe("bounded");
  await processes.dispose(); await processes.dispose();
  expect((await processes.runner("/bin/echo", ["--", "fixture"], { timeoutMs: 1000, maxBytes: 1024 })).exitCode).toBeNull();
});
