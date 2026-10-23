import { DashboardClient } from "./dashboard-client";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardRequest, DashboardRequestContext } from "../types/dashboard-client";
import type { DashboardConnection } from "../types/dashboard-connection";
import type { DashboardSocketRequest } from "./dashboard-socket";

/** Keeps the state owner's identity stable while visibility releases transport credentials. */
export class ControlCenterClient extends DashboardClient {
  private current: DashboardClient | null;
  private disposed = false;
  constructor(connection: DashboardConnection) {
    super(connection);
    this.current = new DashboardClient(connection);
  }
  resume(connection: DashboardConnection): void {
    if (this.disposed) throw new DashboardClientError("cancelled");
    this.current?.dispose();
    this.current = new DashboardClient(connection);
  }
  pause(): void { this.current?.dispose(); this.current = null; }
  private active(): DashboardClient {
    if (this.current === null) throw new DashboardClientError("cancelled");
    return this.current;
  }
  override ready(context: DashboardRequestContext = {}) { return this.active().ready(context); }
  override read(request: DashboardRequest, context: DashboardRequestContext = {}) { return this.active().read(request, context); }
  override task(board: string, id: string, context: DashboardRequestContext = {}) { return this.active().task(board, id, context); }
  override attachment(board: string, id: string, context: DashboardRequestContext = {}) { return this.active().attachment(board, id, context); }
  override mutate(request: DashboardRequest, context: DashboardRequestContext = {}) { return this.active().mutate(request, context); }
  override skills(profile: string, context: DashboardRequestContext = {}) { return this.active().skills(profile, context); }
  override profileLocations(context: DashboardRequestContext = {}) { return this.active().profileLocations(context); }
  override skillContent(profile: string, name: string, context: DashboardRequestContext = {}) { return this.active().skillContent(profile, name, context); }
  override subscribe(input: DashboardSocketRequest, context: DashboardRequestContext = {}) { return this.active().subscribe(input, context); }
  override dispose(): void { this.disposed = true; this.pause(); super.dispose(); }
}
