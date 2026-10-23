import { spawn } from "node:child_process";
import type { RemoteRunner } from "../types/remote-command";
import { applyPrefixBound, decodeUtf8Prefix } from "../domain/response-bound";
import { ProfileDocumentStore } from "./profile-document-store";

export class ControlCenterProcesses {
  private readonly children = new Set<{ readonly alias: string; stop(): void; readonly done: Promise<void> }>();
  private readonly retired = new Set<string>();
  private disposed = false;
  readonly runner: RemoteRunner = (file, args, options) => this.run(file, args, options);
  readonly documents = new ProfileDocumentStore((file, args, stdin, options) => this.run(file, args, options, stdin));
  private run(file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly maxBytes: number }, stdin?: string): ReturnType<RemoteRunner> {
    const alias = args[args.indexOf("--") + 1] ?? "";
    if (this.disposed || this.retired.has(alias)) return Promise.resolve({ stdout: "", stderr: "Connection closed", exitCode: null, capExceeded: false });
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let stderr = "";
      let capped = false;
      let stopped = false;
      let failure: Error | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      };
      const completed = Promise.withResolvers<void>();
      const owned = { alias, stop, done: completed.promise };
      this.children.add(owned);
      const timer = setTimeout(stop, options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (capped) return;
        bytes += chunk.length;
        chunks.push(chunk);
        if (bytes > options.maxBytes) { capped = true; stop(); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 8192); });
      child.once("error", error => { failure = error; });
      child.stdin?.on("error", error => { failure = error; stop(); });
      if (stdin !== undefined) child.stdin?.end(stdin);
      child.once("close", exitCode => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        this.children.delete(owned);
        completed.resolve();
        if (failure) { reject(failure); return; }
        const bounded = applyPrefixBound(Buffer.concat(chunks), options.maxBytes);
        resolve({ stdout: decodeUtf8Prefix(bounded.bytes), stderr: stopped && !capped ? "Connection closed or command timed out" : stderr,
          exitCode: stopped ? null : exitCode, capExceeded: capped || bounded.capExceeded });
      });
    });
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
