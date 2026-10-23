import { requireTestPath } from "./isolated-environment";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, ownedFixturePath, verifyFixtureHost, verifyIdentity, verifyVault } from "../scripts/qa/fixture-guard";
import { prepareVault } from "../scripts/qa/fixture-vault";
import { startDashboardFixture } from "./fixtures/dashboard-fixture-server";

verifyFixtureHost();
const parent = ownedFixturePath(requireTestPath("HERMES_TEST_ROOT"));
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(resolve(parent, "run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("fixture isolation", () => {
  test("rejects synthetic wrong hardware before target mutation", () => {
    const path = resolve(root, "wrong-host");
    const act = () => { verifyIdentity({ platform: "darwin", hardware: "Apple M3 Pro", user: "beomsu", hostname: "xia.local" }); mkdirSync(path); };
    expect(act).toThrow(FixtureRefusal);
    expect(existsSync(path)).toBe(false);
  });
  test("rejects real-home path before mutation", () => {
    expect(() => ownedFixturePath("/Users/beomsu/.hermes")).toThrow(FixtureRefusal);
  });
  test("rejects symlink escape including dangling targets", () => {
    symlinkSync(resolve(root, "absent"), resolve(root, "escape"));
    expect(() => ownedFixturePath(resolve(root, "escape/child"))).toThrow(FixtureRefusal);
  });
  test("rejects synthetic sync enabled vault before asset write", () => {
    const vault = resolve(root, "synced");
    mkdirSync(resolve(vault, ".obsidian"), { recursive: true });
    writeFileSync(resolve(vault, ".obsidian/core-plugins.json"), '["sync"]');
    expect(() => prepareVault(vault, resolve(root, "absent-assets"))).toThrow(FixtureRefusal);
    expect(existsSync(resolve(vault, ".obsidian/plugins"))).toBe(false);
  });
  test("preserves fixture settings and notes when refreshing assets", () => {
    const assets = resolve(root, "assets");
    mkdirSync(assets);
    writeFileSync(resolve(assets, "main.js"), "first");
    writeFileSync(resolve(assets, "styles.css"), "first");
    writeFileSync(resolve(assets, "manifest.json"), '{"id":"hermes-cron-viewer"}');
    const vault = resolve(root, "HermesQA");
    prepareVault(vault, assets);
    const data = resolve(vault, ".obsidian/plugins/hermes-cron-viewer/data.json");
    writeFileSync(data, '{"syntheticState":17}');
    writeFileSync(resolve(vault, "Synthetic.md"), "retained");
    writeFileSync(resolve(assets, "main.js"), "second");
    prepareVault(vault, assets);
    expect(readFileSync(data, "utf8")).toBe('{"syntheticState":17}');
    expect(readFileSync(resolve(vault, "Synthetic.md"), "utf8")).toBe("retained");
    expect(readFileSync(resolve(vault, ".obsidian/plugins/hermes-cron-viewer/main.js"), "utf8")).toBe("second");
  });
  test("refuses dispatch at the HTTP boundary", async () => {
    const fixture = startDashboardFixture({ port: 0, instance: "isolation", shutdown: async () => {} });
    try {
      const origin = `http://127.0.0.1:${fixture.server.port}`;
      const text = await fetch(origin).then(response => response.text());
      const match = text.match(/="([a-f0-9]+)";/);
      if (!match?.[1]) throw new FixtureRefusal("test bootstrap missing");
      const response = await fetch(`${origin}/api/plugins/kanban/dispatch?profile=default&board=default`, { method: "POST", headers: { "X-Hermes-Session-Token": match[1] } });
      expect(response.status).toBe(403);
    } finally { await fixture.stop(); }
  });
});
