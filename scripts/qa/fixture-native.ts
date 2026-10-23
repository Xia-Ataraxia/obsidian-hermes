import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { FixtureRefusal, isRecord } from "./fixture-guard";

export async function launchNative(root: string, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn(resolve(root, "python/bin/python"), ["-I", resolve(import.meta.dir, "native-kanban-fixture.py"), "--root", root, "--port", "0"], {
    env: { PATH: "/usr/bin:/bin", HERMES_FIXTURE_TOKEN: token }, stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>(resolveExit => child.once("close", resolveExit));
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  const abort = () => { void stop(); };
  signal.addEventListener("abort", abort, { once: true });
  child.once("spawn", () => console.log(JSON.stringify({ event: "native-spawned", pid: child.pid })));
  try {
    const ready = await new Promise<{ readonly origin: string; readonly pid: number }>((resolveReady, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(new FixtureRefusal("native ready timeout")), 30_000);
      child.once("error", error => { clearTimeout(timer); lines.close(); reject(error); });
      child.once("exit", () => { clearTimeout(timer); lines.close(); reject(new FixtureRefusal("native exited before readiness")); });
      lines.once("line", line => {
        clearTimeout(timer);
        lines.close();
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || value.event !== "ready" || value.host !== "127.0.0.1" || value.root !== root || value.pid !== child.pid || typeof value.pid !== "number" || typeof value.port !== "number") throw new FixtureRefusal("invalid native ready record");
          resolveReady({ origin: `http://127.0.0.1:${value.port}`, pid: value.pid });
        } catch (error) { reject(error); }
      });
    });
    const response = await fetch(`${ready.origin}/__fixture/ready`, { headers: { "X-Hermes-Session-Token": token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new FixtureRefusal("native authenticated readiness failed");
    signal.throwIfAborted();
    return { ...ready, token, stop, exited };
  } catch (error) { await stop(); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}
