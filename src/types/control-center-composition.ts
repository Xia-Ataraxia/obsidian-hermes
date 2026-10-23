import type { ConnectionId } from "./control-center";
import type { DashboardRequestContext } from "./dashboard-client";
import type { DashboardConnectionProvider } from "./dashboard-connection";
import type { ProfileMetadataReader } from "./profile-catalog";
import type { TaskActivityReader } from "./task-activity-read";
import type { ProfileDocumentStore } from "../ui/profile-document-store";
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import type { DashboardClient } from "../ui/dashboard-client";

export interface ControlCenterLocation {
  readonly connection: ConnectionId;
  readonly root: string;
  readonly sourceRoot: string;
}
export interface ControlCenterDependencies {
  readonly connections: DashboardConnectionProvider;
  readonly adapter: SshReadOnlyAdapter;
  readonly documents?: ProfileDocumentStore;
  location(connection: ConnectionId, context: DashboardRequestContext, client: DashboardClient): Promise<ControlCenterLocation>;
  metadata(location: ControlCenterLocation): ProfileMetadataReader;
  activity(): TaskActivityReader;
}
