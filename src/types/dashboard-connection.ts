export interface DashboardConnection {
  readonly alias: string;
  readonly generation: number;
  readonly baseUrl: string;
  readonly signal: AbortSignal;
}

export interface DashboardConnectionLease {
  readonly ready: Promise<DashboardConnection>;
  release(): Promise<void>;
}

export interface DashboardConnectionProvider {
  acquire(alias: string, signal?: AbortSignal): DashboardConnectionLease;
  invalidate(alias: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Task 7 supplies a bounded authenticated status request; TCP acceptance is insufficient. */
export type DashboardReadinessProbe = (connection: DashboardConnection) => Promise<void>;

export interface DashboardTunnelProcess {
  readonly port: number;
  readonly exited: Promise<void>;
  close(): Promise<void>;
}

export interface DashboardTunnelTransport {
  connect(alias: string, signal: AbortSignal): Promise<DashboardTunnelProcess>;
}

export class DashboardConnectionError extends Error {
  constructor(readonly code: "alias" | "closed" | "exit" | "timeout" | "forward" | "config") {
    super(`Dashboard connection: ${code}`);
    this.name = "DashboardConnectionError";
  }
}
