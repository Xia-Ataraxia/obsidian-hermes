import { parseControlCenterToken } from "../domain/control-center-validation";
import type { ConnectionId } from "../types/control-center";
import type { ControlCenterDependencies, ControlCenterLocation } from "../types/control-center-composition";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardConnection, DashboardConnectionLease } from "../types/dashboard-connection";
import type { ProfileMetadataReader } from "../types/profile-catalog";
import { ProfileCatalogError } from "../types/profile-catalog";
import type { TaskActivityReader } from "../types/task-activity-read";
import { ControlCenterClient } from "./control-center-client";
import { ControlCenterState } from "./control-center-state";
import { ControlCenterLocationOwner } from "./control-center-location";
import type { DashboardRequestContext } from "../types/dashboard-client";

export interface ControlCenterConnection {
  readonly connection: ConnectionId;
  readonly state: ControlCenterState;
  readonly client: ControlCenterClient;
  readonly metadata: ProfileMetadataReader;
  readonly activity: TaskActivityReader;
  readonly location: ControlCenterLocation | null;
  resolveLocation(context: DashboardRequestContext): Promise<ControlCenterLocation | null>;
}
interface Entry {
  readonly lifetime: AbortController;
  readonly connection: ConnectionId;
  references: number;
  visible: number;
  lease: DashboardConnectionLease | null;
  wire: DashboardConnection | null;
  scope: ControlCenterConnection | null;
  ready: Promise<ControlCenterConnection> | null;
  location: ControlCenterLocationOwner | null;
}
export interface ControlCenterConnectionBinding {
  readonly connection: ConnectionId;
  show(): Promise<ControlCenterConnection>;
  hide(): Promise<void>;
  dispose(): Promise<void>;
}

/** Shared state survives hidden tabs; only visible tabs retain an authenticated transport. */
export class ControlCenterConnections {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(readonly dependencies: ControlCenterDependencies) {}
  bind(alias: string): ControlCenterConnectionBinding {
    const parsed = parseControlCenterToken("connection", alias);
    if (!parsed.ok) throw new DashboardClientError("invalid-request");
    if (this.disposed) throw new DashboardClientError("cancelled");
    let entry = this.entries.get(alias);
    if (!entry) {
      entry = { connection: parsed.value, lifetime: new AbortController(), references: 0, visible: 0, lease: null, wire: null, scope: null, ready: null, location: null };
      this.entries.set(alias, entry);
    }
    const owned = entry;
    owned.references += 1;
    let visible = false;
    let closed = false;
    const hide = async (): Promise<void> => {
      if (!visible) return;
      visible = false;
      owned.visible -= 1;
      if (owned.visible === 0) await this.pause(owned);
    };
    return {
      connection: parsed.value,
      show: async () => {
        if (closed || owned.lifetime.signal.aborted) throw new DashboardClientError("cancelled");
        if (!visible) { visible = true; owned.visible += 1; }
        return this.resume(owned);
      },
      hide,
      dispose: async () => {
        if (closed) return;
        closed = true;
        await hide();
        owned.references -= 1;
        if (owned.references === 0) await this.remove(owned);
      },
    };
  }
  private resume(entry: Entry): Promise<ControlCenterConnection> {
    if (entry.ready) return entry.ready;
    const lease = this.dependencies.connections.acquire(entry.connection, entry.lifetime.signal);
    entry.lease = lease;
    const ready = (async () => {
      try {
        const wire = await lease.ready;
        if (entry.lease !== lease || entry.lifetime.signal.aborted) throw new DashboardClientError("cancelled");
        entry.wire = wire;
        if (entry.scope) {
          entry.scope.client.resume(wire);
          return entry.scope;
        }
        const client = new ControlCenterClient(wire);
        const location = new ControlCenterLocationOwner(entry.connection, this.dependencies, () => {
          const current = entry.wire;
          if (!current) throw new ProfileCatalogError("aborted");
          return { signal: current.signal, isCurrent: () => entry.wire === current };
        }, client);
        entry.location = location;
        const metadata = location.metadata;
        const state = new ControlCenterState(entry.connection, client, metadata);
        entry.scope = { connection: entry.connection, client, state, metadata, get location() { return location.location; }, resolveLocation: context => location.resolve(context), activity: this.dependencies.activity() };
        return entry.scope;
      } catch (error) {
        if (entry.lease === lease) { entry.lease = null; entry.ready = null; }
        await lease.release();
        throw error;
      }
    })();
    entry.ready = ready;
    return ready;
  }
  private async pause(entry: Entry): Promise<void> {
    const lease = entry.lease;
    entry.lease = null;
    entry.wire = null;
    entry.ready = null;
    entry.location?.resetPending();
    entry.scope?.client.pause();
    await lease?.release();
  }
  private async remove(entry: Entry): Promise<void> {
    entry.lifetime.abort();
    entry.location?.dispose();
    entry.scope?.state.dispose();
    entry.scope?.activity.dispose();
    entry.scope?.client.dispose();
    entry.scope = null;
    if (this.entries.get(entry.connection) === entry) this.entries.delete(entry.connection);
    await this.pause(entry);
  }
  async invalidate(alias: string): Promise<void> {
    const entry = this.entries.get(alias);
    if (entry) await this.remove(entry);
    await this.dependencies.connections.invalidate(alias);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.values()].map(entry => this.remove(entry)));
    await this.dependencies.connections.dispose();
  }
}
