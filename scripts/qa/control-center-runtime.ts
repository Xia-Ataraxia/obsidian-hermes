import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, isRecord, ownedPath } from "./fixture-guard";

export const CONTROL_CENTER_PYTHON = "/private/tmp/hermes-control-center-m1-01a161c0/task-3/lifecycle/workspace/.omo/qa/hermes/python/bin/python";
export const CONTROL_CENTER_SCENARIOS = ["reset", "delay", "delayed-profile", "unavailable-skills", "unavailable-orchestration", "unavailable-profiles", "expire-auth", "partial-activity", "transport-loss", "partial-patch", "lost-response", "external-soul", "malformed", "render-error"] as const;
export type ControlCenterScenario = typeof CONTROL_CENTER_SCENARIOS[number];
export function scenarioAt(root: string): ControlCenterScenario {
  const value: unknown = JSON.parse(readFileSync(resolve(ownedPath(root), "scenario.json"), "utf8"));
  if (!isRecord(value)) throw new FixtureRefusal("fixture scenario object required");
  const result = CONTROL_CENTER_SCENARIOS.find(item => item === value.scenario);
  if (!result) throw new FixtureRefusal("fixture scenario unknown");
  return result;
}
export async function fixtureDelay(signal: AbortSignal, milliseconds = 1800): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolveDone, reject) => {
    const abort = () => { clearTimeout(timer); reject(new FixtureRefusal("fixture operation aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolveDone(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function fixtureProcess(file: string, args: readonly string[], options: {
  readonly root: string; readonly signal?: AbortSignal; readonly stdin?: string; readonly maxBytes: number; readonly timeoutMs: number;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly capExceeded: boolean }> {
  const root = ownedPath(options.root);
  options.signal?.throwIfAborted();
  const child = spawn(file, [...args], { env: { PATH: "/usr/bin:/bin", TMPDIR: root, HOME: `${root}/home`, HERMES_HOME: `${root}/home`, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  let exceeded = false;
  const stop = () => { child.kill("SIGKILL"); };
  const timer = setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) { exceeded = true; stop(); } else chunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdin.end(options.stdin);
  try {
    const exitCode = await new Promise<number | null>((resolveDone, reject) => { child.once("error", reject); child.once("close", resolveDone); });
    options.signal?.throwIfAborted();
    return { stdout: Buffer.concat(chunks).toString(), stderr, exitCode, capExceeded: exceeded };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); }
}
