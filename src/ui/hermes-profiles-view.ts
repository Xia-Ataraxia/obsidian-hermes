import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { ProfilesCanvasServices } from "../types/profiles-canvas";
import { mountProfilesCanvas, type ProfilesCanvas } from "./profiles-canvas";

export const HERMES_PROFILES_VIEW = "hermes-profiles";
export class HermesProfilesView extends ItemView {
  private canvas: ProfilesCanvas | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly services: ProfilesCanvasServices) { super(leaf); }
  override getViewType(): string { return HERMES_PROFILES_VIEW; }
  override getDisplayText(): string { return "Hermes Profiles"; }
  override getIcon(): string { return "network"; }
  override async onOpen(): Promise<void> {
    this.canvas?.dispose();
    this.canvas = mountProfilesCanvas(this.contentEl, this.services);
    await this.canvas.start();
  }
  setVisible(visible: boolean): void { this.canvas?.setVisible(visible); }
  async requestClose(): Promise<boolean> { return await this.canvas?.close() ?? true; }
  override async onClose(): Promise<void> { this.canvas?.dispose(); this.canvas = null; }
}
