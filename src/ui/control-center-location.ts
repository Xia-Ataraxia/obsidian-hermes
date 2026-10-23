import type { ControlCenterDependencies, ControlCenterLocation } from "../types/control-center-composition";
import type { ConnectionId } from "../types/control-center";
import type { DashboardRequestContext } from "../types/dashboard-client";
import type { ProfileMetadataReader } from "../types/profile-catalog";
import { ProfileCatalogError } from "../types/profile-catalog";
import type { DashboardClient } from "./dashboard-client";

export class ControlCenterLocationOwner {
  private value: ControlCenterLocation | null = null;
  private reader: ProfileMetadataReader | null = null;
  private pending: Promise<ControlCenterLocation | null> | null = null;
  private disposed = false;
  readonly metadata: ProfileMetadataReader = {
    read: async (profile, context) => {
      await this.resolve(context);
      if (!this.reader) throw new ProfileCatalogError("read-failed");
      return this.reader.read(profile, context);
    },
  };
  constructor(private readonly connection: ConnectionId, private readonly dependencies: ControlCenterDependencies,
    private readonly context: () => DashboardRequestContext, private readonly client: DashboardClient) {}
  get location(): ControlCenterLocation | null { return this.value; }
  async resolve(caller: DashboardRequestContext = {}): Promise<ControlCenterLocation | null> {
    this.check(caller);
    if (!this.pending) {
      const context = this.context();
      const pending = this.discover(context);
      this.pending = pending;
    }
    const pending = this.pending;
    try {
      const result = await pending;
      this.check(caller);
      return result;
    } finally { if (this.pending === pending) this.pending = null; }
  }
  private check(context: DashboardRequestContext): void {
    if (this.disposed || context.signal?.aborted || context.isCurrent?.() === false) throw new ProfileCatalogError("aborted");
  }
  private async discover(context: DashboardRequestContext): Promise<ControlCenterLocation | null> {
    try {
      const value = await this.dependencies.location(this.connection, context, this.client);
      this.check(context);
      this.reader = this.dependencies.metadata(value);
      this.value = value;
      return value;
    } catch (error) {
      this.check(context);
      if (error instanceof ProfileCatalogError && error.code === "read-failed") { this.value = null; this.reader = null; return null; }
      throw error;
    }
  }
  resetPending(): void { this.pending = null; this.value = null; this.reader = null; }
  dispose(): void { this.disposed = true; this.value = null; this.reader = null; this.pending = null; }
}
