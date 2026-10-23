import { Modal, type App } from "obsidian";
import type { ProfileRef } from "../types/hermes-cron";
import type { ConfirmationSpec, DocumentVersion, ProfileDocumentName } from "../types/profile-document";
import {
  DiscardConfirmationModal,
  discardChangesPrompt,
  reloadFromServerPrompt,
  saveInProgressPrompt,
} from "./discard-confirmation-modal";
import { renderDocumentEditor, updateDocumentActions } from "./profile-document-render";
import { ProfileDocumentStore } from "./profile-document-store";
type Phase = "loading" | "ready" | "failed";

/**
 * Bounded editor for one profile document (`SOUL.md` or `USER.md`).
 *
 * The body lives in this modal's memory only: it is never written to disk locally, never logged
 * and never snapshotted. Saving is always an explicit user action - there is no autosave, and a
 * missing document is created only when the user presses Save.
 */
export class ProfileDocumentModal extends Modal {
  private readonly store: ProfileDocumentStore;
  private phase: Phase = "loading";
  private message: string | null = null;
  /** Editor buffer. Authoritative while the modal is open. */
  private buffer = "";
  /** Last body confirmed to match the server at `version`. */
  private baseline = "";
  private version: DocumentVersion = null;
  /**
   * Absolute file the open buffer was read from, as resolved by the server.
   *
   * Shown to the user and sent back with an explicit Save so the write is bound to that exact
   * target: if `memories` was retargeted meanwhile, the server refuses instead of writing
   * somewhere else. Empty only before the first successful read.
   */
  private resolvedPath = "";
  private busy = false;
  private conflict = false;
  /** Guards against a late reply from a request that outlived the modal. */
  private closed = false;
  private confirming = false;
  private embeddedClose: (() => void) | null = null;
  private confirmation: DiscardConfirmationModal | null = null;
  private closeRequest: Promise<boolean> | null = null;
  private revision = 0;

  constructor(
    app: App,
    private readonly profile: ProfileRef,
    private readonly name: ProfileDocumentName,
    store?: ProfileDocumentStore,
  ) {
    super(app);
    this.store = store ?? new ProfileDocumentStore();
  }

  private get dirty(): boolean {
    return this.buffer !== this.baseline;
  }

  /** A document that does not exist yet can be created even with an empty, unedited buffer. */
  private get savable(): boolean {
    return this.phase === "ready" && !this.busy && (this.dirty || this.version === null);
  }

  override async onOpen(): Promise<void> {
    (this.modalEl as HTMLElement | undefined)?.addClass("hcv-doc-modal");
    this.render();
    await this.load();
  }

  /**
   * Single close gate for every route out of the modal: Cancel, the X, Escape and the backdrop.
   *
   * An in-flight save is never abandoned silently, and an unsaved buffer is never dropped without
   * an explicit confirmation.
   */
  override close(): void {
    if (this.embeddedClose !== null) {
      this.embeddedClose();
      return;
    }
    if (!this.busy && !this.dirty) {
      super.close();
      return;
    }
    void this.requestClose().then(allowed => { if (allowed && !this.closed) super.close(); });
  }

  override onClose(): void {
    this.closed = true;
    this.revision += 1;
    this.confirmation?.close();
    this.confirmation = null;
    this.buffer = "";
    this.baseline = "";
    this.version = null;
    this.resolvedPath = "";
    this.message = null;
    this.embeddedClose = null;
    for (const editor of Array.from(this.contentEl.querySelectorAll("textarea"))) editor.value = "";
    this.contentEl.empty();
  }

  /** Use the same editor and save checks inside a leaf; never open a global modal. */
  async mount(container: HTMLElement, onClose: () => void): Promise<void> {
    this.embeddedClose = onClose;
    container.append(this.contentEl);
    await this.onOpen();
  }

  requestClose(): Promise<boolean> {
    if (this.closed || !this.busy && !this.dirty) return Promise.resolve(true);
    if (this.confirming) return Promise.resolve(false);
    if (this.closeRequest !== null) return this.closeRequest;
    this.closeRequest = new Promise<boolean>(resolve => {
      this.confirmation = new DiscardConfirmationModal(this.app, this.busy ? saveInProgressPrompt(this.name) : discardChangesPrompt(this.name), resolve);
      this.confirmation.open();
    }).finally(() => { this.closeRequest = null; this.confirmation = null; });
    return this.closeRequest;
  }

  dispose(): void {
    this.onClose();
    this.contentEl.remove();
  }

  /** Observe external changes without replacing the editor, selection or its buffer. */
  async refresh(): Promise<void> {
    if (this.closed || this.busy || this.phase !== "ready") return;
    const revision = ++this.revision;
    const result = await this.store.read(this.profile, this.name);
    if (this.closed || this.busy || revision !== this.revision) return;
    if (!result.ok) this.message = `Could not refresh ${this.name} (${result.code}). Your text is kept.`;
    else if (result.value.version !== this.version || result.value.resolvedPath !== this.resolvedPath) {
      this.conflict = true;
      this.message = `${this.name} changed on the server. Your text is kept here; reload to see the server copy.`;
    } else return;
    const message = this.contentEl.querySelector<HTMLElement>("[data-document-message]");
    if (message !== null) { message.hidden = false; message.textContent = this.message; message.className = "hcv-doc-error"; }
  }

  /** Open one confirmation at a time; `onConfirmed` runs only on an explicit yes. */
  private ask(spec: ConfirmationSpec, onConfirmed: () => void): void {
    if (this.confirming) return;
    this.confirming = true;
    this.confirmation = new DiscardConfirmationModal(this.app, spec, (confirmed) => {
      this.confirming = false;
      this.confirmation = null;
      if (confirmed && !this.closed) onConfirmed();
    });
    this.confirmation.open();
  }

  private async load(): Promise<void> {
    this.revision += 1;
    this.busy = true;
    this.render();
    const result = await this.store.read(this.profile, this.name);
    if (this.closed) return;
    this.busy = false;
    if (!result.ok) {
      this.phase = "failed";
      this.message = `Could not read ${this.name} (${result.code}): ${result.detail}`;
      this.render();
      return;
    }
    this.phase = "ready";
    this.conflict = false;
    this.version = result.value.version;
    this.resolvedPath = result.value.resolvedPath;
    this.baseline = result.value.body;
    this.buffer = result.value.body;
    this.message = result.value.version === null
      ? `${this.name} does not exist yet. Saving creates it.`
      : null;
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.savable) return;
    this.revision += 1;
    this.busy = true;
    this.message = null;
    this.render();
    const body = this.buffer;
    const result = await this.store.save(this.profile, this.name, body, this.version, this.resolvedPath);
    if (this.closed) return;
    this.busy = false;
    if (!result.ok) {
      // The buffer is kept exactly as typed in every failure case, including a conflict.
      this.conflict = result.code === "conflict";
      this.message = this.conflict
        ? `${this.name} changed on the server. Your text is kept here; reload to see the server copy.`
        : `Save failed (${result.code}): ${result.detail}`;
      this.render();
      return;
    }
    this.conflict = false;
    this.version = result.value.version;
    this.resolvedPath = result.value.resolvedPath;
    this.baseline = body;
    this.message = `Saved ${this.name}.`;
    this.render();
  }

  /** Explicit, confirmed discard of the local buffer in favour of the server copy. */
  private reloadFromServer(): void {
    if (this.busy) return;
    if (!this.dirty) {
      void this.load();
      return;
    }
    this.ask(reloadFromServerPrompt(this.name), () => void this.load());
  }

  private render(): void {
    renderDocumentEditor(this.contentEl, {
      profile: this.profile, name: this.name, phase: this.phase, message: this.message,
      conflict: this.conflict, resolvedPath: this.resolvedPath, buffer: this.buffer,
      busy: this.busy, savable: this.savable, stateLabel: this.stateLabel,
    }, {
      reload: () => this.reloadFromServer(), retry: () => void this.load(), save: () => void this.save(),
      close: () => this.close(), input: value => { this.buffer = value; this.updateActionState(); },
    });
  }

  private get stateLabel(): string {
    if (this.busy) return "Working...";
    if (this.dirty) return "Unsaved changes";
    return this.version === null ? "Not created yet" : "No unsaved changes";
  }

  /** Keep the dirty indicator and Save availability current without rebuilding the editor. */
  private updateActionState(): void {
    updateDocumentActions(this.contentEl, this.savable, this.stateLabel);
  }
}
