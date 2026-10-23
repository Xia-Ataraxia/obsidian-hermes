import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { FixtureRefusal, isRecord, ownedPath, verifyHost } from "./fixture-guard";
import { prepareVault } from "./fixture-vault";
import { launchNative } from "./fixture-native";
import { referenceAssets } from "./fixture-reference";
import { portHostAssets } from "./fixture-port-host";
import { cancellationGuard } from "./fixture-process";
import { parseScenario, startDashboardFixture } from "../../tests/fixtures/dashboard-fixture-server";

type Receipt = { readonly root: string; readonly instance: string; readonly port: number; readonly pid: number };
function receipt(value: unknown, root: string): Receipt {
  if (!isRecord(value) || value.root !== root || typeof value.instance !== "string" || typeof value.port !== "number" || value.port < 1 || value.port > 65535 || typeof value.pid !== "number") throw new FixtureRefusal("invalid lifecycle receipt");
  return { root, instance: value.instance, port: value.port, pid: value.pid };
}
async function authenticate(state: Receipt) {
  const origin = `http://127.0.0.1:${state.port}`;
  const response = await fetch(origin, { signal: AbortSignal.timeout(3000) });
  const match = (await response.text()).match(/window\.__HERMES_SESSION_TOKEN__=("[a-f0-9]+");/);
  const token: unknown = match?.[1] ? JSON.parse(match[1]) : null;
  if (typeof token !== "string") throw new FixtureRefusal("fixture bootstrap unavailable");
  const headers = { "X-Hermes-Session-Token": token, "X-Fixture-Instance": state.instance };
  const ready: unknown = await fetch(`${origin}/__fixture/ready`, { headers, signal: AbortSignal.timeout(3000) }).then(result => result.json());
  if (!isRecord(ready) || ready.instance !== state.instance || ready.ready !== true) throw new FixtureRefusal("fixture instance mismatch");
  return { origin, headers };
}
async function serve(root: string, port: number, mode: string) {
  const instance = randomBytes(16).toString("hex");
  const controller = new AbortController();
  let native: Awaited<ReturnType<typeof launchNative>> | undefined;
  let fixture: ReturnType<typeof startDashboardFixture> | undefined;
  let stopping = false;
  let initializing = true;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await fixture?.stop();
    await native?.stop();
    rmSync(ownedPath(resolve(root, "lifecycle.json")), { force: true });
    process.exit(0);
  };
  const cancel = () => { controller.abort(); if (!initializing) void shutdown(); };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    native = mode === "native" ? await launchNative(root, randomBytes(32).toString("hex"), controller.signal) : undefined;
    const reference = await referenceAssets();
    const portHost = await portHostAssets(controller.signal);
    controller.signal.throwIfAborted();
    fixture = startDashboardFixture({ port, instance, shutdown, reference, portHost, ...(native ? { native } : {}) });
    const state = { event: "ready", root, instance, port: fixture.server.port, pid: process.pid, mode, nativePid: native?.pid ?? null, nativeOrigin: native?.origin ?? null };
    writeFileSync(ownedPath(resolve(root, "lifecycle.json")), JSON.stringify(state), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(state));
    if (native) void native.exited.then(() => shutdown());
  } catch (error) { await fixture?.stop(); await native?.stop(); throw error; }
  finally { initializing = false; if (controller.signal.aborted) await shutdown(); }
}
async function start(root: string, port: number, mode: string) {
  if (existsSync(resolve(root, "lifecycle.json"))) throw new FixtureRefusal("fixture already registered; stop it before starting");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const log = openSync(ownedPath(resolve(root, "lifecycle.stderr.log")), "a", 0o600);
  const child = spawn(process.execPath, [import.meta.path, "serve", "--root", root, "--port", String(port), "--mode", mode], {
    detached: true, stdio: ["ignore", "pipe", log], env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", TMPDIR: root, NODE_COMPILE_CACHE: resolve(root, "node-cache"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: resolve(root, "bun-cache") },
  });
  closeSync(log);
  const guard = cancellationGuard(child);
  child.once("spawn", () => console.error(JSON.stringify({ event: "serve-spawned", pid: child.pid })));
  const output = child.stdout;
  if (!output) { child.kill("SIGTERM"); throw new FixtureRefusal("fixture child stdout unavailable"); }
  try {
    const state = await new Promise<Receipt>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new FixtureRefusal("fixture startup timeout")), 45_000);
      const lines = createInterface({ input: output });
      child.once("error", reject);
      child.once("exit", code => { clearTimeout(timer); reject(new FixtureRefusal(`fixture exited during startup: ${code}`)); });
      lines.on("line", line => {
        try {
          const value: unknown = JSON.parse(line);
          if (isRecord(value) && value.event === "native-spawned") { console.error(line); return; }
          clearTimeout(timer); lines.close(); resolveReady(receipt(value, root));
        } catch (error) { clearTimeout(timer); lines.close(); reject(error); }
      });
    });
    await authenticate(state);
    if (guard.cancelled) throw new FixtureRefusal("fixture startup cancelled");
    guard.release();
    output.destroy();
    child.unref();
    console.log(JSON.stringify({ event: "started", ...state, mode }));
  } catch (error) { await guard.stop(); throw error; }
  finally { guard.release(); }
}
async function main() {
  const args = parseArgs({ allowPositionals: true, options: { help: { type: "boolean" }, root: { type: "string", default: ".omo/qa/hermes" }, port: { type: "string", default: "19129" }, mode: { type: "string", default: "deterministic" }, scenario: { type: "string" }, path: { type: "string", default: ".omo/qa/HermesQA" }, assets: { type: "string", default: "." } } });
  if (args.values.help) { console.log("fixture.ts start [--root .omo/qa/hermes] [--port 19129] [--mode deterministic|native]\nfixture.ts control --scenario reset|delay|error|expire-auth|disconnect|partial-patch|unknown-attribution|review-cycle\nfixture.ts stop [--root .omo/qa/hermes]\nfixture.ts prepare-vault [--path .omo/qa/HermesQA] [--assets .]"); return; }
  verifyHost();
  const command = args.positionals[0];
  if (args.positionals.length !== 1) throw new FixtureRefusal("one lifecycle command required");
  const root = ownedPath(args.values.root);
  const port = Number(args.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FixtureRefusal("invalid fixture port");
  const mode = args.values.mode;
  if (mode !== "native" && mode !== "deterministic") throw new FixtureRefusal("invalid fixture mode");
  switch (command) {
    case "prepare-vault": console.log(JSON.stringify(prepareVault(args.values.path, args.values.assets))); return;
    case "start": await start(root, port, mode); return;
    case "serve": await serve(root, port, mode); return;
    case "control": case "stop": {
      const state = receipt(JSON.parse(readFileSync(ownedPath(resolve(root, "lifecycle.json")), "utf8")), root);
      const session = await authenticate(state);
      let watcher: ReturnType<typeof watch> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = command === "stop" ? new Promise<void>((resolveStopped, reject) => {
        watcher = watch(root, (_event, name) => { if (name === "lifecycle.json" && !existsSync(resolve(root, "lifecycle.json"))) resolveStopped(); });
        timer = setTimeout(() => reject(new FixtureRefusal("fixture shutdown timeout")), 7000);
      }) : Promise.resolve();
      try {
      const response = await fetch(`${session.origin}/__fixture/${command}`, { method: "POST", headers: { ...session.headers, "content-type": "application/json" }, body: JSON.stringify(command === "control" ? { scenario: parseScenario(args.values.scenario) } : {}), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new FixtureRefusal(`fixture ${command} refused: ${response.status}`);
      await stopped;
      console.log(JSON.stringify({ event: command, root, status: response.status })); return;
      } finally { watcher?.close(); clearTimeout(timer); }
    }
    default: throw new FixtureRefusal("expected start, control, stop or prepare-vault");
  }
}
if (import.meta.main) main().catch(error => {
  console.error(JSON.stringify({ event: "fixture-failed", error: error instanceof Error ? error.message : "unknown failure" }));
  process.exitCode = 1;
});
