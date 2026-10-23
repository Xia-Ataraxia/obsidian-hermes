import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ownedFixturePath, verifyFixtureHost, verifyHost } from "./qa/fixture-guard";
import { readManifest } from "./test-manifest";
import { buildSeal } from "./test-build-seal";
import { runTestProcess } from "./test-process";
import contracts from "../tests/fixtures/contract-source-manifest.json";

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "isolated" && mode !== "live-read-only" || process.argv.length !== 3) throw new TypeError("Usage: test-runner.ts isolated|live-read-only");
  const host = mode === "isolated" ? verifyFixtureHost() : verifyHost();
  const root = process.cwd();
  const entries = readManifest(root);
  const selected = entries.filter(entry => mode === "isolated" ? entry.scope !== "live-read-only" : entry.scope === mode);
  const requestedRoot = process.env.HERMES_TEST_ROOT;
  if (!requestedRoot) throw new TypeError("HERMES_TEST_ROOT required beneath owned temporary namespace");
  const parent = ownedFixturePath(requestedRoot);
  mkdirSync(parent, { recursive: true });
  const run = mkdtempSync(resolve(parent, "run-"));
  const evidence = resolve(run, "evidence"); mkdirSync(evidence);
  const temporary = resolve(run, "temporary"); mkdirSync(temporary);
  const commandLog = resolve(evidence, "commands.log");
  const results: { path: string; tests: number; innerExit: number }[] = [];
  let complete = false;
  const env: NodeJS.ProcessEnv = {
    ...(mode === "live-read-only" ? process.env : { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: temporary, ...(process.env.CI === "true" ? { CI: "true" } : {}) }),
    HERMES_TEST_ROOT: temporary, HERMES_TEST_PYTHON: process.env.HERMES_TEST_PYTHON,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, NO_COLOR: "1", FORCE_COLOR: "0",
  };
  const execute = (argv: readonly string[]) => runTestProcess({ argv, env, log: commandLog });
  try {
    if (readFileSync(".omo/test/build.sha256", "utf8").trim() !== buildSeal(root)) throw new TypeError("Stale build: run bun run build before tests");
    if (mode === "isolated") {
      const python = process.env.HERMES_TEST_PYTHON;
      if (!python || !existsSync(python)) throw new TypeError("HERMES_TEST_PYTHON owned exact Python prerequisite is missing");
      ownedFixturePath(dirname(dirname(python)));
      const checked = await execute([python, "-I", resolve("scripts/qa/verify-native-environment.py"), "--root", dirname(dirname(python))]);
      if (checked.code !== 0) throw new TypeError(`Python prerequisite failed: inner exit ${checked.code}`);
      const sqlite = await execute(["/usr/bin/sqlite3", "--version"]);
      if (sqlite.code !== 0) throw new TypeError("SQLite prerequisite failed");
      const source = resolve(temporary, "contract-source");
      for (const pin of contracts.files) {
        if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(pin.path) || pin.path.split("/").includes("..")) throw new TypeError("Invalid pinned source path");
        const from = resolve("tests/fixtures/contract-source", pin.path);
        if (createHash("sha256").update(readFileSync(from)).digest("hex") !== pin.sha256) throw new TypeError(`Pinned source mismatch: ${pin.path}`);
        const to = resolve(source, pin.path); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to);
      }
      env.HERMES_CONTRACT_SOURCE = source;
    }
    for (const entry of selected) {
      const argv = entry.runner === "bun" ? [process.execPath, "test", `./${entry.path}`] : [env.HERMES_TEST_PYTHON ?? "", "-I", entry.path, "-v"];
      const result = await execute(argv);
      const count = entry.runner === "bun" ? result.text.match(/Ran (\d+) tests? across/) : result.text.match(/Ran (\d+) tests?/);
      const tests = Number(count?.[1] ?? 0);
      results.push({ path: entry.path, tests, innerExit: result.code });
      if (result.code !== 0 || tests < 1 || /[1-9]\d* (?:skip|todo)|skipped=|\((?:skip|todo)\)/.test(result.text)) throw new TypeError(`Test gate failed: ${entry.path}; inner exit ${result.code}; expanded ${tests}`);
    }
    complete = true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    const receipt = { host, mode, complete, classifiedFiles: entries.length, selectedFiles: selected.length, executedFiles: results.length, expandedTests: results.reduce((sum, row) => sum + row.tests, 0), results, cleanup: { temporaryRemoved: true }, commandLog };
    writeFileSync(resolve(evidence, "test-inventory.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ event: "isolated-regression", ...receipt, evidence }));
  }
}
if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Unknown regression runner failure");
  process.exitCode = 1;
});
