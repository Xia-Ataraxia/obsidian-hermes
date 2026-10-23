import type { App } from "obsidian";
import type { ProfileRef } from "../types/hermes-cron";
import type { ProfileDocumentName } from "../types/profile-document";
import { ProfileDocumentModal } from "./profile-document-modal";
import type { ProfileDocumentStore } from "./profile-document-store";

export class InspectorDocuments {
  private readonly editors = new Map<ProfileDocumentName, { readonly pane: HTMLElement; readonly editor: ProfileDocumentModal; readonly home: string }>();
  private readonly status: HTMLElement;
  constructor(private readonly root: HTMLElement, private readonly app: App, private readonly store: ProfileDocumentStore | undefined, private readonly onClose: () => void) {
    this.status = root.createEl("p", { attr: { role: "status" } });
  }
  show(name: ProfileDocumentName, ref: ProfileRef | null): void {
    for (const [key, item] of this.editors) item.pane.hidden = key !== name;
    const existing = this.editors.get(name);
    this.status.hidden = ref !== null && (existing === undefined || existing.home === ref.home);
    this.status.textContent = ref === null ? "Profile home unavailable. Document access requires native profile metadata."
      : existing !== undefined && existing.home !== ref.home ? "Profile home changed. This editor remains bound to its original file; close and reopen to inspect the new home." : "";
    if (existing !== undefined || ref === null) return;
    const pane = this.root.createDiv();
    const editor = new ProfileDocumentModal(this.app, ref, name, this.store);
    this.editors.set(name, { pane, editor, home: ref.home });
    void editor.mount(pane, this.onClose);
  }
  async refresh(): Promise<void> { await Promise.all(Array.from(this.editors.values(), item => item.editor.refresh())); }
  async requestClose(): Promise<boolean> {
    for (const item of this.editors.values()) if (!await item.editor.requestClose()) return false;
    return true;
  }
  dispose(): void {
    for (const item of this.editors.values()) item.editor.dispose();
    this.editors.clear();
    this.root.empty();
  }
}
