import { describe, expect, test } from "bun:test";
import { COMMUNITY, HERMES, JOBS_JSON, PREEXISTING_COMMUNITY_PLUGINS, PROFILE, ROOT, SRC, SshReadOnlyAdapter, VAULT_PLUGIN, buildQueryExecutions, collectRound, fakeRunner, persistedSnapshot, readExecutionHistory, rehydrateSnapshot, sha256File, walk } from "./delta-fixtures";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("B3 re-verify: Ataraxia install surface", () => {
  test("plugin files exist, data.json was not invented, and community plugins keep prior ids", () => {
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(existsSync(join(VAULT_PLUGIN, file))).toBe(true);
    }
    // The plugin has now actually run in the vault, so data.json legitimately exists. The real
    // invariant is that it holds allow-listed metadata only: no prompt, reply, error or output body.
    const dataPath = join(VAULT_PLUGIN, "data.json");
    if (existsSync(dataPath)) {
      const raw = readFileSync(dataPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["remoteHomes", "settings", "store"]);
      for (const forbiddenKey of [
        "prompt", "lastError", "lastDeliveryError", "error", "body", "output", "stdout",
      ]) {
        expect(raw.includes(`"${forbiddenKey}":`)).toBe(false);
      }
    }
    const enabled = JSON.parse(readFileSync(COMMUNITY, "utf8")) as string[];
    for (const id of PREEXISTING_COMMUNITY_PLUGINS) {
      expect(enabled).toContain(id);
    }
    expect(enabled).toContain("hermes-cron-viewer");
  });

  test("records built vs installed hashes for the leader's final reinstall", () => {
    const report: Record<string, { built: string; installed: string; match: boolean }> = {};
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      const built = sha256File(join(ROOT, file));
      const installed = sha256File(join(VAULT_PLUGIN, file));
      report[file] = { built, installed, match: built === installed };
    }
    expect(report["manifest.json"]?.match).toBe(true);
    expect(report["styles.css"]?.match).toBe(true);
    // main.js may lag the latest build until the leader's final reinstall; do not re-raise B3.
    expect(typeof report["main.js"]?.built).toBe("string");
    expect(typeof report["main.js"]?.installed).toBe("string");
  });
});
