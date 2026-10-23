import type { App } from "obsidian";
import type { ConnectionId, ProfileKey } from "./control-center";
import type { CronJobRecord, ProfileRef } from "./hermes-cron";
import type { ProfileSkillCatalog } from "./profile-catalog";
import type { ControlCenterState } from "../ui/control-center-state";
import type { ProfileDocumentStore } from "../ui/profile-document-store";
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";

export type InspectorCron = {
  readonly status: "read" | "missing" | "unavailable";
  readonly jobs: readonly CronJobRecord[];
  readonly detail: string | null;
};
export type ProfileInspection = {
  readonly catalog: ProfileSkillCatalog;
  readonly ref: ProfileRef | null;
  readonly cron: InspectorCron;
};
export type ProfileInspectorServices = {
  readonly app: App;
  readonly connection: ConnectionId;
  readonly state: ControlCenterState;
  readonly adapter: SshReadOnlyAdapter;
  readonly documents?: ProfileDocumentStore;
  readonly onClose?: () => void;
};
export interface ProfileInspectorHandle {
  select(profile: ProfileKey, focusReturn?: HTMLElement): Promise<boolean>;
  refresh(): Promise<void>;
  close(): Promise<boolean>;
  setVisible(visible: boolean): void;
  dispose(): void;
}
