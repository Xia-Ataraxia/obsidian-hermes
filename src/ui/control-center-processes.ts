import { spawn } from "node:child_process";
import type { RemoteRunner } from "../types/remote-command";
import { applyPrefixBound, decodeUtf8Prefix } from "../domain/response-bound";

export class ControlCenterProcesses {
  private readonly children = new Set<{ readonly alias: string; stop(): void; readonly done: Promise<void> }>();
  private readonly retired = new Set<string>();
  private disposed = false;
  readonly runner: RemoteRunner = (file, args, options) => this.run(file, args, options, options.stdin);
  private run(file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly maxBytes: number }, stdin?: Uint8Array): ReturnType<RemoteRunner> {
    const alias = args[args.indexOf("--") + 1] ?? "";
    if (this.disposed || this.retired.has(alias)) return Promise.resolve({ stdout: "", stderr: "Connection closed", exitCode: null, capExceeded: false });
    return new Promise((resolve, reject) => {
      let completed!: () => void;
      const done = new Promise<void>(settle => { completed = settle; });
      const child = spawn(file, [...args], { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let stderr = "";
      let capped = false;
      let stopped = false;
      let failure: Error | null = null;
      let killTimer: number | undefined;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        child.kill("SIGTERM");
        killTimer = window.setTimeout(() => child.kill("SIGKILL"), 1000);
      };
      const owned = { alias, stop, done };
      this.children.add(owned);
      const timer = window.setTimeout(stop, options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (capped) return;
        bytes += chunk.length;
        chunks.push(chunk);
        if (bytes > options.maxBytes) { capped = true; stop(); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 8192); });
      child.once("error", error => { failure = error; });
      // A host that exits before reading all of stdin breaks the pipe (EPIPE): its own exit status says why, and the upload
      // script checks the byte count, so a short write never passes as success.
      child.stdin?.on("error", () => undefined);
      if (stdin !== undefined) child.stdin?.end(stdin);
      child.once("close", exitCode => {
        window.clearTimeout(timer);
        if (killTimer) window.clearTimeout(killTimer);
        this.children.delete(owned);
        completed();
        if (failure) { reject(failure); return; }
        const bounded = applyPrefixBound(Buffer.concat(chunks), options.maxBytes);
        resolve({ stdout: decodeUtf8Prefix(bounded.bytes), stderr: stopped && !capped ? "Connection closed or command timed out" : stderr,
          exitCode: stopped ? null : exitCode, capExceeded: capped || bounded.capExceeded, bytes: bounded.bytes });
      });
    });
  }
  /** One long-lived remote command with line callbacks; never rejects, and is `refused` when it never ran. Tracked like `run`, so `cancel`/`dispose` stop it.
   *  With `stdin`, its stdin stays open for `write`, which does nothing once stopped or closed. */
  stream(file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly maxBytes: number; readonly stdin?: boolean; onStdout(line: string): void; onStderr(line: string): void }):
    { stop(): void; write(text: string): void; readonly done: Promise<{ exitCode: number | null; stderrTail: string; refused?: boolean }> } {
    const alias = args[args.indexOf("--") + 1] ?? "";
    if (this.disposed || this.retired.has(alias)) return { stop() {}, write() {}, done: Promise.resolve({ exitCode: null, stderrTail: "Connection closed", refused: true }) };
    // Plain promises, not Promise.withResolvers: older Obsidian installers ship Chromium < 119.
    let settle!: (result: { exitCode: number | null; stderrTail: string }) => void;
    const done = new Promise<{ exitCode: number | null; stderrTail: string }>(resolve => { settle = resolve; });
    const child = spawn(file, [...args], { stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    // A host gone mid-write breaks the pipe (EPIPE); the stream's own close says why.
    child.stdin?.on("error", () => undefined);
    let bytes = 0;
    let tail = "";
    // Why we stopped; it goes after the tail on close, so stderr that keeps coming never pushes it out.
    let reason = "";
    let stopped = false;
    let closed = false;
    let killTimer: number | undefined;
    const stop = (): void => {
      if (stopped || closed) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = window.setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    // utf8 decoding keeps a character split across chunks whole; the partial last line waits for the next chunk.
    // A callback that throws is logged, so the rest of the chunk still arrives.
    const lines = (emit: (line: string) => void) => {
      const each = (line: string) => { try { emit(line); } catch (error) { console.error(error); } };
      let rest = "";
      return {
        push(text: string): void { const parts = (rest + text).split("\n"); rest = parts.pop() ?? ""; parts.forEach(each); },
        flush(): void { if (rest) each(rest); rest = ""; },
      };
    };
    const out = lines(line => options.onStdout(line));
    const err = lines(line => { tail = (tail + line + "\n").slice(-4096); options.onStderr(line); });
    const owned = { alias, stop, done: done.then(() => undefined) };
    this.children.add(owned);
    const timer = window.setTimeout(() => { reason = "Timed out\n"; stop(); }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (text: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(text);
      if (bytes > options.maxBytes) { reason = "Response too large\n"; stop(); return; }
      out.push(text);
    });
    // stderr keeps flowing after stop, so a late `Session:` line still lands.
    child.stderr?.setEncoding("utf8").on("data", (text: string) => err.push(text));
    child.once("error", error => { tail += `${error.message}\n`; });
    child.once("close", exitCode => {
      closed = true;
      window.clearTimeout(timer);
      if (killTimer) window.clearTimeout(killTimer);
      out.flush();
      err.flush();
      this.children.delete(owned);
      settle({ exitCode: stopped ? null : exitCode, stderrTail: tail + reason });
    });
    return { stop, write: text => { if (!stopped && !closed) child.stdin?.write(text); }, done };
  }
  allow(aliases: readonly string[]): void { for (const alias of aliases) this.retired.delete(alias); }
  async cancel(alias: string): Promise<void> {
    this.retired.add(alias);
    const owned = [...this.children].filter(child => child.alias === alias);
    for (const child of owned) child.stop();
    await Promise.all(owned.map(child => child.done));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const owned = [...this.children];
    for (const child of owned) child.stop();
    await Promise.all(owned.map(child => child.done));
  }
}
