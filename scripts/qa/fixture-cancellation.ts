import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, isRecord, ownedPath, verifyHost } from "./fixture-guard";

const identity = verifyHost();
const root = ownedPath(resolve(".omo/qa/hermes"));
const logPath = ownedPath(resolve(root, "lifecycle.stderr.log"));
const results = [];
for (const scenario of [
  { command: "start", mode: "deterministic", event: "serve-spawned", signal: "SIGINT" },
  { command: "start", mode: "native", event: "native-spawned", signal: "SIGTERM" },
  { command: "serve", mode: "native", event: "native-spawned", signal: "SIGTERM" },
] as const) {
  if (existsSync(resolve(root, "lifecycle.json"))) throw new FixtureRefusal("cancellation probe requires stopped fixture");
  writeFileSync(logPath, "");
  const argv = [resolve("scripts/qa/fixture.ts"), scenario.command, "--root", root, "--port", "19129", "--mode", scenario.mode];
  const child = spawn(process.execPath, argv, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let triggered = false;
  const pids = new Set<number>(child.pid ? [child.pid] : []);
  const inspect = () => {
    const text = stderr + stdout + readFileSync(logPath, "utf8");
    for (const line of text.split("\n")) {
      let event: unknown;
      try { event = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (!isRecord(event)) continue;
      if (typeof event.pid === "number") pids.add(event.pid);
      if (event.event === scenario.event && !triggered) {
        triggered = true;
        if (!child.kill(scenario.signal)) throw new FixtureRefusal("cancellation signal was not delivered");
      }
    }
  };
  const watcher = watch(logPath, inspect);
  child.stdout.on("data", chunk => { stdout += String(chunk); inspect(); });
  child.stderr.on("data", chunk => { stderr += String(chunk); inspect(); });
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    const timer = setTimeout(() => {
      for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; } }
      reject(new FixtureRefusal("startup cancellation exceeded 10 seconds"));
    }, 10_000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolveClose({ code, signal }); });
  }).finally(() => watcher.close());
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n");
  const remaining = processes.filter(line => { const [pid, pgid] = line.trim().split(/\s+/).map(Number); return typeof pid === "number" && pids.has(pid) || typeof pgid === "number" && pids.has(pgid); });
  let listenerClosed = false;
  try { await fetch("http://127.0.0.1:19129/__fixture/ready", { signal: AbortSignal.timeout(1000) }); } catch { listenerClosed = true; }
  const passed = triggered && !stdout.includes('"event":"started"') && !stdout.includes('"event":"ready"') && remaining.length === 0 && listenerClosed && !existsSync(resolve(root, "lifecycle.json"));
  results.push({ scenario, argv, triggered, pids: [...pids], closed, remaining, listenerClosed, stdout, stderr, passed });
  if (!passed) throw new FixtureRefusal(JSON.stringify(results));
}
console.log(JSON.stringify({ identity, results }));
