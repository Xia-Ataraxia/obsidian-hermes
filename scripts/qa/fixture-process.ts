import type { ChildProcess } from "node:child_process";

export function cancellationGuard(child: ChildProcess) {
  const exited = new Promise<void>(resolveExit => child.once("close", () => resolveExit()));
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  let cancelled = false;
  let cleanup: Promise<void> | undefined;
  const stop = () => cleanup ??= (async () => {
    signalGroup("SIGTERM");
    const timer = setTimeout(() => signalGroup("SIGKILL"), 6000);
    await exited;
    clearTimeout(timer);
    signalGroup("SIGKILL");
  })();
  const cancel = () => { cancelled = true; void stop(); };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  return {
    stop,
    get cancelled() { return cancelled; },
    release() { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); },
  };
}
