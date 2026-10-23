import { ItemView, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type { ControlCenterConnection, ControlCenterConnectionBinding } from "./control-center-connections";
import { guardControlCenterClose } from "./control-center-close-guard";
import { DashboardClientError } from "../types/dashboard-client";

export interface ControlCenterMountedView {
  readonly view: ItemView & { onOpen(): Promise<void>; onClose(): Promise<void>; setVisible(visible: boolean): void; requestClose(): Promise<boolean> };
  navigate?(board: string, taskId: string | null): Promise<boolean>;
  dispose(): void;
}
export interface ManagedViewOptions {
  readonly type: string;
  readonly title: string;
  readonly icon: string;
  readonly initialConnection?: string;
  hasConnection(alias: string): boolean;
  bind(alias: string): ControlCenterConnectionBinding;
  mount(scope: ControlCenterConnection, leaf: WorkspaceLeaf): Promise<ControlCenterMountedView>;
  closed(): void;
}
export abstract class ControlCenterManagedView extends ItemView {
  private mounted: ControlCenterMountedView | null = null;
  private readonly guard;
  private observer: ResizeObserver | null = null;
  private visible = false;
  private disposed = false;
  private generation = 0;
  private pending: { readonly board: string; readonly taskId: string | null } | null = null;
  private readonly status: HTMLElement;
  private cleanup: Promise<void> | null = null;
  private binding: ControlCenterConnectionBinding | null = null;
  private selectedConnection: string | null = null;
  private opening: Promise<void> | null = null;
  protected constructor(leaf: WorkspaceLeaf, readonly options: ManagedViewOptions) {
    super(leaf);
    this.contentEl.classList.add("hcv-control-center");
    this.status = this.contentEl.createEl("p", { cls: "hcv-control-status", attr: { role: "status" } });
    this.guard = guardControlCenterClose(leaf, () => this.requestClose(), error => this.showError(error), () => this.dispose());
  }
  get connection(): string { return this.selectedConnection ?? "Unavailable connection"; }
  override getState(): { readonly connection: string | null } { return { connection: this.selectedConnection }; }
  override async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const alias = typeof state === "object" && state !== null && "connection" in state && typeof state.connection === "string" ? state.connection : this.options.initialConnection;
    if (this.binding) {
      if (alias !== this.selectedConnection) this.status.textContent = "Close this view before changing its connection.";
      return;
    }
    this.selectedConnection = alias ?? null;
    if (!alias || !this.options.hasConnection(alias)) {
      this.status.textContent = "The saved connection is unavailable. Open Hermes settings to select a configured connection.";
      return;
    }
    this.binding = this.options.bind(alias);
    await this.updateVisibility();
  }
  override async onOpen(): Promise<void> {
    this.observer = new ResizeObserver(() => void this.updateVisibility());
    this.observer.observe(this.containerEl);
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.updateVisibility()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.updateVisibility()));
    await this.updateVisibility();
  }
  async updateVisibility(): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    const visible = !this.disposed && this.containerEl.isConnected && this.containerEl.getClientRects().length > 0 && this.containerEl.checkVisibility({ checkVisibilityCSS: true });
    if (visible === this.visible) return;
    this.visible = visible;
    const generation = ++this.generation;
    if (!visible) {
      this.mounted?.view.setVisible(false);
      await binding.hide();
      return;
    }
    this.status.textContent = `${this.connection} · Connecting…`;
    try {
      const scope = await binding.show();
      if (generation !== this.generation || this.disposed) return;
      if (!this.mounted) {
        const mounted = await this.options.mount(scope, this.leaf);
        if (generation !== this.generation || this.disposed) { mounted.dispose(); await mounted.view.onClose(); return; }
        this.mounted = mounted;
        this.contentEl.append(mounted.view.containerEl);
        mounted.view.containerEl.classList.add("hcv-control-child");
        this.opening = mounted.view.onOpen();
        await this.opening;
        this.opening = null;
      } else this.mounted.view.setVisible(true);
      if (generation !== this.generation || this.disposed) return;
      this.status.textContent = "";
      if (this.pending) await this.mounted.navigate?.(this.pending.board, this.pending.taskId);
      this.pending = null;
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.showError(error);
        const retry = this.status.createEl("button", { text: "Retry", attr: { type: "button" } });
        retry.addEventListener("click", () => { this.visible = false; void this.updateVisibility(); }, { once: true });
      }
    }
  }
  private showError(error: unknown): void {
    this.status.textContent = `${this.connection} · ${error instanceof DashboardClientError ? error.message : "Connection or view could not be loaded."}`;
  }
  async navigate(board: string, taskId: string | null): Promise<boolean> {
    if (this.disposed) return false;
    if (this.mounted) return await this.mounted.navigate?.(board, taskId) ?? false;
    this.pending = { board, taskId };
    return true;
  }
  async requestClose(): Promise<boolean> { return await this.mounted?.view.requestClose() ?? true; }
  close(): Promise<boolean> { return this.guard.close(); }
  override onClose(): Promise<void> { return this.dispose(); }
  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.disposed = true;
    this.generation += 1;
    this.guard.restore();
    this.unload();
    this.observer?.disconnect(); this.observer = null;
    const mounted = this.mounted;
    const opening = this.opening;
    this.mounted = null;
    this.pending = null;
    mounted?.view.setVisible(false);
    mounted?.dispose();
    this.contentEl.empty();
    this.options.closed();
    const close = mounted?.view.onClose();
    this.cleanup = (async () => {
      await close;
      if (opening) await opening.catch(error => { if (!(error instanceof Error)) throw error; });
      mounted?.view.unload();
      await this.binding?.dispose();
      this.binding = null;
    })();
    return this.cleanup;
  }
}
export function createControlCenterManagedView(leaf: WorkspaceLeaf, options: ManagedViewOptions): ControlCenterManagedView {
  return new class extends ControlCenterManagedView {
    constructor() { super(leaf, options); }
    override getViewType(): string { return options.type; }
    override getDisplayText(): string { return options.title; }
    override getIcon(): string { return options.icon; }
  }();
}
