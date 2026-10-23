import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, ownedFixturePath, verifyFixtureHost, verifyFixtureVault } from "./fixture-guard";

export function prepareVault(raw: string, assets: string) {
  const identity = verifyFixtureHost();
  const path = ownedFixturePath(raw);
  verifyFixtureVault(path);
  const marker = ownedFixturePath(resolve(path, ".hermes-fixture-vault.json"));
  if (existsSync(path) && !existsSync(marker)) throw new FixtureRefusal("existing vault lacks fixture ownership marker");
  if (existsSync(marker) && readFileSync(marker, "utf8") !== JSON.stringify({ version: 1, path })) throw new FixtureRefusal("fixture ownership marker mismatch");
  const files = ["main.js", "manifest.json", "styles.css"].map(name => ({ name, bytes: readFileSync(resolve(assets, name)) }));
  const manifest: unknown = JSON.parse(files.find(file => file.name === "manifest.json")?.bytes.toString() ?? "null");
  if (typeof manifest !== "object" || manifest === null || !("id" in manifest) || manifest.id !== "hermes-cron-viewer") throw new FixtureRefusal("plugin manifest mismatch");
  const plugin = ownedFixturePath(resolve(path, ".obsidian/plugins/hermes-cron-viewer"));
  for (const file of files) ownedFixturePath(resolve(plugin, file.name));
  const fresh = !existsSync(path);
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  if (fresh) {
    writeFileSync(marker, JSON.stringify({ version: 1, path }), { mode: 0o600 });
    writeFileSync(resolve(path, ".obsidian/core-plugins.json"), "[]\n");
    writeFileSync(resolve(path, ".obsidian/community-plugins.json"), '["hermes-cron-viewer"]\n');
    writeFileSync(resolve(path, ".obsidian/app.json"), '{"showUnsupportedFiles":false}\n');
    writeFileSync(resolve(plugin, "data.json"), JSON.stringify({ settings: { servers: ["hermes-fixture"], selectedSources: [], autoRefreshSeconds: 0, persistJobNames: false }, snapshots: [] }));
    writeFileSync(resolve(path, "Welcome.md"), "# Hermes QA\nSynthetic, task-owned vault.\n");
  }
  for (const file of files) writeFileSync(resolve(plugin, file.name), file.bytes);
  return { event: "vault-prepared", identity, path, fresh, files: files.map(file => ({ name: file.name, sha256: createHash("sha256").update(file.bytes).digest("hex") })), transport: "external QA injection required; alias hermes-fixture is intentionally not a live connection" };
}
