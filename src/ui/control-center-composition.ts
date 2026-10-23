import { ItemView, type Plugin, type WorkspaceLeaf } from "obsidian";
import { parseControlCenterToken } from "../domain/control-center-validation";
import type { ControlCenterDependencies } from "../types/control-center-composition";
import type { TaskKey } from "../types/control-center";
import { DashboardClientError } from "../types/dashboard-client";
import type { PluginDataGateway } from "./plugin-data-gateway";
import { ControlCenterConnections } from "./control-center-connections";
import { ControlCenterPreferencesStore } from "./control-center-preferences-store";
import { ControlCenterManagedView, createControlCenterManagedView } from "./control-center-managed-view";
import { createControlCenterProfileServices } from "./control-center-profile-services";
import { HERMES_KANBAN_VIEW, HermesKanbanView } from "./hermes-kanban-view";
import { HERMES_PROFILES_VIEW, HermesProfilesView } from "./hermes-profiles-view";
import { DiscardConfirmationModal, discardChangesPrompt, saveInProgressPrompt } from "./discard-confirmation-modal";
import { notify } from "./notices";
import type { ConfirmationSpec } from "../types/profile-document";

export class ControlCenterComposition {
  private pool: ControlCenterConnections;
  private readonly preferences: ControlCenterPreferencesStore;
  private readonly views = new Set<ControlCenterManagedView>();
  private readonly requested = new WeakMap<WorkspaceLeaf, string>();
  private readonly dialogs = new Set<DiscardConfirmationModal>();
  private disposed = false;
  constructor(private readonly plugin: Plugin, gateway: PluginDataGateway,
    private readonly aliases: () => readonly string[], dependencies: ControlCenterDependencies) {
    this.pool = new ControlCenterConnections(dependencies);
    this.preferences = new ControlCenterPreferencesStore(gateway);
  }
  register(): void {
    this.plugin.registerView(HERMES_KANBAN_VIEW, leaf => this.create(leaf, HERMES_KANBAN_VIEW));
    this.plugin.registerView(HERMES_PROFILES_VIEW, leaf => this.create(leaf, HERMES_PROFILES_VIEW));
    this.plugin.addCommand({ id: "open-hermes-kanban", name: "Open Hermes Kanban", callback: () => this.openCommand(HERMES_KANBAN_VIEW) });
    this.plugin.addCommand({ id: "open-hermes-profiles", name: "Open Hermes Profiles", callback: () => this.openCommand(HERMES_PROFILES_VIEW) });
  }
  async configure(dependencies: ControlCenterDependencies): Promise<void> {
    if (this.views.size !== 0 || this.disposed) throw new DashboardClientError("invalid-request");
    await this.pool.dispose();
    this.pool = new ControlCenterConnections(dependencies);
  }
  private openCommand(type: string): void {
    void this.open(type).catch(error => {
      if (error instanceof Error) notify(error.message);
      else throw error;
    });
  }
  private create(leaf: WorkspaceLeaf, type: string): ItemView {
    const alias = this.requested.get(leaf);
    const kanban = type === HERMES_KANBAN_VIEW;
    const view = createControlCenterManagedView(leaf, {
      type, title: kanban ? "Hermes Kanban" : "Hermes Profiles", icon: kanban ? "kanban" : "network",
      ...(alias ? { initialConnection: alias } : {}),
      hasConnection: candidate => this.aliases().includes(candidate), bind: candidate => this.pool.bind(candidate),
      closed: () => this.views.delete(view),
      mount: async scope => {
        if (kanban) {
          const child = new HermesKanbanView(leaf, { state: scope.state, confirmDiscard: decision => this.confirm(decision.saving), confirmNavigation: decision => this.confirmNavigation(decision.saving) });
          return { view: child, navigate: (board, taskId) => child.navigate(board, taskId), dispose: () => child.dispose() };
        }
        const profile = await createControlCenterProfileServices(this.plugin.app, scope, this.pool.dependencies, this.preferences, task => this.openTask(task));
        if (profile.status === "unsupported-version") notify("Map preferences use a newer version. Layout changes cannot be saved.");
        return { view: new HermesProfilesView(leaf, profile.services), dispose: profile.dispose };
      },
    });
    this.views.add(view);
    return view;
  }
  private confirm(saving: boolean): Promise<boolean> {
    return this.prompt(saving ? saveInProgressPrompt("Hermes task") : discardChangesPrompt("Hermes task"));
  }
  private confirmNavigation(saving: boolean): Promise<boolean> {
    return this.prompt({ title: "Open another task?", question: `Unsaved drafts remain in this view.${saving ? " A save is still pending; its result will not be replayed." : ""}`, confirmLabel: "Continue", cancelLabel: "Keep editing" });
  }
  private prompt(spec: ConfirmationSpec): Promise<boolean> {
    return new Promise(resolve => {
      const dialog = new DiscardConfirmationModal(this.plugin.app, spec,
        approved => { this.dialogs.delete(dialog); resolve(approved); });
      this.dialogs.add(dialog);
      dialog.open();
    });
  }
  async open(type: string, alias = this.aliases()[0], task?: TaskKey): Promise<void> {
    if (this.disposed) throw new DashboardClientError("cancelled");
    if (!alias || !this.aliases().includes(alias)) throw new DashboardClientError("invalid-request", 0, "Add an SSH connection in Hermes settings first.");
    const existing = [...this.views].find(view => view.getViewType() === type && view.connection === alias);
    if (existing && task && !await existing.navigate(task.board, task.taskId)) return;
    const leaf = existing?.leaf ?? this.plugin.app.workspace.getLeaf("tab");
    this.requested.set(leaf, alias);
    if (!existing) await leaf.setViewState({ type, active: true, state: { connection: alias } });
    await this.plugin.app.workspace.revealLeaf(leaf);
    if (!existing && task && leaf.view instanceof ControlCenterManagedView) await leaf.view.navigate(task.board, task.taskId);
  }
  private async openTask(task: TaskKey): Promise<void> {
    await this.open(HERMES_KANBAN_VIEW, task.connection, task);
  }
  async closeConnection(alias: string): Promise<boolean> {
    for (const view of [...this.views].filter(view => view.connection === alias)) {
      if (!await view.close()) return false;
      await view.dispose();
    }
    await this.pool.invalidate(alias);
    const connection = parseControlCenterToken("connection", alias);
    if (connection.ok) await this.preferences.remove(connection.value);
    return true;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const dialog of this.dialogs) dialog.close();
    this.dialogs.clear();
    await Promise.all([...this.views].map(view => view.dispose()));
    await this.pool.dispose();
  }
}
