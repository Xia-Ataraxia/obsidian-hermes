import { ItemView, Scope, type WorkspaceLeaf } from "obsidian";
import { mountKanbanSdkHost } from "./kanban-sdk-host";
import { KanbanViewSession } from "./kanban-view-session";
import type { HermesKanbanViewServices } from "./kanban-view-contract";

export const HERMES_KANBAN_VIEW = "hermes-kanban";

export class HermesKanbanView extends ItemView {
  private readonly session: KanbanViewSession;
  private host: ReturnType<typeof mountKanbanSdkHost> | null = null;
  private statusEl: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopAge: (() => void) | null = null;
  private disposed = false;
  constructor(leaf: WorkspaceLeaf, private readonly services: HermesKanbanViewServices) {
    super(leaf);
    this.session = new KanbanViewSession(services.state, services.initialBoard);
  }
  override getViewType(): string { return HERMES_KANBAN_VIEW; }
  override getDisplayText(): string { return "Hermes Kanban"; }
  override getIcon(): string { return "kanban"; }
  override async onOpen(): Promise<void> {
    if (this.disposed || this.host) return;
    this.contentEl.classList.add("hcv-kanban-view");
    const status = this.contentEl.ownerDocument.createElement("div");
    status.className = "hcv-kanban-connection";
    status.setAttribute("role", "status");
    this.contentEl.append(status);
    this.statusEl = status;
    this.unsubscribe = this.session.drafts.subscribe(() => this.renderStatus());
    this.host = mountKanbanSdkHost(this.contentEl, this.session.services, (dialog, cancel) => {
      const scope = new Scope(this.app.scope);
      scope.register(null, null, event => {
        if (event.key !== "Escape" || !(event.target instanceof Node && dialog.contains(event.target))) return;
        cancel();
        return false;
      });
      this.app.keymap.pushScope(scope);
      let released = false;
      return () => { if (!released) { released = true; this.app.keymap.popScope(scope); } };
    });
    this.renderStatus();
    this.armAge();
  }
  private armAge(): void {
    this.stopAge = this.services.state.clock.later(() => { this.renderStatus(); if (!this.disposed) this.armAge(); }, 1000);
  }
  private renderStatus(): void { if (this.statusEl) this.statusEl.textContent = this.session.status(); }
  navigate(board: string, taskId: string | null = null): Promise<boolean> {
    return this.session.requestNavigation(board, taskId, this.services.confirmNavigation ?? this.services.confirmDiscard);
  }
  setVisible(visible: boolean): void { this.session.setVisible(visible); this.renderStatus(); }
  async requestClose(): Promise<boolean> {
    const decision = this.session.closeDecision();
    if (decision.kind === "confirm-discard" && !await this.services.confirmDiscard(decision)) return false;
    this.dispose();
    return true;
  }
  override async onClose(): Promise<void> { this.dispose(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAge?.(); this.stopAge = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.host?.dispose(); this.host = null;
    this.session.dispose();
    this.statusEl?.remove(); this.statusEl = null;
    this.contentEl.classList.remove("hcv-kanban-view");
  }
}
