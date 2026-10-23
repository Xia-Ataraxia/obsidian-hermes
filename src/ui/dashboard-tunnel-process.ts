import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { checkAlias } from "../domain/remote-token-validator";
import { DashboardConnectionError } from "../types/dashboard-connection";
import type { DashboardTunnelProcess, DashboardTunnelTransport } from "../types/dashboard-connection";
import { DASHBOARD_SSH_OPTIONS, dashboardTunnelConfig } from "./dashboard-tunnel-config";
import type { DashboardTunnelConfig } from "./dashboard-tunnel-config";

export async function reserveDashboardPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new DashboardConnectionError("forward"));
      });
    });
  });
}

export class DashboardSshTransport implements DashboardTunnelTransport {
  constructor(private readonly dependencies: {
    readonly reservePort: () => Promise<number>;
    readonly config: (alias: string, signal: AbortSignal) => Promise<DashboardTunnelConfig>;
  } = { reservePort: reserveDashboardPort, config: dashboardTunnelConfig }) {}

  async connect(alias: string, signal: AbortSignal): Promise<DashboardTunnelProcess> {
    if (!checkAlias(alias).ok) throw new DashboardConnectionError("alias");
    const config = await this.dependencies.config(alias, signal);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        signal.throwIfAborted();
        const port = await this.dependencies.reservePort();
        try {
          const process = await startDashboardForward({ alias, port, config: config.path }, signal);
          return { port, exited: process.exited, close: async () => {
            await process.close();
            await config.remove();
          } };
        } catch (error) {
          if (!(error instanceof DashboardConnectionError) || error.code !== "forward" || attempt === 2) throw error;
        }
      }
      throw new DashboardConnectionError("forward");
    } catch (error) {
      await config.remove();
      throw error;
    }
  }
}

export interface DashboardForwardTarget {
  readonly alias: string;
  readonly port: number;
  readonly config: string;
}

export async function startDashboardForward(target: DashboardForwardTarget,
  signal: AbortSignal): Promise<DashboardTunnelProcess> {
  if (!checkAlias(target.alias).ok) throw new DashboardConnectionError("alias");
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new DashboardConnectionError("forward");
  signal.throwIfAborted();
  const child = spawn("ssh", ["-F", target.config, ...DASHBOARD_SSH_OPTIONS,
    "-v", "-T", "-n", "-N", "-L", `127.0.0.1:${target.port}:127.0.0.1:9119`, "--", target.alias],
  { shell: false, stdio: ["ignore", "ignore", "pipe"] });
  let ended = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => { ended = true; resolve(); });
  });
  const stop = (): void => { if (!ended) child.kill("SIGTERM"); };
  signal.addEventListener("abort", stop, { once: true });
  const close = async (): Promise<void> => {
    stop();
    const deadline = setTimeout(() => { if (!ended) child.kill("SIGKILL"); }, 1000);
    await exited;
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
  };
  let cleanup = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new DashboardConnectionError("timeout")), 20_000);
      const abort = (): void => reject(new DashboardConnectionError("closed"));
      cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", () => reject(new DashboardConnectionError("exit")));
      child.stderr.on("data", (chunk: Buffer) => {
        buffer = (buffer + chunk.toString("utf8")).slice(-8192);
        if (buffer.includes("Address already in use")) reject(new DashboardConnectionError("forward"));
        if (buffer.includes("Entering interactive session.")) resolve();
      });
      void exited.then(() => reject(new DashboardConnectionError("exit")));
    });
    if (ended || signal.aborted) throw new DashboardConnectionError("closed");
    return { port: target.port, exited, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    cleanup();
  }
}
