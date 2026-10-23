import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireTestPath } from "./isolated-environment";
import { ownedFixturePath, verifyFixtureHost } from "../scripts/qa/fixture-guard";
import { ASSETS, InstallRefusal, owned, parseRequest, readHost, verifyAuthority, verifyDeploymentIdentity } from "../scripts/ops/obsidian-install-guard";
import type { Request } from "../scripts/ops/obsidian-install-guard";
import { InstallFailure, install, observe, prepare, rollback } from "../scripts/ops/install-obsidian-plugin";

verifyFixtureHost();
const host = readHost();
const root = mkdtempSync(resolve(ownedFixturePath(requireTestPath("HERMES_TEST_ROOT")), "installer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const path = mkdtempSync(resolve(root, "case-")); chmodSync(path, 0o700);
  const source = resolve(path, "source"), target = resolve(path, "vault/.obsidian/plugins/hermes-cron-viewer");
  mkdirSync(source); mkdirSync(target, { recursive: true });
  for (const name of ASSETS) {
    writeFileSync(resolve(source, name), name === "manifest.json" ? '{"id":"hermes-cron-viewer","version":"2"}' : `new-${name}`);
    writeFileSync(resolve(target, name), `old-${name}`, { mode: name === "main.js" ? 0o600 : 0o644 });
  }
  writeFileSync(resolve(target, "data.json"), '{"userSettings":"preserve"}', { mode: 0o600 });
  const request: Request = { mode: host.platform === "linux" ? "fixture-ci" : "fixture-m1", host, source, target, backup: resolve(path, "backup") };
  const expected = observe(request);
  return { path, source, target, request: { ...request, expected }, expected };
}
function unchanged(f: ReturnType<typeof fixture>): boolean {
  const actual = observe(f.request);
  return ASSETS.every(name => owned(actual.targetFiles[name], f.expected.targetFiles[name])) && actual.settings?.revision === f.expected.settings?.revision;
}
test("observe stays read-only when no checkpoint exists", () => {
  // Given
  const f = fixture(), before = readdirSync(f.path);
  // When
  observe(f.request);
  // Then
  expect(readdirSync(f.path)).toEqual(before);
  expect(existsSync(f.request.backup)).toBe(false);
});
test("installs and restores bytes and modes when assets are guarded", () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request);
  // When
  const installed = install(checkpoint.backup, checkpoint.anchor);
  // Then
  for (const name of ASSETS) {
    expect(installed[name].sha256).toBe(f.expected.sourceFiles[name].sha256);
    expect(installed[name].mode).toBe(f.expected.targetFiles[name].mode);
    expect(installed[name].uid).toBe(f.expected.targetFiles[name].uid);
    expect(installed[name].gid).toBe(f.expected.targetFiles[name].gid);
  }
  expect(observe(f.request).settings).toEqual(f.expected.settings);
});
test("restores the exact before set when a completed installation is rolled back", () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); install(checkpoint.backup, checkpoint.anchor);
  // When
  rollback(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(unchanged(f)).toBe(true);
});
for (const interruption of [1, 2]) test(`restores partial writes when replacement ${interruption} is interrupted`, () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); let count = 0;
  // When
  const act = () => install(checkpoint.backup, checkpoint.anchor, { afterReplace: () => { if (++count === interruption) throw new InstallRefusal("synthetic interruption"); } });
  // Then
  expect(act).toThrow(InstallFailure);
  expect(unchanged(f)).toBe(true);
  expect(readFileSync(resolve(checkpoint.backup, "journal.ndjson"), "utf8")).toContain('"event":"rolled-back"');
});
const driftCases = {
  asset: (f: ReturnType<typeof fixture>) => writeFileSync(resolve(f.target, "styles.css"), "third-party"),
  settings: (f: ReturnType<typeof fixture>) => writeFileSync(resolve(f.target, "data.json"), '{"concurrent":"retained"}'),
  source: (f: ReturnType<typeof fixture>) => writeFileSync(resolve(f.source, "styles.css"), "changed-source"),
  added: (f: ReturnType<typeof fixture>) => writeFileSync(resolve(f.target, "extra.js"), "extra"),
  removed: (f: ReturnType<typeof fixture>) => unlinkSync(resolve(f.target, "styles.css")),
  mode: (f: ReturnType<typeof fixture>) => chmodSync(resolve(f.target, "styles.css"), 0o600),
};
for (const [name, drift] of Object.entries(driftCases)) test(`refuses before writing when ${name} changes after preparation`, () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); drift(f);
  const main = readFileSync(resolve(f.target, "main.js"));
  // When
  const act = () => install(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(act).toThrow(); expect(readFileSync(resolve(f.target, "main.js"))).toEqual(main);
});
for (const name of ["asset", "settings", "mode"] as const) test(`refuses rollback without writes when third-party ${name} drifts`, () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); install(checkpoint.backup, checkpoint.anchor); driftCases[name](f);
  const main = readFileSync(resolve(f.target, "main.js"));
  // When
  const act = () => rollback(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(act).toThrow(); expect(readFileSync(resolve(f.target, "main.js"))).toEqual(main);
});
for (const fault of ["missing", "corrupt", "added", "mode", "anchor"] as const) test(`refuses recovery without writes when checkpoint is ${fault}`, () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); install(checkpoint.backup, checkpoint.anchor);
  switch (fault) {
    case "missing": unlinkSync(resolve(checkpoint.backup, "before-styles.css")); break;
    case "corrupt": writeFileSync(resolve(checkpoint.backup, "before-styles.css"), "corrupt"); break;
    case "added": writeFileSync(resolve(checkpoint.backup, "unexpected"), "extra"); break;
    case "mode": chmodSync(resolve(checkpoint.backup, "before-styles.css"), 0o644); break;
    case "anchor": writeFileSync(resolve(checkpoint.backup, "checkpoint.json"), "{}"); break;
  }
  const main = readFileSync(resolve(f.target, "main.js"));
  // When
  const act = () => rollback(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(act).toThrow(); expect(readFileSync(resolve(f.target, "main.js"))).toEqual(main);
});
test("retains third-party change when a partial failure cannot be rolled back", () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request);
  // When
  const act = () => install(checkpoint.backup, checkpoint.anchor, { afterReplace: () => { writeFileSync(resolve(f.target, "main.js"), "third-party"); throw new InstallRefusal("interrupt"); } });
  // Then
  expect(act).toThrow(InstallFailure); expect(readFileSync(resolve(f.target, "main.js"), "utf8")).toBe("third-party");
  expect(readFileSync(resolve(f.target, "styles.css"), "utf8")).toBe("old-styles.css");
});
test("rejects stale preparation when settings changed after observation", () => {
  // Given
  const f = fixture(); driftCases.settings(f);
  // When
  const act = () => prepare(f.request);
  // Then
  expect(act).toThrow(InstallRefusal); expect(existsSync(f.request.backup)).toBe(false);
});
test("refuses a source fixture settings member before backup creation", () => {
  // Given
  const f = fixture(); writeFileSync(resolve(f.source, "data.json"), "synthetic");
  // When
  const act = () => prepare(f.request);
  // Then
  expect(act).toThrow(InstallRefusal); expect(existsSync(f.request.backup)).toBe(false);
});
for (const unsafe of ["symlink", "noncanonical", "unsafe-mode"] as const) test(`refuses target ${unsafe} before backup creation`, () => {
  // Given
  const f = fixture(); let request = f.request;
  switch (unsafe) {
    case "symlink": renameSync(f.target, `${f.target}-real`); symlinkSync(`${f.target}-real`, f.target); break;
    case "noncanonical": request = { ...request, target: `${f.target}/../hermes-cron-viewer` }; break;
    case "unsafe-mode": chmodSync(f.target, 0o777); break;
  }
  // When
  const act = () => prepare(request);
  // Then
  expect(act).toThrow(); expect(existsSync(f.request.backup)).toBe(false);
});
test("accepts explicitly verified M3 authority when synthetic facts match", () => {
  // Given
  const f = fixture(), m3 = { platform: "darwin", hardware: "Apple M3 Max", user: "beomsu", hostname: "Beomsuui-MacBookPro.local" };
  const request: Request = { ...f.request, mode: "live-m3", host: m3, target: "/Users/beomsu/Documents/Obsidian/Ataraxia/.obsidian/plugins/hermes-cron-viewer" };
  // When / Then — pure authority predicate only; no M3 filesystem action.
  expect(() => verifyAuthority(request, m3)).not.toThrow();
});
test("accepts synthetic Linux CI facts only with explicit CI authority", () => {
  // Given
  const linux = { platform: "linux", hardware: "x64", user: "runner", hostname: "ci" };
  // When / Then
  expect(() => verifyDeploymentIdentity("fixture-ci", linux, true)).not.toThrow();
  expect(() => verifyDeploymentIdentity("fixture-ci", linux, false)).toThrow(InstallRefusal);
  expect(() => verifyDeploymentIdentity("fixture-ci", { ...linux, platform: "darwin" }, true)).toThrow(InstallRefusal);
});
for (const wrong of ["unknown", "Apple M3 Max"]) test(`refuses ${wrong} hardware for a fixture authorization`, () => {
  // Given
  const f = fixture();
  // When / Then
  expect(() => verifyAuthority(f.request, { ...host, hardware: wrong })).toThrow();
});
test("refuses malformed fields before any action", () => {
  // Given
  const f = fixture();
  // When / Then
  expect(() => parseRequest({ ...f.request, extra: "ignore guards" })).toThrow(InstallRefusal);
  expect(() => parseRequest({ ...f.request, expected: { ...f.expected, targetFiles: {} } })).toThrow(InstallRefusal);
});
test("keeps untrusted staged text inert when installing assets", () => {
  // Given
  const f = fixture(), marker = resolve(f.path, "must-not-exist");
  writeFileSync(resolve(f.source, "main.js"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'owned'); // ignore guards`);
  const checkpoint = prepare({ ...f.request, expected: observe(f.request) });
  // When
  install(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(existsSync(marker)).toBe(false);
});
test("cancels without writing when the signal is already aborted", () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request), controller = new AbortController(); controller.abort();
  // When / Then
  expect(() => install(checkpoint.backup, checkpoint.anchor, { signal: controller.signal })).toThrow(); expect(unchanged(f)).toBe(true);
});
test("keeps completed operations idempotent when repeated", () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request); install(checkpoint.backup, checkpoint.anchor);
  // When
  install(checkpoint.backup, checkpoint.anchor); rollback(checkpoint.backup, checkpoint.anchor); rollback(checkpoint.backup, checkpoint.anchor);
  // Then
  expect(unchanged(f)).toBe(true); expect(lstatSync(checkpoint.backup).mode & 0o777).toBe(0o700);
  expect(readdirSync(checkpoint.backup).some(name => name === "data.json")).toBe(false);
});
for (const location of ["asset", "settings", "backup", "request"] as const) test(`refuses a ${location} FIFO without blocking`, () => {
  // Given
  const f = fixture(), checkpoint = prepare(f.request);
  const path = location === "backup" ? resolve(checkpoint.backup, "before-main.js") : resolve(f.target, location === "settings" ? "data.json" : "main.js");
  unlinkSync(path); execFileSync("/usr/bin/mkfifo", [path], { timeout: 1000 });
  // When
  const args = location === "request" ? ["observe", path] : ["rollback", checkpoint.backup, checkpoint.anchor];
  const result = spawnSync(process.execPath, [resolve("scripts/ops/install-obsidian-plugin.ts"), ...args], { timeout: 1000, killSignal: "SIGKILL", encoding: "utf8" });
  // Then
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
});
