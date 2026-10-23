import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { DashboardConnection, DashboardTunnelProcess, DashboardTunnelTransport } from "../src/types/dashboard-connection";

export class LoopbackTransport implements DashboardTunnelTransport {
  readonly children: ChildProcess[] = [];
  readonly ports: number[] = [];
  async connect(_alias: string, signal: AbortSignal): Promise<DashboardTunnelProcess> {
    signal.throwIfAborted();
    const child = spawn(process.execPath, ["-e", `
      const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
        return new Response(request.headers.get('authorization')==='Bearer task-owned'?'authenticated':'denied',
          {status:request.headers.get('authorization')==='Bearer task-owned'?200:401});
      }}); console.log(server.port);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    this.children.push(child);
    const exited = once(child, "close").then(() => undefined);
    const stop = (): void => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", stop, { once: true });
    const close = async (): Promise<void> => {
      stop();
      await exited;
      signal.removeEventListener("abort", stop);
    };
    try {
      if (!child.stdout) throw new Error("Missing child stdout");
      const [data] = await once(child.stdout, "data", { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      const port = Number(String(data).trim());
      if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid fixture port");
      this.ports.push(port);
      return { port, exited, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}

export async function authenticatedProbe(connection: DashboardConnection): Promise<void> {
  const response = await fetch(connection.baseUrl, {
    headers: { authorization: "Bearer task-owned" },
    signal: AbortSignal.any([connection.signal, AbortSignal.timeout(3000)]),
  });
  if (response.status !== 200 || await response.text() !== "authenticated") throw new Error("Authentication failed");
}

export function gate(): { readonly promise: Promise<void>; open(): void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
