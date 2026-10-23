import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { isRecord } from "./qa/fixture-guard";

export type TestEntry = { readonly path: string; readonly scope: "isolated" | "environment-dependent" | "live-read-only"; readonly runner: "bun" | "python-unittest"; readonly reason: string };
const TEST_PATH = /^tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:test|spec)\.(?:ts|tsx|js|mjs|py)$/;
export function testFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", ".git", ".omo"].includes(entry.name)) continue;
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`Test symlink refused: ${relative(root, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (/\.(test|spec)\.(ts|tsx|js|mjs|py)$/.test(entry.name)) files.push(relative(root, full));
    }
  };
  walk(root);
  return files.sort();
}
export function readManifest(root: string): readonly TestEntry[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(root, "tests/test-scope-manifest.json"), "utf8"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.tests) || Object.keys(raw).sort().join() !== "schemaVersion,tests") throw new TypeError("Malformed test manifest");
  const entries = raw.tests.map((entry: unknown): TestEntry => {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== "path,reason,runner,scope" || typeof entry.path !== "string" || !TEST_PATH.test(entry.path) || typeof entry.reason !== "string" || entry.reason.length < 1 || entry.reason.length > 500) throw new TypeError("Malformed test manifest path/entry");
    if (entry.scope !== "isolated" && entry.scope !== "environment-dependent" && entry.scope !== "live-read-only") throw new TypeError("Malformed test scope");
    if (entry.runner !== "bun" && entry.runner !== "python-unittest") throw new TypeError("Malformed test runner");
    if ((entry.runner === "python-unittest") !== entry.path.endsWith(".py")) throw new TypeError("Test runner extension mismatch");
    const full = resolve(root, entry.path);
    if (lstatSync(full).isSymbolicLink() || realpathSync(full) !== full) throw new TypeError("Test path must be canonical");
    return { path: entry.path, scope: entry.scope, runner: entry.runner, reason: entry.reason };
  });
  const actual = testFiles(root);
  const listed = entries.map(entry => entry.path).sort();
  if (new Set(listed).size !== listed.length || JSON.stringify(actual) !== JSON.stringify(listed)) throw new TypeError(`Unclassified or duplicate test files: ${actual.filter(path => !listed.includes(path)).join(", ")}`);
  return entries;
}
