import { spawn } from "node:child_process";
import { ACTIVITY_LIMITS } from "../types/task-activity";
import type { ActivityRunner, ActivityRunResult } from "../types/task-activity-read";

export const activityProcessRunner: ActivityRunner = (command, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve({ ok: false, reason: "transport-failure" }); return; }
  const child = spawn(command.file, [...command.args], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: ActivityRunResult | null = null;
  const stop = (result: ActivityRunResult) => { failure ??= result; child.kill("SIGKILL"); };
  const abort = () => stop({ ok: false, reason: "transport-failure" });
  const timer = setTimeout(() => stop({ ok: false, reason: "deadline" }), ACTIVITY_LIMITS.deadlineMs + 12_000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > ACTIVITY_LIMITS.bytesPerBoard) stop({ ok: false, reason: "byte-cap" });
    else if (failure === null) chunks.push(chunk);
  });
  child.on("error", () => { failure ??= { ok: false, reason: "transport-failure" }; });
  child.on("close", (code) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    resolve(failure ?? (code === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString("utf8") } : { ok: false, reason: "transport-failure" }));
  });
});
