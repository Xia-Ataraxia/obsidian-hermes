import { checkAlias } from "../domain/remote-token-validator";
import { DashboardConnectionError } from "../types/dashboard-connection";
import type { DashboardConnection, DashboardConnectionLease, DashboardConnectionProvider,
  DashboardReadinessProbe, DashboardTunnelProcess, DashboardTunnelTransport } from "../types/dashboard-connection";
import { DashboardSshTransport } from "./dashboard-tunnel-process";

interface Session {
  readonly abort: AbortController;
  readonly ready: Promise<DashboardConnection>;
  readonly finished: Promise<void>;
  references: number;
}

export class DashboardSshTunnel implements DashboardConnectionProvider {
  private readonly sessions = new Map<string, Session>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly probe: DashboardReadinessProbe,
    private readonly transport: DashboardTunnelTransport = new DashboardSshTransport()) {}

  acquire(alias: string, signal?: AbortSignal): DashboardConnectionLease {
    if (!checkAlias(alias).ok) throw new DashboardConnectionError("alias");
    if (this.disposed || signal?.aborted) throw new DashboardConnectionError("closed");
    let session = this.sessions.get(alias);
    if (!session || session.abort.signal.aborted) {
      session = this.create(alias, session?.finished);
      this.sessions.set(alias, session);
    }
    const owned = session;
    owned.references += 1;
    let released: Promise<void> | undefined;
    const local = new AbortController();
    const release = (): Promise<void> => {
      if (released) return released;
      released = (async (): Promise<void> => {
        signal?.removeEventListener("abort", onAbort);
        local.abort();
        owned.references -= 1;
        if (owned.references === 0) {
          owned.abort.abort();
          await owned.finished;
        }
      })();
      return released;
    };
    const onAbort = (): void => { void release(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const ready = abortable(owned.ready, local.signal);
    return { ready, release };
  }

  async invalidate(alias: string): Promise<void> {
    const session = this.sessions.get(alias);
    if (!session) return;
    session.abort.abort();
    await session.finished;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.abort.abort();
    await Promise.all(sessions.map((session) => session.finished));
  }

  private create(alias: string, previous?: Promise<void>): Session {
    const abort = new AbortController();
    const generation = ++this.generation;
    let process: DashboardTunnelProcess | undefined;
    const ready = (async (): Promise<DashboardConnection> => {
      await previous;
      if (abort.signal.aborted) throw new DashboardConnectionError("closed");
      process = await this.transport.connect(alias, abort.signal);
      if (abort.signal.aborted) throw new DashboardConnectionError("closed");
      void process.exited.then(() => abort.abort());
      const connection = { alias, generation, baseUrl: `http://127.0.0.1:${process.port}`, signal: abort.signal };
      await abortable(this.probe(connection), abort.signal);
      if (abort.signal.aborted) throw new DashboardConnectionError("closed");
      return connection;
    })();
    const finished = (async (): Promise<void> => {
      try {
        await ready;
        await untilAborted(abort.signal);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        abort.abort();
      } finally {
        await process?.close();
        if (this.sessions.get(alias)?.abort === abort) this.sessions.delete(alias);
      }
    })();
    return { abort, ready, finished, references: 0 };
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new DashboardConnectionError("closed"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
