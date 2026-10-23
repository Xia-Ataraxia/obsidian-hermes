import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export async function runTestProcess(input: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly log: string; readonly timeoutMs?: number }) {
  const [command, ...args] = input.argv;
  if (!command) throw new TypeError("Empty test command");
  appendFileSync(input.log, JSON.stringify({ event: "command", argv: input.argv }) + "\n");
  const child = spawn(command, args, { env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  let cancelled = false;
  const signal = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, kind); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { cancelled = true; signal("SIGTERM"); killTimer ??= setTimeout(() => signal("SIGKILL"), 6000); };
  const timer = setTimeout(cancel, input.timeoutMs ?? 180_000);
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const capture = (chunk: Buffer) => {
    if (text.length > 8_388_608) { cancel(); return; }
    const part = chunk.toString(); text += part; appendFileSync(input.log, part); process.stdout.write(part);
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  try {
    const code = await new Promise<number>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (value, terminated) => accept(value ?? (terminated ? 128 : 1)));
    });
    appendFileSync(input.log, JSON.stringify({ event: "exit", innerExit: code, cancelled }) + "\n");
    return { code: cancelled ? 130 : code, text };
  } finally {
    signal("SIGKILL"); clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
