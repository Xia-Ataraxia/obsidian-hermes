import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord, verifyFixtureHost } from "../scripts/qa/fixture-guard";
import { startDashboardFixture } from "./fixtures/dashboard-fixture-server";
import { testPython } from "./isolated-environment";

export async function nativeDashboardFixture() {
  verifyFixtureHost();
  const python = testPython();
  const root = dirname(dirname(dirname(python)));
  const token = randomBytes(32).toString("hex");
  const child = spawn(python, ["-I", resolve("scripts/qa/native-kanban-fixture.py"), "--root", root, "--port", "0"], {
    env: { PATH: "/usr/bin:/bin", HERMES_FIXTURE_TOKEN: token, ...(process.env.CI === "true" ? { CI: "true" } : {}) }, stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>(accept => child.once("close", accept));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  try {
    const origin = await new Promise<string>((accept, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(new Error("native readiness timeout")), 30_000);
      const finish = () => { clearTimeout(timer); lines.close(); };
      child.once("error", error => { finish(); reject(error); });
      child.once("exit", code => { finish(); reject(new Error(`native exited before readiness: ${code}`)); });
      lines.once("line", line => {
        finish();
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || value.event !== "ready" || value.root !== root || value.host !== "127.0.0.1" || value.pid !== child.pid || typeof value.port !== "number") throw new Error("invalid native readiness");
          accept(`http://127.0.0.1:${value.port}`);
        } catch (error) { reject(error); }
      });
    });
    const response = await fetch(`${origin}/__fixture/ready`, { headers: { "X-Hermes-Session-Token": token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("native authenticated readiness failed");
    const fixture = startDashboardFixture({ port: 0, instance: randomBytes(16).toString("hex"), shutdown: stop, native: { origin, token } });
    return { fixture, origin: `http://127.0.0.1:${fixture.server.port}`, async stop() { await fixture.stop(); await stop(); } };
  } catch (error) { await stop(); throw error; }
}
