import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { FixtureRefusal, isRecord, ownedPath, verifyHost } from "./fixture-guard";
import { referenceAssets } from "./fixture-reference";
import { serveControlCenter } from "./control-center-service";
import { CONTROL_CENTER_PYTHON } from "./control-center-runtime";

export async function startControlCenterFixture(rootInput: string, port: number) {
  const identity = verifyHost();
  const root = ownedPath(rootInput);
  if (existsSync(resolve(root, "lifecycle.json"))) throw new FixtureRefusal("registered fixture already exists");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner = { owner: "task20_fixture", root };
  if (existsSync(resolve(root, "owner.json"))) {
    const previous: unknown = JSON.parse(readFileSync(resolve(root, "owner.json"), "utf8"));
    if (!isRecord(previous) || previous.owner !== owner.owner || previous.root !== root) throw new FixtureRefusal("foreign fixture root");
  }
  writeFileSync(resolve(root, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  writeFileSync(resolve(root, "scenario.json"), JSON.stringify({ scenario: "reset" }), { mode: 0o600 });
  const token = randomBytes(32).toString("hex");
  const child = spawn(CONTROL_CENTER_PYTHON, ["-I", "-B", resolve(import.meta.dir, "control-center-native.py"), root, "0"], { env: { PATH: "/usr/bin:/bin", HERMES_FIXTURE_TOKEN: token }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise(resolveExit => child.once("close", resolveExit));
  let front: ReturnType<typeof serveControlCenter> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    await front?.stop();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    rmSync(resolve(root, "lifecycle.json"), { force: true });
  })();
  const cancel = () => { void stop(); };
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try {
    const native = await new Promise<{ readonly origin: string; readonly pid: number }>((resolveReady, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => { lines.close(); reject(new FixtureRefusal("native startup timeout")); }, 30_000);
      child.once("error", error => { clearTimeout(timer); lines.close(); reject(error); });
      child.once("exit", () => { clearTimeout(timer); lines.close(); reject(new FixtureRefusal("native startup exited")); });
      lines.once("line", line => {
        clearTimeout(timer); lines.close();
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || value.event !== "ready" || value.root !== root || value.pid !== child.pid || typeof value.pid !== "number" || typeof value.port !== "number" || value.host !== "127.0.0.1") throw new FixtureRefusal("invalid native readiness");
          resolveReady({ origin: `http://127.0.0.1:${value.port}`, pid: value.pid });
        } catch (error) { reject(error); }
      });
    });
    const reference = await referenceAssets();
    front = serveControlCenter({ root, port, native: { ...native, token }, reference, shutdown: stop });
    const receipt = { event: "ready", ...owner, identity, port: front.server.port, origin: `http://127.0.0.1:${front.server.port}`, pid: process.pid, nativePid: native.pid, nativeOrigin: native.origin };
    writeFileSync(resolve(root, "lifecycle.json"), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    return { receipt, stop: async () => { await stop(); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); } };
  } catch (error) { await stop(); throw error; }
}

export async function fixtureSession(origin: string) {
  const page = await fetch(origin, { signal: AbortSignal.timeout(3000) }).then(response => response.text());
  const literal = page.match(/window\.__HERMES_SESSION_TOKEN__=("[a-f0-9]+");/)?.[1];
  const token: unknown = literal ? JSON.parse(literal) : null;
  if (typeof token !== "string") throw new FixtureRefusal("fixture bootstrap missing");
  return { headers: { "X-Hermes-Session-Token": token, "content-type": "application/json" } };
}

if (import.meta.main) {
  verifyHost();
  const args = parseArgs({ allowPositionals: true, options: { root: { type: "string" }, port: { type: "string", default: "19129" }, scenario: { type: "string" } } });
  const root = ownedPath(args.values.root ?? "/private/tmp/hermes-control-center-m1-01a161c0/task-20/fixture-worker/native");
  const command = args.positionals[0];
  if (command === "serve") console.log(JSON.stringify((await startControlCenterFixture(root, Number(args.values.port))).receipt));
  else if (command === "control" || command === "stop") {
    const receipt: unknown = JSON.parse(readFileSync(resolve(root, "lifecycle.json"), "utf8"));
    if (!isRecord(receipt) || typeof receipt.origin !== "string" || receipt.root !== root) throw new FixtureRefusal("fixture lifecycle missing");
    const session = await fixtureSession(receipt.origin);
    const response = await fetch(`${receipt.origin}/__fixture/${command}`, { method: "POST", headers: session.headers, body: JSON.stringify({ scenario: args.values.scenario }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new FixtureRefusal(`fixture control failed ${response.status}`);
    console.log(JSON.stringify({ command, status: response.status }));
  } else throw new FixtureRefusal("expected serve, control, or stop");
}
